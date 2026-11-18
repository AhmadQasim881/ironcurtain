/**
 * Tests for AuditLog write-error handling.
 *
 * Writes are synchronous (`appendFileSync`), so failures surface at
 * the call site — no async `'error'` event, no timing windows. The
 * tests pin down the fail-closed contract:
 *
 *   - `log()` throws synchronously when the underlying write fails.
 *   - The error is cached: subsequent `log()` calls rethrow the same
 *     error without attempting another write (idempotent failure
 *     surface so a retry loop can't mask the root cause).
 *   - `close()` is a no-op after an error and never throws.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_LOG_UNAVAILABLE, AuditLog, isAuditLogUnavailableError } from '../src/trusted-process/audit-log.js';
import type { AuditEntry } from '../src/types/audit.js';

/** Runs `fn` and returns what it threw; fails if it returned. */
function captureThrow(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

function makeEntry(): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    requestId: 'req-1',
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: '/tmp/x' },
    policyDecision: { status: 'allow', rule: 'test-rule', reason: 'test' },
    result: { status: 'success' },
    durationMs: 1,
  };
}

describe('AuditLog write-error handling', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('log() throws synchronously when the write fails', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-err-'));
    // A *file* sits where the AuditLog expects a directory, so the
    // ctor's `mkdirSync(dirname(path), { recursive: true })` fails
    // synchronously with ENOTDIR. The ctor latches the error and the
    // first `log()` rethrows it — the caller experiences the same
    // fail-closed contract regardless of which layer noticed first.
    const notADir = join(tmpDir, 'im-a-file');
    writeFileSync(notADir, '');
    const badPath = join(notADir, 'audit.jsonl');

    const log = new AuditLog(badPath);

    expect(() => log.log(makeEntry())).toThrow(/AuditLog stream error/);
    // The thrown message MUST include the underlying errno string so
    // operators can diagnose the failure. Which errno fires depends on
    // the platform and on whether ctor's mkdirSync or log's
    // appendFileSync noticed first — EEXIST (macOS, mkdir sees a file
    // at the target), ENOTDIR (Linux, appendFileSync descends through
    // a file), or ENOENT (parent dir truly missing).
    expect(() => log.log(makeEntry())).toThrow(/EEXIST|ENOTDIR|ENOENT/);
  });

  it('log() is idempotent after an error: the same cached error is rethrown', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-err-'));
    const notADir = join(tmpDir, 'im-a-file');
    writeFileSync(notADir, '');
    const badPath = join(notADir, 'audit.jsonl');

    const log = new AuditLog(badPath);

    let firstError: unknown;
    try {
      log.log(makeEntry());
    } catch (err) {
      firstError = err;
    }
    expect(firstError).toBeInstanceOf(Error);

    let secondError: unknown;
    try {
      log.log(makeEntry());
    } catch (err) {
      secondError = err;
    }
    expect(secondError).toBeInstanceOf(Error);
    // The messages must match — a retry after latched failure must
    // not paper over the root cause by attempting another write with
    // a potentially different errno.
    expect((secondError as Error).message).toBe((firstError as Error).message);
  });

  it('close() is a no-op and does not throw after a write failure', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-err-'));
    const notADir = join(tmpDir, 'im-a-file');
    writeFileSync(notADir, '');
    const badPath = join(notADir, 'audit.jsonl');

    const log = new AuditLog(badPath);
    expect(() => log.log(makeEntry())).toThrow();

    await expect(log.close()).resolves.toBeUndefined();
    // Second close() is also a no-op.
    await expect(log.close()).resolves.toBeUndefined();
  });

  it('close() does not throw when the ctor failed before any log()', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-err-'));
    const notADir = join(tmpDir, 'im-a-file');
    writeFileSync(notADir, '');
    const badPath = join(notADir, 'audit.jsonl');

    const log = new AuditLog(badPath);
    await expect(log.close()).resolves.toBeUndefined();
  });
});

/**
 * `assertWritable()` is the pipeline's pre-flight check: it surfaces a
 * latched failure (or a closed log) BEFORE a tool call is evaluated, so
 * the call is refused instead of running unaudited. Every failure the
 * log raises carries the `AUDIT_LOG_UNAVAILABLE` code, which is how the
 * coordinator recognises it without an `instanceof` across modules.
 */
describe('AuditLog.assertWritable() and the AUDIT_LOG_UNAVAILABLE code', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes on a healthy log, before and after successful writes', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-ok-'));
    const log = new AuditLog(join(tmpDir, 'audit.jsonl'));

    expect(() => log.assertWritable()).not.toThrow();
    log.log(makeEntry());
    expect(() => log.assertWritable()).not.toThrow();
  });

  it('throws the latched ctor failure with the code, before any write was attempted', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-err-'));
    const notADir = join(tmpDir, 'im-a-file');
    writeFileSync(notADir, '');
    const log = new AuditLog(join(notADir, 'audit.jsonl'));

    const err = captureThrow(() => log.assertWritable());
    expect(isAuditLogUnavailableError(err)).toBe(true);
    expect((err as Error).message).toMatch(/AuditLog stream error/);
    expect((err as { code?: string }).code).toBe(AUDIT_LOG_UNAVAILABLE);
  });

  it('latches a failure that first surfaces on a write, and a repaired path does not clear it', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-err-'));
    const auditPath = join(tmpDir, 'audit.jsonl');
    const log = new AuditLog(auditPath);
    log.log(makeEntry());

    // A directory now sits where the file was: the next append fails
    // (EISDIR). The check cannot foresee a failure that has not happened
    // yet -- that is why the pipeline also writes a `dispatching` record
    // before every dispatch -- but once a write failed, it reports it.
    rmSync(auditPath);
    mkdirSync(auditPath);
    expect(() => log.assertWritable()).not.toThrow();

    const err = captureThrow(() => log.log(makeEntry()));
    expect(isAuditLogUnavailableError(err)).toBe(true);
    expect((err as Error).message).toMatch(/EISDIR|ENOTDIR|EEXIST/);
    expect(() => log.assertWritable()).toThrow(/AuditLog stream error/);

    // Repairing the path does not reopen the log: the gap in the record
    // is permanent for this session, so the session must end.
    rmSync(auditPath, { recursive: true, force: true });
    expect(() => log.assertWritable()).toThrow(/AuditLog stream error/);
    expect(() => log.log(makeEntry())).toThrow(/AuditLog stream error/);
    expect(existsSync(auditPath)).toBe(false);
  });

  it('throws with the code after close()', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-ok-'));
    const log = new AuditLog(join(tmpDir, 'audit.jsonl'));
    await log.close();

    expect(isAuditLogUnavailableError(captureThrow(() => log.assertWritable()))).toBe(true);
    expect(isAuditLogUnavailableError(captureThrow(() => log.log(makeEntry())))).toBe(true);
  });

  it('isAuditLogUnavailableError goes by the code, not the class', () => {
    const foreign = Object.assign(new Error('AuditLog stream error: ENOSPC'), { code: AUDIT_LOG_UNAVAILABLE });
    expect(isAuditLogUnavailableError(foreign)).toBe(true);
    expect(isAuditLogUnavailableError(new Error('AuditLog stream error: ENOSPC'))).toBe(false);
    expect(isAuditLogUnavailableError(AUDIT_LOG_UNAVAILABLE)).toBe(false);
    expect(isAuditLogUnavailableError(undefined)).toBe(false);
  });
});
