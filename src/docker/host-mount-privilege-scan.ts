/**
 * Host-side scan of the directories an agent container can write (its
 * read-write bind mounts) for privilege that container root may have planted
 * on the host (audit finding DINF-3).
 *
 * On native Linux Docker without rootless mode or userns-remap, container
 * UID 0 is host UID 0 on every bind mount, and agents keep passwordless sudo
 * by default (`agentSudo`). A compromised agent can therefore leave a
 * root-owned setuid binary in the workspace (as a git hook, a
 * `node_modules/.bin` entry or a build tool) that a later host command runs
 * as root, or chown the user's files to root. After each agent turn, at
 * session end (PTY sessions: only then), after a container whose start failed
 * is removed, and after workflow dependency provisioning, the coordinator
 * walks those mounts and:
 *
 * - strips the setuid and setgid bits from every regular file the host user
 *   owns (the agent's own files are host-user files; a setuid copy of a shell
 *   would let other local users act as this user);
 * - reports the setuid/setgid files it cannot change (owned by root or
 *   another user: only root can neutralize them, so the report names them for
 *   removal with sudo) and every root-owned entry, the mount roots included
 *   (container root can chown the workspace directory itself).
 *
 * The walk never follows a symlink. Each directory is opened through
 * `openDirectoryBelow` (canonical-root contained, descriptor-anchored on
 * Linux) and must be the very directory its parent's `lstat` saw; entries are
 * `lstat`ed through that descriptor; and a file is changed only through an
 * `O_PATH | O_NOFOLLOW` descriptor whose `fstat` matches the `lstat`, so a
 * name swapped for a symlink to a host file between the check and the change
 * can neither redirect the chmod nor change another file's mode. Only the
 * setuid/setgid bits are cleared; nothing is moved or deleted.
 *
 * Limits, stated rather than hidden: a turn-time scan runs while the
 * container (and anything the agent left running in it) is still alive, so a
 * racing process can plant a file again after the scan; the session-end scan
 * runs after the container is gone. Directories that root made unreadable,
 * or that are nested deeper than an absolute path can name (PATH_MAX), cannot
 * be listed and are reported instead, marking the scan incomplete. File
 * capabilities are not a vector here: agent containers never receive
 * CAP_SETFCAP. Directory setgid bits (group inheritance, not an exec vector)
 * are left alone.
 *
 * Linux only: the only platform where container root is host root on bind
 * mounts. Never throws: callers are a session's turn and teardown paths.
 *
 * Every finding goes to the session log. The user is told as well
 * ({@link hostPrivilegedFilesNotice}, a `host_privileged_files` diagnostic):
 * after a turn about what no earlier scan of the bundle reported (a finding
 * removed and planted again counts as new), at session end about everything
 * left; the transports show it (CLI, web UI, Signal),
 * cron runs record it and workflows log it in their message log.
 */
