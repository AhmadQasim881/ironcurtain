/**
 * src/persona/policy-mutation-audit.ts
 *
 * Hash-chained, append-only audit log of persona policy mutations (Phase 1c,
 * §7).
 *
 * Every mutating persona-service function (createPersona / setPersonaConstitution
 * / setPersonaMemory / deletePersona / setPersonaBroadPolicyOptIn /
 * setPersonaOverrides / clonePersona / renamePersona / restorePersona /
 * purgePersonaTrash) and the shared compile path (`runPersonaCompile`,
 * persona-compile-service.ts, which CLI and web-UI compiles both take) append
 * one record here, so the CLI and the WS dispatch are both captured at the
 * service layer (not the WS boundary).
 *
 * Files, all under `$IRONCURTAIN_HOME/audit/` (directory 0700, files 0600):
 *   - `policy-mutation.jsonl`      the log, one JSON record per line. Size-
 *                                  rotated at ~10 MB (current -> `.1`, `.1` ->
 *                                  `.2`, ... up to `.3`; the oldest is dropped).
 *   - `policy-mutation.head.json`  the chain head: `seq` and `hash` of the
 *                                  newest record, replaced atomically after
 *                                  every append.
 *   - `policy-mutation.lock`       created exclusively (O_EXCL) while a process
 *                                  appends or verifies. A lock whose holder is
 *                                  dead, or that is older than
 *                                  {@link STALE_LOCK_MS}, is reclaimed.
 *
 * Chain. Each record carries a monotonic `seq`, the `prevHash` of the record
 * before it (empty for seq 1) and its own `hash`, a SHA-256 over its canonical
 * content. Appends from every process (the daemon, each CLI `persona`
 * invocation) take the lock, read the persisted head and extend that one
 * chain, so the file never holds interleaved per-process chains. A record is
 * fsynced before the head moves, and an append whose head update failed is
 * picked up by the next one (see `chainTip`).
 * `verifyPolicyMutationLog` (`ironcurtain audit verify`) re-hashes every
 * record, follows the links across the rotated files and checks the head
 * against the chain (the newest record, or the record at the head's seq when
 * appends could not move the head), so it reports an edited record, a removed
 * or reordered record, and records removed from the end (truncation).
 *
 * HONEST SCOPE: the chain is keyless. It detects accidental corruption and an
 * edit by anyone who does not also rewrite every later record and the head;
 * a local user who can write `~/.ironcurtain` can recompute a consistent chain
 * (or bypass the service and write policy files directly), so the log is
 * tamper-EVIDENT against careless edits, not tamper-PROOF. Records written by
 * releases that HMAC'd the chain with a per-process secret (no `v` field) can
 * no longer be checked; verification counts them as legacy records.
 *
 * Appends are best effort: a failed write never blocks the mutation it
 * describes.
 *
 * ZERO runtime value-imports from src/pipeline — type-only imports only.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §7
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { getAuditDir } from '../config/paths.js';
import { readUntrustedRegularFile, writeFileNoFollowAtomic } from '../hardened-fs.js';

/** Mutation methods recorded in the audit log. */
export type PolicyMutationMethod =
  | 'createPersona'
  | 'setPersonaConstitution'
  | 'setPersonaMemory'
  | 'deletePersona'
  | 'setPersonaBroadPolicyOptIn'
  | 'setPersonaOverrides'
  | 'compilePersonaPolicy'
  // Persona lifecycle: the record's `persona` is the new persona (clone), the
  // new name (rename), the name restored to (restore) or the purged entry's
  // persona (purge); `details` names the other side.
  | 'clonePersona'
  | 'renamePersona'
  | 'restorePersona'
  | 'purgePersonaTrash';

