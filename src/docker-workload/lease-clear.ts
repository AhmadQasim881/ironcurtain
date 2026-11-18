/**
 * Operator retirement of one fenced nested-Docker lease
 * (`ironcurtain docker-workload clear`).
 *
 * A lease whose exact recovery keeps failing fences every new nested-Docker
 * admission. Deleting its record by hand would leave whatever it still owns
 * running and invisible to `ironcurtain gc` (nested resources carry no managed
 * labels). Clearing therefore never retires a record without proving, by the
 * lease's generation label, that the runtime holds nothing of it:
 *
 * 1. A live or recently active lease is refused, and so is an unreadable
 *    record that is still being rewritten or whose recorded coordinator
 *    process still runs (it may be live under a version that wrote it).
 * 2. With `apply`, the ordinary exact recovery is tried first; when it closes
 *    the lease with a cleanup proof, nothing else happens.
 * 3. A state root that is no longer the exact directory the lease recorded (a
 *    symlink or a replaced directory) is refused, exactly as exact cleanup
 *    refuses it: removing the state paths beneath it would follow it.
 * 4. Otherwise every container, volume and network that carries the lease's
 *    generation label on its recorded runtime is listed through daemon-side
 *    label filters (a dry run stops here), stopped and removed, and two
 *    inventories separated by the lease's frozen gap must both come back
 *    empty.
 * 5. Only then, still under the lease's lifecycle claim, are its host-only
 *    state paths removed and its record moved to `docker-workload/cleared/`
 *    (kept for the evidence), where admission no longer sees it.
 *
 * A record that cannot be parsed and names no generation is cleared only when
 * the selected runtime holds no generation-labelled object that a readable
 * lease of this home does not account for; otherwise nothing is touched.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { dockerEndpointSchema, type DockerEndpoint } from '../docker/docker-endpoint.js';
import type { ContainerRuntime } from '../docker/types.js';
import { getDockerWorkloadRoot, getDockerWorkloadStateRoot } from '../config/paths.js';
import { lifecycleIdentifierSchema } from '../zod-helpers.js';
import { MAX_DOCKER_WORKLOAD_LEASE_BYTES, type DockerWorkloadLease } from './bundle-lease.js';
import { removeExactBundleState } from './bundle-cleanup.js';
import {
  DOCKER_WORKLOAD_CLEANUP_LOCK_FILE,
  isDockerWorkloadLifecycleClaimBusy,
  tryAcquireDockerWorkloadLifecycleClaim,
  type DockerWorkloadLifecycleClaimHandle,
} from './cleanup-ownership.js';
import { releaseDockerWorkloadEmergencyReserve } from './emergency-reserve.js';
import {
  assertDockerWorkloadStateRootIdentity,
  describeUnreadableDockerWorkloadLeaseActivity,
  DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
  inspectDockerWorkloadLeases,
  recoverDockerWorkloadLease,
  type DockerWorkloadLeaseSummary,
  type DockerWorkloadRuntimeKind,
  type ReconcileDockerWorkloadOptions,
} from './infrastructure.js';

/** Inventory gap for a record whose own frozen gap cannot be read. */
const UNREADABLE_RECORD_INVENTORY_GAP_MS = 1_000;
const CLEARED_DIR = 'cleared';

export interface GenerationLabelledObject {
  readonly kind: 'container' | 'volume' | 'network';
  readonly id: string;
  readonly name: string;
  readonly generation: string;
}

export interface ClearDockerWorkloadLeaseOptions extends ReconcileDockerWorkloadOptions {
  /** False plans only: nothing is stopped, removed, or moved. */
  readonly apply: boolean;
}

export interface ClearDockerWorkloadLeaseResult {
  readonly leaseId: string;
  /**
   * `recovered`: exact recovery closed the lease with a cleanup proof.
   * `cleared`: label-proven absence; the record was retired.
   * `planned`: dry run; `objects` is what `apply` would remove.
   * `refused`: nothing was changed; `detail` says why.
   */
  readonly outcome: 'recovered' | 'cleared' | 'planned' | 'refused';
  readonly detail: string;
  readonly objects: readonly GenerationLabelledObject[];
  /** Where the retired record was moved. */
  readonly retiredTo?: string;
}

