/**
 * Crash-safe ownership, reconciliation, and IPv4 allocation for container
 * resources created by IronCurtain (Docker containers and networks, and Apple
 * Container VMs).
 *
 * Runtimes intentionally outlive their CLI clients. A killed IronCurtain
 * process therefore leaves containers and networks behind unless a later
 * process can prove ownership and reclaim them. Labels plus a host-side owner
 * lease provide that proof without confusing a concurrently-starting empty
 * network for an orphan.
 *
 * Owner lease records (docs/designs/pty-gc-ownership.md) live in
 * `~/.ironcurtain/run/docker-owners/<token>.json`:
 *
 *   { leaseSchema: 2, token, pid, identity: { kind, value }, bundleId, runtime,
 *     state: 'active' | 'released', createdAt, releasedAt? }
 *
 * `active` means the owner is still operating the bundle. A teardown that
 * proves every resource carrying the token is gone deletes the record; any
 * other teardown atomically rewrites it as a `released` tombstone, which lets
 * reconciliation reclaim exactly those resources even while the owner process
 * (a long-lived daemon) is still running. Reconciliation deletes a record only
 * after a fresh inventory shows that no resource carries its token.
 *
 * `identity` is the owner's process-start identity, measured by
 * `getProcessStartIdentity` (../docker-workload/process-lock.ts) and named by
 * its kind: on Linux the kernel boot ID plus `/proc/<pid>/stat` start ticks,
 * which no wall-clock step changes. Schema 1 and older records hold
 * `{ bootId, startedAt }` from `ps -o lstart` instead, which on Linux moves
 * whenever the clock is stepped; it is never compared, so a live owner of such
 * a record is ambiguous (retained), never `pid-reused`. Older versions reject
 * a record of an unknown schema as ambiguous, so they never compare the new
 * identity with theirs either.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import * as logger from '../logger.js';
import { isExecError } from '../utils/exec-error.js';
import { writeStableJsonAtomic } from '../hardened-fs.js';
import type { BundleId } from '../session/types.js';
import type { ContainerRuntime, DockerContainerInfo, DockerNetworkInfo } from './types.js';
import type { ContainerRuntimeKind } from './container-runtime.js';
import {
  acquireProcessLock,
  getProcessStartIdentity,
  PROCESS_START_IDENTITY_KINDS,
  processStartIdentityKind,
  ProcessLockBusyError,
  type ProcessIdentityResolver,
  type ProcessStartIdentityKind,
} from '../docker-workload/process-lock.js';

export const IRONCURTAIN_MANAGED_LABEL = 'ironcurtain.managed';
export const IRONCURTAIN_OWNER_PID_LABEL = 'ironcurtain.owner-pid';
export const IRONCURTAIN_OWNER_TOKEN_LABEL = 'ironcurtain.owner-token';
export const IRONCURTAIN_OWNER_SCOPE_LABEL = 'ironcurtain.owner-scope';
export const IRONCURTAIN_CREATED_AT_LABEL = 'ironcurtain.created-at';
export const IRONCURTAIN_RESOURCE_SCHEMA_LABEL = 'ironcurtain.resource-schema';
const IRONCURTAIN_BUNDLE_LABEL = 'ironcurtain.bundle';
const RESOURCE_SCHEMA = '3';
const LEASE_SCHEMA = 2;
/** Records with a `ps -o lstart` owner identity; read, never written. */
const LSTART_LEASE_SCHEMA = 1;
// Current bundle slugs are 12 hex digits; pre-identity-refactor names used a
// raw UUID substring and therefore contain a hyphen after eight digits.
const LEGACY_NETWORK_RE = /^ironcurtain-(?:[a-f0-9]{12}|[a-f0-9]{8}-[a-f0-9]{3})$/;
const LEGACY_EMPTY_NETWORK_GRACE_MS = 2 * 60_000;
/**
 * Owner tokens become lease file names. Labels are runtime metadata that any
 * local runtime user can set, so a token is used as a path component only when
 * it is a plain name (no separators); everything else is treated as malformed.
 */
const SAFE_TOKEN_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const LEASE_FILE_RE = /^([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})\.json$/;
const MAX_PID = 0x7fff_ffff;

type LeaseState = 'active' | 'released';

interface OwnerLease {
  readonly token: string;
  readonly pid: number;
  readonly identity: ProcessIdentity;
  readonly path: string;
  readonly bundleId: string;
  readonly runtime: ContainerRuntimeKind;
  readonly createdAt: string;
}

/** On-disk lease record, current schema. */
interface OwnerLeaseRecord {
  readonly leaseSchema: typeof LEASE_SCHEMA;
  readonly token: string;
  readonly pid: number;
  readonly identity: ProcessIdentity;
  readonly bundleId: string;
  readonly runtime: ContainerRuntimeKind;
  readonly state: LeaseState;
  readonly createdAt: string;
  readonly releasedAt?: string;
}

/** A parsed lease record; legacy (pre-schema) records parse as `active` Docker leases. */
interface ParsedLease {
  readonly token: string;
  readonly pid: number;
  readonly identity: RecordedIdentity;
  readonly bundleId: string | undefined;
  readonly runtime: ContainerRuntimeKind;
  readonly state: LeaseState;
  readonly releasedAt: string | undefined;
}

type LeaseRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'record'; readonly lease: ParsedLease };

/**
 * An owner's process-start identity as `getProcessStartIdentity` measures it:
 * on Linux `<kernel boot ID>:<start ticks>` from procfs, elsewhere the UTC
 * `ps -o lstart` time, which macOS fixes at fork. The same PID with a
 * different identity of the same kind is another process (PID reuse, or a
 * pre-reboot lease); identities of different kinds are never compared.
 */
export interface ProcessIdentity {
  readonly kind: ProcessStartIdentityKind;
  readonly value: string;
}

