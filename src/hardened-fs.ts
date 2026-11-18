/**
 * Hardened host-filesystem I/O.
 *
 * Four families of primitives live here:
 *
 * - **Host-owned files** (`readHardenedFile`, `loadImmutableHostJson`,
 *   `writeStableJsonAtomic`, `assertCanonicalHostPath`) centralize the
 *   fail-closed idioms of the Docker-workload security kernel: reading a
 *   host-owned immutable file through a single no-follow descriptor (and
 *   refusing group/world-writable modes), atomically writing a durable
 *   canonical JSON record, and rejecting non-canonical host paths. Error-message
 *   text is load-bearing (tests assert it, and some hashed bytes feed frozen
 *   digests), so callers thread a `label` that reproduces their exact message
 *   prefix. This is the check for state IronCurtain itself writes (leases,
 *   rendered policies, identity files, staged trust), which it always creates
 *   with exact modes.
 * - **Package-shipped assets** (`readPackageAsset`, `loadPackageAssetJson`) are
 *   for the reviewed records and binaries that ship next to the code (the
 *   frozen manifests under `config/docker-workload/`, the build-trust wrapper).
 *   A git checkout or an npm install honours the installer's umask, so under the
 *   common user-private-group umask 002 they are legitimately 0664/0775. The
 *   check follows OpenSSH StrictModes instead of the strict mode test: the file
 *   and every directory up to the package root must be owned by root, the
 *   current user or the package root's owner, never world-writable, and
 *   group-writable only when the group is the owner's private group. Each
 *   principal these rules accept (root, the user running IronCurtain, the owner
 *   of the code being run) is already trusted with that code, so accepting
 *   them grants nothing new. Any other local user that the owners and mode bits
 *   reveal is still refused; ACLs are not read (see `readPackageAsset`). The
 *   same rules back `readOwnedRegularFile` and `assertTrustedDirectoryChain`,
 *   for inputs that decide what an agent may do but that IronCurtain's own
 *   tooling writes with the user's umask (compiled policies under the
 *   IronCurtain home or the package).
 * - **Untrusted paths** (`readUntrustedRegularFile`,
 *   `readIdentifiedUntrustedRegularFile`, `writeFileNoFollowAtomic`,
 *   `appendRegularFileNoFollow`) are for host code touching a directory an agent
 *   can write (a bind-mounted workspace, a conversation-state mount, a session
 *   sandbox). The agent can plant a symlink, FIFO, socket, device link or hard
 *   link at any name there and swap it between a check and a use. These
 *   helpers never follow a symlink in the final component, never block on a
 *   FIFO or device, bound every read, and replace (never write through) the
 *   entry at a name. Modes are not checked: agent files are legitimately
 *   group-writable under a 002 umask. Errors are {@link UntrustedFileError}
 *   with a `code` discriminant. Directory components above the final one are
 *   the caller's responsibility (Node has no `openat`), so callers pass a
 *   directory the agent cannot replace, such as a mount root or a host-owned
 *   directory, or check containment of the parent first.
 *   `readRegularFileFollowingLinks` keeps the never-block, regular-files-only
 *   and bounded-read rules for a path whose symlinks are legitimate (a manifest
 *   the user names, the definition a run record names); it follows links, so it
 *   is no containment check.
 * - **Untrusted paths below a trusted root** (`readUntrustedRegularFileBelow`,
 *   `hashUntrustedRegularFileBelow`, `copyRegularFileBelow`,
 *   `ensureDirectoryBelow`, `ensureRealDirectoryNoFollow`,
 *   `displaceEntryNoFollow`, and the asynchronous lister `openDirectoryBelow`)
 *   take that responsibility for the common case of a
 *   host-chosen root (a workspace mount source) and an agent-writable subtree
 *   below it: directory components are realpath-contained in the root, and on
 *   Linux the opened descriptor itself is located through `/proc/self/fd`, so
 *   a directory swapped for a symlink between the check and the open is
 *   detected rather than followed.
 *
 * Every descriptor is opened close-on-exec: libuv adds `O_CLOEXEC` to every
 * `open()` on POSIX, so it is not (and cannot be) spelled in the flags here.
 *
 * This is a top-level leaf (imports only Node built-ins, zod, and `./hash.js`)
 * so `src/docker/`, `src/docker-workload/`, `src/workflow/`, `src/session/`,
 * `src/web-ui/` and the other layers can depend on it without a layering
 * violation.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Dir,
  type Stats,
} from 'node:fs';
import {
  lstat as lstatAsync,
  open as openAsync,
  opendir as opendirAsync,
  readlink as readlinkAsync,
  realpath as realpathAsync,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { sha256Hex, stableStringify } from './hash.js';

export interface ReadHardenedFileOptions {
  /** Message prefix reproducing the caller's exact error strings. */
  readonly label: string;
  /** Reject files smaller than this many bytes. */
  readonly minBytes: number;
  /** Reject files larger than this many bytes. */
  readonly maxBytes: number;
}

/**
 * Read a host-owned regular file through one `O_RDONLY | O_NOFOLLOW` descriptor,
 * rejecting symlinks, non-regular files, group/world-writable modes, and sizes
 * outside `[minBytes, maxBytes]`. The descriptor is used for both the stat and
 * the read so a rename or symlink swap between checks cannot change the bytes.
 * Callers own any absolute/canonical path check (see {@link assertCanonicalHostPath}).
 * This strict mode test is for state IronCurtain writes itself; files shipped
 * in the package are read with {@link readPackageAsset}.
 */
