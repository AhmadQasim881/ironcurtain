/** Exact host-authoritative outer-resource revocation for a bundle lease. */

import type { ContainerRuntime } from '../docker/types.js';
import {
  DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recordDockerWorkloadOuterResourceRemoval,
  revokeDockerWorkloadLease,
  type DockerWorkloadLease,
  type DockerWorkloadOuterResource,
} from './bundle-lease.js';

export interface DockerWorkloadRevocationResult {
  readonly removedResourceIds: readonly string[];
  readonly finalOwnedResourceIds: readonly string[];
}

type OuterResourceKind = DockerWorkloadOuterResource['kind'];

interface NamedResourceInfo {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * How revocation finds and removes one kind of outer resource. Presence is
 * decided by an exact single-object inspect wherever the runtime offers one,
 * so the cost of a teardown does not grow with the number of unrelated objects
 * on the host. The exhaustive inventory remains only as the fallback for
 * runtimes without such an inspect (Apple lists everything in one call anyway).
 */
interface ExactResourceAccess {
  readonly kind: OuterResourceKind;
  /** Resolves `undefined` only when the runtime reports the object absent. */
  readonly inspect?: (nameOrId: string) => Promise<NamedResourceInfo | undefined>;
  readonly list: () => Promise<readonly NamedResourceInfo[]>;
  readonly remove: (id: string, assertBudget: () => void) => Promise<void>;
}

/**
 * Revoke only resources whose immutable ID/name and generation label match the
 * host-only lease. The create-before-observation crash window is resolved by
 * the precommitted caller-selected name plus the exact generation label, then promoted
 * to an immutable-ID record before deletion.
 */
export async function revokeDockerWorkloadOuterResources(
  runtime: ContainerRuntime,
  leasePath: string,
  generation: string,
  now: () => Date = () => new Date(),
  assertBudget: () => void = () => {},
): Promise<DockerWorkloadRevocationResult> {
  assertBudget();
  let lease = loadDockerWorkloadLease(leasePath);
  if (lease.generation !== generation) throw new Error('Docker-workload revocation generation mismatch');
  if (lease.status === 'admitting' || lease.status === 'active') {
    lease = revokeDockerWorkloadLease(leasePath, generation, now());
  } else if (lease.status !== 'revoking') {
    throw new Error(`Docker-workload revocation cannot run for terminal lease: ${lease.status}`);
  }
  if (runtime.listContainers === undefined) {
    throw new Error('selected outer runtime cannot inventory containers for exact revocation');
  }

  const removedResourceIds: string[] = [];
  const ordered = [...lease.resources].sort(compareRevocationOrder);
  for (const snapshot of ordered) {
    const current = requiredResource(loadDockerWorkloadLease(leasePath), snapshot.requestId);
    if (current.removal !== null) continue;
    const access = exactResourceAccess(runtime, current.kind);
    removedResourceIds.push(
      await revokeExactResource(access, { leasePath, generation, resource: current, now, assertBudget }),
    );
  }

  const finalLease = loadDockerWorkloadLease(leasePath);
  const finalOwnedResourceIds = await inventoryOwnedResourceIds(runtime, finalLease, assertBudget);
  if (finalOwnedResourceIds.length !== 0) {
    throw new Error(`Docker-workload revocation left owned outer resources: ${finalOwnedResourceIds.join(',')}`);
  }
  return { removedResourceIds, finalOwnedResourceIds };
}

export interface DockerWorkloadUnledgeredRevocationResult {
  /** Exact runtime identities this pass stopped and removed. */
  readonly removedResourceIds: readonly string[];
  /** Bounded diagnostics for identities it could not handle; the ledgered pass decides. */
  readonly failures: readonly string[];
}

/**
 * Stop and remove the generation's exact outer containers, then its exact
 * volumes, without any durable write. A watchdog trip runs this before it
 * touches the lease, a lock, or its status file, so a full disk cannot keep a
 * revoked bundle running or growing. Identity rules match
 * {@link revokeDockerWorkloadOuterResources}: the observed immutable ID (or,
 * before observation, the precommitted name), the exact requested name, and
 * the generation label; anything else is left alone. Presence is decided the
 * same way too, by an exact single-object inspect wherever the runtime offers
 * one, so stopping the bundle never waits on an inventory of every object on
 * the host. Networks hold no disk and wait for the ledgered pass. Never
 * throws: that ledgered pass follows, records the absence proofs, and remains
 * the authority.
 */
export async function revokeDockerWorkloadOuterResourcesBeforeLedger(
  runtime: ContainerRuntime,
  lease: DockerWorkloadLease,
): Promise<DockerWorkloadUnledgeredRevocationResult> {
  const removedResourceIds: string[] = [];
  const failures: string[] = [];
  const record = (identity: string, error: unknown): void => {
    if (failures.length < 32) {
      failures.push(`${identity}: ${(error instanceof Error ? error.message : String(error)).slice(0, 512)}`);
    }
  };
  const pending = lease.resources.filter((resource) => resource.removal === null).sort(compareRevocationOrder);

  const containers = pending.filter((resource) => resource.kind === 'container');
  if (containers.length > 0) {
    const exactTarget = unledgeredTargetResolver(runtime, 'container', record);
    for (const resource of containers) {
      const target = await exactTarget(resource);
      if (target === undefined) continue;
      try {
        await runtime.stop(target);
      } catch (error) {
        record(target, error);
      }
      try {
        await runtime.remove(target);
        removedResourceIds.push(target);
      } catch (error) {
        record(target, error);
      }
    }
  }

  const volumes = pending.filter((resource) => resource.kind === 'volume');
  if (volumes.length > 0 && runtime.listVolumes !== undefined && runtime.removeVolume !== undefined) {
    const exactTarget = unledgeredTargetResolver(runtime, 'volume', record);
    for (const resource of volumes) {
      const target = await exactTarget(resource);
      if (target === undefined) continue;
      try {
        await runtime.removeVolume(target);
        removedResourceIds.push(target);
      } catch (error) {
        record(target, error);
      }
    }
  }
  return { removedResourceIds, failures };
}

/**
 * Resolve each pending resource of one kind to the runtime identity that is
 * exactly it, or `undefined` when it is absent, ambiguous, foreign, or could
 * not be read (every case but absence is recorded). An exact inspect decides
 * wherever the runtime offers one; otherwise a single inventory, taken on first
 * use, serves the whole kind. Never throws.
 */
function unledgeredTargetResolver(
  runtime: ContainerRuntime,
  kind: 'container' | 'volume',
  record: (identity: string, error: unknown) => void,
): (resource: DockerWorkloadOuterResource) => Promise<string | undefined> {
  let access: ExactResourceAccess;
  try {
    access = exactResourceAccess(runtime, kind);
  } catch (error) {
    record(`${kind} inventory`, error);
    return () => Promise.resolve(undefined);
  }
  const unbudgeted = (): void => {};
  let inventory: Promise<readonly NamedResourceInfo[] | undefined> | undefined;
  return async (resource) => {
    try {
      if (access.inspect === undefined) {
        inventory ??= requiredInventory(access, unbudgeted).catch((error: unknown) => {
          record(`${kind} inventory`, error);
          return undefined;
        });
        const snapshot = await inventory;
        return snapshot === undefined ? undefined : exactUnledgeredTarget(snapshot, resource, record);
      }
      const found =
        resource.observedId === null
          ? await findByExactName(access, resource.requestedName, unbudgeted)
          : await findByImmutableId(access, resource.observedId, unbudgeted);
      return found === undefined ? undefined : exactUnledgeredTarget([found], resource, record);
    } catch (error) {
      record(resource.observedId ?? resource.requestedName, error);
      return undefined;
    }
  };
}

/** The one inventory entry that is exactly this ledgered resource, or undefined. */
function exactUnledgeredTarget(
  inventory: readonly NamedResourceInfo[],
  resource: DockerWorkloadOuterResource,
  record: (identity: string, error: unknown) => void,
): string | undefined {
  const matching =
    resource.observedId === null
      ? inventory.filter((candidate) => candidate.name === resource.requestedName)
      : inventory.filter((candidate) => candidate.id === resource.observedId);
  if (matching.length !== 1) {
    if (matching.length > 1) record(resource.requestedName, new Error('duplicate runtime identity'));
    return undefined;
  }
  const [target] = matching;
  if (
    target.name !== resource.requestedName ||
    target.labels[resource.ownershipLabelKey] !== resource.ownershipLabelValue
  ) {
    record(target.id, new Error('runtime name or generation label does not match the lease'));
    return undefined;
  }
  return target.id;
}

/**
 * Every outer resource still carrying one of the lease's ownership labels.
 *
 * Each `(label key, generation)` pair is one daemon-side label filter, so the
 * inventory inspects only this generation's objects, never every object on the
 * host. Matches are rechecked here: a runtime that ignores the filter can only
 * report too much, which fails the empty-inventory proof closed.
 */
export async function inventoryOwnedResourceIds(
  runtime: ContainerRuntime,
  lease: DockerWorkloadLease,
  assertBudget: () => void = () => {},
): Promise<readonly string[]> {
  if (runtime.listContainers === undefined) {
    throw new Error('selected outer runtime cannot inventory containers for cleanup proof');
  }
  const listContainers = runtime.listContainers.bind(runtime);
  const ownership = ownershipLabels(lease);
  const ids = await ownedInventory(
    'container',
    ownership,
    (labelFilter) => listContainers({ labelFilter }),
    assertBudget,
  );
  if (lease.resources.some((resource) => resource.kind === 'network')) {
    if (runtime.listNetworks === undefined) {
      throw new Error('selected outer runtime cannot inventory networks for cleanup proof');
    }
    const listNetworks = runtime.listNetworks.bind(runtime);
    ids.push(
      ...(await ownedInventory('network', ownership, (labelFilter) => listNetworks({ labelFilter }), assertBudget)),
    );
  }
  if (lease.resources.some((resource) => resource.kind === 'volume')) {
    if (runtime.listVolumes === undefined) {
      throw new Error('selected outer runtime cannot inventory volumes for cleanup proof');
    }
    const listVolumes = runtime.listVolumes.bind(runtime);
    ids.push(
      ...(await ownedInventory('volume', ownership, (labelFilter) => listVolumes({ labelFilter }), assertBudget)),
    );
  }
  return [...ids].sort();
}

/**
 * The distinct `(key, value)` ownership labels the lease's resources were
 * created with. A lease that never precommitted a resource is still proven
 * empty by one authoritative inventory, under the default ownership label.
 */
function ownershipLabels(lease: DockerWorkloadLease): readonly { readonly key: string; readonly value: string }[] {
  if (lease.resources.length === 0) return [{ key: DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY, value: lease.generation }];
  const unique = new Map<string, { readonly key: string; readonly value: string }>();
  for (const resource of lease.resources) {
    unique.set(`${resource.ownershipLabelKey}\0${resource.ownershipLabelValue}`, {
      key: resource.ownershipLabelKey,
      value: resource.ownershipLabelValue,
    });
  }
  return [...unique.values()];
}

async function ownedInventory(
  kind: OuterResourceKind,
  ownership: readonly { readonly key: string; readonly value: string }[],
  list: (labelFilter: string) => Promise<readonly NamedResourceInfo[]>,
  assertBudget: () => void,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const { key, value } of ownership) {
    assertBudget();
    const inventory = await list(`${key}=${value}`);
    assertBudget();
    assertUniqueInventory(inventory, kind);
    for (const resource of inventory) {
      if (resource.labels[key] === value) ids.add(resource.id);
    }
  }
  return [...ids];
}

