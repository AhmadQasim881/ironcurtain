/**
 * Classification of SQLite and filesystem failures for the metrics writer.
 *
 * The persistence worker loads this module through Node's native type
 * stripping, so it must stay a leaf with erasable TypeScript syntax only.
 */

/**
 * What the writer does with a failure: `busy` batches go back to the head of
 * the queue; the other codes are storage states no worker restart can repair,
 * so persistence latches off. Unclassified failures are transient.
 */
export type LlmMetricsStorageErrorCode = 'busy' | 'incompatible_schema' | 'corrupt' | 'permission';

/** `code` of the error a process raises for a database schema it must not read or write. */
export const LLM_METRICS_SCHEMA_INCOMPATIBLE = 'LLM_METRICS_SCHEMA_INCOMPATIBLE';

const SQLITE_PERM = 3;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
const SQLITE_TOOBIG = 18;
const SQLITE_CONSTRAINT = 19;
const SQLITE_MISMATCH = 20;
const SQLITE_AUTH = 23;
const SQLITE_RANGE = 25;
const SQLITE_NOTADB = 26;
/** The file was renamed or unlinked after open: a reopen, not a permission fix, cures it. */
const SQLITE_READONLY_DBMOVED = SQLITE_READONLY | (4 << 8);
const PERMISSION_ERRNO_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EROFS']);
/** node:sqlite rejects a JavaScript value it cannot bind with these codes. */
const BIND_ERROR_CODES: ReadonlySet<string> = new Set(['ERR_INVALID_ARG_TYPE', 'ERR_OUT_OF_RANGE']);

function errorProperty(error: unknown, name: 'code' | 'errcode'): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[name] : undefined;
}

/** node:sqlite reports the extended result code; its low byte is the primary code. */
function sqlitePrimaryCode(error: unknown): number | undefined {
  const errcode = errorProperty(error, 'errcode');
  return typeof errcode === 'number' && Number.isSafeInteger(errcode) ? errcode & 0xff : undefined;
}

export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = errorProperty(error, 'code');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const primary = sqlitePrimaryCode(error);
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) return true;
  return /database (?:table )?is locked|database is busy/i.test(error.message);
}

export function classifyStorageError(error: unknown): LlmMetricsStorageErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = errorProperty(error, 'code');
  if (code === LLM_METRICS_SCHEMA_INCOMPATIBLE) return 'incompatible_schema';
  if (isSqliteBusyError(error)) return 'busy';
  if (typeof code === 'string' && PERMISSION_ERRNO_CODES.has(code)) return 'permission';
  const primary = sqlitePrimaryCode(error);
  if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB) return 'corrupt';
  if (primary === SQLITE_PERM || primary === SQLITE_AUTH) return 'permission';
  if (primary === SQLITE_READONLY && errorProperty(error, 'errcode') !== SQLITE_READONLY_DBMOVED) return 'permission';
  return undefined;
}

/** Failures that latch persistence off instead of restarting the writer. */
export function isPermanentStorageError(code: LlmMetricsStorageErrorCode | undefined): boolean {
  return code === 'incompatible_schema' || code === 'corrupt' || code === 'permission';
}

/**
 * True when one record's own values failed its INSERT (a constraint, an
 * oversized or unbindable value). The rest of its batch can still commit;
 * storage-level failures (busy, I/O, full, corrupt) are never record-scoped.
 */
export function isRecordScopedSqliteError(error: unknown): boolean {
  const code = errorProperty(error, 'code');
  if (typeof code === 'string' && BIND_ERROR_CODES.has(code)) return true;
  const primary = sqlitePrimaryCode(error);
  return (
    primary === SQLITE_CONSTRAINT ||
    primary === SQLITE_TOOBIG ||
    primary === SQLITE_MISMATCH ||
    primary === SQLITE_RANGE
  );
}
