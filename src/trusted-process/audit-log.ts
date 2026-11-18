import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PRIVATE_DIR_MODE, appendPrivateLog } from '../observability/private-log-file.js';
import type { AuditEntry } from '../types/audit.js';
import { prepareRedactionSecrets, redactObject } from './audit-redactor.js';

export interface AuditLogOptions {
  /** When true, PII/credential patterns are redacted before writing. */
  redact?: boolean;
  /**
   * Exact credential values to redact wherever they appear in arguments
   * and results (configured server credentials, provider API keys, OAuth
   * tokens). Only applied when `redact` is true. Values shorter than
   * `MIN_SECRET_LENGTH` are ignored.
   */
  secrets?: Iterable<string | undefined | null>;
}

/** Discriminant carried by every error the audit log raises. */
export const AUDIT_LOG_UNAVAILABLE = 'AUDIT_LOG_UNAVAILABLE';

/**
 * Thrown when the audit log cannot record an entry: a write failed (and
 * the failure is latched for the rest of the session), the constructor
 * could not create the log's directory, or the log is closed. Callers
 * identify it by `code`, not `instanceof`, so a catch across module
 * boundaries does not depend on sharing this class.
 */
export class AuditLogUnavailableError extends Error {
  readonly code = AUDIT_LOG_UNAVAILABLE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuditLogUnavailableError';
  }
}

/** True for any error carrying the `AUDIT_LOG_UNAVAILABLE` code. */
export function isAuditLogUnavailableError(err: unknown): err is Error & { code: typeof AUDIT_LOG_UNAVAILABLE } {
  return err instanceof Error && (err as { code?: unknown }).code === AUDIT_LOG_UNAVAILABLE;
}

/**
 * Append-only JSONL writer for audit entries.
 *
 * Writes are synchronous (`appendFileSync`) for two reasons: durability
 * and read-after-write determinism. An async `WriteStream` buffers
 * chunks and flushes them on the event loop; on fast machines (the CI
 * ubuntu-latest runner being the motivating case) the test/inspection
 * code can call `readFileSync(auditPath)` before the last write has
 * reached disk. More importantly, a process crash between a policy
 * decision and the next flush would silently drop the audit entry for
 * that decision — the exact window where durability matters most. The
 * sibling logger (`src/logger.ts`) uses the same pattern for the same
 * reason. Since `rotate()` was removed in the coordinator redesign,
 * this class's only remaining job is appending records.
 *
 * Record shape. Every call that reaches the security pipeline produces
 * one outcome record (`result.status` of `success`, `denied` or `error`).
 * A call that is allowed and acts on a backend (or runs as a virtual proxy
 * tool) additionally produces a write-ahead record with
 * `result.status: 'dispatching'` and the same `requestId`, appended
 * immediately before its first side effect: the backend call, or, for an
 * approved escalation that needs a new root, the roots update (a roots
 * verification failure after it ends in a `denied` outcome). The
 * write-ahead record is what makes the fail-closed contract hold for the
 * very first failing append: if it cannot be written, the call is refused
 * before anything happens. It also means a `dispatching` record without a
 * matching outcome record marks a call that was in flight when the
 * process died. Readers that want one record per call filter with
 * `isDispatchingAuditEntry`.
 *
 * Each coordinator owns exactly one `AuditLog` targeting a single file
 * for its entire lifetime. Workflow runs write one file per run
 * (entries tagged with `persona` so consumers can slice by re-entry);
 * single-session modes write one file per session. Policy hot-swap
 * only updates `currentPersona` on the coordinator and all entries
 * continue to land in the same file.
 */
