/**
 * Unit tests for the hash-chained persona policy-mutation audit log.
 *
 * Exercises: one chain shared by every writer (the daemon and each CLI
 * process) through the persisted head and the log lock, on-disk JSONL + 0600
 * mode, and `verifyPolicyMutationLog` / `ironcurtain audit verify` catching
 * an edited, removed, reordered, forged or truncated record.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync, mkdirSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PolicyMutationAuditLog,
  STALE_LOCK_MS,
  computeRecordHash,
  verifyPolicyMutationLog,
  type PolicyMutationRecord,
} from '../src/persona/policy-mutation-audit.js';
import { runAuditCommand } from '../src/audit/audit-command.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-audit-test-${process.pid}`);
const AUDIT_DIR = resolve(TEST_HOME, 'audit');

function logPath(): string {
  return resolve(AUDIT_DIR, 'policy-mutation.jsonl');
}

function headPath(): string {
  return resolve(AUDIT_DIR, 'policy-mutation.head.json');
}

function lockPath(): string {
  return resolve(AUDIT_DIR, 'policy-mutation.lock');
}

function readLines(): string[] {
  return readFileSync(logPath(), 'utf-8').split('\n').filter(Boolean);
}

function readRecords(): PolicyMutationRecord[] {
  return readLines().map((l) => JSON.parse(l) as PolicyMutationRecord);
}

function writeLines(lines: string[]): void {
  writeFileSync(logPath(), lines.map((l) => `${l}\n`).join(''));
}

function appendThree(): void {
  const log = new PolicyMutationAuditLog();
  log.append('cli', 'createPersona', 'a', { constitutionHash: 'aaa' });
  log.append('1.2.3.4#7', 'setPersonaMemory', 'a', { enabled: false });
  log.append('cli', 'deletePersona', 'a', { hardDelete: true });
}

async function auditVerify(): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await runAuditCommand(['verify'], { write: (t) => (out += t), writeError: (t) => (out += t) });
  return { code, out };
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('PolicyMutationAuditLog', () => {
  it('appends JSONL records with monotonic seq, chained prevHash and a SHA-256 hash', () => {
    appendThree();

    const records = readRecords();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(records.map((r) => r.v)).toEqual([2, 2, 2]);
    expect(records[0].prevHash).toBe('');
    expect(records[1].prevHash).toBe(records[0].hash);
    expect(records[2].prevHash).toBe(records[1].hash);
    for (const r of records) expect(computeRecordHash(r)).toBe(r.hash);
    expect(records[0].method).toBe('createPersona');
    expect(records[1].actor).toBe('1.2.3.4#7');

    const head = JSON.parse(readFileSync(headPath(), 'utf-8')) as { seq: number; hash: string };
    expect(head).toMatchObject({ seq: 3, hash: records[2].hash });
    expect(existsSync(lockPath())).toBe(false);
  });

  it('writes the log and head with 0600 mode', () => {
    new PolicyMutationAuditLog().append('cli', 'createPersona', 'p');
    expect(statSync(logPath()).mode & 0o777).toBe(0o600);
    expect(statSync(headPath()).mode & 0o777).toBe(0o600);
  });

  it('creates a missing IronCurtain home with owner-only permissions', () => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    new PolicyMutationAuditLog().append('cli', 'createPersona', 'p');
    expect(statSync(TEST_HOME).mode & 0o777).toBe(0o700);
    expect(statSync(AUDIT_DIR).mode & 0o777).toBe(0o700);
  });

  it('extends ONE chain across writers (a daemon and a CLI process)', () => {
    // Previously each process kept its own seq/prevHash in memory, so a
    // daemon and a CLI appending to the same file produced seq 1,2,1,3 and a
    // chain nobody could verify. The state now lives in the head file.
    const daemon = new PolicyMutationAuditLog();
    const cli = new PolicyMutationAuditLog();
    daemon.append('1.2.3.4#1', 'compilePersonaPolicy', 'a');
    daemon.append('1.2.3.4#1', 'setPersonaMemory', 'a', { enabled: true });
    cli.append('cli', 'createPersona', 'b');
    daemon.append('1.2.3.4#1', 'deletePersona', 'a');
    cli.append('cli', 'setPersonaConstitution', 'b');

    expect(readRecords().map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: true, records: 5, firstSeq: 1, lastSeq: 5 });
  });

  it('continues the chain when an append wrote its line but not the head', () => {
    appendThree();
    const records = readRecords();
    // Simulate a crash between the line write and the head update.
    writeFileSync(headPath(), JSON.stringify({ v: 2, seq: 2, hash: records[1].hash, ts: records[1].ts }));
    const lagging = verifyPolicyMutationLog();
    expect(lagging.ok).toBe(true);
    expect(lagging.notes.join(' ')).toContain('lags');

    new PolicyMutationAuditLog().append('cli', 'createPersona', 'z');
    expect(readRecords().map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: true, records: 4, notes: [] });
  });

  it('keeps one chain when several appends could not move the head (a full disk)', () => {
    // An append can still fit in the log's last block while the head's new
    // temporary file cannot be created. Chaining from that stale head forked
    // the chain (seq 1,2,3,2), and every later verification reported tampering.
    appendThree();
    const records = readRecords();
    writeFileSync(headPath(), JSON.stringify({ v: 2, seq: 1, hash: records[0].hash, ts: records[0].ts }));
    const lagging = verifyPolicyMutationLog();
    expect(lagging.ok).toBe(true);
    expect(lagging.notes.join(' ')).toContain('lags the log by 2 records');

    new PolicyMutationAuditLog().append('cli', 'createPersona', 'z');
    expect(readRecords().map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: true, records: 4, lastSeq: 4, notes: [] });
  });

  it('still reports a replaced record behind a lagging head', () => {
    appendThree();
    const records = readRecords();
    // The head names seq 2 by a hash that is not the chain's record 2.
    writeFileSync(headPath(), JSON.stringify({ v: 2, seq: 2, hash: 'e'.repeat(64), ts: records[1].ts }));
    const result = verifyPolicyMutationLog();
    expect(result.ok).toBe(false);
    expect(result.problem).toMatchObject({ file: 'policy-mutation.head.json', seq: 2 });
    expect(result.problem?.reason).toMatch(/record at seq 2/);
  });

  it('reclaims a lock left by a dead process', () => {
    mkdirSync(AUDIT_DIR, { recursive: true });
    // pid 2^22+ is above the default pid_max: no such process.
    writeFileSync(lockPath(), JSON.stringify({ pid: 4_194_400, ts: new Date().toISOString() }));
    expect(new PolicyMutationAuditLog({ lockTimeoutMs: 1_000 }).append('cli', 'createPersona', 'p')).toBeDefined();
    expect(existsSync(lockPath())).toBe(false);
  });

  it('gives up (without throwing) while a live process holds the lock, and reclaims it once stale', () => {
    mkdirSync(AUDIT_DIR, { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    expect(new PolicyMutationAuditLog({ lockTimeoutMs: 50 }).append('cli', 'createPersona', 'p')).toBeUndefined();
    expect(existsSync(logPath())).toBe(false);

    const old = new Date(Date.now() - STALE_LOCK_MS - 5_000).toISOString();
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, ts: old }));
    expect(new PolicyMutationAuditLog({ lockTimeoutMs: 50 }).append('cli', 'createPersona', 'p')).toBeDefined();
  });

  it('never appends through a symlink planted at the log path', () => {
    mkdirSync(AUDIT_DIR, { recursive: true });
    const target = resolve(TEST_HOME, 'elsewhere.txt');
    writeFileSync(target, 'untouched');
    symlinkSync(target, logPath());
    expect(new PolicyMutationAuditLog().append('cli', 'createPersona', 'p')).toBeUndefined();
    expect(readFileSync(target, 'utf-8')).toBe('untouched');
  });
});

describe('verifyPolicyMutationLog / ironcurtain audit verify', () => {
  it('accepts an untampered chain (and an empty log)', async () => {
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: true, records: 0 });
    appendThree();
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: true, records: 3, legacyRecords: 0 });
    const { code, out } = await auditVerify();
    expect(code).toBe(0);
    expect(out).toContain('Policy-mutation log OK: 3 record(s)');
  });

  it('detects a post-hoc content edit (hash mismatch)', async () => {
    appendThree();
    const lines = readLines();
    const edited = { ...(JSON.parse(lines[0]) as PolicyMutationRecord), actor: 'attacker' };
    writeLines([JSON.stringify(edited), lines[1], lines[2]]);

    const result = verifyPolicyMutationLog();
    expect(result.ok).toBe(false);
    expect(result.problem).toMatchObject({ file: 'policy-mutation.jsonl', line: 1, seq: 1 });
    expect(result.problem?.reason).toMatch(/does not match its hash/);
    const { code, out } = await auditVerify();
    expect(code).toBe(1);
    expect(out).toContain('FAILED verification');
  });

  it('detects a deleted record (seq gap)', () => {
    appendThree();
    const lines = readLines();
    writeLines([lines[0], lines[2]]);
    const result = verifyPolicyMutationLog();
    expect(result.ok).toBe(false);
    expect(result.problem).toMatchObject({ line: 2, seq: 3 });
    expect(result.problem?.reason).toMatch(/expected seq 2/);
  });

  it('detects a reordered chain', () => {
    appendThree();
    const lines = readLines();
    writeLines([lines[1], lines[0], lines[2]]);
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: false, problem: { line: 1 } });
  });

  it('detects a forged record that re-hashes but does not link', () => {
    appendThree();
    const lines = readLines();
    const original = JSON.parse(lines[1]) as PolicyMutationRecord;
    const forgedBody = { ...original, actor: 'attacker', prevHash: 'f'.repeat(64) };
    const forged = { ...forgedBody, hash: computeRecordHash(forgedBody) };
    writeLines([lines[0], JSON.stringify(forged), lines[2]]);
    const result = verifyPolicyMutationLog();
    expect(result.ok).toBe(false);
    expect(result.problem?.reason).toMatch(/does not link/);
  });

  it('detects records removed from the end (truncation) through the head', async () => {
    appendThree();
    writeLines(readLines().slice(0, 2));
    const result = verifyPolicyMutationLog();
    expect(result.ok).toBe(false);
    expect(result.problem).toMatchObject({ file: 'policy-mutation.head.json', seq: 3 });
    expect(result.problem?.reason).toMatch(/newest records were removed/);
    expect((await auditVerify()).code).toBe(1);

    // A later append chains from the head, so the gap stays visible.
    new PolicyMutationAuditLog().append('cli', 'createPersona', 'z');
    expect(verifyPolicyMutationLog().ok).toBe(false);
  });

  it('detects a deleted head and a log emptied behind the head', () => {
    appendThree();
    unlinkSync(headPath());
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: false, problem: { file: 'policy-mutation.head.json' } });

    rmSync(AUDIT_DIR, { recursive: true, force: true });
    appendThree();
    writeFileSync(logPath(), '');
    expect(verifyPolicyMutationLog().problem?.reason).toMatch(/holds no chain records/);
  });

  it('detects a chain that starts after seq 1 in the current file', () => {
    appendThree();
    writeLines(readLines().slice(1));
    expect(verifyPolicyMutationLog().problem?.reason).toMatch(/starts at seq 2/);
  });

  it('counts legacy HMAC records before the chain but refuses one after it', () => {
    mkdirSync(AUDIT_DIR, { recursive: true });
    const legacy = JSON.stringify({
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      actor: 'cli',
      method: 'createPersona',
      persona: 'old',
      details: {},
      prevHash: '',
      hash: 'ab'.repeat(32),
    });
    writeLines([legacy, legacy]);
    appendThree();
    const ok = verifyPolicyMutationLog();
    expect(ok).toMatchObject({ ok: true, records: 3, legacyRecords: 2 });
    expect(ok.notes.join(' ')).toContain('cannot be checked');

    writeLines([...readLines(), legacy]);
    expect(verifyPolicyMutationLog().problem?.reason).toMatch(/without a chain version follows/);
  });

  it('reports a record with nested details instead of crashing, and later appends still work', async () => {
    // A line whose details nest deeply enough to overflow a recursive
    // serializer. Hashing it used to throw a RangeError: `audit verify`
    // crashed, and every later append failed on the chain tip.
    appendThree();
    const records = readRecords();
    const depth = 20_000;
    const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const crafted =
      `{"v":2,"seq":4,"ts":"${new Date().toISOString()}","actor":"x","method":"createPersona","persona":"b",` +
      `"details":{"a":${nested}},"prevHash":"${records[2].hash}","hash":"${'f'.repeat(64)}"}`;
    writeLines([...readLines(), crafted]);

    const result = verifyPolicyMutationLog();
    expect(result.ok).toBe(false);
    expect(result.problem).toMatchObject({ line: 4, reason: expect.stringMatching(/not a policy-mutation record/) });
    expect((await auditVerify()).code).toBe(1);

    const next = new PolicyMutationAuditLog().append('cli', 'createPersona', 'z');
    expect(next).toMatchObject({ seq: 4, prevHash: records[2].hash });
  });

  it('follows the chain across a rotated file', () => {
    appendThree();
    // Rotate by hand the way the writer does: current -> .1.
    writeFileSync(`${logPath()}.1`, readFileSync(logPath()));
    writeFileSync(logPath(), '');
    new PolicyMutationAuditLog().append('cli', 'createPersona', 'next');
    expect(readRecords().map((r) => r.seq)).toEqual([4]);
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: true, records: 4, firstSeq: 1, lastSeq: 4 });

    // The oldest retained file may start later when older files rotated out.
    const rotated = readFileSync(`${logPath()}.1`, 'utf-8').split('\n').filter(Boolean);
    writeFileSync(`${logPath()}.1`, rotated.slice(1).join('\n') + '\n');
    const trimmed = verifyPolicyMutationLog();
    expect(trimmed).toMatchObject({ ok: true, firstSeq: 2 });
    expect(trimmed.notes.join(' ')).toContain('rotated out');
  });
});