import { chmod, open as openAsync, type FileHandle } from 'node:fs/promises';
import { constants, lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { openDirectoryBelow, type DirectoryBelow } from '../hardened-fs.js';
import * as logger from '../logger.js';
import { formatSessionNotice, type HostPrivilegedFilesDiagnostic } from '../session/startup-notices.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

/** A host directory bind-mounted read-write into the agent container. */
export interface HostMountScanRoot {
  /** Host path of the mount source. */
  readonly hostPath: string;
  /** Where the agent sees it, for reports. */
  readonly containerPath: string;
}

export interface PrivilegedEntry {
  /** Host path of the entry. */
  readonly path: string;
  readonly uid: number;
  /** Permission bits including setuid/setgid/sticky (`st_mode & 0o7777`). */
  readonly mode: number;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
}

export interface UnstrippedEntry extends PrivilegedEntry {
  readonly reason: string;
}

export interface HostMountPrivilegeScanResult {
  /** Entries examined across all roots. */
  readonly scannedEntries: number;
  /** False when the entry bound was hit, or a root or directory could not be listed. */
  readonly complete: boolean;
  /** Regular files whose setuid/setgid bits this scan removed. */
  readonly stripped: readonly PrivilegedEntry[];
  /** setuid/setgid files left as they are (owned by root or another user, or changed mid-scan). */
  readonly unstripped: readonly UnstrippedEntry[];
  /** Root-owned entries other than the unstripped files above. */
  readonly rootOwned: readonly PrivilegedEntry[];
  /** Directories (or roots) that could not be listed. */
  readonly unreadable: readonly { readonly path: string; readonly reason: string }[];
  /** Findings beyond the per-category cap (counted, not listed). */
  readonly omitted: number;
}

/** A scanner's result: the scan's findings, and which of them no earlier scan of the scanner reported. */
export interface HostMountPrivilegeScanReport extends HostMountPrivilegeScanResult {
  /** When the scan ran (`after agent turn`, `session end`, ...). */
  readonly when: string;
  /**
   * The unneutralized and root-owned entries this scanner had not reported
   * before (a lasting finding is reported once; one that was removed and is
   * found again is new). Every strip is new: it is an action this scan took.
   */
  readonly newFindings: {
    readonly unstripped: readonly UnstrippedEntry[];
    readonly rootOwned: readonly PrivilegedEntry[];
  };
}

export interface HostMountPrivilegeScanOptions {
  /** UID whose files the scan may change; defaults to this process's. */
  readonly hostUid?: number;
  /** UID reported as root; defaults to 0. Tests override it to simulate root-owned entries. */
  readonly rootUid?: number;
  /** Stop after this many entries (default 1,000,000) and report the scan incomplete. */
  readonly maxEntries?: number;
  /** Cap on each listed finding category (default 100); the rest are counted in `omitted`. */
  readonly maxListed?: number;
  /** Parallel `lstat`s per directory (default 16). */
  readonly concurrency?: number;
}

const DEFAULT_MAX_ENTRIES = 1_000_000;
const DEFAULT_MAX_LISTED = 100;
const DEFAULT_CONCURRENCY = 16;
const SETUID_SETGID = 0o6000;

/**
 * Linux `O_PATH`: a descriptor that names an inode without opening it for
 * I/O, so a file whose mode forbids reading can still be pinned without
 * following a symlink. Node does not export it; this is the asm-generic value
 * shared by every architecture Node supports on Linux.
 */
const O_PATH = 0o10000000;

function entryKind(stats: Stats): PrivilegedEntry['kind'] {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

/** A short reason: the error's code, with the errno behind a hardened-fs discriminant (`IO_ERROR (EACCES)`). */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = errorCode(error);
  const cause = errorCode(error.cause);
  if (code === undefined) return error.message;
  return cause === undefined || cause === code ? code : `${code} (${cause})`;
}

/** A directory removed between its parent's listing and its own open is not a finding. */
function isGone(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'NOT_FOUND';
}

function sameInode(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Clears setuid/setgid on the inode `seen` describes, reached at `entryPath`
 * without following a symlink. Returns why it did not, or undefined. An entry
 * replaced since `seen` was taken (by a symlink, or by another file) is left
 * alone. Exported for tests.
 */
export async function stripSetuidSetgidNoFollow(entryPath: string, seen: Stats): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await openAsync(entryPath, O_PATH | constants.O_NOFOLLOW);
  } catch (error) {
    return `could not be opened (${describeError(error)})`;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameInode(opened, seen)) return 'it changed during the scan';
    // fchmod does not accept O_PATH descriptors; chmod through the
    // descriptor's /proc magic link changes exactly the pinned inode.
    await chmod(`/proc/self/fd/${handle.fd}`, opened.mode & 0o7777 & ~SETUID_SETGID);
    return undefined;
  } catch (error) {
    return `chmod failed (${describeError(error)})`;
  } finally {
    await handle.close();
  }
}

/**
 * Walks `roots` without following symlinks, strips setuid/setgid bits from
 * the host user's regular files and collects what it could not neutralize.
 * Never throws.
 */