export class AuditLog {
  private readonly path: string;
  private readonly redact: boolean;
  private readonly secrets: readonly string[];
  private closed = false;
  // Latched write error. Once any `appendFileSync` has failed (ENOSPC,
  // EACCES, missing parent dir that was deleted mid-session, etc.) we
  // stop attempting further writes and rethrow the cached error on
  // every subsequent `log()` and `assertWritable()` call. This preserves
  // the "fail-closed" invariant: a trusted process that cannot audit
  // must stop processing tool calls, and must report the same root-cause
  // error each time it's asked to audit afterwards. The pipeline checks
  // `assertWritable()` before evaluating a call and writes a
  // `dispatching` record before forwarding it, so the latch (or a fresh
  // failure) always prevents the dispatch instead of following it.
  private streamError: Error | null = null;

  constructor(path: string, options?: AuditLogOptions) {
    this.path = path;
    // Match the old `createWriteStream` behavior of auto-creating the
    // parent directory for common session/workflow layouts. If this
    // itself fails (e.g., a path component is a file), we latch the
    // error so the first `log()` rethrows it synchronously — the
    // caller experiences the same fail-closed contract either way.
    try {
      mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (err) {
      this.streamError = err instanceof Error ? err : new Error(String(err));
    }
    this.redact = options?.redact ?? false;
    this.secrets = this.redact && options?.secrets ? prepareRedactionSecrets(options.secrets) : [];
  }

  /**
   * Throws when this log can no longer record entries: after `close()`,
   * or once any write (or the constructor's `mkdirSync`) has failed.
   * Returns normally when the next `log()` has a chance of succeeding.
   * The security pipeline calls this before it evaluates a tool call so
   * a broken audit log refuses the call instead of letting it run
   * unaudited.
   *
   * @throws {AuditLogUnavailableError}
   */
  assertWritable(): void {
    if (this.closed) {
      throw new AuditLogUnavailableError('AuditLog is closed');
    }
    if (this.streamError) {
      throw new AuditLogUnavailableError(`AuditLog stream error: ${this.streamError.message}`, {
        cause: this.streamError,
      });
    }
  }

  /**
   * Appends a single audit entry to the log file.
   *
   * A trusted process that cannot audit is a security violation: we
   * fail loudly rather than silently drop entries. If a previous write
   * failed, we rethrow the cached error without attempting a new write
   * so the caller sees a deterministic, idempotent failure surface.
   *
   * @throws {AuditLogUnavailableError} if called after `close()`.
   * @throws {AuditLogUnavailableError} if any previous write (or the ctor's `mkdirSync`) failed.
   * @throws {AuditLogUnavailableError} if this write fails (ENOSPC, EACCES, etc.).
   */
  log(entry: AuditEntry): void {
    if (this.closed) {
      throw new AuditLogUnavailableError('AuditLog.log() called after close()');
    }
    this.assertWritable();
    const toWrite = this.redact ? redactAuditEntry(entry, this.secrets) : entry;
    try {
      // Created owner-only (0600), like the session's other logs.
      appendPrivateLog(this.path, JSON.stringify(toWrite) + '\n');
    } catch (err) {
      this.streamError = err instanceof Error ? err : new Error(String(err));
      throw new AuditLogUnavailableError(`AuditLog stream error: ${this.streamError.message}`, {
        cause: err,
      });
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    // Synchronous writes have nothing to flush and no fd to release.
    // Returns a promise purely for API compatibility with the existing
    // coordinator teardown path, which `await`s this call.
    return Promise.resolve();
  }
}

/**
 * Redacts PII/credential patterns and known credential values from an
 * audit entry's arguments and result content. Metadata fields
 * (timestamps, tool names, policy decisions) are never modified.
 */
function redactAuditEntry(entry: AuditEntry, secrets: readonly string[]): AuditEntry {
  return {
    ...entry,
    arguments: redactObject(entry.arguments, secrets),
    result: {
      ...entry.result,
      content: entry.result.content !== undefined ? redactObject(entry.result.content, secrets) : undefined,
      error: entry.result.error !== undefined ? redactObject(entry.result.error, secrets) : undefined,
    },
  };
}