/**
 * The owner identity of a schema 1 or pre-schema record: `ps -o lstart` plus
 * a boot marker. On Linux lstart moves with every wall-clock step, so such an
 * identity proves neither that its owner is live nor that its PID was reused.
 */
const LSTART_IDENTITY = { kind: 'legacy-ps-lstart' } as const;

type RecordedIdentity = ProcessIdentity | typeof LSTART_IDENTITY;

/** Active leases of this process, keyed by lease root and bundle. Released leases are forgotten. */
const ownerLeases = new Map<string, OwnerLease>();
let exitHookInstalled = false;

/**
 * The identity of process `pid`, or undefined when no such process exists.
 * Throws when the process table cannot be read. Reads procfs on Linux and
 * never runs `ps` there (see `getProcessStartIdentity`).
 */
function measureProcessIdentity(pid: number): ProcessIdentity | undefined {
  const value = getProcessStartIdentity(pid);
  return value === undefined ? undefined : { kind: processStartIdentityKind(), value };
}

/** This process's identity, for a new lease record. */
function measureOwnIdentity(): ProcessIdentity {
  let identity: ProcessIdentity | undefined;
  let cause: unknown;
  try {
    identity = measureProcessIdentity(process.pid);
  } catch (error) {
    cause = error;
  }
  if (identity === undefined) {
    throw new Error(
      `Unable to determine the identity of owner process ${process.pid}`,
      cause === undefined ? undefined : { cause },
    );
  }
  return identity;
}

function leaseRoot(): string {
  return resolve(getIronCurtainHome(), 'run', 'docker-owners');
}

function leasePath(root: string, token: string): string {
  return resolve(root, `${token}.json`);
}

/**
 * Stable, non-sensitive namespace for one IronCurtain home. Docker inventory is
 * host-global, while ownership leases live below IRONCURTAIN_HOME; without this
 * label a test using a temporary home can mistake production resources for
 * orphans because it cannot see their lease files.
 */
function currentOwnerScope(): string {
  const resolvedHome = resolve(getIronCurtainHome());
  let canonicalHome: string;
  try {
    canonicalHome = realpathSync(resolvedHome);
  } catch {
    canonicalHome = resolvedHome;
  }
  return createHash('sha256').update(canonicalHome).digest('hex').slice(0, 24);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    // Only active leases are in the map: a released tombstone stays on disk
    // until reconciliation verifies that its resources are gone.
    for (const lease of ownerLeases.values()) {
      try {
        unlinkSync(lease.path);
      } catch {
        // A crash reconciler may already have removed it.
      }
    }
  });
}

function ownerLeaseKey(root: string, bundleId: string): string {
  return `${root}\0${bundleId}`;
}

function leaseRecord(lease: OwnerLease, state: LeaseState, releasedAt?: string): OwnerLeaseRecord {
  return {
    leaseSchema: LEASE_SCHEMA,
    token: lease.token,
    pid: lease.pid,
    identity: lease.identity,
    bundleId: lease.bundleId,
    runtime: lease.runtime,
    state,
    createdAt: lease.createdAt,
    ...(releasedAt === undefined ? {} : { releasedAt }),
  };
}