interface LeaseIdentity {
  /** Undefined when an unreadable record names no usable generation. */
  readonly generation: string | undefined;
  readonly runtimeKind: DockerWorkloadRuntimeKind | undefined;
  readonly endpoint: DockerEndpoint | undefined;
  readonly labelKeys: readonly string[];
  readonly gapMs: number;
}

export async function clearDockerWorkloadLease(
  leaseId: string,
  options: ClearDockerWorkloadLeaseOptions,
): Promise<ClearDockerWorkloadLeaseResult> {
  const refused = (
    detail: string,
    objects: readonly GenerationLabelledObject[] = [],
  ): ClearDockerWorkloadLeaseResult => ({
    leaseId,
    outcome: 'refused',
    detail,
    objects,
  });
  if (!lifecycleIdentifierSchema.safeParse(leaseId).success) return refused('not a valid lease id');
  const summary = findLease(leaseId, options);
  if (summary === undefined) return refused('no lease record with this id');
  const unclearable = describeUnclearable(summary, options);
  if (unclearable !== undefined) return refused(unclearable);

  if (options.apply && summary.lease !== undefined) {
    // The ordinary exact path first: it closes the lease with a cleanup proof.
    const recovery = await recoverDockerWorkloadLease(leaseId, options);
    if (recovery.reconciled.includes(leaseId)) {
      return {
        leaseId,
        outcome: 'recovered',
        detail: 'exact recovery closed the lease with a cleanup proof',
        objects: [],
      };
    }
  }

  // Exact cleanup refuses a state root whose identity changed; so does this.
  const hostStateRefusal = describeHostStateRefusal(summary);
  if (hostStateRefusal !== undefined) return refused(hostStateRefusal);

  const identity =
    summary.lease === undefined ? salvageIdentity(readRawRecord(summary.leasePath)) : leaseIdentity(summary.lease);
  const runtime = runtimeFor(identity, options);
  if (runtime === undefined) {
    return refused(
      `its recorded ${identity.runtimeKind ?? 'container'} runtime is unavailable, so absence cannot be proven; ` +
        'start that runtime and retry',
    );
  }
  if (identity.endpoint !== undefined && runtime.dockerEndpoint?.host !== identity.endpoint.host) {
    return refused('the runtime resolved for its recorded Docker endpoint does not use that endpoint');
  }
  const owned = ownedBy(identity, leaseId, options);
  let objects: readonly GenerationLabelledObject[];
  try {
    objects = await inventoryLabelled(runtime, identity, owned);
  } catch (error) {
    return refused(`cannot inventory its runtime, so absence cannot be proven: ${errorText(error)}`);
  }
  if (identity.generation === undefined && objects.length > 0) {
    return refused(
      'the record names no readable generation, and the runtime holds generation-labelled objects no readable lease ' +
        'accounts for; remove them (they may belong to this lease or to another IronCurtain home) and retry',
      objects,
    );
  }
  if (!options.apply) {
    return {
      leaseId,
      outcome: 'planned',
      detail:
        objects.length === 0
          ? 'the runtime holds nothing with its generation label; --force retires the record'
          : `--force removes ${objects.length} object(s) carrying its generation label, then retires the record`,
      objects,
    };
  }

  let claim: DockerWorkloadLifecycleClaimHandle;
  try {
    claim = tryAcquireDockerWorkloadLifecycleClaim({
      leasePath: summary.leasePath,
      processIdentityForPid: options.processIdentityForPid,
    });
  } catch (error) {
    if (isDockerWorkloadLifecycleClaimBusy(error)) {
      return refused('another lifecycle owner (a session, its watchdog, or a recovery) is working on it; retry');
    }
    throw error;
  }
  let retiredTo: string | undefined;
  try {
    // Re-judge under the claim: the lease must still be unowned.
    const current = findLease(leaseId, options);
    const nowUnclearable = current === undefined ? 'its record disappeared' : describeUnclearable(current, options);
    if (nowUnclearable !== undefined) return refused(nowUnclearable);
    const failures = await removeLabelled(runtime, objects);
    const sleep = options.sleep ?? ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
    const first = await inventoryLabelled(runtime, identity, owned);
    await sleep(identity.gapMs);
    const second = await inventoryLabelled(runtime, identity, owned);
    const remaining = [...first, ...second.filter((object) => !first.some((seen) => seen.id === object.id))];
    if (remaining.length > 0) {
      return refused(
        `objects carrying its generation label remain after removal${failures.length === 0 ? '' : ` (${failures.join('; ')})`}`,
        remaining,
      );
    }
    const hostStateFailure = removeHostState(summary, leaseId);
    if (hostStateFailure !== undefined) return refused(hostStateFailure);
    // Retire while the claim still excludes every other lifecycle owner, so
    // no recovery can start on a record that is about to move.
    retiredTo = retireRecord(leaseId, summary);
  } finally {
    releaseClaim(claim, retiredTo);
  }
  return {
    leaseId,
    outcome: 'cleared',
    detail:
      objects.length === 0
        ? 'the runtime held nothing with its generation label; the record was retired'
        : `removed ${objects.length} object(s) carrying its generation label; the record was retired`,
    objects,
    retiredTo,
  };
}

