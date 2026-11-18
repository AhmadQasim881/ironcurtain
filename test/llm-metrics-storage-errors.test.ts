import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import { createRateLimitedLog } from '../src/llm-metrics/persistence/health-log.js';
import { LlmMetricsSchemaIncompatibleError } from '../src/llm-metrics/persistence/migrations.js';
import {
  classifyStorageError,
  isPermanentStorageError,
  isRecordScopedSqliteError,
} from '../src/llm-metrics/persistence/storage-errors.js';

function sqliteError(errcode: number, message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: operation failed`), { code });
}

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to throw');
}

describe('LLM metrics storage error classification', () => {
  it('latches only for incompatible schemas, corrupt files, and permission failures', () => {
    const permanent: [unknown, string][] = [
      [new LlmMetricsSchemaIncompatibleError('schema 9 is newer'), 'incompatible_schema'],
      [sqliteError(11, 'database disk image is malformed'), 'corrupt'],
      [sqliteError(26, 'file is not a database'), 'corrupt'],
      [sqliteError(3, 'access permission denied'), 'permission'],
      [sqliteError(8, 'attempt to write a readonly database'), 'permission'],
      [sqliteError(23, 'authorization denied'), 'permission'],
      [errnoError('EACCES'), 'permission'],
      [errnoError('EPERM'), 'permission'],
      [errnoError('EROFS'), 'permission'],
    ];
    for (const [error, code] of permanent) {
      expect(classifyStorageError(error)).toBe(code);
      expect(isPermanentStorageError(classifyStorageError(error))).toBe(true);
    }

    const transient: unknown[] = [
      sqliteError(10, 'disk I/O error'),
      sqliteError(13, 'database or disk is full'),
      sqliteError(14, 'unable to open database file'),
      // SQLITE_READONLY_DBMOVED: a reopen cures it, a permission fix does not.
      sqliteError(1032, 'attempt to write a readonly database'),
      errnoError('ENOSPC'),
      new Error('LLM metrics worker exited with code 1'),
      'not an error',
    ];
    for (const error of transient) {
      expect(isPermanentStorageError(classifyStorageError(error))).toBe(false);
    }
  });

  it('classifies lock contention as busy, including extended result codes', () => {
    for (const error of [
      sqliteError(5, 'database is locked'),
      sqliteError(517, 'database is locked'),
      sqliteError(6, 'database table is locked'),
      Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
    ]) {
      expect(classifyStorageError(error)).toBe('busy');
      expect(isPermanentStorageError('busy')).toBe(false);
    }
  });

  it('scopes constraint and binding failures to one record, never storage failures', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT NOT NULL) STRICT');
    database.exec("INSERT INTO t VALUES (1, 'x')");
    const unique = thrownBy(() => database.exec("INSERT INTO t VALUES (1, 'y')"));
    const notNull = thrownBy(() => database.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(2, null));
    const datatype = thrownBy(() => database.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(2.5, 'z'));
    // `undefined` is no SQL value (the types rule it out): binding it fails.
    const unbindable = thrownBy(() =>
      database.prepare('INSERT INTO t (a, b) VALUES ($a, $b)').run({ a: 3, b: undefined as unknown as SQLInputValue }),
    );
    database.close();

    for (const error of [unique, notNull, datatype, unbindable]) expect(isRecordScopedSqliteError(error)).toBe(true);
    for (const error of [
      sqliteError(5, 'database is locked'),
      sqliteError(10, 'disk I/O error'),
      sqliteError(13, 'database or disk is full'),
      sqliteError(11, 'database disk image is malformed'),
      sqliteError(1, 'no such column: estimated_cost_usd'),
      new Error('Invalid responseStatus'),
    ]) {
      expect(isRecordScopedSqliteError(error)).toBe(false);
    }
  });
});

describe('rate-limited persistence health log', () => {
  it('writes each key at most once per interval and reports what it suppressed', () => {
    let now = 0;
    const sink = vi.fn();
    const log = createRateLimitedLog({ intervalMs: 60_000, sink, now: () => now });

    log.emit('restarting', 'warn', 'writer unavailable (1)');
    log.emit('restarting', 'warn', 'writer unavailable (2)');
    log.emit('restarting', 'warn', 'writer unavailable (3)');
    log.emit('disabled', 'error', 'persistence disabled');
    now = 59_999;
    log.emit('restarting', 'warn', 'writer unavailable (4)');
    now = 60_000;
    log.emit('restarting', 'warn', 'writer unavailable (5)');
    now = 120_000;
    log.emit('restarting', 'warn', 'writer unavailable (6)');

    expect(sink.mock.calls).toEqual([
      ['warn', 'writer unavailable (1)'],
      ['error', 'persistence disabled'],
      ['warn', 'writer unavailable (5) (3 similar message(s) suppressed)'],
      ['warn', 'writer unavailable (6)'],
    ]);
  });

  it('never lets a failing sink escape into persistence', () => {
    const log = createRateLimitedLog({
      intervalMs: 1,
      sink: () => {
        throw new Error('log file gone');
      },
    });
    expect(() => log.emit('degraded', 'warn', 'writer degraded')).not.toThrow();
  });
});