export async function scanHostMountPrivileges(
  roots: readonly HostMountScanRoot[],
  options: HostMountPrivilegeScanOptions = {},
): Promise<HostMountPrivilegeScanResult> {
  const hostUid = options.hostUid ?? process.getuid?.() ?? -1;
  const rootUid = options.rootUid ?? 0;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxListed = options.maxListed ?? DEFAULT_MAX_LISTED;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const stripped: PrivilegedEntry[] = [];
  const unstripped: UnstrippedEntry[] = [];
  const rootOwned: PrivilegedEntry[] = [];
  const unreadable: { path: string; reason: string }[] = [];
  let omitted = 0;
  let scannedEntries = 0;
  let truncated = false;
  let unlisted = 0;
  const record = <T>(target: T[], item: T): void => {
    if (target.length < maxListed) target.push(item);
    else omitted++;
  };
  const noteUnreadable = (path: string, reason: string): void => {
    unlisted++;
    record(unreadable, { path, reason });
  };
  const result = (): HostMountPrivilegeScanResult => ({
    scannedEntries,
    complete: !truncated && unlisted === 0,
    stripped,
    unstripped,
    rootOwned,
    unreadable,
    omitted,
  });

  if (process.platform !== 'linux') return result();

  const visited = new Set<string>();
  const examine = async (directory: DirectoryBelow, name: string, stats: Stats): Promise<void> => {
    const path = join(directory.path, name);
    const entry: PrivilegedEntry = { path, uid: stats.uid, mode: stats.mode & 0o7777, kind: entryKind(stats) };
    if (stats.isFile() && (stats.mode & SETUID_SETGID) !== 0) {
      if (stats.uid !== hostUid) {
        record(unstripped, {
          ...entry,
          reason: stats.uid === rootUid ? 'owned by root' : `owned by UID ${stats.uid}`,
        });
        return;
      }
      const entryPath = directory.entryPath(name);
      const failure =
        entryPath === undefined ? 'its directory was closed' : await stripSetuidSetgidNoFollow(entryPath, stats);
      if (failure === undefined) record(stripped, entry);
      else record(unstripped, { ...entry, reason: failure });
      return;
    }
    if (stats.uid === rootUid) record(rootOwned, entry);
  };

  for (const root of roots) {
    if (truncated) break;
    let realRoot: string;
    try {
      realRoot = realpathSync(root.hostPath);
    } catch (error) {
      // A mount source teardown already removed (the sockets dir) is not a finding.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') noteUnreadable(root.hostPath, describeError(error));
      continue;
    }
    // The mount root itself is never one of the listed entries, yet container
    // root can chown it (the user can then no longer write their own
    // workspace) even though it cannot replace it: report it like an entry.
    try {
      const rootStats = lstatSync(realRoot);
      if (rootStats.uid === rootUid && !visited.has(`${rootStats.dev}:${rootStats.ino}`)) {
        record(rootOwned, {
          path: realRoot,
          uid: rootStats.uid,
          mode: rootStats.mode & 0o7777,
          kind: entryKind(rootStats),
        });
      }
    } catch {
      // Gone or unreadable: the open below reports it.
    }

    // Each pending directory carries the identity its parent's lstat saw: a
    // directory swapped for another one before it is opened is not listed.
    const pending: { path: string; expected?: Stats }[] = [{ path: realRoot }];
    while (pending.length > 0 && !truncated) {
      const next = pending.pop();
      if (next === undefined) break;
      let directory: DirectoryBelow;
      try {
        directory = await openDirectoryBelow(realRoot, next.path, { allowRoot: true });
      } catch (error) {
        if (next.expected === undefined || !isGone(error)) noteUnreadable(next.path, describeError(error));
        continue;
      }
      try {
        const opened = await directory.stat();
        if (next.expected !== undefined && !sameInode(opened, next.expected)) {
          noteUnreadable(next.path, 'it changed during the scan');
          continue;
        }
        // Bind mounts can expose one directory twice; list each inode once.
        const identity = `${opened.dev}:${opened.ino}`;
        if (visited.has(identity)) continue;
        visited.add(identity);

        // Stream the listing in small batches: an agent can create millions
        // of names in one directory, and the coordinator must not hold them.
        // A batch reports false once the entry bound is reached.
        let batch: string[] = [];
        const flush = async (): Promise<boolean> => {
          const names = batch;
          batch = [];
          const batchStats = await Promise.all(names.map((name) => directory.lstatEntry(name)));
          for (let offset = 0; offset < names.length; offset++) {
            const stats = batchStats[offset];
            if (stats === undefined) continue; // removed meanwhile
            if (scannedEntries >= maxEntries) return false;
            scannedEntries++;
            await examine(directory, names[offset], stats);
            if (stats.isDirectory()) pending.push({ path: join(directory.path, names[offset]), expected: stats });
          }
          return true;
        };
        let withinBound = true;
        for await (const dirent of directory.entries) {
          batch.push(dirent.name);
          if (batch.length >= concurrency && !(await flush())) {
            withinBound = false;
            break;
          }
        }
        if (withinBound) withinBound = await flush();
        if (!withinBound) truncated = true;
      } catch (error) {
        noteUnreadable(next.path, describeError(error));
      } finally {
        await directory.close();
      }
    }
  }
  return result();
}