function findLease(leaseId: string, options: ClearDockerWorkloadLeaseOptions): DockerWorkloadLeaseSummary | undefined {
  return inspectDockerWorkloadLeases(options).find((candidate) => candidate.leaseId === leaseId);
}

function describeUnclearable(
  summary: DockerWorkloadLeaseSummary,
  options: ClearDockerWorkloadLeaseOptions,
): string | undefined {
  switch (summary.state) {
    case 'closed':
      return 'it is already closed with a cleanup proof and does not block admission';
    case 'live':
      return `it is live (${summary.detail}); end its session first`;
    case 'settling':
      return 'its coordinator was active moments ago; wait for the stale bound (30s) and retry';
    case 'unreadable':
      // No trustworthy liveness: act only on a quiescent record.
      return describeUnreadableDockerWorkloadLeaseActivity(
        summary.leasePath,
        salvageCoordinator(readRawRecord(summary.leasePath)),
        options,
      );
    default:
      return undefined;
  }
}

/** Why the lease's host-only state cannot be removed safely, or undefined. */
function describeHostStateRefusal(summary: DockerWorkloadLeaseSummary): string | undefined {
  if (summary.lease === undefined) return undefined;
  try {
    assertDockerWorkloadStateRootIdentity(summary.lease, summary.leasePath);
    return undefined;
  } catch (error) {
    return (
      `its state root ${summary.lease.paths.stateRoot} is not provably the directory the lease recorded, so ` +
      `removing it could follow it elsewhere (${errorText(error)}); inspect and remove it by hand, then retry`
    );
  }
}

function leaseIdentity(lease: DockerWorkloadLease): LeaseIdentity {
  return {
    generation: lease.generation,
    runtimeKind: lease.runtimeKind,
    endpoint: lease.schemaVersion === 1 ? undefined : lease.dockerEndpoint,
    labelKeys: [
      ...new Set([
        DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
        ...lease.resources.map((resource) => resource.ownershipLabelKey),
      ]),
    ],
    gapMs: lease.cleanupInventoryGapMs,
  };
}

/**
 * The parsed JSON object of an unreadable record, or undefined when it is not
 * one: a symlink, a non-regular or oversized file, or text that is not a JSON
 * object says nothing.
 */