export function readHardenedFile(path: string, options: ReadHardenedFileOptions): Buffer {
  const { label, minBytes, maxBytes } = options;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    if ((stats.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable: ${path}`);
    if (stats.size < minBytes || stats.size > maxBytes) {
      throw new Error(`${label} size is outside the allowed range: ${stats.size}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export interface LoadImmutableHostJsonOptions<T> {
  /** Message prefix reproducing the caller's exact error strings. */
  readonly label: string;
  /** Schema the parsed JSON must satisfy; a mismatch fails closed. */
  readonly schema: z.ZodType<T>;
  /** Reject files larger than this many bytes. */
  readonly maxBytes: number;
  /** Reject files smaller than this many bytes (default 2). */
  readonly minBytes?: number;
}

export interface LoadedImmutableHostJson<T> {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly value: T;
}

/**
 * Load, bound, hash, parse, and schema-validate one host-owned immutable JSON
 * file. Returns the absolute path, the SHA-256 of the exact bytes, the byte
 * length, and the validated value. Any ambiguity fails closed.
 */
export function loadImmutableHostJson<T>(
  path: string,
  options: LoadImmutableHostJsonOptions<T>,
): LoadedImmutableHostJson<T> {
  const { label, schema, maxBytes, minBytes = 2 } = options;
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  return parseImmutableJson(path, readHardenedFile(path, { label, minBytes, maxBytes }), label, schema);
}

/** Parse, hash and schema-validate bytes that a hardened reader has already bounded. */
function parseImmutableJson<T>(
  path: string,
  bytes: Buffer,
  label: string,
  schema: z.ZodType<T>,
): LoadedImmutableHostJson<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`${label} is invalid: ${validated.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return { path, sha256: sha256Hex(bytes), sizeBytes: bytes.length, value: validated.data };
}

export interface WriteStableJsonAtomicOptions {
  /** Final file mode applied before the atomic rename (default 0o600). */
  readonly mode?: number;
}

/**
 * Durably write a canonically serialized JSON record via a temp file in the same
 * directory, fsync + rename, then fsync the parent directory. The serialization
 * is {@link stableStringify} with a trailing newline so the on-disk bytes are
 * stable across writers.
 *
 * Before anything is written, the serialization must parse back to a value
 * that serializes to the very same bytes; a value with no JSON form (such as
 * `undefined`) is refused. A record that a loader could not parse, or that
 * would hash differently once re-read, never replaces the current file.
 */
export function writeStableJsonAtomic(path: string, value: unknown, options: WriteStableJsonAtomicOptions = {}): void {
  const { mode = 0o600 } = options;
  const serialized = canonicalJsonForWrite(path, value);
  const directory = dirname(path);
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${serialized}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

/**
 * {@link stableStringify} of `value`, checked to round-trip: it parses, and the
 * parsed value serializes to the same bytes. Throws (writing nothing) otherwise.
 */
function canonicalJsonForWrite(path: string, value: unknown): string {
  const serialized = stableStringify(value);
  if (serialized === undefined) throw new Error(`refusing to write ${path}: the value has no JSON representation`);
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(`refusing to write ${path}: its serialization is not valid JSON`, { cause: error });
  }
  if (stableStringify(reparsed) !== serialized) {
    throw new Error(`refusing to write ${path}: its serialization does not round-trip`);
  }
  return serialized;
}

/** Reject a host path that is not absolute and already canonical (`resolve(path) === path`). */
export function assertCanonicalHostPath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be canonical and absolute`);
}

// ── Package-shipped assets ────────────────────────────────────────────

/**
 * The passwd(5) and group(5) text behind the private-group rule of
 * {@link readPackageAsset}. Production reads the host's `/etc/passwd` and
 * `/etc/group`; tests inject a fixed database.
 */
export interface AccountDatabase {
  readonly passwd: string;
  readonly group: string;
}

interface PackageAssetRootOptions {
  /**
   * Root of the package the asset ships in: the directory the running code was
   * itself loaded from (`getIronCurtainPackageRoot()` in production). The asset
   * must lie below it, every directory from the asset's own up to and including
   * this root is checked, and the root's owner is trusted like the current user
   * because it controls that code anyway.
   */
  readonly packageRoot: string;
  /**
   * Account database for the private-group rule. Defaults to the host's
   * `/etc/passwd` and `/etc/group`, read only when a group-writable entry is
   * found. Tests inject one so the outcome does not depend on the runner.
   */
  readonly accounts?: AccountDatabase;
}

export interface ReadPackageAssetOptions extends ReadHardenedFileOptions, PackageAssetRootOptions {}

export interface LoadPackageAssetJsonOptions<T> extends LoadImmutableHostJsonOptions<T>, PackageAssetRootOptions {}

const ACCOUNT_DATABASE_MAX_BYTES = 16 * 1024 * 1024;
const NUMERIC_ACCOUNT_ID = /^\d{1,10}$/u;

/**
 * Read a file that ships inside a package (a frozen manifest, a packaged
 * binary) through one `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` descriptor.
 *
 * The final component must not be a symlink, and the opened object must be a
 * regular file within `[minBytes, maxBytes]`. The file, and every directory
 * from its own up to and including `packageRoot` (both resolved canonically;
 * the asset must lie below the root), must pass OpenSSH StrictModes-like rules:
 *
 * - owned by root, the effective user, or the owner of the package root;
 * - never world-writable;
 * - group-writable only when the group is the owner's user-private group (see
 *   {@link isUserPrivateGroup}), so the group bits give no one else write
 *   access (but see the limits below).
 *
 * So an install made under umask 002 (0664 files, 0775 directories, a private
 * group) is accepted, while an asset whose owner or mode bits let another
 * local user rewrite or replace it is refused. Errors name the offending path
 * and, for a mode problem, the `chmod` that fixes it. The descriptor serves the
 * stat and the read, and on Linux it is re-located afterwards, so a rename
 * during the checks is detected. Host state that IronCurtain writes itself
 * keeps the strict {@link readHardenedFile}.
 *
 * Limits, as with StrictModes: only owners and mode bits are checked. Access
 * control lists are not read (Node exposes no xattr API). On Linux, an ACL
 * entry that gives a named user or group write access shows in the mode only
 * as the group (mask) bits. Such an asset passes when its owning group is
 * private, although the strict test would refuse it. Only the owner or root can
 * set an ACL on these entries, possibly through a default ACL inherited from a
 * parent directory. Extended ACLs on macOS never show in the mode. The account
 * files also do not show accounts that only a network directory defines, for
 * example an LDAP user whose primary group has the same gid. In each of these
 * cases the code that ships next to the asset carries the same grants, so this
 * check cannot protect the package's integrity there.
 */
export function readPackageAsset(path: string, options: ReadPackageAssetOptions): Buffer {
  const { label, minBytes, maxBytes, packageRoot } = options;
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  if (!isAbsolute(packageRoot)) throw new Error(`${label} package root must be absolute: ${packageRoot}`);
  const euid = process.geteuid?.();
  if (euid === undefined) throw new Error(`${label} ownership cannot be checked on this platform: ${path}`);

  let realRoot: string;
  let realDirectory: string;
  try {
    realRoot = realpathSync(packageRoot);
    realDirectory = realpathSync(dirname(path));
  } catch (error) {
    throw new Error(`${label} must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  if (!isCanonicalPathWithin(realDirectory, realRoot)) {
    throw new Error(`${label} must ship inside the package root ${realRoot}: ${path}`);
  }
  const canonicalPath = join(realDirectory, basename(path));

  let descriptor: number;
  try {
    descriptor = openSync(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY,
    );
  } catch (error) {
    throw new Error(`${label} must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    const trust: PackageTrust = {
      label,
      euid,
      extraOwners: [{ uid: lstatPackageDirectory(realRoot, label).uid, description: 'the package owner' }],
      accounts: accountDatabaseLoader(options.accounts),
    };
    assertTrustedPackageEntry(trust, stats, path, 'file');
    let directory = realDirectory;
    for (;;) {
      assertTrustedPackageEntry(trust, lstatPackageDirectory(directory, label), directory, 'directory');
      if (directory === realRoot) break;
      const parent = dirname(directory);
      // Unreachable while realDirectory lies inside realRoot; never stop short of the root silently.
      if (parent === directory) throw new Error(`${label} is not below the package root ${realRoot}: ${path}`);
      directory = parent;
    }
    if (stats.size < minBytes || stats.size > maxBytes) {
      throw new Error(`${label} size is outside the allowed range: ${stats.size}`);
    }
    // The size above can be stale; the bounded read is authoritative.
    const bytes = readAtMost(descriptor, maxBytes + 1);
    if (bytes.length < minBytes || bytes.length > maxBytes) {
      throw new Error(`${label} size is outside the allowed range: ${bytes.length}`);
    }
    const located = descriptorPath(descriptor);
    if (located !== undefined && located !== canonicalPath) {
      throw new Error(`${label} was moved while it was being read: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * {@link loadImmutableHostJson} for a JSON record that ships in the package:
 * the bytes come from {@link readPackageAsset} and are then hashed, parsed and
 * schema-validated the same way.
 */
export function loadPackageAssetJson<T>(
  path: string,
  options: LoadPackageAssetJsonOptions<T>,
): LoadedImmutableHostJson<T> {
  const { label, schema, maxBytes, minBytes = 2, packageRoot, accounts } = options;
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const bytes = readPackageAsset(path, { label, minBytes, maxBytes, packageRoot, accounts });
  return parseImmutableJson(path, bytes, label, schema);
}

/** A principal trusted like the current user, as error messages name it. */
export interface TrustedOwner {
  readonly uid: number;
  /** e.g. "the package owner", "the owner of the IronCurtain home". */
  readonly description: string;
}

export interface ReadOwnedRegularFileOptions extends ReadHardenedFileOptions {
  /** Owners trusted besides root and the effective user. */
  readonly trustedOwners?: readonly TrustedOwner[];
  /** Account database for the private-group rule (default: the host's, read only when needed). */
  readonly accounts?: AccountDatabase;
}

/**
 * Read a file that IronCurtain wrote or shipped and that decides what an agent
 * may do (a compiled policy, say) through one `O_RDONLY | O_NOFOLLOW |
 * O_NONBLOCK` descriptor. The final component must not be a symlink, the
 * opened object must be a regular file within `[minBytes, maxBytes]`, and the
 * file itself must pass the ownership and mode rules of
 * {@link readPackageAsset}: owned by root, the effective user or one of
 * `trustedOwners`, never world-writable, group-writable only for the owner's
 * private group (so a umask 002 install or pipeline output is accepted). The
 * directories above it are not checked here; check them once with
 * {@link assertTrustedDirectoryChain} where the directory is chosen.
 */
export function readOwnedRegularFile(path: string, options: ReadOwnedRegularFileOptions): Buffer {
  const { label, minBytes, maxBytes } = options;
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const euid = process.geteuid?.();
  if (euid === undefined) throw new Error(`${label} ownership cannot be checked on this platform: ${path}`);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    throw Object.assign(new Error(`${label} must be a readable regular non-symlink file: ${path}`, { cause: error }), {
      code: errnoCode(error),
    });
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    assertTrustedPackageEntry(
      {
        label,
        euid,
        extraOwners: options.trustedOwners ?? [],
        accounts: accountDatabaseLoader(options.accounts),
      },
      stats,
      path,
      'file',
    );
    const bytes = readAtMost(descriptor, maxBytes + 1);
    if (bytes.length < minBytes || bytes.length > maxBytes) {
      throw new Error(`${label} size is outside the allowed range: ${bytes.length}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export interface TrustedDirectoryChainOptions {
  /** Message prefix reproducing the caller's exact error strings. */
  readonly label: string;
  /**
   * The trusted root: the directory must lie at or below it, every directory
   * from it up to and including the root is checked, and the root's owner is
   * trusted like the current user (it controls everything below anyway).
   */
  readonly root: string;
  /** How messages name the root, e.g. "the IronCurtain home" ("owned by ... the owner of <this>"). */
  readonly rootDescription: string;
  /** Account database for the private-group rule (default: the host's, read only when needed). */
  readonly accounts?: AccountDatabase;
}

/**
 * Assert that `directory` and every directory above it, up to and including
 * `root`, pass the ownership and mode rules of {@link readPackageAsset} (owned
 * by root, the effective user or the root's owner; never world-writable;
 * group-writable only for the owner's private group), so no other local user
 * can replace a file in it. Both paths are resolved canonically first, and
 * `directory` must lie at or below `root`.
 */
export function assertTrustedDirectoryChain(directory: string, options: TrustedDirectoryChainOptions): void {
  const { label, root } = options;
  const euid = process.geteuid?.();
  if (euid === undefined) throw new Error(`${label} ownership cannot be checked on this platform: ${directory}`);
  let realRoot: string;
  let realDirectory: string;
  try {
    realRoot = realpathSync(root);
    realDirectory = realpathSync(directory);
  } catch (error) {
    throw new Error(`${label} directory cannot be checked: ${directory}`, { cause: error });
  }
  if (!isCanonicalPathWithin(realDirectory, realRoot)) {
    throw new Error(`${label} is not below ${realRoot}: ${directory}`);
  }
  const trust: PackageTrust = {
    label,
    euid,
    extraOwners: [
      { uid: lstatPackageDirectory(realRoot, label).uid, description: `the owner of ${options.rootDescription}` },
    ],
    accounts: accountDatabaseLoader(options.accounts),
  };
  let current = realDirectory;
  for (;;) {
    assertTrustedPackageEntry(trust, lstatPackageDirectory(current, label), current, 'directory');
    if (current === realRoot) return;
    const parent = dirname(current);
    // Unreachable while realDirectory lies inside realRoot; never stop short of the root silently.
    if (parent === current) throw new Error(`${label} is not below ${realRoot}: ${directory}`);
    current = parent;
  }
}

/**
 * True when `gid` is the user-private group of the account `uid` in
 * `accounts`: it is that account's primary group (passwd(5)), no other
 * account has it as its primary group, and group(5) has exactly one entry for
 * it, whose supplementary members, if any, are names of that same account.
 *
 * Anything the two files cannot settle counts as not private, so callers fail
 * closed: NIS `+`/`-` compat lines, a malformed line, an unknown member name,
 * duplicate group entries, a missing entry. Accounts known only to a network
 * directory (LDAP, sssd, systemd-homed) are therefore never private here.
 */
export function isUserPrivateGroup(uid: number, gid: number, accounts: AccountDatabase): boolean {
  const users = parseAccountFile(accounts.passwd, 4, [2, 3]);
  const groups = parseAccountFile(accounts.group, 3, [2]);
  if (users === undefined || groups === undefined) return false;

  const uidsByName = new Map<string, Set<number>>();
  let ownersPrimaryGroup = false;
  for (const fields of users) {
    const userId = Number(fields[2]);
    const ids = uidsByName.get(fields[0]) ?? new Set<number>();
    ids.add(userId);
    uidsByName.set(fields[0], ids);
    if (Number(fields[3]) === gid) {
      // Another account's primary group is shared, whatever group(5) says.
      if (userId !== uid) return false;
      ownersPrimaryGroup = true;
    }
  }
  if (!ownersPrimaryGroup) return false;

  const entries = groups.filter((fields) => Number(fields[2]) === gid);
  if (entries.length !== 1) return false;
  const members = (entries[0].at(3) ?? '')
    .split(',')
    .map((member) => member.trim())
    .filter((member) => member !== '');
  return members.every((member) => {
    const ids = uidsByName.get(member);
    return ids !== undefined && ids.size === 1 && ids.has(uid);
  });
}

interface PackageTrust {
  readonly label: string;
  readonly euid: number;
  /** Owners trusted besides root and the effective user (the package owner), as messages name them. */
  readonly extraOwners: readonly { readonly uid: number; readonly description: string }[];
  readonly accounts: () => AccountDatabase | undefined;
}

/** Apply the ownership and mode rules of {@link readPackageAsset} to one file or directory. */
function assertTrustedPackageEntry(
  trust: PackageTrust,
  stats: Stats,
  entryPath: string,
  kind: 'file' | 'directory',
): void {
  const { label, euid, extraOwners } = trust;
  const where = kind === 'file' ? `${label} is` : `${label} is in a directory`;
  if (stats.uid !== 0 && stats.uid !== euid && !extraOwners.some((owner) => owner.uid === stats.uid)) {
    const trusted = [
      'root',
      `the current user (uid ${euid})`,
      ...extraOwners.map((owner) => `${owner.description} (uid ${owner.uid})`),
    ];
    throw new Error(
      `${where} owned by uid ${stats.uid}, not by ${trusted.slice(0, -1).join(', ')} or ${trusted.at(-1) ?? ''}: ${entryPath}`,
    );
  }
  if ((stats.mode & 0o002) !== 0) {
    const what = kind === 'file' ? `${label} must not be world-writable` : `${label} is in a world-writable directory`;
    throw new Error(`${what}: ${entryPath}. Fix it with: chmod o-w ${shellWordForDisplay(entryPath)}`);
  }
  if ((stats.mode & 0o020) !== 0) {
    const accounts = trust.accounts();
    if (accounts === undefined || !isUserPrivateGroup(stats.uid, stats.gid, accounts)) {
      const what = kind === 'file' ? `${label} is group-writable` : `${label} is in a group-writable directory`;
      throw new Error(
        `${what} and its group (gid ${stats.gid}) is not the private group of its owner (uid ${stats.uid}): ${entryPath}. Fix it with: chmod g-w ${shellWordForDisplay(entryPath)}`,
      );
    }
  }
}

function lstatPackageDirectory(directory: string, label: string): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(directory);
  } catch (error) {
    throw new Error(`${label} directory cannot be checked: ${directory}`, { cause: error });
  }
  if (!stats.isDirectory()) throw new Error(`${label} directory is not a real directory: ${directory}`);
  return stats;
}

/** The injected database, or the host's read at most once and only on first use. */
function accountDatabaseLoader(injected: AccountDatabase | undefined): () => AccountDatabase | undefined {
  if (injected !== undefined) return () => injected;
  let host: { readonly value: AccountDatabase | undefined } | undefined;
  return () => (host ??= { value: readHostAccountDatabase() }).value;
}

/**
 * The host's `/etc/passwd` and `/etc/group`, for {@link isUserPrivateGroup};
 * undefined when either cannot be read (callers then treat group write as
 * unprovable, failing closed).
 */
export function readHostAccountDatabase(): AccountDatabase | undefined {
  try {
    return { passwd: readSystemTextFile('/etc/passwd'), group: readSystemTextFile('/etc/group') };
  } catch {
    // Without the account files group ownership is unprovable, so group write is refused.
    return undefined;
  }
}

/**
 * Bounded read of a root-maintained text file. Symlinks are followed (some
 * distributions link `/etc/passwd`); a FIFO or device is refused without blocking.
 */
function readSystemTextFile(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`not a regular file: ${path}`);
    const bytes = readAtMost(descriptor, ACCOUNT_DATABASE_MAX_BYTES + 1);
    if (bytes.length > ACCOUNT_DATABASE_MAX_BYTES) throw new Error(`too large: ${path}`);
    return bytes.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Split passwd(5)/group(5) text into colon-separated fields, skipping blank
 * and `#` lines. Returns undefined for a NIS compat line or a line with fewer
 * than `minFields` fields or a non-numeric ID, since membership is then unknown.
 */
function parseAccountFile(
  text: string,
  minFields: number,
  numericFields: readonly number[],
): readonly (readonly string[])[] | undefined {
  const entries: string[][] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('+') || line.startsWith('-')) return undefined;
    const fields = line.split(':');
    if (fields.length < minFields || fields[0] === '') return undefined;
    if (numericFields.some((index) => !NUMERIC_ACCOUNT_ID.test(fields.at(index) ?? ''))) return undefined;
    entries.push(fields);
  }
  return entries;
}

/** Quote a path for a copy-pasteable shell hint. Display only: nothing here is executed. */
function shellWordForDisplay(path: string): string {
  return /^[\w@%+=:,./-]+$/u.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

// ── Untrusted (agent-writable) paths ──────────────────────────────────

export type UntrustedFileErrorCode =
  /** The path is not absolute, or a name is not a single plain path component. */
  | 'INVALID_PATH'
  /** Nothing exists at the path (or a parent component is missing or not a directory). */
  | 'NOT_FOUND'
  /** The final component is a symbolic link. */
  | 'SYMLINK'
  /** The entry is a FIFO, socket, device or directory, not a regular file. */
  | 'NOT_REGULAR_FILE'
  /** The directory argument is not a real directory (missing, a symlink, or another type). */
  | 'NOT_DIRECTORY'
  /** The regular file has more than one hard link, so writing it would change another path too. */
  | 'HARD_LINKED'
  /** The file is, or would become, larger than the caller's byte limit. */
  | 'TOO_LARGE'
  /** The entry was replaced between the check and the use. */
  | 'CHANGED'
  /** A directory component resolves outside the trusted root (the `*Below` helpers only). */
  | 'OUTSIDE_ROOT'
  /** Any other filesystem error (permissions, I/O); `cause` holds the original error. */
  | 'IO_ERROR';

/**
 * Error raised by the untrusted-path helpers. Catch on `code` rather than
 * `instanceof` so a catcher in another layer need not import this module.
 * `path` and the message can contain agent-chosen names: sanitize them before
 * showing them on a terminal.
 */
export class UntrustedFileError extends Error {
  readonly code: UntrustedFileErrorCode;
  readonly path: string;

  constructor(code: UntrustedFileErrorCode, path: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UntrustedFileError';
    this.code = code;
    this.path = path;
  }
}

export interface ReadUntrustedRegularFileOptions {
  /** Largest accepted file size in bytes. At most `maxBytes + 1` bytes are ever read. */
  readonly maxBytes: number;
  /**
   * What to do with a file larger than `maxBytes`: `'error'` (default) throws
   * `TOO_LARGE`; `'truncate'` returns the first `maxBytes` bytes with
   * `truncated: true`.
   */
  readonly oversize?: 'error' | 'truncate';
}

export interface UntrustedFileContents {
  readonly bytes: Buffer;
  /** True only in `'truncate'` mode, when the file held more than `maxBytes` bytes. */
  readonly truncated: boolean;
}

/** Device and inode of the file a descriptor read, as `fstat` reported them. */
export interface UntrustedFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface IdentifiedUntrustedFileContents extends UntrustedFileContents {
  /** Identity of the file that was actually read (see {@link readIdentifiedUntrustedRegularFile}). */
  readonly identity: UntrustedFileIdentity;
}

export interface AppendRegularFileNoFollowOptions {
  /** Refuse (`TOO_LARGE`) when the file would grow beyond this many bytes, existing content included. */
  readonly maxBytes: number;
  /**
   * Create the file when nothing exists at the path. It is created exclusively
   * (`O_CREAT | O_EXCL`), so an entry that appears concurrently, including a
   * dangling symlink, makes the call fail instead of being followed. Default false.
   */
  readonly create?: boolean;
  /** Permission bits for a newly created file (default 0o600). */
  readonly mode?: number;
}

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_NAME_BYTES = 255;
const TEMPORARY_PREFIX = '.ironcurtain-tmp-';
const TEMPORARY_NAME_RE = /^\.ironcurtain-tmp-[0-9a-f]{24}\.tmp$/u;

/**
 * True when `name` has the shape of the temporary file
 * {@link writeFileNoFollowAtomic} creates next to its target. Such a file
 * outlives its write only when the process died mid-write (every failure path
 * removes it), so a caller that owns a directory may sweep old ones.
 */
export function isNoFollowAtomicTempName(name: string): boolean {
  return TEMPORARY_NAME_RE.test(name);
}

function untrustedError(
  code: UntrustedFileErrorCode,
  path: string,
  message: string,
  cause?: unknown,
): UntrustedFileError {
  return new UntrustedFileError(code, path, message, cause === undefined ? undefined : { cause });
}

/** Keep an {@link UntrustedFileError}; wrap anything else (EIO, EAGAIN, ...) as `IO_ERROR`. */
function asUntrustedError(error: unknown, path: string, message: string): UntrustedFileError {
  return error instanceof UntrustedFileError ? error : untrustedError('IO_ERROR', path, message, error);
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** Map an `open`/`lstat` errno to a discriminant. */
function codeForErrno(error: unknown): UntrustedFileErrorCode {
  switch (errnoCode(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'NOT_FOUND';
    case 'ELOOP': // O_NOFOLLOW on a symlink (Linux, macOS)
    case 'EMLINK': // O_NOFOLLOW on a symlink (FreeBSD)
      return 'SYMLINK';
    case 'ENXIO': // a socket, or a FIFO opened for writing without a reader
    case 'ENODEV':
    case 'EISDIR':
      return 'NOT_REGULAR_FILE';
    default:
      return 'IO_ERROR';
  }
}

function assertAbsolutePath(path: string, operation: string): void {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw untrustedError('INVALID_PATH', path, `${operation} requires an absolute path: ${path}`);
  }
}

function assertByteLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer: ${value}`);
  }
  return value;
}

function assertFileMode(mode: number): number {
  // Plain permission bits only: never setuid, setgid or sticky on an agent-visible file.
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new RangeError(`file mode must be within 0o000-0o777: ${mode}`);
  }
  return mode;
}

/** lstat the final component without following it; fail on a symlink or non-regular entry. */
function lstatRegularFile(path: string): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw untrustedError(codeForErrno(error), path, `cannot stat ${path}`, error);
  }
  if (stats.isSymbolicLink()) throw untrustedError('SYMLINK', path, `refusing to follow a symlink: ${path}`);
  if (!stats.isFile()) throw untrustedError('NOT_REGULAR_FILE', path, `not a regular file: ${path}`);
  return stats;
}

function openUntrusted(path: string, flags: number, mode?: number): number {
  try {
    return openSync(path, flags, mode);
  } catch (error) {
    throw untrustedError(codeForErrno(error), path, `cannot open ${path} without following links`, error);
  }
}

/** Read at most `limit` bytes from the start of `descriptor`. */
function readAtMost(descriptor: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, limit - total));
    const count = readSync(descriptor, chunk, 0, chunk.length, total);
    if (count === 0) break;
    chunks.push(count === chunk.length ? chunk : chunk.subarray(0, count));
    total += count;
  }
  return Buffer.concat(chunks, total);
}

function writeAll(descriptor: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    offset += writeSync(descriptor, payload, offset, payload.length - offset);
  }
}

function toBuffer(data: string | Uint8Array): Buffer {
  return typeof data === 'string'
    ? Buffer.from(data, 'utf8')
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Read a file in an agent-writable location without following a symlink,
 * without blocking, and without reading more than `maxBytes + 1` bytes.
 *
 * The final component is opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK |
 * O_NOCTTY` (close-on-exec), and the opened object must `fstat` as a regular
 * file, so a symlink (`SYMLINK`), FIFO, socket, device or directory
 * (`NOT_REGULAR_FILE`) is refused without ever blocking the event loop, and a
 * swap after the `lstat` pre-check cannot redirect the read. The stat and the
 * read use the same descriptor. A file larger than `maxBytes` throws
 * `TOO_LARGE` unless `oversize: 'truncate'` is given. Modes and ownership are
 * not checked (see the module comment).
 */
export function readUntrustedRegularFile(
  path: string,
  options: ReadUntrustedRegularFileOptions,
): UntrustedFileContents {
  const { bytes, truncated } = readUntrustedRegularFileWithIdentity(path, options, 'readUntrustedRegularFile');
  return { bytes, truncated };
}

/**
 * {@link readUntrustedRegularFile}, also returning the device and inode of the
 * file the descriptor actually read.
 *
 * `O_NOFOLLOW` covers only the final component: a parent directory the agent
 * swaps for a symlink between a caller's containment check and the open
 * redirects the read elsewhere. A caller that must know the bytes came from
 * inside a directory the agent controls therefore checks, after the read, that
 * the path still resolves (`realpath`) to the place it vetted and that `lstat`
 * of it reports this identity. A swap before the open is then detected whether
 * or not it was swapped back afterwards.
 */
export function readIdentifiedUntrustedRegularFile(
  path: string,
  options: ReadUntrustedRegularFileOptions,
): IdentifiedUntrustedFileContents {
  return readUntrustedRegularFileWithIdentity(path, options, 'readIdentifiedUntrustedRegularFile');
}

function readUntrustedRegularFileWithIdentity(
  path: string,
  options: ReadUntrustedRegularFileOptions,
  operation: string,
): IdentifiedUntrustedFileContents {
  assertAbsolutePath(path, operation);
  const maxBytes = assertByteLimit(options.maxBytes, 'maxBytes');
  const truncate = options.oversize === 'truncate';
  // Cheap pre-check: a FIFO or device that is already in place is never opened.
  lstatRegularFile(path);
  const descriptor = openUntrusted(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY,
  );
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw untrustedError('NOT_REGULAR_FILE', path, `not a regular file: ${path}`);
    const identity: UntrustedFileIdentity = { dev: stats.dev, ino: stats.ino };
    return { ...readBoundedRegularFile(descriptor, stats, path, maxBytes, truncate), identity };
  } catch (error) {
    throw asUntrustedError(error, path, `cannot read ${path}`);
  } finally {
    closeSync(descriptor);
  }
}

/** The size-capped read shared by the untrusted read helpers; `stats` is the descriptor's fstat. */
function readBoundedRegularFile(
  descriptor: number,
  stats: Stats,
  path: string,
  maxBytes: number,
  truncate: boolean,
): UntrustedFileContents {
  if (!truncate && stats.size > maxBytes) {
    throw untrustedError('TOO_LARGE', path, `file exceeds ${maxBytes} bytes: ${path}`);
  }
  // The size above can be stale; the bounded read is authoritative.
  const bytes = readAtMost(descriptor, maxBytes + 1);
  if (bytes.length <= maxBytes) return { bytes, truncated: false };
  if (!truncate) throw untrustedError('TOO_LARGE', path, `file exceeds ${maxBytes} bytes: ${path}`);
  return { bytes: bytes.subarray(0, maxBytes), truncated: true };
}

/**
 * {@link codeForErrno} for a lookup that follows symlinks: there `ELOOP` means a
 * symlink loop, not a refused final link, so it is an `IO_ERROR`.
 */
function codeForFollowingErrno(error: unknown): UntrustedFileErrorCode {
  const code = codeForErrno(error);
  return code === 'SYMLINK' ? 'IO_ERROR' : code;
}

/**
 * Read a regular file named by a path whose symbolic links are legitimate (a
 * workflow manifest a user names, the definition a run record names, a user's
 * own skill), without blocking and without reading more than `maxBytes + 1`
 * bytes.
 *
 * Unlike {@link readUntrustedRegularFile}, links are followed, the final one
 * included, so this is no containment check: use it only where any regular file
 * the path leads to is acceptable. What it refuses is anything else. The target
 * is stat-ed first, so a FIFO, socket, device or directory already in place
 * (`NOT_REGULAR_FILE`) is never opened; the open is `O_RDONLY | O_NONBLOCK |
 * O_NOCTTY` (close-on-exec) and the descriptor must `fstat` as a regular file,
 * so one swapped in after the stat cannot block the event loop either. The
 * stat and the read use the same descriptor. A file larger than `maxBytes`
 * throws `TOO_LARGE` unless `oversize: 'truncate'` is given; a missing path is
 * `NOT_FOUND` and a relative one `INVALID_PATH`.
 */
export function readRegularFileFollowingLinks(
  path: string,
  options: ReadUntrustedRegularFileOptions,
): UntrustedFileContents {
  assertAbsolutePath(path, 'readRegularFileFollowingLinks');
  const maxBytes = assertByteLimit(options.maxBytes, 'maxBytes');
  const truncate = options.oversize === 'truncate';
  let target: Stats;
  try {
    target = statSync(path);
  } catch (error) {
    throw untrustedError(codeForFollowingErrno(error), path, `cannot stat ${path}`, error);
  }
  if (!target.isFile()) throw untrustedError('NOT_REGULAR_FILE', path, `not a regular file: ${path}`);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    throw untrustedError(codeForFollowingErrno(error), path, `cannot open ${path}`, error);
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw untrustedError('NOT_REGULAR_FILE', path, `not a regular file: ${path}`);
    return readBoundedRegularFile(descriptor, stats, path, maxBytes, truncate);
  } catch (error) {
    throw asUntrustedError(error, path, `cannot read ${path}`);
  } finally {
    closeSync(descriptor);
  }
}

function assertPlainName(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES
  ) {
    throw untrustedError('INVALID_PATH', name, `not a single plain file name: ${JSON.stringify(name)}`);
  }
}

/** lstat a directory argument: it must exist and be a real directory, not a symlink to one. */
function lstatRealDirectory(dir: string): Stats {
  let stats: Stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    throw untrustedError('NOT_DIRECTORY', dir, `not a directory: ${dir}`, error);
  }
  if (!stats.isDirectory()) {
    throw untrustedError('NOT_DIRECTORY', dir, `not a real directory (symlink or other type): ${dir}`);
  }
  return stats;
}