/**
 * The read-write host directories among an agent container's bind mounts:
 * what the agent (as container root, on a host-root daemon) can write on the
 * host. Read-only mounts, single files and sockets are left out. A source
 * given through a symlink is kept, as Docker binds the directory it names
 * (the scan resolves it); mount sources are host-chosen paths, not the
 * agent's.
 */
export function hostWritableMountRoots(
  mounts: readonly { readonly source: string; readonly target: string; readonly readonly: boolean }[],
): HostMountScanRoot[] {
  const roots: HostMountScanRoot[] = [];
  for (const mount of mounts) {
    if (mount.readonly) continue;
    try {
      if (!statSync(mount.source).isDirectory()) continue;
    } catch {
      continue;
    }
    roots.push({ hostPath: mount.source, containerPath: mount.target });
  }
  return roots;
}

/**
 * The scanner for an agent container created with `mounts`, or undefined
 * unless the bundle's daemon maps container root to host root
 * (`PreContainerInfrastructure.containerRootIsHostRoot`). Shared by batch
 * (`createSessionContainers`) and PTY (`runPtySession`) containers.
 */
export function createBundlePrivilegedFileScanner(
  bundle: { readonly containerRootIsHostRoot?: boolean },
  mounts: readonly { readonly source: string; readonly target: string; readonly readonly: boolean }[],
): HostMountPrivilegeScanner | undefined {
  if (bundle.containerRootIsHostRoot !== true) return undefined;
  const roots = hostWritableMountRoots(mounts);
  return roots.length === 0 ? undefined : createHostMountPrivilegeScanner(roots);
}

/** Session-scoped scanner for one agent container's read-write host mounts. */
export interface HostMountPrivilegeScanner {
  readonly roots: readonly HostMountScanRoot[];
  /**
   * Scans once (after any scan already running), logs what it changed and
   * every finding not yet reported by this scanner, and resolves with the
   * result and those new findings. Never throws.
   */
  scan(when: string): Promise<HostMountPrivilegeScanReport>;
}

/**
 * Creates the scanner a Docker bundle runs after each agent turn and at
 * teardown. Scans are serialized (concurrent fan-out lanes share a bundle).
 * Findings that persist across scans (a root-owned file nobody removed) are
 * logged once per scanner; every strip is logged, since each is an action.
 */
export function createHostMountPrivilegeScanner(
  roots: readonly HostMountScanRoot[],
  options: HostMountPrivilegeScanOptions = {},
): HostMountPrivilegeScanner {
  const frozenRoots = Object.freeze(roots.map((root) => Object.freeze({ ...root })));
  const reported = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    roots: frozenRoots,
    scan(when: string): Promise<HostMountPrivilegeScanReport> {
      const run = tail.then(async (): Promise<HostMountPrivilegeScanReport> => {
        try {
          const scanned = await scanHostMountPrivileges(frozenRoots, options);
          const newFindings = takeUnreported(scanned, reported);
          for (const line of describeFindings(scanned, when, newFindings)) logger.warn(line);
          return { ...scanned, when, newFindings };
        } catch (error) {
          logger.warn(`[docker] Host-mount privilege scan (${when}) failed: ${describeError(error)}`);
          return {
            scannedEntries: 0,
            complete: false,
            stripped: [],
            unstripped: [],
            rootOwned: [],
            unreadable: [],
            omitted: 0,
            when,
            newFindings: { unstripped: [], rootOwned: [] },
          };
        }
      });
      tail = run;
      return run;
    },
  };
}