/** Optional structured details about the mutation's effect. */
export interface PolicyMutationDetails {
  /** sha256 hex of the constitution file content (where applicable). */
  readonly constitutionHash?: string;
  /** Rule-count delta vs the previous compiled policy (compiles). */
  readonly ruleCountDelta?: number;
  /**
   * True when the resulting policy has broad access: a compile whose written
   * policy has a broad wildcard (dynamic lists included), an out-of-workspace
   * path or an unconstrained resource argument on an `allow` rule (see
   * `hasBroadAccess` in broad-policy-validator.ts), first compiles included;
   * or an opt-in to broad policy.
   */
  readonly broadened?: boolean;
  /** Operation id tying a compile record to its llm-interactions log. */
  readonly operationId?: string;
  /**
   * Compiles: how the compile ended. `written`: a new policy was written.
   * `rejected`: the broad-policy validator refused the result (the persona
   * is not opted in). `failed`: the compile failed. Nothing is written in the
   * last two cases. Every compile that ran gets exactly one record, whether
   * started from the CLI or the web UI.
   */
  readonly outcome?: 'written' | 'rejected' | 'failed';
  /** Compiles that wrote nothing: the typed error code (e.g. `BROAD_POLICY_REJECTED`). */
  readonly errorCode?: string;
  /** Whether a delete was a hard (force) delete vs a soft (trash) delete. */
  readonly hardDelete?: boolean;
  /** New value for setPersonaMemory / setPersonaBroadPolicyOptIn. */
  readonly enabled?: boolean;
  /**
   * True when the persona's compiled policy was moved aside, so sessions
   * refuse the persona until it is recompiled: a broad-policy opt-out whose
   * policy needed the opt-in, or a rename (and a restore under another name),
   * whose policy was compiled for the old workspace path.
   */
  readonly policyRevoked?: boolean;
  /**
   * setPersonaOverrides: the persona's agent model after the change (null:
   * removed). clonePersona: the model the clone copied, when the source sets one.
   */
  readonly agentModelId?: string | null;
  /**
   * setPersonaOverrides: the persona's resource limits after the change, as
   * JSON with sorted keys (a `null` limit is disabled), or null when the
   * persona no longer sets any. clonePersona: the limits the clone copied,
   * the same way, when the source sets any. A string, not an object: details
   * stay flat (see `isFlatDetails`), so the record verifies like every other
   * one.
   */
  readonly resourceBudget?: string | null;
  /** clonePersona: the persona the new one was copied from. */
  readonly source?: string;
  /** renamePersona, and restorePersona under another name: the name before. */
  readonly previousName?: string;
  /**
   * The trash entry involved: where a soft delete put the persona, the entry
   * a restore took it from, or the entry a purge removed.
   */
  readonly trashEntry?: string;
  /** restorePersona with force: the trash entry the replaced persona was moved to. */
  readonly replacedTrashEntry?: string;
  /** purgePersonaTrash: true when the retention sweep (or `--expired`) purged it. */
  readonly expired?: boolean;
}

/** Chain format version of the records this module writes. */
export const POLICY_MUTATION_LOG_VERSION = 2;

/** A single persisted audit record. */
export interface PolicyMutationRecord {
  readonly v: typeof POLICY_MUTATION_LOG_VERSION;
  readonly seq: number;
  readonly ts: string;
  readonly actor: string;
  readonly method: PolicyMutationMethod;
  readonly persona: string;
  readonly details: PolicyMutationDetails;
  /** `hash` of the previous record (empty string for seq 1). */
  readonly prevHash: string;
  /** SHA-256 (hex) over this record's canonical content (v..prevHash). */
  readonly hash: string;
}

/** The persisted chain head: the newest record's position and hash. */
interface ChainHead {
  readonly v: typeof POLICY_MUTATION_LOG_VERSION;
  readonly seq: number;
  readonly hash: string;
  readonly ts: string;
}

export const POLICY_MUTATION_LOG_FILENAME = 'policy-mutation.jsonl';
const HEAD_FILENAME = 'policy-mutation.head.json';
const LOCK_FILENAME = 'policy-mutation.lock';

