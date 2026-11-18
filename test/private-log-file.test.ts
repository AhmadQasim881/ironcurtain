/**
 * Owner-only session logs: directories 0700, files 0600, whatever the umask,
 * for the LLM interaction logs, interactions.jsonl, audit.jsonl and
 * session.log alike.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendPrivateLog,
  ensurePrivateDirectory,
  preparePrivateLogFile,
} from '../src/observability/private-log-file.js';
import { AuditLog } from '../src/trusted-process/audit-log.js';
import * as logger from '../src/logger.js';
import type { AuditEntry } from '../src/types/audit.js';

let dir: string;
let savedUmask: number;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'private-log-file-'));
  // The most permissive umask: any mode below comes from the code, not from it.
  savedUmask = process.umask(0o000);
});

afterEach(() => {
  process.umask(savedUmask);
  logger.teardown();
  rmSync(dir, { recursive: true, force: true });
});

describe('ensurePrivateDirectory', () => {
  it('creates the directory and its missing parents owner-only', () => {
    ensurePrivateDirectory(join(dir, 'sessions', 'abc'));
    expect(mode(join(dir, 'sessions'))).toBe(0o700);
    expect(mode(join(dir, 'sessions', 'abc'))).toBe(0o700);
  });

  it('tightens an existing directory', () => {
    const existing = join(dir, 'old-session');
    mkdirSync(existing, { mode: 0o755 });
    ensurePrivateDirectory(existing);
    expect(mode(existing)).toBe(0o700);
  });
});

describe('preparePrivateLogFile', () => {
  it('creates the file 0600 in a new 0700 directory', () => {
    const path = join(dir, 'new', 'llm-interactions.jsonl');
    preparePrivateLogFile(path, { truncate: false });
    expect(mode(path)).toBe(0o600);
    expect(mode(join(dir, 'new'))).toBe(0o700);
  });

  it('keeps or empties an existing file and tightens it, leaving its directory alone', () => {
    const path = join(dir, 'log.jsonl');
    writeFileSync(path, 'kept\n', { mode: 0o644 });
    chmodSync(dir, 0o755);

    preparePrivateLogFile(path, { truncate: false });
    expect(readFileSync(path, 'utf-8')).toBe('kept\n');
    expect(mode(path)).toBe(0o600);
    expect(mode(dir)).toBe(0o755);

    preparePrivateLogFile(path, { truncate: true });
    expect(readFileSync(path, 'utf-8')).toBe('');
  });
});

describe('appendPrivateLog', () => {
  it('creates a missing log 0600', () => {
    const path = join(dir, 'recreated.jsonl');
    appendPrivateLog(path, 'line\n');
    appendPrivateLog(path, 'line\n');
    expect(readFileSync(path, 'utf-8')).toBe('line\nline\n');
    expect(mode(path)).toBe(0o600);
  });
});

describe('session logs written by other modules', () => {
  it('audit.jsonl is created 0600 in a 0700 directory', () => {
    const path = join(dir, 'run', 'audit.jsonl');
    const log = new AuditLog(path);
    log.log({
      timestamp: '2026-11-11T00:00:00.000Z',
      requestId: 'r1',
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: {},
      policyDecision: { status: 'allow', rule: 'test', reason: 'test' },
      result: { status: 'success' },
      durationMs: 1,
    } as unknown as AuditEntry);
    expect(mode(path)).toBe(0o600);
    expect(mode(join(dir, 'run'))).toBe(0o700);
  });

  it('session.log is created 0600 in a 0700 directory', () => {
    const path = join(dir, 'state', 'session.log');
    logger.setup({ logFilePath: path });
    logger.info('hello');
    expect(mode(path)).toBe(0o600);
    expect(mode(join(dir, 'state'))).toBe(0o700);
  });
});