/** Paths a notice names at most; the session log lists every finding. */
const MAX_NOTICE_PATHS = 5;

/**
 * What the user is told about a scan, or undefined when it found nothing
 * to tell. `scope: 'new'` (after an agent turn) covers this scan's strips
 * and the findings no earlier scan of the scanner reported, so a root-owned
 * file nobody removed is not repeated after every turn; `'all'` (session
 * end) covers everything the scan found left behind. Paths are agent-chosen
 * names, rendered as bounded display text.
 */
export function hostPrivilegedFilesNotice(
  report: HostMountPrivilegeScanReport | undefined,
  scope: 'new' | 'all',
): HostPrivilegedFilesDiagnostic | undefined {
  if (report === undefined) return undefined;
  const unstripped = scope === 'new' ? report.newFindings.unstripped : report.unstripped;
  const rootOwned = scope === 'new' ? report.newFindings.rootOwned : report.rootOwned;
  const { stripped } = report;
  if (unstripped.length + rootOwned.length + stripped.length === 0) return undefined;
  const hint =
    unstripped.length > 0
      ? 'Inspect the files IronCurtain could not neutralize and remove them as root (for example with sudo rm) ' +
        'before running anything from these directories; details are in the session log.'
      : rootOwned.length > 0
        ? 'Container root is host root on this Docker daemon, so only sudo can change or remove the root-owned ' +
          'entries; details are in the session log.'
        : 'Their setuid/setgid bits are removed; details are in the session log.';
  return {
    kind: 'host_privileged_files',
    when: report.when,
    stripped: stripped.length,
    unstripped: unstripped.length,
    rootOwned: rootOwned.length,
    unlisted: report.omitted,
    paths: [...unstripped, ...rootOwned, ...stripped].slice(0, MAX_NOTICE_PATHS).map((entry) => formatPath(entry.path)),
    incomplete: !report.complete,
    hint,
  };
}

/** Hand startup/provisioning findings to a user-facing sink, with stderr as a fallback. */
export function deliverHostPrivilegedFilesNotice(
  report: HostMountPrivilegeScanReport | undefined,
  onNotice?: (notice: HostPrivilegedFilesDiagnostic) => void,
): HostPrivilegedFilesDiagnostic | undefined {
  return deliverHostPrivilegedFilesDiagnostic(hostPrivilegedFilesNotice(report, 'all'), onNotice);
}

/** A teardown already returned a diagnostic; delivery must not change its cleanup outcome. */
export function deliverHostPrivilegedFilesDiagnostic(
  notice: HostPrivilegedFilesDiagnostic | undefined,
  onNotice?: (notice: HostPrivilegedFilesDiagnostic) => void,
): HostPrivilegedFilesDiagnostic | undefined {
  if (notice === undefined) return undefined;
  if (onNotice !== undefined) {
    try {
      onNotice(notice);
      return notice;
    } catch (error) {
      logger.warn(`Could not deliver host-mount findings: ${describeError(error)}`);
    }
  }
  try {
    process.stderr.write(`${formatSessionNotice(notice)}\n`);
  } catch (error) {
    logger.warn(`Could not print host-mount findings: ${describeError(error)}`);
  }
  return notice;
}

/** Keep a setup failure's identity and code, but include the cleanup finding in its visible reason. */
export function includeHostPrivilegedFilesInFailure(
  failure: unknown,
  notice: HostPrivilegedFilesDiagnostic | undefined,
): unknown {
  if (notice === undefined) return failure;
  const original = failure instanceof Error ? failure : new Error(String(failure));
  const message = `${original.message}\n${formatSessionNotice(notice)}`;
  try {
    original.message = message;
    return original;
  } catch {
    // A frozen external error cannot be annotated; preserve it as the cause.
    return new Error(message, { cause: original });
  }
}