/** ~10 MB rotation threshold. */
const ROTATION_BYTES = 10 * 1024 * 1024;
/** How many rotated files to keep (.1 .. .N). */
const MAX_ROTATIONS = 3;
/** How long an append or a verification waits for the lock. */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** A lock older than this belongs to a crashed holder (an append takes milliseconds). */
export const STALE_LOCK_MS = 30_000;
/** Bytes read from the end of a log file to find its newest record. */
const TAIL_BYTES = 64 * 1024;
/** Largest record line accepted when verifying. */
const MAX_RECORD_LINE_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const METHODS: ReadonlySet<string> = new Set<PolicyMutationMethod>([
  'createPersona',
  'setPersonaConstitution',
  'setPersonaMemory',
  'deletePersona',
  'setPersonaBroadPolicyOptIn',
  'setPersonaOverrides',
  'compilePersonaPolicy',
  'clonePersona',
  'renamePersona',
  'restorePersona',
  'purgePersonaTrash',
]);

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every level, so the hash survives key reordering. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash a record must carry: SHA-256 over every field except `hash`. */
export function computeRecordHash(record: Omit<PolicyMutationRecord, 'hash'>): string {
  const { v, seq, ts, actor, method, persona, details, prevHash } = record;
  const canonical = canonicalJson({ v, seq, ts, actor, method, persona, details, prevHash });
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * True for a `details` object as this module writes it: flat, with string,
 * number or boolean values (or `null`, what JSON makes of a non-finite number)
 * only (see {@link PolicyMutationDetails}). Anything nested is refused before
 * it is hashed, so a crafted line cannot make the canonical serialization
 * recurse until the stack overflows (which would crash `audit verify` and make
 * every later append fail on the chain tip).
 */
function isFlatDetails(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

/** A v2 record, shape-checked (its hash is checked separately). */
function parseRecord(value: unknown): PolicyMutationRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (r.v !== POLICY_MUTATION_LOG_VERSION) return undefined;
  if (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || r.seq < 1) return undefined;
  if (typeof r.ts !== 'string' || typeof r.actor !== 'string' || typeof r.persona !== 'string') return undefined;
  if (typeof r.method !== 'string' || !METHODS.has(r.method)) return undefined;
  if (!isFlatDetails(r.details)) return undefined;
  if (typeof r.prevHash !== 'string' || (r.prevHash !== '' && !SHA256_HEX.test(r.prevHash))) return undefined;
  if (typeof r.hash !== 'string' || !SHA256_HEX.test(r.hash)) return undefined;
  return value as PolicyMutationRecord;
}

/** A record written by the HMAC-chained releases: no `v`, but the old chain fields. */
function isLegacyRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === undefined &&
    typeof r.seq === 'number' &&
    typeof r.hash === 'string' &&
    typeof r.prevHash === 'string' &&
    typeof r.method === 'string'
  );
}

function parseHead(value: unknown): ChainHead | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const h = value as Record<string, unknown>;
  if (h.v !== POLICY_MUTATION_LOG_VERSION) return undefined;
  if (typeof h.seq !== 'number' || !Number.isSafeInteger(h.seq) || h.seq < 1) return undefined;
  if (typeof h.hash !== 'string' || !SHA256_HEX.test(h.hash)) return undefined;
  if (typeof h.ts !== 'string') return undefined;
  return { v: POLICY_MUTATION_LOG_VERSION, seq: h.seq, hash: h.hash, ts: h.ts };
}

type HeadState = { readonly kind: 'missing' } | { readonly kind: 'invalid' } | { readonly kind: 'ok'; head: ChainHead };

