import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { MemoryRow } from './database.js';
import type { MemoryConfig } from '../config.js';
import {
  deleteSegmentsWithoutLiveFacts,
  getRandomActiveMemories,
  markDecayed,
  pruneVectorsOfInactiveMemories,
} from './queries.js';
import { runCompaction } from './compaction.js';
import { runConsolidation } from './consolidation.js';

const SAMPLE_SIZE = 100;

/**
 * How long a maintenance lease holds. A running pass renews it every
 * MAINTENANCE_LEASE_RENEW_MS and after each phase; a lease left behind by a process that
 * died is taken over once it has expired.
 */
export const MAINTENANCE_LEASE_MS = 15 * 60_000;

/**
 * How often a running pass renews its lease. One phase can take longer than the lease
 * (consolidation and compaction make up to dozens of LLM calls, each allowed
 * `config.llmTimeoutMs`), so renewing only between phases let a slow pass lose its lease
 * to another server mid-phase, and the two passes then overlapped.
 */
export const MAINTENANCE_LEASE_RENEW_MS = MAINTENANCE_LEASE_MS / 3;

/**
 * A server that starts within this long after a pass completed (by any process on the
 * same database) skips its startup pass: every session of a persona, and every cron run,
 * starts a server on the persona's database, and each pass costs LLM calls.
 */
export const STARTUP_MAINTENANCE_MIN_INTERVAL_MS = 10 * 60_000;

let storeCounter = 0;

/**
 * Reset the store counter (useful for testing).
 */
export function resetMaintenanceCounter(): void {
  storeCounter = 0;
}

export interface MaintenanceResult {
  consolidated: number;
  merged: number;
  superseded: number;
  decayed: number;
  compacted: number;
  /** Source segments deleted because no live memory references them any more. */
  segmentsRemoved: number;
  /**
   * Why no pass ran, when none did: one was already running on this connection
   * ('running'), another server holds the database's maintenance lease ('leased'), or,
   * for the startup pass, another server completed one moments ago ('recent').
   */
  skipped?: 'running' | 'leased' | 'recent';
}

function emptyResult(skipped?: MaintenanceResult['skipped']): MaintenanceResult {
  return {
    consolidated: 0,
    merged: 0,
    superseded: 0,
    decayed: 0,
    compacted: 0,
    segmentsRemoved: 0,
    ...(skipped === undefined ? {} : { skipped }),
  };
}

/**
 * Called after stores with the number of memories they created. Runs maintenance once
 * every `maintenanceInterval` new memories: an ingest of many facts counts them all and
 * runs at most one pass, after its writes, not one inside every Nth write.
 */
export async function maybeRunMaintenance(
  db: Database.Database,
  config: MemoryConfig,
  stores = 1,
): Promise<MaintenanceResult> {
  storeCounter += stores;
  if (storeCounter < config.maintenanceInterval) {
    return emptyResult();
  }
  storeCounter = 0;
  return runMaintenance(db, config);
}

// ---------- Coordination ----------
//
// Every session of a persona (and every cron run with one) starts its own server on the
// persona's database. Without coordination their passes overlapped, judged stale
// snapshots and repeated LLM calls. Two guards:
//   - in this process, one pass at a time per connection (`running`);
//   - across processes, a lease row in schema_meta (`maintenance_lease:<namespace>`:
//     owner and expiry), taken under SQLite's write lock before a pass starts, renewed
//     while it runs (every MAINTENANCE_LEASE_RENEW_MS, and after each phase) and
//     released at the end. A pass that finds another owner's unexpired lease is
//     skipped, not queued: the memories it would have consolidated stay unconsolidated
//     (and are still recalled) until the next pass.
// A completed pass records its time (`maintenance_last_run:<namespace>`), which lets a
// server that starts soon after skip its startup pass.

/** Connections with a pass in progress. */
const running = new WeakSet<Database.Database>();

/** The lease owner each connection uses: one connection stands for one server process. */
const owners = new WeakMap<Database.Database, string>();

function ownerOf(db: Database.Database): string {
  let owner = owners.get(db);
  if (owner === undefined) {
    owner = `${process.pid}:${randomBytes(8).toString('hex')}`;
    owners.set(db, owner);
  }
  return owner;
}

function leaseKey(namespace: string): string {
  return `maintenance_lease:${namespace}`;
}

function lastRunKey(namespace: string): string {
  return `maintenance_last_run:${namespace}`;
}

interface MaintenanceLease {
  owner: string;
  expires_at: number;
}

function readMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(key) as
    { value: string | null } | undefined;
  return row?.value ?? undefined;
}

function writeMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** The lease recorded for `namespace`; null when there is none or it is unreadable (treated as free). */
function readLease(db: Database.Database, namespace: string): MaintenanceLease | null {
  const value = readMeta(db, leaseKey(namespace));
  if (value === undefined) return null;
  try {
    const lease = JSON.parse(value) as Partial<MaintenanceLease> | null;
    if (typeof lease?.owner === 'string' && typeof lease.expires_at === 'number') {
      return { owner: lease.owner, expires_at: lease.expires_at };
    }
  } catch {
    // Unreadable: free.
  }
  return null;
}

/**
 * Take, or renew, the maintenance lease of `namespace` for this connection, unless
 * another owner holds one that has not expired. Runs under SQLite's write lock (BEGIN
 * IMMEDIATE), so two servers cannot both take it. Returns false, too, when the database
 * is busy or closed: the pass is skipped, and the next trigger tries again.
 */
