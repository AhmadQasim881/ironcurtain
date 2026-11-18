/**
 * Owner-only directories and files for the logs IronCurtain writes about a
 * session (LLM interaction logs, interactions.jsonl, session.log, audit.jsonl).
 *
 * These logs hold prompts, tool results and transcripts. The session
 * directory that contains them is owner-only (0700), and each log file is
 * created owner-only (0600) as well, so a log that is copied out of the
 * directory (a backup, an attachment to a bug report) keeps the restriction.
 *
 * Tightening an entry that already exists is best effort: a filesystem that
 * cannot represent modes, or an entry owned by another user, keeps what it
 * has and the caller still gets its log. The host user is trusted; this is
 * data-at-rest hygiene, not a trust boundary.
 *
 * Leaf module: Node built-ins only.
 */

import { appendFileSync, chmodSync, closeSync, fchmodSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/** Mode of a directory that holds session logs. */
export const PRIVATE_DIR_MODE = 0o700;

/** Mode of a session log file. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Makes `dir` an owner-only directory: creates it (and any missing parent)
 * with mode 0700, and tightens it to 0700 when it already exists. Use it for
 * a directory IronCurtain owns outright, such as `sessions/<id>/`; never for
 * a directory the user supplied.
 */
export function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // Best effort (see the module comment).
  }
}

/**
 * Prepares the log file at `path`: creates it with mode 0600, or tightens an
 * existing file to 0600, emptying it first when `truncate` is set. A missing
 * parent directory is created owner-only; an existing parent keeps its mode
 * (it may be shared, such as a package's generated-policy directory).
 *
 * @throws when the file cannot be opened (the caller decides whether a log it
 *   cannot create is fatal).
 */
export function preparePrivateLogFile(path: string, options: { readonly truncate: boolean }): void {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  const fd = openSync(path, options.truncate ? 'w' : 'a', PRIVATE_FILE_MODE);
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
  } catch {
    // Best effort (see the module comment).
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends `text` to the log at `path`, creating the file with mode 0600 if it
 * is missing (for example after the session directory was cleaned up while
 * the session ran). Synchronous, like the other session logs, so a reader
 * sees every entry as soon as the call returns.
 */
export function appendPrivateLog(path: string, text: string): void {
  appendFileSync(path, text, { mode: PRIVATE_FILE_MODE });
}