function sameEntry(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Best-effort directory fsync so the rename itself is durable. */
function fsyncDirectoryBestEffort(dir: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } catch {
    // Some filesystems refuse directory fsync; the file data itself is already synced.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Atomically replace `<dir>/<name>` with `data` without ever writing through
 * whatever is at that name.
 *
 * The bytes go to a fresh randomly named temporary file created exclusively
 * (`O_CREAT | O_EXCL | O_NOFOLLOW`, i.e. `'wx'`) in `dir`, which is fsynced and
 * given exactly `mode`, and then renamed over `name`. A rename replaces the
 * directory entry itself, so a symlink (absolute, relative or dangling), FIFO,
 * socket or hard link at `name` is replaced and its target is never touched or
 * opened. A directory at `name` makes the call fail (`NOT_REGULAR_FILE`) and is
 * left intact. `dir` must be a real directory (`NOT_DIRECTORY` for a symlink),
 * and it must still be the same directory just before the rename (`CHANGED`).
 * The temporary file is removed on every failure path.
 */
export function writeFileNoFollowAtomic(dir: string, name: string, data: string | Uint8Array, mode = 0o600): void {
  assertAbsolutePath(dir, 'writeFileNoFollowAtomic');
  assertPlainName(name);
  const fileMode = assertFileMode(mode);
  const directoryBefore = lstatRealDirectory(dir);
  const target = join(dir, name);
  const temporary = join(dir, `${TEMPORARY_PREFIX}${randomBytes(12).toString('hex')}.tmp`);

  let descriptor: number | undefined;
  let created = false;
  let renamed = false;
  try {
    descriptor = openUntrusted(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NOCTTY,
      0o600,
    );
    created = true;
    try {
      writeAll(descriptor, toBuffer(data));
      fchmodSync(descriptor, fileMode);
      fsyncSync(descriptor);
    } catch (error) {
      throw untrustedError('IO_ERROR', temporary, `cannot write temporary file for ${target}`, error);
    }
    closeSync(descriptor);
    descriptor = undefined;

    let directoryNow: Stats;
    try {
      directoryNow = lstatSync(dir);
    } catch (error) {
      throw untrustedError('CHANGED', dir, `directory changed during write: ${dir}`, error);
    }
    if (!directoryNow.isDirectory() || !sameEntry(directoryBefore, directoryNow)) {
      throw untrustedError('CHANGED', dir, `directory changed during write: ${dir}`);
    }

    try {
      renameSync(temporary, target);
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'EISDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') {
        throw untrustedError('NOT_REGULAR_FILE', target, `a directory occupies ${target}`, error);
      }
      throw untrustedError('IO_ERROR', target, `cannot rename into ${target}`, error);
    }
    renamed = true;
    fsyncDirectoryBestEffort(dir);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created && !renamed) {
      try {
        // unlink removes the entry itself, even if it was swapped for a symlink.
        unlinkSync(temporary);
      } catch {
        // Already gone or replaced by a directory: nothing of ours to remove.
      }
    }
  }
}