function exactResourceAccess(runtime: ContainerRuntime, kind: OuterResourceKind): ExactResourceAccess {
  if (kind === 'container') {
    const listContainers = runtime.listContainers?.bind(runtime);
    if (listContainers === undefined) throw new Error('selected outer runtime cannot inventory containers');
    return {
      kind,
      inspect: runtime.inspectContainer?.bind(runtime),
      list: () => listContainers(),
      remove: async (id, assertBudget) => {
        await runtime.stop(id);
        assertBudget();
        await runtime.remove(id);
      },
    };
  }
  if (kind === 'network') {
    const listNetworks = runtime.listNetworks?.bind(runtime);
    if (listNetworks === undefined) {
      throw new Error('selected outer runtime cannot inventory networks for exact revocation');
    }
    return {
      kind,
      inspect: runtime.inspectNetwork?.bind(runtime),
      list: () => listNetworks(),
      remove: (id) => runtime.removeNetwork(id),
    };
  }
  const listVolumes = runtime.listVolumes?.bind(runtime);
  const removeVolume = runtime.removeVolume?.bind(runtime);
  if (listVolumes === undefined || removeVolume === undefined) {
    throw new Error('selected outer runtime cannot inventory and remove volumes for exact revocation');
  }
  return {
    kind,
    inspect: runtime.inspectVolume?.bind(runtime),
    list: () => listVolumes(),
    remove: (id) => removeVolume(id),
  };
}