function readRawRecord(leasePath: string): Readonly<Record<string, unknown>> | undefined {
  let raw: unknown;
  try {
    const descriptor = openSync(leasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.size > MAX_DOCKER_WORKLOAD_LEASE_BYTES) return undefined;
      raw = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
  return raw === null || typeof raw !== 'object' || Array.isArray(raw)
    ? undefined
    : (raw as Readonly<Record<string, unknown>>);
}

/** The coordinator process an unreadable record still names, when its fields validate. */
function salvageCoordinator(
  record: Readonly<Record<string, unknown>> | undefined,
): { readonly pid: number; readonly processIdentity: string | undefined } | undefined {
  const coordinator = record?.coordinator;
  if (coordinator === null || typeof coordinator !== 'object') return undefined;
  const { pid, processIdentity } = coordinator as Readonly<Record<string, unknown>>;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return {
    pid,
    processIdentity: typeof processIdentity === 'string' && processIdentity !== '' ? processIdentity : undefined,
  };
}

/**
 * What an unreadable record still says about its identity: each field is
 * taken only when it passes the same validation a readable lease applies.
 */
function salvageIdentity(record: Readonly<Record<string, unknown>> | undefined): LeaseIdentity {
  const unknown: LeaseIdentity = {
    generation: undefined,
    runtimeKind: undefined,
    endpoint: undefined,
    labelKeys: [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY],
    gapMs: UNREADABLE_RECORD_INVENTORY_GAP_MS,
  };
  if (record === undefined) return unknown;
  const generation = lifecycleIdentifierSchema.safeParse(record.generation);
  const endpoint = dockerEndpointSchema.safeParse(record.dockerEndpoint);
  const runtimeKind =
    record.runtimeKind === 'docker' || record.runtimeKind === 'apple-container' ? record.runtimeKind : undefined;
  return {
    ...unknown,
    generation: generation.success ? generation.data : undefined,
    runtimeKind,
    endpoint: endpoint.success && runtimeKind === 'docker' ? endpoint.data : undefined,
  };
}

/** The recorded runtime (kind and Docker endpoint), never a silently different one. */
function runtimeFor(identity: LeaseIdentity, options: ClearDockerWorkloadLeaseOptions): ContainerRuntime | undefined {
  const kind = identity.runtimeKind ?? options.runtimeKind;
  const endpoint = identity.endpoint;
  if (
    kind === options.runtimeKind &&
    (endpoint === undefined || endpoint.host === options.runtime.dockerEndpoint?.host)
  ) {
    return options.runtime;
  }
  return options.runtimeForKind?.(kind, endpoint);
}

/**
 * Which generations count as this lease's. A known generation is exact. An
 * unknown one is any generation no readable lease of this home accounts for.
 */
function ownedBy(
  identity: LeaseIdentity,
  leaseId: string,
  options: ClearDockerWorkloadLeaseOptions,
): (generation: string) => boolean {
  if (identity.generation !== undefined) {
    const generation = identity.generation;
    return (candidate) => candidate === generation;
  }
  const accounted = new Set(
    inspectDockerWorkloadLeases(options)
      .filter((summary) => summary.leaseId !== leaseId)
      .flatMap((summary) => (summary.lease === undefined ? [] : [summary.lease.generation])),
  );
  return (candidate) => !accounted.has(candidate);
}

type LabelledEntry = {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
};

/**
 * Every container, volume and network carrying one of the lease's label keys
 * with an owned generation, containers first.
 *
 * Like the owned inventories of exact cleanup, each label key is one
 * daemon-side label filter (`key=generation`, or only `key` when the record
 * names no readable generation), so the inventory never inspects every object
 * on the host. Matches are rechecked here: a runtime that ignores the filter
 * can only report too much, and the recheck drops what is not the lease's.
 */
async function inventoryLabelled(
  runtime: ContainerRuntime,
  identity: Pick<LeaseIdentity, 'generation' | 'labelKeys'>,
  owned: (generation: string) => boolean,
): Promise<GenerationLabelledObject[]> {
  if (runtime.listContainers === undefined) throw new Error('the runtime cannot list containers');
  const listContainers = runtime.listContainers.bind(runtime);
  const labelFilterFor = (key: string): string =>
    identity.generation === undefined ? key : `${key}=${identity.generation}`;
  const objects: GenerationLabelledObject[] = [];
  const collect = async (
    kind: GenerationLabelledObject['kind'],
    list: (labelFilter: string) => Promise<readonly LabelledEntry[]>,
  ): Promise<void> => {
    const seen = new Set<string>();
    for (const labelFilter of identity.labelKeys.map(labelFilterFor)) {
      for (const entry of await list(labelFilter)) {
        // Any of the lease's label keys naming an owned generation makes the
        // object the lease's, whatever its other labels say.
        const key = identity.labelKeys.find(
          (candidate) => Object.hasOwn(entry.labels, candidate) && owned(entry.labels[candidate]),
        );
        if (key === undefined || seen.has(entry.id)) continue;
        seen.add(entry.id);
        objects.push({ kind, id: entry.id, name: entry.name, generation: entry.labels[key] });
      }
    }
  };
  await collect('container', (labelFilter) => listContainers({ labelFilter }));
  // A runtime without volume or network objects cannot have created any.
  const listVolumes = runtime.listVolumes?.bind(runtime);
  if (listVolumes !== undefined) await collect('volume', (labelFilter) => listVolumes({ labelFilter }));
  const listNetworks = runtime.listNetworks?.bind(runtime);
  if (listNetworks !== undefined) await collect('network', (labelFilter) => listNetworks({ labelFilter }));
  return objects;
}

/** Containers first (stop, then remove), then volumes, then networks; failures are reported, not thrown. */
async function removeLabelled(
  runtime: ContainerRuntime,
  objects: readonly GenerationLabelledObject[],
): Promise<readonly string[]> {
  const failures: string[] = [];
  const attempt = async (object: GenerationLabelledObject, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push(`${object.kind} ${object.name}: ${errorText(error).slice(0, 200)}`);
    }
  };
  for (const object of objects.filter((candidate) => candidate.kind === 'container')) {
    await attempt(object, async () => {
      await runtime.stop(object.id).catch(() => {
        // A container that already exited cannot be stopped; removal decides.
      });
      await runtime.remove(object.id);
    });
  }
  for (const object of objects.filter((candidate) => candidate.kind === 'volume')) {
    const removeVolume = runtime.removeVolume?.bind(runtime);
    await attempt(object, async () => {
      if (removeVolume === undefined) throw new Error('the runtime cannot remove volumes');
      await removeVolume(object.id);
    });
  }
  for (const object of objects.filter((candidate) => candidate.kind === 'network')) {
    await attempt(object, () => runtime.removeNetwork(object.id));
  }
  return failures;
}