function getOwnerLease(bundleId: string, runtime: ContainerRuntimeKind): OwnerLease {
  const root = leaseRoot();
  const key = ownerLeaseKey(root, bundleId);
  const existing = ownerLeases.get(key);
  if (existing) return existing;

  mkdirSync(root, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const path = leasePath(root, token);
  const identity = measureOwnIdentity();
  const lease: OwnerLease = {
    token,
    pid: process.pid,
    identity,
    path,
    bundleId,
    runtime,
    createdAt: new Date().toISOString(),
  };
  // Persisted before the first create that carries these labels, and created
  // exclusively: a concurrent reconciler sees a live owner, never a gap.
  try {
    writeFileSync(path, JSON.stringify(leaseRecord(lease, 'active')), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(path, { force: true });
    throw error;
  }
  ownerLeases.set(key, lease);
  installExitHook();
  return lease;
}

/**
 * Labels stamped on every managed container and network. The first call for a
 * bundle persists its `active` owner lease; `runtime` records which runtime's
 * inventory can later settle the lease.
 */
export function managedResourceLabels(
  bundleId: BundleId | string,
  runtime: ContainerRuntimeKind = 'docker',
): Record<string, string> {
  const lease = getOwnerLease(bundleId, runtime);
  return {
    [IRONCURTAIN_MANAGED_LABEL]: 'true',
    [IRONCURTAIN_BUNDLE_LABEL]: bundleId,
    [IRONCURTAIN_OWNER_PID_LABEL]: String(lease.pid),
    [IRONCURTAIN_OWNER_TOKEN_LABEL]: lease.token,
    [IRONCURTAIN_OWNER_SCOPE_LABEL]: currentOwnerScope(),
    [IRONCURTAIN_CREATED_AT_LABEL]: new Date().toISOString(),
    [IRONCURTAIN_RESOURCE_SCHEMA_LABEL]: RESOURCE_SCHEMA,
  };
}

/** Outcome of ending a bundle's owner lease. */
export type ManagedLeaseFinalization =
  /** The bundle never minted a lease (or it was already finalized). */
  | 'none'
  /** Every resource carrying the token is proven gone; the record was deleted. */
  | 'deleted'
  /** The record is now a `released` tombstone that authorizes reconciliation. */
  | 'released'
  /**
   * The record could be neither deleted nor rewritten as a tombstone; it
   * stays active until this process exits (the exit hook then removes it).
   */
  | 'kept-active';

/**
 * Relinquish a bundle's owner lease while resources carrying it may remain:
 * the record is atomically rewritten as a `released` tombstone, so the next
 * reconciliation (any process, `ironcurtain gc --force`) reclaims exactly the
 * resources whose labels match it even though this process is still alive.
 * Call only after the bundle has stopped creating resources and its teardown
 * attempt has finished.
 */
export function releaseManagedResourceLease(bundleId: BundleId | string): ManagedLeaseFinalization {
  const key = ownerLeaseKey(leaseRoot(), bundleId);
  const lease = ownerLeases.get(key);
  if (!lease) return 'none';
  try {
    writeStableJsonAtomic(lease.path, leaseRecord(lease, 'released', new Date().toISOString()), { mode: 0o600 });
  } catch (error) {
    // Fail safe: an active record keeps the resources until this process
    // exits (the exit hook then removes it and the dead PID authorizes GC).
    logger.warn(
      `[docker-gc] could not release the owner lease of bundle ${bundleId}; ` +
        `its resources stay reserved until this process exits: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'kept-active';
  }
  ownerLeases.delete(key);
  return 'released';
}

/** True when a complete inventory shows no container or network carrying `token`. */
async function tokenResourcesAbsent(
  runtime: Pick<ContainerRuntime, 'listContainers' | 'listNetworks'>,
  token: string,
): Promise<boolean> {
  if (!runtime.listContainers) return false;
  try {
    const containers = await runtime.listContainers({ labelFilter: `${IRONCURTAIN_OWNER_TOKEN_LABEL}=${token}` });
    if (containers.some((container) => container.labels[IRONCURTAIN_OWNER_TOKEN_LABEL] === token)) return false;
    // A runtime without network inventory (Apple Container) cannot label networks.
    const networks = runtime.listNetworks ? await runtime.listNetworks() : [];
    return !networks.some((network) => network.labels[IRONCURTAIN_OWNER_TOKEN_LABEL] === token);
  } catch {
    return false;
  }
}

export interface FinalizeManagedResourceLeaseOptions {
  /**
   * Runtime whose inventory proves exact absence of every resource carrying
   * the lease token. Omit only when no runtime resource can exist (setup
   * failed before a runtime was available).
   */
  readonly runtime?: Pick<ContainerRuntime, 'listContainers' | 'listNetworks'>;
  /** Whether the teardown verified the removal of every resource it attempted. */
  readonly teardownVerified: boolean;
}

/**
 * End a bundle's owner lease after its teardown attempt: delete the record
 * when the teardown was verified and (with a runtime) a fresh inventory shows
 * no resource with the token, otherwise leave a `released` tombstone so the
 * leftovers are reclaimed by the next reconciliation instead of being kept as
 * "owner alive, lease missing" until the process exits.
 *
 * Never throws: it runs on teardown and error-recovery paths
 * (`destroyDockerInfrastructure`, the create-failure cleanup) that must go on
 * to stop the proxies and surface the original error.
 */
export async function finalizeManagedResourceLease(
  bundleId: BundleId | string,
  options: FinalizeManagedResourceLeaseOptions,
): Promise<ManagedLeaseFinalization> {
  const root = leaseRoot();
  const key = ownerLeaseKey(root, bundleId);
  const lease = ownerLeases.get(key);
  if (!lease) return 'none';
  let absent = options.teardownVerified;
  if (absent && options.runtime) absent = await tokenResourcesAbsent(options.runtime, lease.token);
  // The inventory is async; another finalize may have settled the lease meanwhile.
  if (ownerLeases.get(key) !== lease) return 'none';
  if (absent) {
    try {
      rmSync(lease.path, { force: true });
    } catch (error) {
      // Nothing carries the token any more, so an active record is harmless:
      // keep it in the map and let the exit hook retry the removal.
      logger.warn(
        `[docker-gc] could not delete the owner lease of bundle ${bundleId}; it stays active until this ` +
          `process exits: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'kept-active';
    }
    ownerLeases.delete(key);
    return 'deleted';
  }
  logger.warn(
    `[docker-gc] teardown of bundle ${bundleId} could not prove that every resource it owned was removed; ` +
      'releasing its owner lease so the next reconciliation reclaims what remains',
  );
  return releaseManagedResourceLease(bundleId);
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A record's owner identity: `{ kind, value }` in the current schema, the
 * `ps -o lstart` marker in schema 1 and pre-schema records.
 */
function parseRecordedIdentity(identity: unknown, leaseSchema: unknown): RecordedIdentity | undefined {
  if (!isRecord(identity)) return undefined;
  if (leaseSchema === LEASE_SCHEMA) {
    const kind = PROCESS_START_IDENTITY_KINDS.find((known) => known === identity.kind);
    const { value } = identity;
    return kind === undefined || typeof value !== 'string' || value === '' ? undefined : { kind, value };
  }
  return typeof identity.bootId === 'string' && typeof identity.startedAt === 'string' ? LSTART_IDENTITY : undefined;
}

/** Parse a lease record strictly; anything unexpected is `invalid` (ambiguous ownership). */
function parseLeaseRecord(raw: unknown): ParsedLease | undefined {
  if (!isRecord(raw)) return undefined;
  const { token, pid, identity, bundleId, runtime, state, releasedAt, leaseSchema } = raw;
  if (typeof token !== 'string' || !Number.isSafeInteger(pid) || typeof pid !== 'number' || pid <= 0) return undefined;
  if (bundleId !== undefined && typeof bundleId !== 'string') return undefined;
  if (releasedAt !== undefined && typeof releasedAt !== 'string') return undefined;
  if (leaseSchema === undefined) {
    // Pre-schema records were written only by active Docker owners.
    if (state !== undefined || runtime !== undefined || releasedAt !== undefined) return undefined;
  } else if (leaseSchema !== LEASE_SCHEMA && leaseSchema !== LSTART_LEASE_SCHEMA) {
    return undefined;
  }
  const recordedIdentity = parseRecordedIdentity(identity, leaseSchema);
  if (recordedIdentity === undefined) return undefined;
  const parsedState = state ?? 'active';
  if (parsedState !== 'active' && parsedState !== 'released') return undefined;
  const parsedRuntime = runtime ?? 'docker';
  if (parsedRuntime !== 'docker' && parsedRuntime !== 'apple-container') return undefined;
  return {
    token,
    pid,
    identity: recordedIdentity,
    bundleId,
    runtime: parsedRuntime,
    state: parsedState,
    releasedAt,
  };
}

/**
 * How a live owner's identity relates to the one its lease recorded. An
 * identity of another kind (the lstart identity of an older version) is
 * `incomparable`: after a wall-clock step it differs from that of the very
 * process that wrote it, so a mismatch is no proof of PID reuse.
 */
function compareOwnerIdentity(
  current: ProcessIdentity,
  recorded: RecordedIdentity,
): 'same' | 'different' | 'incomparable' {
  if (recorded.kind === LSTART_IDENTITY.kind || recorded.kind !== current.kind) return 'incomparable';
  return recorded.value === current.value ? 'same' : 'different';
}

/** What {@link listOwnerLeaseBundleIds} found in the lease directory. */
export interface OwnerLeaseBundles {
  /**
   * Bundle ids named by a lease record of any state: `active` (the owner is
   * running the bundle, or crashed without a teardown) and `released` (a
   * teardown that could not prove its resources gone). Either way containers
   * or networks of the bundle may still exist, and a container may still
   * mount the bundle's directories.
   */
  readonly bundleIds: ReadonlySet<string>;
  /** Lease files that could not be read or parsed (their bundle is unknown). */
  readonly unreadable: number;
}

/**
 * Lists the bundles whose container resources may still exist, from the
 * owner lease records, without touching them. A record disappears once its
 * resources are proven gone (a clean teardown, or `ironcurtain gc`), or when
 * its owner process exits (the exit hook): a container left behind then
 * carries the labels of a dead owner, which reconciliation reclaims. So a
 * bundle missing from the set has no container left that a live owner runs.
 * Retention (`src/maintenance/prune.ts`) never removes the session or
 * workflow run directory of a listed bundle, and prunes no session or run
 * while a record cannot be read (`unreadable`).
 *
 * @throws when the lease directory exists but cannot be listed (callers fail
 *   closed: every bundle may then hold resources).
 */
export function listOwnerLeaseBundleIds(): OwnerLeaseBundles {
  const root = leaseRoot();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bundleIds: new Set(), unreadable: 0 };
    throw error;
  }
  const bundleIds = new Set<string>();
  let unreadable = 0;
  for (const name of names) {
    const token = LEASE_FILE_RE.exec(name)?.[1];
    if (token === undefined) continue;
    const read = readLeaseRecord(root, token);
    if (read.kind === 'missing') continue;
    if (read.kind === 'invalid' || read.lease.bundleId === undefined) {
      unreadable += 1;
      continue;
    }
    bundleIds.add(read.lease.bundleId);
  }
  return { bundleIds, unreadable };
}

function readLeaseRecord(root: string, token: string): LeaseRead {
  if (!SAFE_TOKEN_RE.test(token)) return { kind: 'invalid' };
  let text: string;
  try {
    text = readFileSync(leasePath(root, token), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  const lease = parseLeaseRecord(raw);
  return lease === undefined ? { kind: 'invalid' } : { kind: 'record', lease };
}

/**
 * How reconciliation classifies the owner of one managed resource (the
 * decision table in docs/designs/pty-gc-ownership.md). Only `dead`,
 * `pid-reused` and `released` resources are reclaimed.
 */
export type OwnerClassification =
  /** Labelled for another IronCurtain home. */
  | 'foreign'
  /**
   * Missing or malformed labels, or a live owner whose lease cannot be
   * verified (including one recording an older version's lstart identity).
   */
  | 'ambiguous'
  /** Exact active lease and matching live process. */
  | 'live'
  /** The recorded owner PID is not running. */
  | 'dead'
  /** The recorded PID now belongs to a different process. */
  | 'pid-reused'
  /** The owner released the lease after a failed or unverified teardown. */
  | 'released'
  /** Unlabelled network from before owner labels existed. */
  | 'legacy';

const RECLAIMABLE: ReadonlySet<OwnerClassification> = new Set(['dead', 'pid-reused', 'released']);

interface ClassificationContext {
  readonly root: string;
  readonly ownerScope: string;
  readonly pidAlive: (pid: number) => boolean;
  readonly processIdentity: (pid: number) => ProcessIdentity | undefined;
}

interface Ownership {
  readonly classification: OwnerClassification;
  readonly reason: string;
}

/**
 * Foreign-home resources are never ours to reclaim.
 */
function belongsToForeignScope(labels: Readonly<Partial<Record<string, string>>>, ownerScope: string): boolean {
  const scope = labels[IRONCURTAIN_OWNER_SCOPE_LABEL];
  return scope !== undefined && scope !== ownerScope;
}

/** A label's value; runtime label maps are untyped JSON, so absence is possible. */
function labelValue(labels: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(labels, key) ? labels[key] : undefined;
}

function labelledOwner(labels: Readonly<Record<string, string>>): { pid: number; token: string } | undefined {
  const rawPid = labelValue(labels, IRONCURTAIN_OWNER_PID_LABEL);
  const token = labelValue(labels, IRONCURTAIN_OWNER_TOKEN_LABEL);
  if (rawPid === undefined || !/^[1-9][0-9]{0,9}$/.test(rawPid) || token === undefined || !SAFE_TOKEN_RE.test(token)) {
    return undefined;
  }
  // Above the 32-bit range no platform PID exists; `process.kill` would throw.
  const pid = Number(rawPid);
  return pid <= MAX_PID ? { pid, token } : undefined;
}

/**
 * Classify a managed resource's owner. A live PID with an unreadable or
 * unverifiable lease is not proof that its resource is orphaned:
 * reconciliation is destructive, so every ambiguity is retained. Malformed
 * owner labels are ambiguous too, never proof of death.
 */
function classifyOwnership(labels: Readonly<Record<string, string>>, context: ClassificationContext): Ownership {
  if (belongsToForeignScope(labels, context.ownerScope)) {
    return { classification: 'foreign', reason: 'owned by another IronCurtain home' };
  }
  const owner = labelledOwner(labels);
  if (owner === undefined) return { classification: 'ambiguous', reason: 'owner labels are missing or malformed' };
  if (!context.pidAlive(owner.pid)) return { classification: 'dead', reason: 'owner process is not running' };
  const read = readLeaseRecord(context.root, owner.token);
  if (read.kind === 'missing') return { classification: 'ambiguous', reason: 'live owner has no lease record' };
  if (read.kind === 'invalid')
    return { classification: 'ambiguous', reason: 'lease record is unreadable or malformed' };
  const { lease } = read;
  if (lease.token !== owner.token || lease.pid !== owner.pid) {
    return { classification: 'ambiguous', reason: 'lease record does not match the owner labels' };
  }
  if (lease.state === 'released') {
    // A tombstone authorizes removal only of resources that match it exactly.
    if (lease.releasedAt === undefined || lease.bundleId === undefined) {
      return { classification: 'ambiguous', reason: 'released lease record is incomplete' };
    }
    if (labels[IRONCURTAIN_BUNDLE_LABEL] !== lease.bundleId) {
      return { classification: 'ambiguous', reason: 'released lease record names another bundle' };
    }
    return { classification: 'released', reason: 'owner released the lease after its teardown' };
  }
  const identity = context.processIdentity(owner.pid);
  if (identity === undefined) return { classification: 'ambiguous', reason: 'owner process identity is unavailable' };
  switch (compareOwnerIdentity(identity, lease.identity)) {
    case 'same':
      return { classification: 'live', reason: 'owner process holds an active lease' };
    case 'different':
      return { classification: 'pid-reused', reason: 'owner PID now belongs to another process' };
    case 'incomparable':
      return {
        classification: 'ambiguous',
        reason:
          lease.identity.kind === LSTART_IDENTITY.kind
            ? "lease records an older version's lstart owner identity"
            : 'lease records an owner identity of another kind',
      };
  }
}

interface ReconcileOptions {
  readonly dryRun?: boolean;
  readonly now?: Date;
  readonly pidAlive?: (pid: number) => boolean;
  /**
   * Test seam for the owner identity of a PID (undefined: no such process;
   * throwing: unreadable). It also adjudicates the reconcile lock. Production
   * measures with `getProcessStartIdentity`.
   */
  readonly processIdentity?: (pid: number) => ProcessIdentity | undefined;
  readonly legacyGraceMs?: number;
  /**
   * Kind of `docker`. Lease records name the runtime that holds their
   * resources; only that runtime's inventory may prune them. Default 'docker'.
   */
  readonly runtimeKind?: ContainerRuntimeKind;
}

/** One reclaim/retain decision, for logs and the `ironcurtain gc` report. */
export interface ReconcileDecision {
  readonly kind: 'container' | 'network';
  readonly name: string;
  readonly classification: OwnerClassification;
  /** `reclaim`: removed (or would be, in a dry run). `retain`: ownership. `skip`: unsafe to remove. */
  readonly action: 'reclaim' | 'retain' | 'skip';
  readonly reason: string;
}

export interface ReconcileResult {
  readonly removedContainers: readonly string[];
  readonly removedNetworks: readonly string[];
  readonly retainedActiveResources: number;
  readonly skippedUnsafeNetworks: readonly string[];
  readonly decisions: readonly ReconcileDecision[];
  /** Lease records deleted because no resource carries their token any more. */
  readonly prunedLeases: number;
}

function resourceAgeMs(created: string, now: Date): number {
  const timestamp = Date.parse(created);
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : Number.POSITIVE_INFINITY;
}

async function withReconcileLock<T>(
  fn: () => Promise<T>,
  processIdentityForPid: ProcessIdentityResolver,
): Promise<T | undefined> {
  const root = leaseRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = resolve(root, 'reconcile.lock');
  let lock: ReturnType<typeof acquireProcessLock> | undefined;
  try {
    lock = acquireProcessLock(lockPath, { attempts: 2, processIdentityForPid });
    return await fn();
  } catch (error) {
    if (error instanceof ProcessLockBusyError) return undefined;
    throw error;
  } finally {
    lock?.release();
  }
}

/** Non-sensitive owner summary for decision logs: never the full token. */
function ownerSummary(labels: Readonly<Record<string, string>>): string {
  const token = labelValue(labels, IRONCURTAIN_OWNER_TOKEN_LABEL);
  const pid = labelValue(labels, IRONCURTAIN_OWNER_PID_LABEL);
  const parts = [];
  if (pid !== undefined) parts.push(`pid=${pid.slice(0, 12)}`);
  if (token !== undefined) parts.push(`token=${token.slice(0, 8)}…`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * Lease records whose owner is finished with them: released tombstones, and
 * records of owners that are demonstrably gone. Unreadable records may be
 * mid-creation and records of live or unverifiable owners are kept.
 */
function finishedLeaseTokens(context: ClassificationContext, runtimeKind: ContainerRuntimeKind): string[] {
  let names: string[];
  try {
    names = readdirSync(context.root);
  } catch {
    return [];
  }
  const tokens: string[] = [];
  for (const name of names) {
    const token = LEASE_FILE_RE.exec(name)?.[1];
    if (token === undefined) continue;
    const read = readLeaseRecord(context.root, token);
    if (read.kind !== 'record' || read.lease.token !== token || read.lease.runtime !== runtimeKind) continue;
    const { lease } = read;
    if (lease.state === 'released') {
      tokens.push(token);
      continue;
    }
    if (!context.pidAlive(lease.pid)) {
      tokens.push(token);
      continue;
    }
    // Only a comparable identity proves PID reuse; an older-format record of a live PID is kept.
    const identity = context.processIdentity(lease.pid);
    if (identity !== undefined && compareOwnerIdentity(identity, lease.identity) === 'different') tokens.push(token);
  }
  return tokens;
}

/**
 * Delete finished lease records that no resource carries any more. The
 * candidates are read first and the inventory taken afterwards: an owner
 * creates nothing after releasing (or dying), so a resource that still carries
 * a candidate token must appear in this later inventory. An inventory failure
 * prunes nothing.
 */
async function pruneFinishedLeases(
  docker: Pick<ContainerRuntime, 'listContainers' | 'listNetworks'>,
  context: ClassificationContext,
  runtimeKind: ContainerRuntimeKind,
): Promise<number> {
  const candidates = finishedLeaseTokens(context, runtimeKind);
  if (candidates.length === 0 || !docker.listContainers) return 0;
  let containers: readonly DockerContainerInfo[];
  let networks: readonly DockerNetworkInfo[];
  try {
    containers = await docker.listContainers({ labelFilter: `${IRONCURTAIN_MANAGED_LABEL}=true` });
    networks = docker.listNetworks ? await docker.listNetworks() : [];
  } catch (error) {
    logger.warn(
      `[docker-gc] keeping lease records: inventory failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
  const carried = new Set<string>();
  for (const resource of [...containers, ...networks]) {
    const token = labelValue(resource.labels, IRONCURTAIN_OWNER_TOKEN_LABEL);
    if (token !== undefined) carried.add(token);
  }
  let pruned = 0;
  for (const token of candidates) {
    if (carried.has(token)) continue;
    try {
      rmSync(leasePath(context.root, token), { force: true });
    } catch (error) {
      // A record that cannot be deleted now is retried by the next pass; it
      // must not hide the removals this pass already made.
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`[docker-gc] could not delete finished lease record ${token.slice(0, 8)}…: ${reason}`);
      continue;
    }
    pruned++;
  }
  return pruned;
}

/**
 * Reclaims resources whose owner is gone (dead or recycled PID) or released
 * its lease. Unlabeled legacy networks are reclaimed only when empty and old
 * enough; attached legacy resources are deliberately left for an explicit
 * operator action because ownership cannot be proven safely.
 *
 * Works for any runtime with container inventory: a runtime without network
 * inventory (Apple Container, whose networks cannot carry labels) reconciles
 * containers only.
 */
export async function reconcileIronCurtainDockerResources(
  docker: ContainerRuntime,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const empty: ReconcileResult = {
    removedContainers: [],
    removedNetworks: [],
    retainedActiveResources: 0,
    skippedUnsafeNetworks: [],
    decisions: [],
    prunedLeases: 0,
  };
  if (!docker.listContainers) return empty;
  const runtimeKind = options.runtimeKind ?? 'docker';

  const identityProbe = options.processIdentity ?? measureProcessIdentity;
  const identityCache = new Map<number, ProcessIdentity | undefined>();
  const processIdentity = (pid: number): ProcessIdentity | undefined => {
    if (!identityCache.has(pid)) {
      let identity: ProcessIdentity | undefined;
      try {
        identity = identityProbe(pid);
      } catch {
        // An unreadable process table proves nothing: the owner stays ambiguous.
      }
      identityCache.set(pid, identity);
    }
    return identityCache.get(pid);
  };
  // The reconcile lock uses the same probe, but lets its errors through: a
  // lock holder whose identity cannot be read keeps the lock.
  const lockIdentity: ProcessIdentityResolver = (pid) => identityProbe(pid)?.value;
  const result = await withReconcileLock(async (): Promise<ReconcileResult> => {
    const context: ClassificationContext = {
      root: leaseRoot(),
      ownerScope: currentOwnerScope(),
      pidAlive: options.pidAlive ?? defaultPidAlive,
      processIdentity,
    };
    const now = options.now ?? new Date();
    const removedContainers: string[] = [];
    const removedNetworks: string[] = [];
    const skippedUnsafeNetworks: string[] = [];
    const decisions: ReconcileDecision[] = [];
    const removedContainerIds = new Set<string>();
    let retainedActiveResources = 0;

    const decide = (decision: ReconcileDecision, labels: Readonly<Record<string, string>>): void => {
      decisions.push(decision);
      logger.info(
        `[docker-gc] ${decision.kind} ${decision.name}: ${decision.classification} -> ${decision.action} ` +
          `(${decision.reason})${ownerSummary(labels)}`,
      );
    };

    const managedContainers = await docker.listContainers?.({ labelFilter: `${IRONCURTAIN_MANAGED_LABEL}=true` });
    for (const container of managedContainers ?? []) {
      if (container.labels[IRONCURTAIN_MANAGED_LABEL] !== 'true') continue;
      const ownership = classifyOwnership(container.labels, context);
      if (!RECLAIMABLE.has(ownership.classification)) {
        retainedActiveResources++;
        decide({ kind: 'container', name: container.name, action: 'retain', ...ownership }, container.labels);
        continue;
      }
      logger.warn(`[docker-gc] reclaiming orphaned container ${container.name}`);
      if (!options.dryRun) {
        await docker.remove(container.id);
        if (await docker.containerExists(container.id)) {
          logger.warn(`[docker-gc] container ${container.name} still exists after forced removal`);
          decide(
            {
              kind: 'container',
              name: container.name,
              action: 'skip',
              classification: ownership.classification,
              reason: 'removal could not be verified',
            },
            container.labels,
          );
          continue;
        }
      }
      removedContainers.push(container.name);
      removedContainerIds.add(container.id);
      decide({ kind: 'container', name: container.name, action: 'reclaim', ...ownership }, container.labels);
    }

    const networks = docker.listNetworks ? await docker.listNetworks() : [];
    for (const network of networks) {
      const managed = network.labels[IRONCURTAIN_MANAGED_LABEL] === 'true';
      const legacy = !managed && LEGACY_NETWORK_RE.test(network.name);
      if (!managed && !legacy) continue;

      const ownership: Ownership = managed
        ? classifyOwnership(network.labels, context)
        : { classification: 'legacy', reason: 'unlabelled network from an earlier release' };
      if (managed && !RECLAIMABLE.has(ownership.classification)) {
        retainedActiveResources++;
        decide({ kind: 'network', name: network.name, action: 'retain', ...ownership }, network.labels);
        continue;
      }
      if (legacy) {
        const graceMs = options.legacyGraceMs ?? LEGACY_EMPTY_NETWORK_GRACE_MS;
        if (network.containerIds.length > 0 || resourceAgeMs(network.created, now) < graceMs) {
          skippedUnsafeNetworks.push(network.name);
          decide(
            {
              kind: 'network',
              name: network.name,
              action: 'skip',
              classification: 'legacy',
              reason: 'attached or too recent to prove orphaned',
            },
            network.labels,
          );
          continue;
        }
      }

      const survivingAttachments = network.containerIds.filter((id) => !removedContainerIds.has(id));
      if (survivingAttachments.length > 0) {
        logger.warn(`[docker-gc] refusing to remove ${network.name}: it has non-orphan attachments`);
        skippedUnsafeNetworks.push(network.name);
        decide(
          {
            kind: 'network',
            name: network.name,
            action: 'skip',
            classification: ownership.classification,
            reason: 'has attachments that are not orphaned',
          },
          network.labels,
        );
        continue;
      }
      logger.warn(`[docker-gc] reclaiming orphaned network ${network.name}`);
      if (!options.dryRun) {
        await docker.removeNetwork(network.name);
        if (docker.networkExists && (await docker.networkExists(network.name))) {
          logger.warn(`[docker-gc] network ${network.name} still exists after removal`);
          decide(
            {
              kind: 'network',
              name: network.name,
              action: 'skip',
              classification: ownership.classification,
              reason: 'removal could not be verified',
            },
            network.labels,
          );
          continue;
        }
      }
      removedNetworks.push(network.name);
      decide({ kind: 'network', name: network.name, action: 'reclaim', ...ownership }, network.labels);
    }

    const prunedLeases = options.dryRun ? 0 : await pruneFinishedLeases(docker, context, runtimeKind);

    const counts = new Map<string, number>();
    for (const decision of decisions) {
      counts.set(decision.classification, (counts.get(decision.classification) ?? 0) + 1);
    }
    logger.info(
      `[docker-gc] ${runtimeKind} reconciliation${options.dryRun ? ' (dry run)' : ''}: ` +
        `${decisions.length} candidate(s) [${[...counts].map(([key, value]) => `${key}=${value}`).join(' ') || 'none'}], ` +
        `reclaimed ${removedContainers.length} container(s) and ${removedNetworks.length} network(s), ` +
        `retained ${retainedActiveResources}, skipped ${decisions.filter((decision) => decision.action === 'skip').length}, ` +
        `pruned ${prunedLeases} lease record(s)`,
    );

    return {
      removedContainers,
      removedNetworks,
      retainedActiveResources,
      skippedUnsafeNetworks,
      decisions,
      prunedLeases,
    };
  }, lockIdentity);
  return result ?? empty;
}

/** Startup/retry reconciliation must never become a container session prerequisite. */
export async function reconcileIronCurtainDockerResourcesBestEffort(
  docker: ContainerRuntime,
  context: string,
  options: Pick<ReconcileOptions, 'runtimeKind'> = {},
): Promise<void> {
  try {
    await reconcileIronCurtainDockerResources(docker, options);
  } catch (error) {
    logger.warn(
      `[docker-gc] ${context} reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface Ipv4Cidr {
  readonly network: number;
  readonly prefix: number;
}

function ipv4ToNumber(address: string): number | undefined {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function numberToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function parseIpv4Cidr(value: string): Ipv4Cidr | undefined {
  const [address, rawPrefix] = value.split('/');
  const prefix = Number(rawPrefix);
  const ip = ipv4ToNumber(address);
  if (ip === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (ip & mask) >>> 0, prefix };
}

function cidrsOverlap(left: Ipv4Cidr, right: Ipv4Cidr): boolean {
  const prefix = Math.min(left.prefix, right.prefix);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (left.network & mask) === (right.network & mask);
}

export function hostInterfaceIpv4Cidrs(): readonly string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && entry.cidr)
    .map((entry) => entry.cidr as string);
}

const DOCKER_SUBNET_PREFIX = 29;
const ADDRESS_POOLS = ['172.20.0.0/14', '172.24.0.0/14', '172.28.0.0/14', '10.240.0.0/12'] as const;

/** Returns the allocator pool containing a selected /29. */
export function dockerAllocationPoolForSubnet(subnet: string): string {
  const candidate = parseIpv4Cidr(subnet);
  if (!candidate) return subnet;
  return (
    ADDRESS_POOLS.find((pool) => {
      const parsed = parseIpv4Cidr(pool);
      return parsed !== undefined && cidrsOverlap(candidate, parsed);
    }) ?? subnet
  );
}

export class InternalNetworkConnectivityError extends Error {
  constructor(
    message: string,
    readonly subnet?: string,
  ) {
    super(message);
    this.name = 'InternalNetworkConnectivityError';
  }
}

export async function withInternalNetworkAllocationRetry<T>(
  options: {
    readonly maxAttempts: number;
    readonly description: string;
    readonly reconcile?: () => Promise<void>;
  },
  runAttempt: (excludedSubnets: ReadonlySet<string>, attempt: number) => Promise<T>,
): Promise<T> {
  const excludedSubnets = new Set<string>();
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await runAttempt(excludedSubnets, attempt);
    } catch (error) {
      lastError = error;
      if (!(error instanceof InternalNetworkConnectivityError) || !error.subnet || attempt === options.maxAttempts) {
        throw error;
      }
      const rejectedPool = dockerAllocationPoolForSubnet(error.subnet);
      excludedSubnets.add(rejectedPool);
      logger.warn(
        `${options.description} ${error.subnet} failed its end-to-end checks; rejecting ${rejectedPool} and ` +
          `retrying with another allocation (${attempt}/${options.maxAttempts})`,
      );
      await options.reconcile?.();
    }
  }
  throw lastError;
}

function* candidateSubnets(name: string): Generator<string> {
  const seed = createHash('sha256').update(name).digest().readUInt32BE(0);
  for (const poolValue of ADDRESS_POOLS) {
    const pool = parseIpv4Cidr(poolValue);
    if (!pool) continue;
    const count = 2 ** (DOCKER_SUBNET_PREFIX - pool.prefix);
    const offset = seed % count;
    const blockSize = 2 ** (32 - DOCKER_SUBNET_PREFIX);
    for (let index = 0; index < count; index++) {
      const block = (pool.network + ((offset + index) % count) * blockSize) >>> 0;
      yield `${numberToIpv4(block)}/${DOCKER_SUBNET_PREFIX}`;
    }
  }
}

function allocationConflict(error: unknown): boolean {
  if (!isExecError(error)) return false;
  return /overlap|address pool|fully subnetted|pool.*exhaust|no available network/i.test(error.stderr);
}

export interface AllocatedInternalNetwork {
  readonly name: string;
  readonly subnet: string;
}

export interface SelectIronCurtainInternalSubnetOptions {
  readonly excludedSubnets?: ReadonlySet<string>;
  readonly hostCidrs?: readonly string[];
}

export interface CreateIronCurtainInternalNetworkOptions extends SelectIronCurtainInternalSubnetOptions {
  /**
   * Exact caller-owned labels for lifecycles that already provide durable
   * ownership. Omit for ordinary Docker sessions, which retain the generic
   * process-owner lease and its managed-resource labels.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

class NoAvailableIronCurtainSubnetError extends Error {
  constructor(name: string, cause?: unknown) {
    super(
      `No collision-free IronCurtain Docker subnet is available for ${name}. ` +
        `Reconciled the managed resources and searched /29 networks outside 192.168.0.0/16.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'NoAvailableIronCurtainSubnetError';
  }
}

/** Resolves one usable host address from an allocator-selected /29. */
export function ironCurtainInternalSubnetHostAddress(subnet: string, hostOffset: number): string {
  const parsed = parseIpv4Cidr(subnet);
  if (parsed?.prefix !== DOCKER_SUBNET_PREFIX) {
    throw new Error(`IronCurtain internal subnet must be an IPv4 /${DOCKER_SUBNET_PREFIX}: ${subnet}`);
  }
  if (!Number.isSafeInteger(hostOffset) || hostOffset < 1 || hostOffset > 6) {
    throw new Error('IronCurtain /29 host offset must select one of the six usable addresses');
  }
  return numberToIpv4((parsed.network + hostOffset) >>> 0);
}

/** Selects a collision-free /29 without mutating Docker state. */
export async function selectIronCurtainInternalSubnet(
  docker: ContainerRuntime,
  name: string,
  options: SelectIronCurtainInternalSubnetOptions = {},
): Promise<string> {
  const networks = (await docker.listNetworks?.()) ?? [];
  const sameNamedNetwork = networks.find((network) => network.name === name);
  if (sameNamedNetwork) {
    throw new Error(
      `Docker network ${name} already exists (${sameNamedNetwork.subnets.join(', ') || 'unknown subnet'}). ` +
        `Refusing to reuse it because its requested ownership/subnet cannot be verified.`,
    );
  }
  const occupied = [
    ...networks.flatMap((network: DockerNetworkInfo) => network.subnets),
    ...(options.hostCidrs ?? hostInterfaceIpv4Cidrs()),
  ]
    .map(parseIpv4Cidr)
    .filter((cidr): cidr is Ipv4Cidr => cidr !== undefined);
  const excluded = [...(options.excludedSubnets ?? [])]
    .map(parseIpv4Cidr)
    .filter((cidr): cidr is Ipv4Cidr => cidr !== undefined);

  for (const subnet of candidateSubnets(name)) {
    const candidate = parseIpv4Cidr(subnet);
    if (
      !candidate ||
      excluded.some((cidr) => cidrsOverlap(candidate, cidr)) ||
      occupied.some((cidr) => cidrsOverlap(candidate, cidr))
    ) {
      continue;
    }
    return subnet;
  }

  throw new NoAvailableIronCurtainSubnetError(name);
}

/** Allocates a small internal subnet while never falling back into 192.168/16. */
export async function createIronCurtainInternalNetwork(
  docker: ContainerRuntime,
  name: string,
  bundleId: BundleId | string,
  options: CreateIronCurtainInternalNetworkOptions = {},
): Promise<AllocatedInternalNetwork> {
  const excludedSubnets = new Set(options.excludedSubnets);
  let lastConflict: unknown;
  for (;;) {
    let subnet: string;
    try {
      subnet = await selectIronCurtainInternalSubnet(docker, name, {
        ...options,
        excludedSubnets,
      });
    } catch (error) {
      if (lastConflict === undefined || !(error instanceof NoAvailableIronCurtainSubnetError)) throw error;
      throw new NoAvailableIronCurtainSubnetError(name, lastConflict);
    }
    try {
      await docker.createNetwork(name, {
        internal: true,
        subnet,
        labels: options.labels ?? managedResourceLabels(bundleId),
      });
      return { name, subnet };
    } catch (error) {
      if (!allocationConflict(error)) throw error;
      lastConflict = error;
      excludedSubnets.add(subnet);
    }
  }
}