interface RevokeExactResourceOptions {
  readonly leasePath: string;
  readonly generation: string;
  readonly resource: DockerWorkloadOuterResource;
  readonly now: () => Date;
  readonly assertBudget: () => void;
}

async function revokeExactResource(access: ExactResourceAccess, options: RevokeExactResourceOptions): Promise<string> {
  const { leasePath, generation, resource, now, assertBudget } = options;
  const { kind } = access;
  let observedId = resource.observedId;
  if (observedId === null) {
    // Crash before observation: resolve the precommitted name exactly. A
    // same-named object without this generation's label is someone else's
    // and is refused, never silently treated as absent.
    const discovered = await findByExactName(access, resource.requestedName, assertBudget);
    if (discovered === undefined) {
      recordDockerWorkloadOuterResourceRemoval(
        leasePath,
        generation,
        resource.requestId,
        { kind: 'requested-name-absent', identity: resource.requestedName },
        now(),
      );
      return resource.requestedName;
    }
    assertOwnership(discovered, resource);
    observedId = discovered.id;
    observeDockerWorkloadOuterResource(leasePath, generation, resource.requestId, observedId, now());
  } else {
    const observed = await findByImmutableId(access, observedId, assertBudget);
    if (observed === undefined) {
      recordDockerWorkloadOuterResourceRemoval(
        leasePath,
        generation,
        resource.requestId,
        { kind: 'immutable-id-absent', identity: observedId },
        now(),
      );
      return observedId;
    }
    if (observed.name !== resource.requestedName) {
      throw new Error(`observed ${kind} name changed for immutable ID ${observedId}`);
    }
    assertOwnership(observed, resource);
  }

  assertBudget();
  await access.remove(observedId, assertBudget);
  assertBudget();
  if ((await findByImmutableId(access, observedId, assertBudget)) !== undefined) {
    throw new Error(`exact outer ${kind} still exists after revocation: ${observedId}`);
  }
  recordDockerWorkloadOuterResourceRemoval(
    leasePath,
    generation,
    resource.requestId,
    { kind: 'immutable-id-absent', identity: observedId },
    now(),
  );
  return observedId;
}