function readHead(auditDir: string): HeadState {
  let text: string;
  try {
    text = readUntrustedRegularFile(resolve(auditDir, HEAD_FILENAME), { maxBytes: 4096 }).bytes.toString('utf8');
  } catch (err) {
    return (err as { code?: unknown }).code === 'NOT_FOUND' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  try {
    const head = parseHead(JSON.parse(text));
    return head ? { kind: 'ok', head } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/** The newest v2 record in one log file, read from its tail; undefined when it has none. */
function lastRecordIn(path: string): PolicyMutationRecord | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size === 0) return undefined;
    const start = Math.max(0, stats.size - TAIL_BYTES);
    const buffer = Buffer.alloc(stats.size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    // A tail that starts mid-file starts mid-line: drop that fragment.
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (line === '') continue;
      try {
        return parseRecord(JSON.parse(line));
      } catch {
        return undefined;
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: it exists but is not ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when the lock content names a dead holder or is too old (or unreadable and old). */
function isStaleLock(content: string | undefined, mtimeMs: number, now: number): boolean {
  if (content !== undefined) {
    try {
      const parsed = JSON.parse(content) as { pid?: unknown; ts?: unknown };
      const startedAt = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : Number.NaN;
      if (typeof parsed.pid === 'number' && !isPidAlive(parsed.pid)) return true;
      if (!Number.isNaN(startedAt)) return now - startedAt > STALE_LOCK_MS;
    } catch {
      // Unparseable (a holder crashed mid-write): fall back to the file's age.
    }
  }
  return now - mtimeMs > STALE_LOCK_MS;
}

/**
 * The lock file's content and modification time, or undefined when it is gone.
 * Read without following a link or blocking on a FIFO; content that cannot be
 * read that way is reported as undefined (judged by age alone).
 */
function readLockContent(lockPath: string): { content: string | undefined; mtimeMs: number } | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = lstatSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
  let content: string | undefined;
  try {
    content = readUntrustedRegularFile(lockPath, { maxBytes: 4096 }).bytes.toString('utf8');
  } catch {
    content = undefined;
  }
  return { content, mtimeMs };
}

/**
 * Takes the log lock, reclaiming a stale one. Returns the release function, or
 * undefined when the lock stayed busy for `timeoutMs` or cannot be created.
 */
function acquireLock(auditDir: string, timeoutMs: number): (() => void) | undefined {
  const lockPath = resolve(auditDir, LOCK_FILENAME);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone (reclaimed as stale by another process).
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
    // Retry at once when the lock went away or was reclaimed; otherwise wait.
    let retryNow = false;
    const seen = readLockContent(lockPath);
    if (seen === undefined) {
      retryNow = true;
    } else if (isStaleLock(seen.content, seen.mtimeMs, Date.now())) {
      // Remove it only if it is still the lock we judged stale.
      const again = readLockContent(lockPath);
      if (again === undefined || again.content !== seen.content || again.mtimeMs !== seen.mtimeMs) {
        retryNow = true;
      } else {
        try {
          unlinkSync(lockPath);
          retryNow = true;
        } catch {
          // Cannot remove it: wait out the deadline like a busy lock.
        }
      }
    }
    if (Date.now() >= deadline) return undefined;
    if (!retryNow) sleepSync(5);
  }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface PolicyMutationAuditLogOptions {
  /** Audit directory (default `$IRONCURTAIN_HOME/audit`, resolved at each append). */
  readonly auditDir?: string;
  /** How long an append waits for the lock (default 5 s). */
  readonly lockTimeoutMs?: number;
}

/**
 * Appends records to the shared chain. Any number of instances, in any number
 * of processes, extend the same chain: the state lives on disk (the head file),
 * not in the instance.
 */
export class PolicyMutationAuditLog {
  private readonly options: PolicyMutationAuditLogOptions;

  constructor(options: PolicyMutationAuditLogOptions = {}) {
    this.options = options;
  }

  private auditDir(): string {
    return this.options.auditDir ?? getAuditDir();
  }

  /**
   * Appends one audit record. Best-effort and non-throwing: a failed audit
   * write must never block a persona mutation (the mutation has already
   * happened or is about to). Returns the written record, or undefined when
   * it could not be written (lock busy, I/O error).
   */
  append(
    actor: string,
    method: PolicyMutationMethod,
    persona: string,
    details: PolicyMutationDetails = {},
  ): PolicyMutationRecord | undefined {
    const auditDir = this.auditDir();
    try {
      mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    } catch {
      return undefined;
    }
    const release = acquireLock(auditDir, this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    if (release === undefined) return undefined;
    try {
      const logPath = resolve(auditDir, POLICY_MUTATION_LOG_FILENAME);
      const previous = chainTip(auditDir, logPath);
      const unhashed: Omit<PolicyMutationRecord, 'hash'> = {
        v: POLICY_MUTATION_LOG_VERSION,
        seq: (previous?.seq ?? 0) + 1,
        ts: new Date().toISOString(),
        actor,
        method,
        persona,
        details,
        prevHash: previous?.hash ?? '',
      };
      const record: PolicyMutationRecord = { ...unhashed, hash: computeRecordHash(unhashed) };
      rotateIfNeeded(logPath);
      appendLine(logPath, JSON.stringify(record) + '\n');
      try {
        const head: ChainHead = { v: POLICY_MUTATION_LOG_VERSION, seq: record.seq, hash: record.hash, ts: record.ts };
        writeFileNoFollowAtomic(auditDir, HEAD_FILENAME, JSON.stringify(head) + '\n', 0o600);
      } catch {
        // The record is on disk; the next append finds it as the head's
        // successor and moves the head on (see chainTip).
      }
      return record;
    } catch {
      // Never let an audit failure surface as a mutation failure.
      return undefined;
    } finally {
      release();
    }
  }
}

/**
 * The record the next append links to. The head is authoritative, except when
 * the newest record on disk is newer than it and intact: appends then wrote
 * their lines but could not move the head (an append interrupted between the
 * two writes, or head writes failing while the log still takes lines, as on a
 * full disk where an append can fit in the log's last block). Continuing from
 * that record keeps ONE chain; chaining from the stale head instead would fork
 * it (seq 1,2,3,2) and every later verification would report tampering.
 * Verification still checks every link, and that the head matches the chain
 * record at its seq. Without a head (a fresh install, or one that only has
 * legacy records) the newest record on disk is used, or none.
 */
function chainTip(auditDir: string, logPath: string): { seq: number; hash: string } | undefined {
  const head = readHead(auditDir);
  const last = lastRecordIn(logPath) ?? lastRecordIn(`${logPath}.1`);
  if (head.kind === 'ok') {
    const { head: h } = head;
    if (last !== undefined && last.seq > h.seq && computeRecordHash(last) === last.hash) return last;
    // Chaining from the head when the file is behind it (records removed
    // from the end) or disagrees with it keeps the break visible.
    return h;
  }
  return last;
}

/**
 * Appends one line (O_APPEND, mode 0600). O_NOFOLLOW refuses a symlink at the
 * path and O_NONBLOCK keeps a FIFO from blocking the open. The line is made
 * durable (fsync) before this returns: the head written after it is fsynced
 * too, and a head that reached the disk ahead of its record would make a
 * power loss look like records removed from the end of the log.
 */
function appendLine(path: string, line: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      constants.O_NOCTTY,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`not a regular file: ${path}`);
    // The mode passed to open only applies on creation; enforce 0600 on an
    // existing log too. fchmod targets the open descriptor.
    fchmodSync(fd, 0o600);
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Size-based rotation: current -> .1, .1 -> .2, ... up to MAX_ROTATIONS. */
function rotateIfNeeded(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return; // No file yet — nothing to rotate.
  }
  if (size < ROTATION_BYTES) return;

  // Shift older files down: .2 -> .3, .1 -> .2, current -> .1.
  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    const from = `${path}.${i}`;
    const to = `${path}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        // Best-effort.
      }
    }
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Where verification found the first problem. */
export interface PolicyMutationLogProblem {
  /** Log file (base name, e.g. `policy-mutation.jsonl.1`), or the head file. */
  readonly file: string;
  /** 1-based line number within `file`, when the problem is a line. */
  readonly line?: number;
  readonly seq?: number;
  readonly reason: string;
}

export interface PolicyMutationVerifyResult {
  readonly ok: boolean;
  /** Chain (v2) records checked before the first problem. */
  readonly records: number;
  /** Records from HMAC-chained releases, which cannot be checked. */
  readonly legacyRecords: number;
  readonly firstSeq?: number;
  readonly lastSeq?: number;
  /** The first problem, when `ok` is false. */
  readonly problem?: PolicyMutationLogProblem;
  /** Observations that do not break the chain (rotation, an interrupted append, no lock). */
  readonly notes: readonly string[];
}

export interface VerifyPolicyMutationLogOptions {
  readonly auditDir?: string;
  readonly lockTimeoutMs?: number;
}

/** The log files that exist, oldest first. */
function logFilesOldestFirst(logPath: string): string[] {
  const files: string[] = [];
  for (let i = MAX_ROTATIONS; i >= 1; i -= 1) {
    if (existsSync(`${logPath}.${i}`)) files.push(`${logPath}.${i}`);
  }
  if (existsSync(logPath)) files.push(logPath);
  return files;
}

/** Reads one log file without following a link; a FIFO or device is refused, never opened blocking. */
function readLogFile(path: string): string {
  // Rotation bounds each file near ROTATION_BYTES; allow one large final record.
  return readUntrustedRegularFile(path, { maxBytes: ROTATION_BYTES + MAX_RECORD_LINE_BYTES }).bytes.toString('utf8');
}

/**
 * Verifies the policy-mutation log: every record re-hashes to its `hash`, each
 * links to the one before it (`seq` + 1, `prevHash`), across the rotated files,
 * and the persisted head matches the newest record, or (when appends wrote
 * records but could not move the head) the chain's record at the head's seq.
 * Reads under the log lock so it never sees an append half done; when the
 * lock stays busy it reads anyway and says so in `notes`. Never throws.
 */
export function verifyPolicyMutationLog(options: VerifyPolicyMutationLogOptions = {}): PolicyMutationVerifyResult {
  const auditDir = options.auditDir ?? getAuditDir();
  const notes: string[] = [];
  const release = existsSync(auditDir)
    ? acquireLock(auditDir, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
    : undefined;
  if (release === undefined && existsSync(auditDir)) {
    notes.push(
      'The log lock could not be taken; the log was read without it, so an append in progress may show as a problem.',
    );
  }
  try {
    return verifyUnlocked(auditDir, notes);
  } catch (err) {
    // Whatever the files hold, verification reports a failure instead of
    // throwing (the record shape check already refuses nested content).
    return {
      ok: false,
      records: 0,
      legacyRecords: 0,
      problem: {
        file: POLICY_MUTATION_LOG_FILENAME,
        reason: `verification could not complete: ${err instanceof Error ? err.message : String(err)}`,
      },
      notes,
    };
  } finally {
    release?.();
  }
}

function verifyUnlocked(auditDir: string, notes: string[]): PolicyMutationVerifyResult {
  const logPath = resolve(auditDir, POLICY_MUTATION_LOG_FILENAME);
  const files = logFilesOldestFirst(logPath);
  // Read first, so the walk can check the chain record at the head's seq.
  const head = readHead(auditDir);
  const headSeq = head.kind === 'ok' ? head.head.seq : undefined;
  /** The chain record at the head's seq, once the walk reaches it. */
  let atHeadSeq: PolicyMutationRecord | undefined;
  let records = 0;
  let legacyRecords = 0;
  let firstSeq: number | undefined;
  let previous: PolicyMutationRecord | undefined;
  const fail = (problem: PolicyMutationLogProblem): PolicyMutationVerifyResult => ({
    ok: false,
    records,
    legacyRecords,
    ...(firstSeq !== undefined ? { firstSeq } : {}),
    ...(previous !== undefined ? { lastSeq: previous.seq } : {}),
    problem,
    notes,
  });

  for (const [fileIndex, path] of files.entries()) {
    const file = basename(path);
    let text: string;
    try {
      text = readLogFile(path);
    } catch (err) {
      return fail({ file, reason: `cannot read the file: ${err instanceof Error ? err.message : String(err)}` });
    }
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (const [lineIndex, raw] of lines.entries()) {
      const line = lineIndex + 1;
      if (raw.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return fail({ file, line, reason: 'the line is not valid JSON (edited or truncated)' });
      }
      const record = parseRecord(parsed);
      if (record === undefined) {
        if (isLegacyRecord(parsed)) {
          if (previous !== undefined) {
            return fail({
              file,
              line,
              reason:
                'a record without a chain version follows the hash chain; ' +
                'an older IronCurtain process may still be running, or the log was edited',
            });
          }
          legacyRecords += 1;
          continue;
        }
        return fail({ file, line, reason: 'the line is not a policy-mutation record' });
      }
      if (computeRecordHash(record) !== record.hash) {
        return fail({ file, line, seq: record.seq, reason: 'the record does not match its hash (it was edited)' });
      }
      if (previous === undefined) {
        firstSeq = record.seq;
        if (record.seq !== 1 || record.prevHash !== '') {
          // Only rotation explains a chain that starts later: the first line
          // of the oldest retained rotated file.
          const rotatedStart = fileIndex === 0 && path !== logPath && records === 0 && legacyRecords === 0;
          if (!rotatedStart) {
            return fail({
              file,
              line,
              seq: record.seq,
              reason: `the chain starts at seq ${record.seq}: the records before it are missing`,
            });
          }
          notes.push(`The retained log starts at seq ${record.seq}; older records were rotated out.`);
        }
      } else {
        if (record.seq !== previous.seq + 1) {
          return fail({
            file,
            line,
            seq: record.seq,
            reason: `expected seq ${previous.seq + 1} after seq ${previous.seq}, found seq ${record.seq} (records removed or reordered)`,
          });
        }
        if (record.prevHash !== previous.hash) {
          return fail({
            file,
            line,
            seq: record.seq,
            reason: `seq ${record.seq} does not link to seq ${previous.seq} (a record was replaced)`,
          });
        }
      }
      if (record.seq === headSeq) atHeadSeq = record;
      previous = record;
      records += 1;
    }
  }

  if (legacyRecords > 0) {
    notes.push(
      `${legacyRecords} record(s) from an older release are HMAC-chained with a per-process secret and cannot be checked.`,
    );
  }

  if (head.kind === 'invalid') return fail({ file: HEAD_FILENAME, reason: 'the chain head file is unreadable' });
  if (previous === undefined) {
    if (head.kind === 'ok') {
      return fail({
        file: HEAD_FILENAME,
        seq: head.head.seq,
        reason: `the head records seq ${head.head.seq} but the log holds no chain records (the log was removed or truncated)`,
      });
    }
    return { ok: true, records, legacyRecords, notes };
  }
  const done = { ok: true, records, legacyRecords, firstSeq, lastSeq: previous.seq, notes };
  if (head.kind === 'missing') {
    return fail({
      file: HEAD_FILENAME,
      reason: 'the chain head is missing, so records removed from the end cannot be detected',
    });
  }
  const { head: h } = head;
  if (h.seq === previous.seq && h.hash === previous.hash) return done;
  if (h.seq < previous.seq && atHeadSeq?.hash === h.hash) {
    // Appends wrote their records but could not move the head (interrupted,
    // or the head write failed, e.g. on a full disk); the next append moves it.
    const lag = previous.seq - h.seq;
    notes.push(
      `The head lags the log by ${lag === 1 ? 'one record' : `${lag} records`} ` +
        '(appends wrote their records but did not move the head).',
    );
    return done;
  }
  if (h.seq > previous.seq) {
    return fail({
      file: HEAD_FILENAME,
      seq: h.seq,
      reason: `the log ends at seq ${previous.seq} but the head records seq ${h.seq}: the newest records were removed`,
    });
  }
  return fail({
    file: HEAD_FILENAME,
    seq: h.seq,
    reason:
      h.seq === previous.seq
        ? `the head (seq ${h.seq}) does not match the newest record (seq ${previous.seq})`
        : `the head (seq ${h.seq}) does not match the log's record at seq ${h.seq} (a record was replaced)`,
  });
}

/**
 * The daemon/CLI-wide audit log. Its state is on disk, so every process shares
 * one chain. Tests construct their own instance or point IRONCURTAIN_HOME at a
 * temporary directory.
 */
export const policyMutationAuditLog = new PolicyMutationAuditLog();
