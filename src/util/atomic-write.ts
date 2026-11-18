/**
 * Atomic file-write primitives shared across layers.
 *
 * A neutral leaf with no domain imports (only Node built-ins and the
 * top-level `hardened-fs` leaf), so both offline pipeline tooling
 * (`src/pipeline/`) and live-layer modules (`src/persona/`, `src/config/`,
 * `src/auth/`, `src/docker/`, `src/cron/`, `src/escalation/`) can use it
 * without a layering violation. The raw-text primitive lives here; callers
 * that want a trailing newline (pipeline artifacts, job.json) append it
 * themselves.
 *
 * Files that hold secrets (config.json, OAuth tokens, a host CLI's credential
 * store) use {@link writePrivateFileAtomicSync} instead of
 * {@link atomicWriteTextSync}: the latter creates its temp file with the
 * process umask (0664 under a common umask of 002, unless the caller passes a
 * narrower `mode`), and the renamed file keeps that mode.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { writeFileNoFollowAtomic } from '../hardened-fs.js';

/** Options for {@link atomicWriteTextSync}. */
export interface AtomicWriteOptions {
  /**
   * Create the parent directory when it is missing (default true). Pass
   * false when a missing directory must make the write fail, e.g. so a
   * record for something that was deleted meanwhile does not recreate it.
   */
  readonly createParentDirs?: boolean;
  /**
   * fsync the temp file before the rename (default false), so that after a
   * crash or power loss the target name never points at unwritten data.
   */
  readonly fsync?: boolean;
  /** Permission bits of the new file, before the umask (default 0o666). */
  readonly mode?: number;
}

/** Owner-only read/write: the mode of every file that may hold a secret. */
export const PRIVATE_FILE_MODE = 0o600;

/** Symlinks followed at the final path component before giving up (Linux's own limit is 40). */
const MAX_SYMLINK_HOPS = 40;

/**
 * Atomically writes raw text using write-to-temp-then-rename.
 *
 * `renameSync` is atomic on POSIX filesystems, so a concurrent reader either
 * sees the complete old file or the complete new file, never a torn write;
 * a failed write (ENOSPC, EIO) leaves the old file untouched.
 *
 * The temp file name is unique per call (`<file>.<pid>.<uuid>.tmp`) and is
 * created exclusively (`wx`), so two writers racing on the SAME target path,
 * in one process or in several, can never share or clobber a temp file and
 * rename the wrong content into place: the write is atomic across concurrent
 * writers, not just concurrent readers. The temp stays in the target's
 * directory so the rename is a same-filesystem (atomic) move, and it is
 * removed again when the write fails.
 */
export function atomicWriteTextSync(filePath: string, text: string, options: AtomicWriteOptions = {}): void {
  if (options.createParentDirs !== false) mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmpPath, 'wx', options.mode ?? 0o666);
    try {
      writeFileSync(fd, text);
      if (options.fsync === true) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Never created, or already renamed into place.
    }
    throw error;
  }
}

/**
 * Atomically writes a pretty-printed JSON value (NO trailing newline) via
 * {@link atomicWriteTextSync} (which also creates the parent dir). The
 * no-newline layout matches the historical `persona.json` on-disk convention,
 * so persona-service can use a leaf primitive instead of importing from the
 * escalation domain module. Consumers needing a trailing newline (e.g. pipeline
 * artifacts, job.json) append it themselves.
 */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  atomicWriteTextSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Atomically replaces a private file (one that holds credentials) so that a
 * crash, a full disk or a concurrent reader can never observe an empty or
 * partial file, and so the secret is never readable by anyone but its owner.
 *
 * The bytes go to a fresh, randomly named temporary file in the target's own
 * directory, created exclusively with mode 0600 (`O_CREAT | O_EXCL |
 * O_NOFOLLOW`, i.e. `'wx'`), fsynced, given exactly `mode` (the umask cannot
 * widen or narrow it), and renamed over the target; the directory is then
 * fsynced so the rename survives a crash (`writeFileNoFollowAtomic`). Until the
 * rename, the old file is untouched; on any failure the temporary file is
 * removed and the error propagates. Concurrent writers never share a
 * temporary name; the last rename wins, so callers that read, modify and write
 * serialize themselves (see `./file-lock.ts`).
 *
 * A symlink at `filePath` (a dotfile manager's link, say) is resolved first and
 * the file it points to is replaced, so the link itself survives; a dangling
 * link gets its target created. The target's directory must already exist.
 */
export function writePrivateFileAtomicSync(
  filePath: string,
  data: string | Uint8Array,
  mode: number = PRIVATE_FILE_MODE,
): void {
  const target = resolveFinalSymlinks(filePath);
  // writeFileNoFollowAtomic insists on a real (non-symlink) directory; a
  // symlinked parent such as a relocated ~/.claude is resolved here.
  writeFileNoFollowAtomic(realpathSync(dirname(target)), basename(target), data, mode);
}

/**
 * Follows symlinks at the final component of `filePath` until it names a
 * non-symlink entry or nothing at all, and returns that absolute path. Parent
 * components of `filePath` itself are left as they are. A relative link
 * target is resolved as the kernel resolves it: from the real directory that
 * holds the link, so a leading `..` (GNU Stow writes such links) climbs out of
 * that real directory even when `filePath` reaches it through a symlinked
 * directory. Throws `ELOOP` after {@link MAX_SYMLINK_HOPS} links.
 */
export function resolveFinalSymlinks(filePath: string): string {
  let current = resolve(filePath);
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
    let isSymlink: boolean;
    try {
      isSymlink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return current;
      throw error;
    }
    if (!isSymlink) return current;
    const target = readlinkSync(current);
    // Resolving against the spelled directory instead would replace a
    // different file than every reader opens whenever that directory is itself
    // reached through a symlink (`~/.claude -> /data/claude` holding
    // `.credentials.json -> ../secrets/claude.json`).
    current = isAbsolute(target) ? resolve(target) : resolve(realpathSync(dirname(current)), target);
  }
  throw Object.assign(new Error(`too many levels of symbolic links: ${filePath}`), { code: 'ELOOP' });
}