/**
 * Remove the lease's host-only state: its exact recorded paths, after the same
 * state-root identity check exact cleanup applies, or only the canonical state
 * root of an unreadable record (removed itself, never traversed through).
 * Returns why nothing was removed, or undefined.
 */
function removeHostState(summary: DockerWorkloadLeaseSummary, leaseId: string): string | undefined {
  if (summary.lease !== undefined) {
    const refusal = describeHostStateRefusal(summary);
    if (refusal !== undefined) return refusal;
    removeExactBundleState(summary.lease, summary.leasePath);
    return undefined;
  }
  rmSync(getDockerWorkloadStateRoot(leaseId), { recursive: true, force: true });
  return undefined;
}

/**
 * Release the lease's lifecycle claim. A retired record took the claim's lock
 * file with it into `cleared/`, where no one contends for it, so it is dropped
 * there rather than released at a path that no longer exists.
 */
function releaseClaim(claim: DockerWorkloadLifecycleClaimHandle, retiredTo: string | undefined): void {
  if (retiredTo === undefined) {
    claim.release();
    return;
  }
  try {
    claim.release();
  } catch {
    // Its published path moved with the record: nothing at the old path is ours.
  }
  rmSync(join(retiredTo, DOCKER_WORKLOAD_CLEANUP_LOCK_FILE), { force: true });
}

/** Move the lease directory out of `leases/` (admission scans only that) into `cleared/`, freeing its reserve. */
function retireRecord(leaseId: string, summary: DockerWorkloadLeaseSummary): string {
  const leaseDir = dirname(summary.leasePath);
  releaseDockerWorkloadEmergencyReserve(leaseDir);
  const clearedRoot = join(getDockerWorkloadRoot(), CLEARED_DIR);
  mkdirSync(clearedRoot, { recursive: true, mode: 0o700 });
  let destination = join(clearedRoot, leaseId);
  if (existsSync(destination)) destination = join(clearedRoot, `${leaseId}-${Date.now()}`);
  renameSync(leaseDir, destination);
  return destination;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
