/**
 * Explicit, local statistics maintenance that is not part of the hot path:
 * compacting the database after a full reset. Called only from the
 * `ironcurtain statistics reset` command, never from proxies or the daemon.
 */

import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { assertLlmMetricsSchemaCompatible } from './migrations.js';
import { SQLITE_BUSY_TIMEOUT_MS, withSqliteBusyRetry } from './sqlite-busy-retry.js';

export interface LlmMetricsCompactionResult {
  /** False when another connection still reads an older snapshot, so old WAL frames remain until its next checkpoint. */
  readonly walTruncated: boolean;
}

function restrictMode(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

/**
 * Rebuild the database file without free pages (VACUUM) and truncate the
 * write-ahead log, so deleted rows no longer linger in unused pages or WAL
 * frames. Fails (SQLITE_BUSY after bounded retries) while another process
 * holds a write transaction. Snapshots, backups and filesystem copies are
 * outside its reach.
 *
 * VACUUM rewrites the file, so it runs only where this binary may write: the
 * current schema, or a newer one whose stored compatibility range admits
 * this writer (as the writer worker checks before every batch). VACUUM keeps
 * the schema and its `user_version` unchanged.
 */
export function compactLlmMetricsDatabase(databasePath: string): LlmMetricsCompactionResult {
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    assertLlmMetricsSchemaCompatible(database, 'writer');
    withSqliteBusyRetry(() => database.exec('VACUUM'));
    const checkpoint = withSqliteBusyRetry(() => database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());
    return { walTruncated: checkpoint?.busy === 0 };
  } finally {
    database.close();
    for (const suffix of ['', '-wal', '-shm']) restrictMode(`${databasePath}${suffix}`);
  }
}