/**
 * Append `data` to an existing regular file in an agent-writable location
 * without following links, blocking, or growing it past `maxBytes`.
 *
 * An `lstat` pre-check refuses a symlink or non-regular entry before anything
 * is opened. The file is then opened `O_WRONLY | O_APPEND | O_NOFOLLOW |
 * O_NONBLOCK | O_NOCTTY` and the descriptor must `fstat` as a regular file
 * with exactly one link (`HARD_LINKED` otherwise: appending would also change
 * the other name). The path must still name the same device/inode right before
 * writing (`CHANGED`), and the existing size plus `data` must not exceed
 * `maxBytes` (`TOO_LARGE`). All bytes are written through the checked
 * descriptor. Not fsynced. With `create`, a missing file is created
 * exclusively with `mode`.
 */
export function appendRegularFileNoFollow(
  path: string,
  data: string | Uint8Array,
  options: AppendRegularFileNoFollowOptions,
): void {
  assertAbsolutePath(path, 'appendRegularFileNoFollow');
  const maxBytes = assertByteLimit(options.maxBytes, 'maxBytes');
  const mode = assertFileMode(options.mode ?? 0o600);
  const payload = toBuffer(data);
  // Refuse before anything is opened or created, so a failed call leaves no empty file behind.
  if (payload.length > maxBytes) {
    throw untrustedError('TOO_LARGE', path, `appending would grow ${path} beyond ${maxBytes} bytes`);
  }

  let exists = true;
  try {
    lstatRegularFile(path);
  } catch (error) {
    if (!(error instanceof UntrustedFileError && error.code === 'NOT_FOUND' && options.create === true)) throw error;
    exists = false;
  }

  const baseFlags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let descriptor: number;
  if (exists) {
    descriptor = openUntrusted(path, baseFlags | constants.O_NOCTTY);
  } else {
    try {
      descriptor = openSync(path, baseFlags | constants.O_NOCTTY | constants.O_CREAT | constants.O_EXCL, mode);
    } catch (error) {
      const code = errnoCode(error) === 'EEXIST' ? 'CHANGED' : codeForErrno(error);
      throw untrustedError(code, path, `cannot create ${path} exclusively`, error);
    }
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw untrustedError('NOT_REGULAR_FILE', path, `not a regular file: ${path}`);
    if (stats.nlink !== 1) {
      throw untrustedError(
        stats.nlink === 0 ? 'CHANGED' : 'HARD_LINKED',
        path,
        `refusing to append to a file with ${stats.nlink} links: ${path}`,
      );
    }
    if (stats.size + payload.length > maxBytes) {
      throw untrustedError('TOO_LARGE', path, `appending would grow ${path} beyond ${maxBytes} bytes`);
    }
    let current: Stats;
    try {
      current = lstatSync(path);
    } catch (error) {
      throw untrustedError('CHANGED', path, `file changed during append: ${path}`, error);
    }
    if (!current.isFile() || !sameEntry(stats, current)) {
      throw untrustedError('CHANGED', path, `file changed during append: ${path}`);
    }
    if (!exists) fchmodSync(descriptor, mode);
    writeAll(descriptor, payload);
  } catch (error) {
    throw asUntrustedError(error, path, `cannot append to ${path}`);
  } finally {
    closeSync(descriptor);
  }
}