export function acquireMaintenanceLease(db: Database.Database, namespace: string, now: number = Date.now()): boolean {
  const owner = ownerOf(db);
  try {
    return db
      .transaction((): boolean => {
        const lease = readLease(db, namespace);
        if (lease !== null && lease.owner !== owner && lease.expires_at > now) return false;
        writeMeta(db, leaseKey(namespace), JSON.stringify({ owner, expires_at: now + MAINTENANCE_LEASE_MS }));
        return true;
      })
      .immediate();
  } catch {
    return false;
  }
}

/** Give up this connection's maintenance lease of `namespace`, if it holds it. Best effort: a lease left behind expires. */
export function releaseMaintenanceLease(db: Database.Database, namespace: string): void {
  const owner = ownerOf(db);
  try {
    db.transaction(() => {
      if (readLease(db, namespace)?.owner === owner) {
        db.prepare(`DELETE FROM schema_meta WHERE key = ?`).run(leaseKey(namespace));
      }
    }).immediate();
  } catch {
    // The database is busy or closed; the lease expires on its own.
  }
}

/** When a maintenance pass on `namespace` last completed (epoch ms), by any server; null if never. */
export function lastMaintenanceRun(db: Database.Database, namespace: string): number | null {
  const value = Number(readMeta(db, lastRunKey(namespace)));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Run a full maintenance pass (see runMaintenancePhases), unless one is already running
 * on this connection or another server holds the database's maintenance lease; the
 * result says which (`skipped`).
 */
export async function runMaintenance(db: Database.Database, config: MemoryConfig): Promise<MaintenanceResult> {
  if (running.has(db)) return emptyResult('running');
  if (!acquireMaintenanceLease(db, config.namespace)) return emptyResult('leased');
  running.add(db);
  // Keep the lease while a long phase waits on the LLM. Unref'd: a pending renewal never
  // keeps the process alive, and on a closed database it fails quietly.
  const heartbeat = setInterval(() => {
    acquireMaintenanceLease(db, config.namespace);
  }, MAINTENANCE_LEASE_RENEW_MS);
  heartbeat.unref();
  try {
    const result = await runMaintenancePhases(db, config);
    writeMeta(db, lastRunKey(config.namespace), String(Date.now()));
    return result;
  } finally {
    clearInterval(heartbeat);
    running.delete(db);
    releaseMaintenanceLease(db, config.namespace);
  }
}

/**
 * The pass a server runs when it starts, for the memories earlier sessions left
 * unconsolidated. Skipped when a pass completed less than
 * STARTUP_MAINTENANCE_MIN_INTERVAL_MS ago (by this or another server).
 */
export async function runStartupMaintenance(
  db: Database.Database,
  config: MemoryConfig,
  now: number = Date.now(),
): Promise<MaintenanceResult> {
  const last = lastMaintenanceRun(db, config.namespace);
  if (last !== null && now - last < STARTUP_MAINTENANCE_MIN_INTERVAL_MS) return emptyResult('recent');
  return runMaintenance(db, config);
}

/**
 * The phases of a maintenance pass: consolidation + decay check + compaction, then
 * clean-up: remove the vectors of memories that are no longer live, and the source
 * segments no live memory references (consolidation merges, decay and compaction release
 * them). The lease is renewed after each LLM phase.
 */
async function runMaintenancePhases(db: Database.Database, config: MemoryConfig): Promise<MaintenanceResult> {
  // Phase 0: Consolidation -- batch-resolve duplicates/contradictions
  const consolidation = await runConsolidation(db, config);
  acquireMaintenanceLease(db, config.namespace);

  // Phase 1: Decay -- sample random memories and check vitality
  const now = Date.now();
  const sample = getRandomActiveMemories(db, config.namespace, SAMPLE_SIZE);

  let decayed = 0;
  for (const mem of sample) {
    const vitality = computeVitality(mem, now);
    if (vitality < config.decayThreshold) {
      markDecayed(db, config.namespace, mem.id);
      decayed++;
    }
  }

  // Phase 2: Compaction
  const compacted = await runCompaction(db, config);
  acquireMaintenanceLease(db, config.namespace);

  // Phase 3: Clean-up. Synchronous, so it cannot interleave with an ingest, which
  // writes a segment in the same step as the fact that links to it.
  pruneVectorsOfInactiveMemories(db, config.namespace);
  const segmentsRemoved = deleteSegmentsWithoutLiveFacts(db, config.namespace);

  return { ...consolidation, decayed, compacted, segmentsRemoved };
}

/**
 * Compute the vitality of a memory — a value between 0 and 1 indicating
 * how "alive" the memory is. Vitality below the decay threshold triggers decay.
 *
 * Factors:
 * - Time-based decay with half-life proportional to importance
 * - Access reinforcement: each access extends lifetime
 * - Recency of last access
 *
 * Ages are clamped at zero: a timestamp in the future (clock skew, or a row written
 * before `as_of` was bounded) counts as "now", never as a negative age that would
 * push vitality above its fresh value and stop the memory from ever decaying.
 */
export function computeVitality(mem: MemoryRow, now: number): number {
  const ageHours = Math.max(0, now - mem.created_at) / 3600000;

  // Half-life proportional to importance: importance=1.0 -> 180-day half-life
  const halfLifeHours = mem.importance * 180 * 24;
  if (halfLifeHours <= 0) return 0;

  const baseDecay = Math.pow(0.5, ageHours / halfLifeHours);

  // Access reinforcement: each access extends effective lifetime (capped at 0.4)
  const reinforcement = Math.min(mem.access_count * 0.03, 0.4);

  // Recency of last access (60-day characteristic time)
  const accessAgeHours = Math.max(0, now - mem.last_accessed_at) / 3600000;
  const accessRecency = Math.exp(-accessAgeHours / (60 * 24));

  return Math.min(1.0, baseDecay + reinforcement * accessRecency);
}