/** Presence of one exact immutable ID. Only a reported absence is `undefined`; inspect errors propagate. */
async function findByImmutableId(
  access: ExactResourceAccess,
  id: string,
  assertBudget: () => void,
): Promise<NamedResourceInfo | undefined> {
  if (access.inspect === undefined) {
    return (await requiredInventory(access, assertBudget)).find((candidate) => candidate.id === id);
  }
  assertBudget();
  const inspected = await access.inspect(id);
  assertBudget();
  if (inspected === undefined) return undefined;
  assertCompleteResource(inspected, access.kind);
  if (inspected.id !== id) {
    throw new Error(`outer runtime resolved ${access.kind} ${id} to a different immutable ID: ${inspected.id}`);
  }
  return inspected;
}

/**
 * The one object with exactly `name`. An exact inspect decides when the
 * runtime returns that name; a runtime that resolved the term some other way
 * (Docker falls back to an immutable-ID prefix) falls back to the exhaustive
 * inventory, so exact-name absence is never inferred from a different object.
 */
async function findByExactName(
  access: ExactResourceAccess,
  name: string,
  assertBudget: () => void,
): Promise<NamedResourceInfo | undefined> {
  if (access.inspect !== undefined) {
    assertBudget();
    const inspected = await access.inspect(name);
    assertBudget();
    if (inspected === undefined) return undefined;
    assertCompleteResource(inspected, access.kind);
    if (inspected.name === name) return inspected;
  }
  const matching = (await requiredInventory(access, assertBudget)).filter((candidate) => candidate.name === name);
  if (matching.length > 1) throw new Error(`outer runtime returned duplicate ${access.kind} name: ${name}`);
  return matching.at(0);
}

async function requiredInventory(
  access: ExactResourceAccess,
  assertBudget: () => void,
): Promise<readonly NamedResourceInfo[]> {
  assertBudget();
  const inventory = await access.list();
  assertBudget();
  assertUniqueInventory(inventory, access.kind);
  return inventory;
}

function assertOwnership(
  resource: { readonly id: string; readonly labels: Readonly<Record<string, string>> },
  request: DockerWorkloadOuterResource,
): void {
  if (resource.labels[request.ownershipLabelKey] !== request.ownershipLabelValue) {
    throw new Error(`refusing to revoke outer resource with wrong generation label: ${resource.id}`);
  }
}

function assertCompleteResource(resource: { readonly id: string; readonly name: string }, kind: string): void {
  if (resource.id === '' || resource.name === '') {
    throw new Error(`outer runtime returned incomplete ${kind} inventory`);
  }
}

function assertUniqueInventory(
  resources: readonly { readonly id: string; readonly name: string }[],
  kind: string,
): void {
  for (const resource of resources) assertCompleteResource(resource, kind);
  if (new Set(resources.map((resource) => resource.id)).size !== resources.length) {
    throw new Error(`outer runtime returned duplicate ${kind} immutable ID`);
  }
}

function requiredResource(lease: DockerWorkloadLease, requestId: string): DockerWorkloadOuterResource {
  const resource = lease.resources.find((candidate) => candidate.requestId === requestId);
  if (resource === undefined) throw new Error(`Docker-workload lease lost outer-resource request: ${requestId}`);
  return resource;
}

function compareRevocationOrder(left: DockerWorkloadOuterResource, right: DockerWorkloadOuterResource): number {
  const kindPriority = { container: 0, volume: 1, network: 2 } as const;
  if (left.kind !== right.kind) return kindPriority[left.kind] - kindPriority[right.kind];
  const priorities = new Map([
    ['agent', 0],
    ['nested-daemon', 1],
    ['fixed-relay', 2],
    ['proxy', 3],
  ]);
  return (priorities.get(left.role) ?? 100) - (priorities.get(right.role) ?? 100);
}