// ── Untrusted paths below a trusted root ──────────────────────────────

export interface HashUntrustedRegularFileOptions {
  /** Largest accepted file size in bytes, enforced while reading (not only from fstat). */
  readonly maxBytes: number;
  /** A `node:crypto` hash algorithm name (default `'sha256'`). */
  readonly algorithm?: string;
}

export interface EnsureRealDirectoryResult {
  /** `<parent>/<name>`, now a real directory. */
  readonly path: string;
  /** True when this call created the directory. */
  readonly created: boolean;
  /** Where a non-directory entry previously at the name was moved, when one was. */
  readonly displacedTo?: string;
}

export interface CopyRegularFileBelowOptions {
  /** A separate, already realpath-canonical source root; defaults to the destination root. */
  readonly sourceRoot?: string;
  /** Largest accepted source size in bytes, enforced while copying (not only from fstat). */
  readonly maxBytes: number;
  /** Permission bits for the new file (default 0o600). */
  readonly mode?: number;
  /**
   * Create missing directories on the destination path with
   * {@link ensureDirectoryBelow}, after the source has been opened and
   * checked. Default false: a missing destination directory is `NOT_FOUND`.
   */
  readonly createParents?: boolean;
}

const DISPLACED_INFIX = '.ironcurtain-displaced-';
const MAX_ENSURE_DIRECTORY_ATTEMPTS = 4;