function formatMode(mode: number): string {
  return mode.toString(8).padStart(4, '0');
}

/** Agent-chosen names reach the session log: escape control characters, bound the length. */
function formatPath(path: string): string {
  return toDisplayText(path, { maxLength: 512 });
}

/**
 * The unneutralized and root-owned entries of `result` not in `reported`
 * (keyed by path, owner and mode), which are added to it. A scan that listed
 * everything (complete, nothing omitted) also drops the reported entries it
 * no longer found: they were removed, so one planted there again is new and
 * reported again, not taken for the finding the user already cleaned up.
 */
function takeUnreported(
  result: HostMountPrivilegeScanResult,
  reported: Set<string>,
): HostMountPrivilegeScanReport['newFindings'] {
  const found = new Set<string>();
  const fresh = <T extends PrivilegedEntry>(entries: readonly T[]): T[] =>
    entries.filter((entry) => {
      const key = `${entry.path}\0${entry.uid}\0${entry.mode}`;
      found.add(key);
      if (reported.has(key)) return false;
      reported.add(key);
      return true;
    });
  const newFindings = { unstripped: fresh(result.unstripped), rootOwned: fresh(result.rootOwned) };
  if (result.complete && result.omitted === 0) {
    for (const key of reported) {
      if (!found.has(key)) reported.delete(key);
    }
  }
  return newFindings;
}

/**
 * Renders a scan result as log lines. Entries already in `reported` (keyed by
 * path, owner and mode) are left out, and those listed are added to it.
 */
export function describeHostMountPrivilegeScan(
  result: HostMountPrivilegeScanResult,
  when: string,
  reported: Set<string> = new Set(),
): string[] {
  return describeFindings(result, when, takeUnreported(result, reported));
}

/** Log lines for a scan: every strip, the findings in `fresh`, and an incomplete scan. */
function describeFindings(
  result: HostMountPrivilegeScanResult,
  when: string,
  fresh: HostMountPrivilegeScanReport['newFindings'],
): string[] {
  const prefix = `[docker] Host-mount privilege scan (${when}):`;
  const lines: string[] = [];
  if (result.stripped.length > 0) {
    lines.push(
      `${prefix} removed setuid/setgid bits from ${result.stripped.length} file(s) an agent left in its ` +
        `read-write mounts: ${result.stripped.map((entry) => `${formatPath(entry.path)} (was ${formatMode(entry.mode)})`).join(', ')}`,
    );
  }
  const unstripped = fresh.unstripped;
  if (unstripped.length > 0) {
    lines.push(
      `${prefix} ${unstripped.length} setuid/setgid file(s) could not be neutralized and stay executable with ` +
        "their owner's privileges on this host; inspect and remove them as root (for example with sudo rm): " +
        unstripped
          .map(
            (entry) => `${formatPath(entry.path)} (UID ${entry.uid}, mode ${formatMode(entry.mode)}, ${entry.reason})`,
          )
          .join(', '),
    );
  }
  const rootOwned = fresh.rootOwned;
  if (rootOwned.length > 0) {
    lines.push(
      `${prefix} ${rootOwned.length} root-owned entr${rootOwned.length === 1 ? 'y' : 'ies'} in agent-writable ` +
        'mounts (container root is host root on this Docker daemon; you cannot change these without sudo): ' +
        rootOwned
          .map((entry) => `${formatPath(entry.path)} (${entry.kind}, mode ${formatMode(entry.mode)})`)
          .join(', '),
    );
  }
  if (result.omitted > 0) {
    lines.push(`${prefix} ${result.omitted} further finding(s) not listed.`);
  }
  if (!result.complete) {
    const unreadable = result.unreadable.map((entry) => `${formatPath(entry.path)} (${entry.reason})`).join(', ');
    lines.push(
      `${prefix} incomplete after ${result.scannedEntries} entries` +
        (unreadable === '' ? ' (entry limit reached)' : `; could not list: ${unreadable}`),
    );
  }
  return lines;
}