/** Split a `/`-separated relative path into plain components (`INVALID_PATH` otherwise). */
function relativeComponents(relativePath: string): string[] {
  const components = relativePath.split('/');
  try {
    for (const component of components) assertPlainName(component);
  } catch (error) {
    throw untrustedError(
      'INVALID_PATH',
      relativePath,
      `not a plain relative path: ${JSON.stringify(relativePath)}`,
      error,
    );
  }
  return components;
}

/** True when the canonical `candidate` is `root` or lies below it. */
function isCanonicalPathWithin(candidate: string, root: string): boolean {
  if (root === sep) return candidate.startsWith(sep);
  return candidate === root || candidate.startsWith(root + sep);
}

function realpathUntrusted(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw untrustedError(codeForErrno(error), path, `cannot resolve ${path}`, error);
  }
}

/**
 * The kernel's current path for an open descriptor (Linux `/proc/self/fd`), or
 * `undefined` where that is unavailable. A file unlinked after the open reads
 * back with a ` (deleted)` suffix, which keeps its directory prefix.
 */
function descriptorPath(descriptor: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return readlinkSync(`/proc/self/fd/${descriptor}`);
  } catch {
    return undefined;
  }
}

/**
 * Confirm that the file behind `descriptor` lies below `realRoot`. On Linux the
 * descriptor is located directly, so a directory component swapped for a
 * symlink between the containment check and the open is caught. Elsewhere the
 * name is re-resolved and must still lead, inside the root, to the same inode.
 */
function assertDescriptorBelow(
  descriptor: number,
  opened: Stats,
  realRoot: string,
  lexicalParent: string,
  name: string,
  displayPath: string,
): void {
  const located = descriptorPath(descriptor);
  if (located !== undefined) {
    if (!isCanonicalPathWithin(located, realRoot)) {
      throw untrustedError('OUTSIDE_ROOT', displayPath, `${displayPath} was opened outside ${realRoot}`);
    }
    return;
  }
  let parentNow: string;
  let entryNow: Stats;
  try {
    parentNow = realpathSync(lexicalParent);
    entryNow = lstatSync(join(parentNow, name));
  } catch (error) {
    throw untrustedError('CHANGED', displayPath, `${displayPath} changed while it was opened`, error);
  }
  if (!isCanonicalPathWithin(parentNow, realRoot)) {
    throw untrustedError('OUTSIDE_ROOT', displayPath, `${displayPath} resolves outside ${realRoot}`);
  }
  if (!sameEntry(opened, entryNow)) {
    throw untrustedError('CHANGED', displayPath, `${displayPath} changed while it was opened`);
  }
}

/**
 * Open `<root>/<relativePath>` for reading when, and only when, it is a regular
 * file whose directory components stay inside `root`. Returns the open
 * descriptor (the caller closes it) with its fstat. `knownRealRoot` lets a
 * caller that already resolved the (trusted) root skip resolving it again.
 */
function openRegularFileBelow(
  root: string,
  relativePath: string,
  operation: string,
  knownRealRoot?: string,
): { readonly descriptor: number; readonly stats: Stats; readonly path: string } {
  assertAbsolutePath(root, operation);
  const components = relativeComponents(relativePath);
  const lexicalPath = join(root, ...components);
  const lexicalParent = dirname(lexicalPath);
  const name = basename(lexicalPath);
  const realRoot = knownRealRoot ?? realpathUntrusted(root);
  const realParent = realpathUntrusted(lexicalParent);
  if (!isCanonicalPathWithin(realParent, realRoot)) {
    throw untrustedError('OUTSIDE_ROOT', lexicalPath, `${lexicalPath} resolves outside ${root}`);
  }
  const path = join(realParent, name);
  // Cheap pre-check: a FIFO or device that is already in place is never opened.
  lstatRegularFile(path);
  const descriptor = openUntrusted(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY,
  );
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw untrustedError('NOT_REGULAR_FILE', path, `not a regular file: ${path}`);
    assertDescriptorBelow(descriptor, stats, realRoot, lexicalParent, name, lexicalPath);
    return { descriptor, stats, path };
  } catch (error) {
    closeSync(descriptor);
    throw asUntrustedError(error, path, `cannot open ${path}`);
  }
}

/**
 * {@link readUntrustedRegularFile} for a file named by a `/`-separated path
 * below a trusted root directory whose subtree an agent can write.
 *
 * `root` is trusted (a host-chosen workspace or mount source; it may itself be
 * reached through a host symlink). Every directory component of
 * `relativePath` may be agent-controlled: the parent is realpath-resolved and
 * must stay inside `realpath(root)` (`OUTSIDE_ROOT` otherwise), the final
 * component is opened `O_NOFOLLOW | O_NONBLOCK` and must be a regular file,
 * and the opened descriptor is re-located below the root (see
 * `assertDescriptorBelow`). `relativePath` must be plain components joined by
 * `/` (no `.`, `..`, empty or absolute parts: `INVALID_PATH`). A missing file
 * or parent is `NOT_FOUND`.
 */
export interface ReadUntrustedRegularFileBelowOptions extends ReadUntrustedRegularFileOptions {
  /** Refuse a changed/aliased root instead of adopting its new canonical target. */
  readonly canonicalRoot?: boolean;
}

export function readUntrustedRegularFileBelow(
  root: string,
  relativePath: string,
  options: ReadUntrustedRegularFileBelowOptions,
): UntrustedFileContents {
  const maxBytes = assertByteLimit(options.maxBytes, 'maxBytes');
  const truncate = options.oversize === 'truncate';
  assertAbsolutePath(root, 'readUntrustedRegularFileBelow');
  if (options.canonicalRoot === true && realpathUntrusted(root) !== root) {
    throw untrustedError('OUTSIDE_ROOT', root, 'root must remain realpath-canonical');
  }
  const { descriptor, stats, path } = openRegularFileBelow(
    root,
    relativePath,
    'readUntrustedRegularFileBelow',
    options.canonicalRoot === true ? root : undefined,
  );
  try {
    return readBoundedRegularFile(descriptor, stats, path, maxBytes, truncate);
  } catch (error) {
    throw asUntrustedError(error, path, `cannot read ${path}`);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Hash a file below a trusted root (same containment and file-type rules as
 * {@link readUntrustedRegularFileBelow}) by streaming it through the hash in
 * fixed-size chunks, so memory stays bounded regardless of `maxBytes`. The cap
 * is enforced on the bytes actually read: a file that grows past `maxBytes`
 * after the fstat is still `TOO_LARGE`. Returns the hex digest.
 */
export function hashUntrustedRegularFileBelow(
  root: string,
  relativePath: string,
  options: HashUntrustedRegularFileOptions,
): string {
  const maxBytes = assertByteLimit(options.maxBytes, 'maxBytes');
  // An unknown algorithm throws here, before anything is opened.
  const hash = createHash(options.algorithm ?? 'sha256');
  const { descriptor, stats, path } = openRegularFileBelow(root, relativePath, 'hashUntrustedRegularFileBelow');
  try {
    if (stats.size > maxBytes) throw untrustedError('TOO_LARGE', path, `file exceeds ${maxBytes} bytes: ${path}`);
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), total);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw untrustedError('TOO_LARGE', path, `file exceeds ${maxBytes} bytes: ${path}`);
      hash.update(chunk.subarray(0, count));
    }
    return hash.digest('hex');
  } catch (error) {
    throw asUntrustedError(error, path, `cannot read ${path}`);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Move whatever is at `<dir>/<name>` (symlink, FIFO, socket, device, regular
 * file or directory) aside to a fresh `<name>.ironcurtain-displaced-<random>`
 * in the same directory. `rename(2)` acts on the entry itself, so a symlink is
 * moved, never followed, and nothing is opened. Returns the new path, or
 * `undefined` when nothing was at the name. `dir` must be a real directory.
 */
export function displaceEntryNoFollow(dir: string, name: string): string | undefined {
  assertAbsolutePath(dir, 'displaceEntryNoFollow');
  assertPlainName(name);
  lstatRealDirectory(dir);
  const from = join(dir, name);
  const suffix = `${DISPLACED_INFIX}${randomBytes(6).toString('hex')}`;
  const base = Buffer.byteLength(name, 'utf8') + suffix.length > MAX_NAME_BYTES ? 'entry' : name;
  const to = join(dir, `${base}${suffix}`);
  try {
    renameSync(from, to);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw untrustedError('IO_ERROR', from, `cannot move ${from} aside`, error);
  }
  return to;
}

/**
 * Make `<parent>/<name>` a real directory, creating it (with `mode`, filtered
 * by the umask like `mkdir(2)`) when absent. Anything else at the name, a
 * symlink to a directory included, is moved aside with
 * {@link displaceEntryNoFollow} first and reported in `displacedTo`; its
 * target is never touched. `parent` must be a real directory (`NOT_DIRECTORY`),
 * and must still be the same directory when the call returns (`CHANGED`). An
 * entry that keeps being replaced fails with `CHANGED` instead of looping.
 *
 * The usual no-`openat` caveat applies: a process that can write `parent` may
 * replace the directory again after this returns, so callers that then write
 * into it should use the no-follow helpers above.
 */
export function ensureRealDirectoryNoFollow(parent: string, name: string, mode = 0o777): EnsureRealDirectoryResult {
  assertAbsolutePath(parent, 'ensureRealDirectoryNoFollow');
  assertPlainName(name);
  const directoryMode = assertFileMode(mode);
  const parentBefore = lstatRealDirectory(parent);
  const target = join(parent, name);
  let created = false;
  let displacedTo: string | undefined;

  for (let attempt = 0; attempt < MAX_ENSURE_DIRECTORY_ATTEMPTS; attempt++) {
    let existing: Stats | undefined;
    try {
      existing = lstatSync(target);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        throw untrustedError(codeForErrno(error), target, `cannot stat ${target}`, error);
      }
    }

    if (existing === undefined) {
      try {
        mkdirSync(target, { mode: directoryMode });
        created = true;
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') {
          throw untrustedError(codeForErrno(error), target, `cannot create directory ${target}`, error);
        }
      }
      continue;
    }

    if (!existing.isDirectory()) {
      displacedTo = displaceEntryNoFollow(parent, name) ?? displacedTo;
      continue;
    }

    let parentNow: Stats;
    try {
      parentNow = lstatSync(parent);
    } catch (error) {
      throw untrustedError('CHANGED', parent, `directory changed: ${parent}`, error);
    }
    if (!parentNow.isDirectory() || !sameEntry(parentBefore, parentNow)) {
      throw untrustedError('CHANGED', parent, `directory changed: ${parent}`);
    }
    return { path: target, created, ...(displacedTo !== undefined ? { displacedTo } : {}) };
  }
  throw untrustedError('CHANGED', target, `${target} kept changing while it was being made a directory`);
}

/**
 * Make `<root>/<relativePath>` a real directory below a trusted root whose
 * subtree an agent can write, creating each missing component with `mkdir(2)`
 * (mode 0o777, filtered by the umask). A component that already exists must be
 * a real directory (`NOT_DIRECTORY` for a symlink or any other type), and a
 * component is only created after its parent's realpath has been checked to
 * lie inside `realpath(root)` (`OUTSIDE_ROOT`). `relativePath` follows the
 * rules of {@link readUntrustedRegularFileBelow}.
 *
 * The usual no-`openat` caveat applies to the `mkdir` itself: a parent swapped
 * for a symlink right after its check can at worst receive an empty directory.
 * Files are never written through this helper; {@link copyRegularFileBelow}
 * checks where each file it creates actually landed.
 */
export function ensureDirectoryBelow(root: string, relativePath: string): void {
  assertAbsolutePath(root, 'ensureDirectoryBelow');
  ensureDirectoryComponentsBelow(root, relativeComponents(relativePath));
}

/** {@link ensureDirectoryBelow} on validated components; the root is resolved only if something must be created. */
function ensureDirectoryComponentsBelow(root: string, components: readonly string[], knownRealRoot?: string): void {
  let realRoot = knownRealRoot;
  let current = root;
  for (const component of components) {
    const parent = current;
    current = join(current, component);
    let existing: Stats | undefined;
    try {
      existing = lstatSync(current);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        throw untrustedError(codeForErrno(error), current, `cannot stat ${current}`, error);
      }
    }
    if (existing === undefined) {
      realRoot ??= realpathUntrusted(root);
      const realParent = realpathUntrusted(parent);
      if (!isCanonicalPathWithin(realParent, realRoot)) {
        throw untrustedError('OUTSIDE_ROOT', current, `${current} resolves outside ${root}`);
      }
      try {
        mkdirSync(join(realParent, component));
        continue;
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') {
          throw untrustedError(codeForErrno(error), current, `cannot create directory ${current}`, error);
        }
      }
      // Created concurrently: accept it only if it is a real directory.
      existing = lstatRealDirectory(current);
    }
    if (!existing.isDirectory()) {
      throw untrustedError('NOT_DIRECTORY', current, `not a real directory (symlink or other type): ${current}`);
    }
  }
}

/**
 * Remove a file this module just created exclusively when its descriptor turns
 * out to lie outside the trusted root (a directory was swapped for a symlink
 * between the containment check and the `open`). Linux only: the descriptor is
 * located through `/proc/self/fd`, and the name is unlinked only while it
 * still refers to the same inode. Elsewhere the empty file is left in place.
 */
function removeCreatedOutsideRoot(descriptor: number, created: Stats): void {
  const located = descriptorPath(descriptor);
  if (located === undefined || located.endsWith(' (deleted)')) return;
  try {
    const current = lstatSync(located);
    if (current.isFile() && sameEntry(current, created)) unlinkSync(located);
  } catch {
    // Already gone or not reachable: nothing more to do.
  }
}

/**
 * Create `<root>/<relativePath>` as a new, empty regular file for writing.
 * The parent must realpath inside `root`, the file is created
 * `O_CREAT | O_EXCL | O_NOFOLLOW` (anything already at the name, including a
 * dangling symlink, is `CHANGED` and is never opened or written through), and
 * the new descriptor is re-located below the root before it is returned.
 */
function createRegularFileBelow(
  root: string,
  relativePath: string,
  operation: string,
  knownRealRoot?: string,
): { readonly descriptor: number; readonly path: string } {
  assertAbsolutePath(root, operation);
  const components = relativeComponents(relativePath);
  const lexicalPath = join(root, ...components);
  const lexicalParent = dirname(lexicalPath);
  const name = basename(lexicalPath);
  const realRoot = knownRealRoot ?? realpathUntrusted(root);
  const realParent = realpathUntrusted(lexicalParent);
  if (!isCanonicalPathWithin(realParent, realRoot)) {
    throw untrustedError('OUTSIDE_ROOT', lexicalPath, `${lexicalPath} resolves outside ${root}`);
  }
  const path = join(realParent, name);
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        constants.O_NOCTTY,
      0o600,
    );
  } catch (error) {
    const code = errnoCode(error) === 'EEXIST' ? 'CHANGED' : codeForErrno(error);
    throw untrustedError(code, path, `cannot create ${path} exclusively`, error);
  }
  let created: Stats | undefined;
  try {
    created = fstatSync(descriptor);
    assertDescriptorBelow(descriptor, created, realRoot, lexicalParent, name, lexicalPath);
    return { descriptor, path };
  } catch (error) {
    if (created !== undefined) removeCreatedOutsideRoot(descriptor, created);
    closeSync(descriptor);
    throw asUntrustedError(error, path, `cannot create ${path}`);
  }
}

/**
 * Copy the regular file `<root>/<sourcePath>` to a new file
 * `<root>/<destinationPath>` and return the number of bytes copied. Both paths
 * are below the trusted root unless `options.sourceRoot` names a separate
 * realpath-canonical source root. The same descriptor checks apply separately
 * to both roots, whose subtrees an agent can write.
 *
 * The source is opened like {@link readUntrustedRegularFileBelow} (parent
 * realpath-contained, `O_NOFOLLOW | O_NONBLOCK`, regular file, descriptor
 * re-located), so a symlink, FIFO or device is refused and a host file is never
 * read into the tree. It must not exceed `maxBytes` (`TOO_LARGE`, enforced on
 * the bytes actually read). The destination must not exist: it is created
 * exclusively and no-follow, so a symlink (dangling or not), FIFO or hard link
 * planted at the name fails the call with `CHANGED` instead of being written
 * through, and the new descriptor is re-located below the root before a byte
 * is written (`OUTSIDE_ROOT`; on Linux a file created through a directory
 * swapped for a symlink is removed again). Every byte goes through the two
 * checked descriptors. A failure after the destination was created leaves the
 * partial file in place: removing it by name could be redirected the same way.
 */
export function copyRegularFileBelow(
  root: string,
  sourcePath: string,
  destinationPath: string,
  options: CopyRegularFileBelowOptions,
): number {
  const maxBytes = assertByteLimit(options.maxBytes, 'maxBytes');
  const mode = assertFileMode(options.mode ?? 0o600);
  assertAbsolutePath(root, 'copyRegularFileBelow');
  const destinationComponents = relativeComponents(destinationPath);
  // Pin each accepted root once; each end still resolves its own parent.
  const realRoot = realpathUntrusted(root);
  const sourceRoot = options.sourceRoot ?? root;
  assertAbsolutePath(sourceRoot, 'copyRegularFileBelow');
  const realSourceRoot = options.sourceRoot === undefined ? realRoot : realpathUntrusted(sourceRoot);
  if (options.sourceRoot !== undefined && (sourceRoot !== realSourceRoot || root !== realRoot)) {
    throw untrustedError('OUTSIDE_ROOT', sourceRoot, 'separate copy roots must remain realpath-canonical');
  }
  const source = openRegularFileBelow(sourceRoot, sourcePath, 'copyRegularFileBelow', realSourceRoot);
  try {
    if (source.stats.size > maxBytes) {
      throw untrustedError('TOO_LARGE', source.path, `file exceeds ${maxBytes} bytes: ${source.path}`);
    }
    if (options.createParents === true && destinationComponents.length > 1) {
      ensureDirectoryComponentsBelow(root, destinationComponents.slice(0, -1), realRoot);
    }
    const destination = createRegularFileBelow(root, destinationPath, 'copyRegularFileBelow', realRoot);
    try {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
      let total = 0;
      for (;;) {
        const count = readSync(source.descriptor, chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), total);
        if (count === 0) break;
        total += count;
        if (total > maxBytes) {
          throw untrustedError('TOO_LARGE', source.path, `file exceeds ${maxBytes} bytes: ${source.path}`);
        }
        writeAll(destination.descriptor, chunk.subarray(0, count));
      }
      fchmodSync(destination.descriptor, mode);
      return total;
    } finally {
      closeSync(destination.descriptor);
    }
  } catch (error) {
    throw asUntrustedError(error, source.path, `cannot copy ${source.path}`);
  } finally {
    closeSync(source.descriptor);
  }
}

// ── Listing a directory below a trusted root ──────────────────────────

/** A directory opened by {@link openDirectoryBelow}. The caller must {@link DirectoryBelow.close} it. */
export interface DirectoryBelow {
  /**
   * Canonical path of the directory that was actually opened (on Linux, where
   * the kernel says the open descriptor is). Below the root by construction;
   * pass `join(path, name)` to {@link openDirectoryBelow} to descend.
   */
  readonly path: string;
  /**
   * The opened directory's entries, read asynchronously in batches. A `Dirent`
   * type is never followed: a symlink is `isSymbolicLink()`, not `isFile()` or
   * `isDirectory()`. Finishing (or breaking out of) a `for await` loop closes
   * this iterator; {@link DirectoryBelow.close} is still required.
   */
  readonly entries: Dir;
  /**
   * `lstat` of the entry `name` of the opened directory (never followed), or
   * `undefined` when it is gone or `name` is not a plain name. On Linux the
   * lookup goes through the open descriptor, so a directory swapped for a
   * symlink after it was opened cannot redirect it.
   */
  lstatEntry(name: string): Promise<Stats | undefined>;
  /** `fstat` of the directory that was actually opened (its device and inode identify it). */
  stat(): Promise<Stats>;
  /**
   * A path naming the entry `name` of the opened directory, for the caller's
   * own `O_NOFOLLOW` open (which must still check that the inode it got is the
   * one `lstatEntry` reported). On Linux it goes through the open descriptor,
   * like `lstatEntry`. `undefined` when `name` is not a plain name or the
   * directory is closed.
   */
  entryPath(name: string): string | undefined;
  /** Releases the directory (idempotent); `lstatEntry` must not be called afterwards. */
  close(): Promise<void>;
}

export interface OpenDirectoryBelowOptions {
  /** Accept `realRoot` itself (default false: only directories strictly below it). */
  readonly allowRoot?: boolean;
}

/** Map an `open(O_DIRECTORY)` / `realpath` errno to a discriminant. */
function directoryCodeForErrno(error: unknown): UntrustedFileErrorCode {
  switch (errnoCode(error)) {
    case 'ENOENT':
      return 'NOT_FOUND';
    case 'ENOTDIR':
      return 'NOT_DIRECTORY';
    default:
      return 'IO_ERROR';
  }
}

/** The kernel's current path for an open descriptor (Linux `/proc/self/fd`), or `undefined` elsewhere. */
async function descriptorPathAsync(descriptor: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    return await readlinkAsync(`/proc/self/fd/${descriptor}`);
  } catch {
    return undefined;
  }
}

/**
 * Open the directory at `path` for listing when, and only when, the directory
 * actually opened lies below the trusted canonical `realRoot` (or is the root,
 * with `allowRoot`).
 *
 * `path` is an absolute path whose components below the root an agent may
 * swap at any moment. It is opened `O_RDONLY | O_DIRECTORY | O_NONBLOCK`, so a
 * FIFO, socket, device or regular file there is refused (`NOT_DIRECTORY`)
 * before anything could block, and a missing path is `NOT_FOUND`. Symlinks
 * along `path` are followed by that open; what matters is where it landed. On
 * Linux the descriptor is located through `/proc/self/fd` and the directory is
 * then listed and its entries `lstat`ed through the descriptor itself, so a
 * swap before, during or after the open cannot make it list or size another
 * directory (`OUTSIDE_ROOT`). Without `/proc` (macOS) the path is resolved
 * again after the open and must name the same directory (device and inode) at
 * a canonical place below the root; the listing then goes by that canonical
 * path, which a concurrent swap can still race, misreporting at most names and
 * sizes. File contents are never read here: read them with
 * {@link readUntrustedRegularFileBelow}, which checks the file's own
 * descriptor.
 */
export async function openDirectoryBelow(
  realRoot: string,
  path: string,
  options: OpenDirectoryBelowOptions = {},
): Promise<DirectoryBelow> {
  assertAbsolutePath(realRoot, 'openDirectoryBelow');
  assertAbsolutePath(path, 'openDirectoryBelow');
  const allowRoot = options.allowRoot === true;
  const accepts = (candidate: string): boolean =>
    isCanonicalPathWithin(candidate, realRoot) && (allowRoot || candidate !== realRoot);

  let handle: FileHandle;
  try {
    handle = await openAsync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK);
  } catch (error) {
    throw untrustedError(directoryCodeForErrno(error), path, `cannot open directory ${path}`, error);
  }
  try {
    const located = await descriptorPathAsync(handle.fd);
    if (located !== undefined) {
      if (!accepts(located)) throw untrustedError('OUTSIDE_ROOT', path, `${path} was opened outside ${realRoot}`);
      // `/proc/self/fd/<n>` reopens the very directory the descriptor holds,
      // and `<n>/<name>` looks `name` up in it, whatever `path` names now.
      const viaDescriptor = `/proc/self/fd/${handle.fd}`;
      return directoryBelow(located, await opendirAsync(viaDescriptor), viaDescriptor, handle);
    }
    let canonical: string;
    let current: Stats;
    try {
      canonical = await realpathAsync(path);
      current = await lstatAsync(canonical);
    } catch (error) {
      throw untrustedError(directoryCodeForErrno(error), path, `cannot resolve directory ${path}`, error);
    }
    const opened = await handle.stat();
    if (!accepts(canonical)) throw untrustedError('OUTSIDE_ROOT', path, `${path} resolves outside ${realRoot}`);
    if (!current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw untrustedError('CHANGED', path, `${path} changed while it was opened`);
    }
    return directoryBelow(canonical, await opendirAsync(canonical), canonical, handle);
  } catch (error) {
    await handle.close();
    throw asUntrustedError(error, path, `cannot list ${path}`);
  }
}

function directoryBelow(path: string, entries: Dir, lookupBase: string, handle: FileHandle): DirectoryBelow {
  let closed = false;
  const entryPath = (name: string): string | undefined =>
    closed || name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')
      ? undefined
      : `${lookupBase}/${name}`;
  return {
    path,
    entries,
    async lstatEntry(name: string): Promise<Stats | undefined> {
      const entry = entryPath(name);
      if (entry === undefined) return undefined;
      try {
        return await lstatAsync(entry);
      } catch {
        return undefined;
      }
    },
    stat: () => handle.stat(),
    entryPath,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await entries.close();
      } catch {
        // Already closed by a finished (or abandoned) `for await` loop.
      }
      // Closed last: until now `/proc/self/fd/<n>` must keep naming this directory.
      await handle.close();
    },
  };
}
