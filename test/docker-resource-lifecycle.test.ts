import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIronCurtainInternalNetwork,
  finalizeManagedResourceLease,
  ironCurtainInternalSubnetHostAddress,
  InternalNetworkConnectivityError,
  IRONCURTAIN_CREATED_AT_LABEL,
  IRONCURTAIN_MANAGED_LABEL,
  IRONCURTAIN_OWNER_PID_LABEL,
  IRONCURTAIN_OWNER_SCOPE_LABEL,
  IRONCURTAIN_OWNER_TOKEN_LABEL,
  managedResourceLabels,
  reconcileIronCurtainDockerResources,
  reconcileIronCurtainDockerResourcesBestEffort,
  releaseManagedResourceLease,
  selectIronCurtainInternalSubnet,
  withInternalNetworkAllocationRetry,
} from '../src/docker/docker-resource-lifecycle.js';
import { destroyBundleOuterResources } from '../src/docker/container-lifecycle.js';
import { processStartIdentityKind } from '../src/docker-workload/process-lock.js';
import type { ContainerRuntime, DockerContainerInfo, DockerNetworkInfo } from '../src/docker/types.js';

function runtimeWithInventory(input: {
  containers?: DockerContainerInfo[];
  networks?: DockerNetworkInfo[];
  createNetwork?: ContainerRuntime['createNetwork'];
  /** What `networkExists` reports for every network (default: gone). */
  networkExists?: boolean;
}): ContainerRuntime {
  return {
    supportsImageSnapshots: true,
    listContainers: vi.fn(async () => input.containers ?? []),
    listNetworks: vi.fn(async () => input.networks ?? []),
    createNetwork: input.createNetwork ?? vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    removeNetwork: vi.fn(async () => {}),
    containerExists: vi.fn(async () => false),
    networkExists: vi.fn(async () => input.networkExists ?? false),
  } as unknown as ContainerRuntime;
}

function network(overrides: Partial<DockerNetworkInfo> = {}): DockerNetworkInfo {
  return {
    id: 'network-id',
    name: 'ironcurtain-1234567890ab',
    created: '2020-01-01T00:00:00.000Z',
    labels: {},
    subnets: ['172.20.0.0/29'],
    containerIds: [],
    ...overrides,
  };
}

function container(overrides: Partial<DockerContainerInfo> = {}): DockerContainerInfo {
  return {
    id: 'container-id',
    name: 'ironcurtain-1234567890ab',
    created: '2020-01-01T00:00:00.000Z',
    running: true,
    labels: {},
    ...overrides,
  };
}

function labelFilterMatches(labels: Readonly<Record<string, string>>, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  const separator = filter.indexOf('=');
  return labels[filter.slice(0, separator)] === filter.slice(separator + 1);
}

/**
 * Runtime whose inventory reflects removals, with a switch to make the next
 * container removals fail (a failed `docker rm`). Networks with attachments
 * cannot be removed, as in Docker.
 */
function statefulRuntime(input: { containers?: DockerContainerInfo[]; networks?: DockerNetworkInfo[] }) {
  const containers = [...(input.containers ?? [])];
  const networks = (input.networks ?? []).map((entry) => ({ ...entry, containerIds: [...entry.containerIds] }));
  let failingRemovals = 0;
  let failingInventories = 0;
  const inventory = <T>(value: () => T): Promise<T> => {
    if (failingInventories > 0) {
      failingInventories -= 1;
      return Promise.reject(new Error('scripted inventory failure'));
    }
    return Promise.resolve(value());
  };
  const runtime = {
    supportsImageSnapshots: true,
    listContainers: vi.fn((options?: { labelFilter?: string }) =>
      inventory(() => containers.filter((entry) => labelFilterMatches(entry.labels, options?.labelFilter))),
    ),
    listNetworks: vi.fn(() => inventory(() => networks.map((entry) => ({ ...entry })))),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async (id: string) => {
      if (failingRemovals > 0) {
        failingRemovals -= 1;
        return;
      }
      const index = containers.findIndex((entry) => entry.id === id || entry.name === id);
      if (index >= 0) containers.splice(index, 1);
      for (const entry of networks) entry.containerIds = entry.containerIds.filter((attached) => attached !== id);
    }),
    removeNetwork: vi.fn(async (name: string) => {
      const index = networks.findIndex((entry) => entry.name === name || entry.id === name);
      if (index >= 0 && networks[index].containerIds.length === 0) networks.splice(index, 1);
    }),
    containerExists: vi.fn(async (id: string) => containers.some((entry) => entry.id === id || entry.name === id)),
    networkExists: vi.fn(async (name: string) => networks.some((entry) => entry.name === name || entry.id === name)),
  };
  return {
    runtime: runtime as unknown as ContainerRuntime,
    containers,
    networks,
    failNextRemovals(count: number) {
      failingRemovals = count;
    },
    failNextInventories(count: number) {
      failingInventories = count;
    },
  };
}

describe('Docker resource crash reconciliation', () => {
  let home: string;
  const previousHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-docker-gc-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('preserves resources whose owner process and lease are live', async () => {
    const labels = managedResourceLabels('bundle-live');
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

    expect(result.retainedActiveResources).toBe(2);
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });

  it('does not reclaim live resources owned by another IronCurtain home', async () => {
    const productionHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-production-home-'));
    process.env.IRONCURTAIN_HOME = productionHome;
    const labels = managedResourceLabels('production-bundle');

    process.env.IRONCURTAIN_HOME = home;
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    try {
      const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

      expect(labels[IRONCURTAIN_OWNER_SCOPE_LABEL]).toBeTruthy();
      expect(result.retainedActiveResources).toBe(2);
      expect(docker.remove).not.toHaveBeenCalled();
      expect(docker.removeNetwork).not.toHaveBeenCalled();
    } finally {
      process.env.IRONCURTAIN_HOME = productionHome;
      releaseManagedResourceLease('production-bundle');
      process.env.IRONCURTAIN_HOME = home;
      rmSync(productionHome, { recursive: true, force: true });
    }
  });

  it('uses the same owner scope for symlink aliases of one IronCurtain home', () => {
    const alias = `${home}-alias`;
    symlinkSync(home, alias, 'dir');
    process.env.IRONCURTAIN_HOME = alias;
    const aliasLabels = managedResourceLabels('alias-bundle');
    process.env.IRONCURTAIN_HOME = home;
    const directLabels = managedResourceLabels('direct-bundle');

    try {
      expect(aliasLabels[IRONCURTAIN_OWNER_SCOPE_LABEL]).toBe(directLabels[IRONCURTAIN_OWNER_SCOPE_LABEL]);
    } finally {
      process.env.IRONCURTAIN_HOME = alias;
      releaseManagedResourceLease('alias-bundle');
      process.env.IRONCURTAIN_HOME = home;
      releaseManagedResourceLease('direct-bundle');
      rmSync(alias, { force: true });
    }
  });

  it('never reclaims foreign-home resources even when their recorded owner is dead', async () => {
    const foreignHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-foreign-home-'));
    process.env.IRONCURTAIN_HOME = foreignHome;
    const labels = managedResourceLabels('foreign-bundle');
    process.env.IRONCURTAIN_HOME = home;
    const docker = runtimeWithInventory({ containers: [container({ labels })] });

    try {
      await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });
      expect(docker.remove).not.toHaveBeenCalled();
    } finally {
      process.env.IRONCURTAIN_HOME = foreignHome;
      releaseManagedResourceLease('foreign-bundle');
      process.env.IRONCURTAIN_HOME = home;
      rmSync(foreignHome, { recursive: true, force: true });
    }
  });

  it('preserves live managed resources created before owner scopes were labeled', async () => {
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'legacy-live-owner',
      [IRONCURTAIN_CREATED_AT_LABEL]: '2026-08-24T12:00:00.000Z',
      'ironcurtain.bundle': 'legacy-live-bundle',
    };
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, {
      pidAlive: () => true,
      processIdentity: () => ({ kind: processStartIdentityKind(), value: 'same-boot:2026-08-24T11:59:00.000Z' }),
    });

    expect(result.retainedActiveResources).toBe(2);
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });

  it('preserves a live pre-scope resource when process identity is unavailable', async () => {
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'legacy-unknown-owner',
      [IRONCURTAIN_CREATED_AT_LABEL]: '2026-08-24T12:00:00.000Z',
      'ironcurtain.bundle': 'legacy-unknown-bundle',
    };
    const docker = runtimeWithInventory({ containers: [container({ labels })] });

    const result = await reconcileIronCurtainDockerResources(docker, {
      pidAlive: () => true,
      processIdentity: (pid) =>
        pid === process.pid ? { kind: processStartIdentityKind(), value: 'test-process' } : undefined,
    });

    expect(result.retainedActiveResources).toBe(1);
    expect(docker.remove).not.toHaveBeenCalled();
  });

  it('preserves current-scope resources when a live owner lease is unavailable', async () => {
    const labels = managedResourceLabels('bundle-current-unattributed');
    // An older process deleted its lease file while its resources remain.
    rmSync(resolve(home, 'run', 'docker-owners', `${labels[IRONCURTAIN_OWNER_TOKEN_LABEL]}.json`));
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

    expect(result.retainedActiveResources).toBe(2);
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });

  it('retains live pre-scope resources whose pre-schema lstart lease no longer matches', async () => {
    // Previously reclaimed as `pid-reused`. A pre-schema lease records
    // `ps -o lstart`, which on Linux moves whenever the wall clock is stepped,
    // so the mismatch cannot tell a recycled PID from a clock step under the
    // same live owner. The resources go once the PID is demonstrably dead.
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'legacy-recycled-owner',
      [IRONCURTAIN_CREATED_AT_LABEL]: '2026-08-24T12:00:00.000Z',
      'ironcurtain.bundle': 'legacy-recycled-bundle',
    };
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });
    const leaseDir = resolve(home, 'run', 'docker-owners');
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(
      resolve(leaseDir, 'legacy-recycled-owner.json'),
      JSON.stringify({
        token: 'legacy-recycled-owner',
        pid: 424242,
        identity: { bootId: 'same-boot', startedAt: 'original-process' },
      }),
    );
    const identity = (pid: number) => ({
      kind: processStartIdentityKind(),
      value: pid === 424242 ? 'recycled-process' : 'test-process',
    });

    const live = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true, processIdentity: identity });

    expect(live.retainedActiveResources).toBe(2);
    expect(live.decisions.map((decision) => decision.reason)).toEqual([
      "lease records an older version's lstart owner identity",
      "lease records an older version's lstart owner identity",
    ]);
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.removeNetwork).not.toHaveBeenCalled();

    const dead = await reconcileIronCurtainDockerResources(docker, {
      pidAlive: () => false,
      processIdentity: identity,
    });

    expect(dead.removedContainers).toEqual(['ironcurtain-1234567890ab']);
    expect(dead.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
  });

  it('treats a lease identity of another or an unknown kind as ambiguous, never as PID reuse', async () => {
    const leaseDir = resolve(home, 'run', 'docker-owners');
    mkdirSync(leaseDir, { recursive: true });
    const current = processStartIdentityKind();
    const otherKind = current === 'linux-boot-ticks' ? 'ps-lstart-utc' : 'linux-boot-ticks';
    const containers = ['other-kind', 'unknown-kind', 'no-value'].map((token) => {
      const identity =
        token === 'other-kind'
          ? { kind: otherKind, value: 'measured-elsewhere' }
          : token === 'unknown-kind'
            ? { kind: 'pidfd-inode', value: 'measured-elsewhere' }
            : { kind: current };
      writeFileSync(
        resolve(leaseDir, `${token}.json`),
        JSON.stringify({
          leaseSchema: 2,
          token,
          pid: 424242,
          identity,
          bundleId: `bundle-${token}`,
          runtime: 'docker',
          state: 'active',
          createdAt: '2026-11-14T09:00:00.000Z',
        }),
      );
      return container({
        id: `${token}-id`,
        name: token,
        labels: {
          [IRONCURTAIN_MANAGED_LABEL]: 'true',
          [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
          [IRONCURTAIN_OWNER_TOKEN_LABEL]: token,
          'ironcurtain.bundle': `bundle-${token}`,
        },
      });
    });
    const docker = runtimeWithInventory({ containers });

    const result = await reconcileIronCurtainDockerResources(docker, {
      pidAlive: () => true,
      processIdentity: () => ({ kind: current, value: 'a-different-process' }),
    });

    expect(result.decisions.map((decision) => [decision.name, decision.classification, decision.reason])).toEqual([
      ['other-kind', 'ambiguous', 'lease records an owner identity of another kind'],
      ['unknown-kind', 'ambiguous', 'lease record is unreadable or malformed'],
      ['no-value', 'ambiguous', 'lease record is unreadable or malformed'],
    ]);
    expect(docker.remove).not.toHaveBeenCalled();
  });

  it('force-removes managed containers and networks after owner death', async () => {
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'dead-owner',
      'ironcurtain.bundle': 'bundle-dead',
    };
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });

    expect(result.removedContainers).toEqual(['ironcurtain-1234567890ab']);
    expect(result.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(docker.remove).toHaveBeenCalledWith('container-id');
    expect(docker.removeNetwork).toHaveBeenCalledWith('ironcurtain-1234567890ab');
  });

  it('reclaims a lease when its PID was recycled by another process', async () => {
    const labels = managedResourceLabels('bundle-recycled-pid');
    const docker = runtimeWithInventory({ networks: [network({ labels })] });

    const result = await reconcileIronCurtainDockerResources(docker, {
      pidAlive: () => true,
      processIdentity: () => ({ kind: processStartIdentityKind(), value: 'different-process-start' }),
    });

    expect(result.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(docker.removeNetwork).toHaveBeenCalledWith('ironcurtain-1234567890ab');
  });

  it('replaces a reconciliation lock held by a recycled PID', async () => {
    const lockRoot = resolve(home, 'run', 'docker-owners');
    mkdirSync(lockRoot, { recursive: true });
    writeFileSync(
      resolve(lockRoot, 'reconcile.lock'),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        processIdentity: 'old-boot:old-process',
        token: '00000000-0000-4000-8000-000000000001',
        createdAtMs: Date.now(),
      }),
    );
    const docker = runtimeWithInventory({});

    await reconcileIronCurtainDockerResources(docker, {
      processIdentity: () => ({ kind: processStartIdentityKind(), value: 'current-boot:current-process' }),
    });

    expect(docker.listContainers).toHaveBeenCalledOnce();
    expect(docker.listNetworks).toHaveBeenCalledOnce();
  });

  it('keeps an owner, and a reconcile lock holder, whose process identity cannot be read', async () => {
    const lockRoot = resolve(home, 'run', 'docker-owners');
    mkdirSync(lockRoot, { recursive: true });
    writeFileSync(
      resolve(lockRoot, 'unreadable-owner.json'),
      JSON.stringify({
        leaseSchema: 2,
        token: 'unreadable-owner',
        pid: 424242,
        identity: { kind: processStartIdentityKind(), value: 'recorded-start' },
        bundleId: 'bundle-unreadable',
        runtime: 'docker',
        state: 'active',
        createdAt: '2026-11-14T09:00:00.000Z',
      }),
    );
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'unreadable-owner',
      'ironcurtain.bundle': 'bundle-unreadable',
    };
    const processIdentity = (pid: number) => {
      if (pid === 424242) throw new Error('EACCES: permission denied, open /proc/424242/stat');
      return { kind: processStartIdentityKind(), value: 'test-process' };
    };
    const docker = runtimeWithInventory({ containers: [container({ labels })] });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true, processIdentity });

    expect(result.decisions).toEqual([
      expect.objectContaining({ classification: 'ambiguous', reason: 'owner process identity is unavailable' }),
    ]);
    expect(docker.remove).not.toHaveBeenCalled();

    // The same failure for the holder of the reconcile lock is no proof that it exited.
    writeFileSync(
      resolve(lockRoot, 'reconcile.lock'),
      JSON.stringify({
        schemaVersion: 1,
        pid: 424242,
        processIdentity: 'recorded-start',
        token: '00000000-0000-4000-8000-000000000002',
        createdAtMs: Date.now(),
      }),
    );

    await expect(reconcileIronCurtainDockerResources(docker, { processIdentity })).resolves.toMatchObject({
      decisions: [],
    });
    // Listed only by the first pass: the second one found the lock held.
    expect(docker.listContainers).toHaveBeenCalledOnce();
    expect(existsSync(resolve(lockRoot, 'reconcile.lock'))).toBe(true);
  });

  it('keeps startup reconciliation best-effort when Docker inventory fails', async () => {
    const docker = runtimeWithInventory({});
    vi.mocked(docker.listContainers!).mockRejectedValueOnce(new Error('concurrent inspect failure'));

    await expect(reconcileIronCurtainDockerResourcesBestEffort(docker, 'test startup')).resolves.toBeUndefined();
  });

  it('reclaims a failed teardown while its released owner process is still live', async () => {
    // Previously retained until the owner exited: a released lease is a
    // tombstone that authorizes reclaiming exactly its resources.
    const labels = managedResourceLabels('bundle-released');
    expect(releaseManagedResourceLease('bundle-released')).toBe('released');
    const docker = runtimeWithInventory({ networks: [network({ labels })] });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

    expect(result.retainedActiveResources).toBe(0);
    expect(result.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(docker.removeNetwork).toHaveBeenCalledWith('ironcurtain-1234567890ab');
    expect(result.decisions).toEqual([expect.objectContaining({ classification: 'released', action: 'reclaim' })]);
  });

  it('keeps a lease while a matching network survives and prunes it once nothing carries its token', async () => {
    const labels = managedResourceLabels('bundle-container-removed');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    const leasePath = resolve(home, 'run', 'docker-owners', `${token}.json`);
    const fake = statefulRuntime({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id', 'other-container'] })],
    });

    const first = await reconcileIronCurtainDockerResources(fake.runtime, { pidAlive: () => false });

    expect(first.removedContainers).toEqual(['ironcurtain-1234567890ab']);
    expect(first.skippedUnsafeNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(first.prunedLeases).toBe(0);
    expect(existsSync(leasePath)).toBe(true);

    // The foreign attachment goes away; the next pass removes the network and the lease.
    fake.networks[0].containerIds = [];
    const second = await reconcileIronCurtainDockerResources(fake.runtime, { pidAlive: () => false });

    expect(second.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(second.prunedLeases).toBe(1);
    expect(existsSync(leasePath)).toBe(false);
  });

  it('keeps a lease when Docker still reports its container after removal', async () => {
    const labels = managedResourceLabels('bundle-container-still-exists');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    const leasePath = resolve(home, 'run', 'docker-owners', `${token}.json`);
    const docker = runtimeWithInventory({
      containers: [container({ labels })],
      networks: [network({ labels, containerIds: ['container-id'] })],
    });
    vi.mocked(docker.containerExists).mockResolvedValue(true);

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });

    expect(docker.remove).toHaveBeenCalledWith('container-id');
    expect(result.removedContainers).toEqual([]);
    expect(result.skippedUnsafeNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(existsSync(leasePath)).toBe(true);
  });

  it('keeps a lease when Docker still reports its network after removal', async () => {
    const labels = managedResourceLabels('bundle-network-still-exists');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    const leasePath = resolve(home, 'run', 'docker-owners', `${token}.json`);
    const docker = runtimeWithInventory({ networks: [network({ labels })], networkExists: true });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });

    expect(docker.removeNetwork).toHaveBeenCalledWith('ironcurtain-1234567890ab');
    expect(result.removedNetworks).toEqual([]);
    expect(existsSync(leasePath)).toBe(true);
  });

  it('migrates only empty, aged legacy networks', async () => {
    const docker = runtimeWithInventory({ networks: [network()] });
    const result = await reconcileIronCurtainDockerResources(docker, {
      now: new Date('2020-01-01T00:10:00.000Z'),
      legacyGraceMs: 60_000,
    });
    expect(result.removedNetworks).toEqual(['ironcurtain-1234567890ab']);
  });

  it('never removes a network with an attachment it cannot prove is orphaned', async () => {
    const labels = {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      [IRONCURTAIN_OWNER_PID_LABEL]: '424242',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'dead-owner',
      'ironcurtain.bundle': 'bundle-dead',
    };
    const docker = runtimeWithInventory({
      networks: [network({ labels, containerIds: ['foreign-container'] })],
    });

    const result = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => false });

    expect(result.skippedUnsafeNetworks).toEqual(['ironcurtain-1234567890ab']);
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });
});

describe('Owner lease tombstones and reconciliation decisions', () => {
  let home: string;
  const previousHome = process.env.IRONCURTAIN_HOME;
  const leaseFile = (token: string): string => resolve(home, 'run', 'docker-owners', `${token}.json`);
  const readLease = (token: string): Record<string, unknown> =>
    JSON.parse(readFileSync(leaseFile(token), 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-docker-tombstone-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('reclaims a failed docker rm of a long-lived owner at the next reconciliation', async () => {
    // A daemon-hosted session: its process stays alive after the teardown.
    const labels = managedResourceLabels('bundle-daemon');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    expect(readLease(token)).toMatchObject({ leaseSchema: 2, state: 'active', bundleId: 'bundle-daemon' });
    const fake = statefulRuntime({
      containers: [container({ id: 'agent-id', name: 'ironcurtain-daemon0001', labels })],
      networks: [network({ id: 'net-id', name: 'ironcurtain-daemon0001', labels, containerIds: ['agent-id'] })],
    });
    fake.failNextRemovals(1);

    const outcome = await destroyBundleOuterResources({
      docker: fake.runtime,
      dockerWorkload: undefined,
      containerId: 'agent-id',
      sidecarContainerId: null,
      networkName: 'ironcurtain-daemon0001',
      bundleId: 'bundle-daemon',
      context: 'test teardown',
    });

    expect(outcome).toBe('released');
    expect(fake.containers).toHaveLength(1);
    expect(readLease(token)).toMatchObject({ state: 'released', releasedAt: expect.any(String) });

    const result = await reconcileIronCurtainDockerResources(fake.runtime, { pidAlive: () => true });

    expect(result.removedContainers).toEqual(['ironcurtain-daemon0001']);
    expect(result.removedNetworks).toEqual(['ironcurtain-daemon0001']);
    expect(fake.containers).toHaveLength(0);
    expect(fake.networks).toHaveLength(0);
    // The tombstone is pruned only after the post-removal inventory is clean.
    expect(result.prunedLeases).toBe(1);
    expect(existsSync(leaseFile(token))).toBe(false);
  });

  it('deletes the lease after a verified teardown', async () => {
    const labels = managedResourceLabels('bundle-clean');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    const fake = statefulRuntime({ containers: [container({ id: 'agent-id', labels })] });

    const outcome = await destroyBundleOuterResources({
      docker: fake.runtime,
      dockerWorkload: undefined,
      containerId: 'agent-id',
      sidecarContainerId: null,
      networkName: null,
      bundleId: 'bundle-clean',
      context: 'test teardown',
    });

    expect(outcome).toBe('deleted');
    expect(existsSync(leaseFile(token))).toBe(false);
  });

  it('never throws from teardown when a verified lease record cannot be deleted', async () => {
    // destroyDockerInfrastructure and the create-failure cleanup must go on to
    // stop the proxies; a lease the filesystem refuses to delete cannot stop them.
    const labels = managedResourceLabels('bundle-undeletable');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    // A directory makes rm fail (EISDIR) the way EACCES or EBUSY would.
    rmSync(leaseFile(token));
    mkdirSync(leaseFile(token));
    const fake = statefulRuntime({ containers: [container({ id: 'agent-id', labels })] });

    const outcome = await destroyBundleOuterResources({
      docker: fake.runtime,
      dockerWorkload: undefined,
      containerId: 'agent-id',
      sidecarContainerId: null,
      networkName: null,
      bundleId: 'bundle-undeletable',
      context: 'test teardown',
    });

    expect(outcome).toBe('kept-active');
    expect(fake.containers).toHaveLength(0);
    // Still the bundle's active lease: a second finalize is not a fresh 'none'.
    await expect(finalizeManagedResourceLease('bundle-undeletable', { teardownVerified: true })).resolves.toBe(
      'kept-active',
    );
  });

  it('releases instead of deleting when a resource with the token is still listed', async () => {
    const labels = managedResourceLabels('bundle-straggler');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    // The teardown removed what it knew about, but a second container carries the token.
    const fake = statefulRuntime({ containers: [container({ id: 'unknown-id', labels })] });

    await expect(
      finalizeManagedResourceLease('bundle-straggler', { runtime: fake.runtime, teardownVerified: true }),
    ).resolves.toBe('released');
    expect(readLease(token)).toMatchObject({ state: 'released' });
  });

  it('releases when absence cannot be proven because the runtime has no inventory', async () => {
    const labels = managedResourceLabels('bundle-no-inventory');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    const runtime = { supportsImageSnapshots: true } as unknown as ContainerRuntime;

    await expect(
      finalizeManagedResourceLease('bundle-no-inventory', { runtime, teardownVerified: true }),
    ).resolves.toBe('released');
    expect(readLease(token)).toMatchObject({ state: 'released' });
    await expect(finalizeManagedResourceLease('bundle-no-inventory', { teardownVerified: true })).resolves.toBe('none');
  });

  it('keeps a released tombstone when the post-removal inventory fails', async () => {
    const labels = managedResourceLabels('bundle-flaky-inventory');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    releaseManagedResourceLease('bundle-flaky-inventory');
    const fake = statefulRuntime({ containers: [container({ labels })] });
    // The reclaim inventory succeeds; the later inventory that would prune fails.
    let inventories = 0;
    vi.mocked(fake.runtime.listContainers)?.mockImplementation(async () => {
      inventories += 1;
      if (inventories > 1) throw new Error('scripted inventory failure');
      return fake.containers.slice();
    });

    const result = await reconcileIronCurtainDockerResources(fake.runtime, { pidAlive: () => true });

    expect(result.removedContainers).toEqual(['ironcurtain-1234567890ab']);
    expect(result.prunedLeases).toBe(0);
    expect(existsSync(leaseFile(token))).toBe(true);
  });

  it('prunes an orphaned tombstone once a complete inventory has nothing carrying it', async () => {
    const token = managedResourceLabels('bundle-orphan-tombstone')[IRONCURTAIN_OWNER_TOKEN_LABEL];
    releaseManagedResourceLease('bundle-orphan-tombstone');
    const fake = statefulRuntime({});

    const result = await reconcileIronCurtainDockerResources(fake.runtime, { pidAlive: () => true });

    expect(result.prunedLeases).toBe(1);
    expect(existsSync(leaseFile(token))).toBe(false);
  });

  it('never prunes the active lease of a live owner', async () => {
    const labels = managedResourceLabels('bundle-still-starting');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    // Created its lease, has not created any resource yet.
    const fake = statefulRuntime({});

    const result = await reconcileIronCurtainDockerResources(fake.runtime, { pidAlive: () => true });

    expect(result.prunedLeases).toBe(0);
    expect(existsSync(leaseFile(token))).toBe(true);
    releaseManagedResourceLease('bundle-still-starting');
  });

  it('retains both of two concurrently live bundles in one home', async () => {
    // Regression for the PTY incident: starting a second session must not
    // reclaim the first one's container or network.
    const first = managedResourceLabels('bundle-first-pty');
    const second = managedResourceLabels('bundle-second-pty');
    const fake = statefulRuntime({
      containers: [
        container({ id: 'first-id', name: 'ironcurtain-pty-first', labels: first }),
        container({ id: 'second-id', name: 'ironcurtain-pty-second', labels: second }),
      ],
      networks: [
        network({ id: 'n1', name: 'ironcurtain-first', labels: first, containerIds: ['first-id'] }),
        network({ id: 'n2', name: 'ironcurtain-second', labels: second, containerIds: ['second-id'] }),
      ],
    });

    const result = await reconcileIronCurtainDockerResources(fake.runtime);

    expect(result.removedContainers).toEqual([]);
    expect(result.removedNetworks).toEqual([]);
    expect(result.retainedActiveResources).toBe(4);
    expect(result.decisions.every((decision) => decision.classification === 'live')).toBe(true);
    expect(fake.containers).toHaveLength(2);
    releaseManagedResourceLease('bundle-first-pty');
    releaseManagedResourceLease('bundle-second-pty');
  });

  it('treats malformed owner labels as ambiguous instead of proof of death', async () => {
    const fake = statefulRuntime({
      containers: [
        container({ id: 'a', name: 'no-owner', labels: { [IRONCURTAIN_MANAGED_LABEL]: 'true' } }),
        container({
          id: 'b',
          name: 'bad-pid',
          labels: {
            [IRONCURTAIN_MANAGED_LABEL]: 'true',
            [IRONCURTAIN_OWNER_PID_LABEL]: '12x',
            [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'token-b',
          },
        }),
      ],
    });

    fake.containers.push(
      container({
        id: 'c',
        name: 'impossible-pid',
        labels: {
          [IRONCURTAIN_MANAGED_LABEL]: 'true',
          [IRONCURTAIN_OWNER_PID_LABEL]: '9999999999',
          [IRONCURTAIN_OWNER_TOKEN_LABEL]: 'token-c',
        },
      }),
    );

    const result = await reconcileIronCurtainDockerResources(fake.runtime, { pidAlive: () => false });

    expect(result.removedContainers).toEqual([]);
    expect(result.decisions.map((decision) => [decision.name, decision.classification, decision.action])).toEqual([
      ['no-owner', 'ambiguous', 'retain'],
      ['bad-pid', 'ambiguous', 'retain'],
      ['impossible-pid', 'ambiguous', 'retain'],
    ]);
  });

  it('never uses a label token as a path outside the lease directory', async () => {
    const outside = resolve(home, 'precious.json');
    writeFileSync(outside, JSON.stringify({ token: '../precious', pid: process.pid }));
    const fake = statefulRuntime({
      containers: [
        container({
          labels: {
            [IRONCURTAIN_MANAGED_LABEL]: 'true',
            [IRONCURTAIN_OWNER_PID_LABEL]: String(process.pid),
            [IRONCURTAIN_OWNER_TOKEN_LABEL]: '../precious',
          },
        }),
      ],
    });

    const result = await reconcileIronCurtainDockerResources(fake.runtime, { pidAlive: () => false });

    expect(result.decisions).toEqual([expect.objectContaining({ classification: 'ambiguous', action: 'retain' })]);
    expect(existsSync(outside)).toBe(true);
  });

  it('retains a resource whose released record names another bundle or is not a known state', async () => {
    const labels = managedResourceLabels('bundle-mismatch');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    releaseManagedResourceLease('bundle-mismatch');
    const fake = statefulRuntime({
      containers: [container({ labels: { ...labels, 'ironcurtain.bundle': 'some-other-bundle' } })],
    });

    const mismatched = await reconcileIronCurtainDockerResources(fake.runtime, { pidAlive: () => true });
    expect(mismatched.decisions).toEqual([expect.objectContaining({ classification: 'ambiguous', action: 'retain' })]);

    writeFileSync(leaseFile(token), JSON.stringify({ ...readLease(token), state: 'paused' }));
    const unknownState = statefulRuntime({ containers: [container({ labels })] });
    const unknown = await reconcileIronCurtainDockerResources(unknownState.runtime, { pidAlive: () => true });
    expect(unknown.decisions).toEqual([expect.objectContaining({ classification: 'ambiguous', action: 'retain' })]);
    expect(unknownState.containers).toHaveLength(1);
  });

  it("reconciles a runtime without network inventory and leaves other runtimes' leases alone", async () => {
    const appleLabels = managedResourceLabels('bundle-apple-vm', 'apple-container');
    const appleToken = appleLabels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    releaseManagedResourceLease('bundle-apple-vm');
    const dockerLabels = managedResourceLabels('bundle-docker-other');
    const dockerToken = dockerLabels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    releaseManagedResourceLease('bundle-docker-other');
    expect(readLease(appleToken)).toMatchObject({ runtime: 'apple-container' });

    const fake = statefulRuntime({
      containers: [container({ id: 'vm-id', name: 'ironcurtain-pty-vm', labels: appleLabels })],
    });
    const apple = {
      ...fake.runtime,
      listNetworks: undefined,
      networkExists: undefined,
    } as unknown as ContainerRuntime;

    const result = await reconcileIronCurtainDockerResources(apple, {
      pidAlive: () => true,
      runtimeKind: 'apple-container',
    });

    expect(result.removedContainers).toEqual(['ironcurtain-pty-vm']);
    expect(result.prunedLeases).toBe(1);
    expect(existsSync(leaseFile(appleToken))).toBe(false);
    // A Docker tombstone cannot be settled by the Apple inventory.
    expect(existsSync(leaseFile(dockerToken))).toBe(true);
  });
});

describe('IronCurtain Docker subnet allocator', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-docker-ipam-'));
    process.env.IRONCURTAIN_HOME = home;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('allocates a labeled /29 outside 192.168/16 and host interface routes', async () => {
    const createNetwork = vi.fn(async () => {});
    const docker = runtimeWithInventory({ createNetwork });
    const allocated = await createIronCurtainInternalNetwork(docker, 'ironcurtain-abcdef123456', 'bundle-1', {
      hostCidrs: ['172.20.0.0/14'],
    });

    expect(allocated.subnet).toMatch(/\/29$/);
    expect(allocated.subnet).not.toMatch(/^192\.168\./);
    expect(allocated.subnet).not.toMatch(/^172\.(2[0-3])\./);
    expect(createNetwork).toHaveBeenCalledWith(
      'ironcurtain-abcdef123456',
      expect.objectContaining({
        internal: true,
        subnet: allocated.subnet,
        labels: expect.objectContaining({ [IRONCURTAIN_MANAGED_LABEL]: 'true' }),
      }),
    );
  });

  it('selects around Docker collisions without creating a network', async () => {
    const name = 'ic-dw-egress-selection-test';
    const baseline = await selectIronCurtainInternalSubnet(runtimeWithInventory({}), name, { hostCidrs: [] });
    const createNetwork = vi.fn(async () => {});
    const docker = runtimeWithInventory({
      networks: [network({ name: 'unrelated-network', subnets: [baseline] })],
      createNetwork,
    });

    const selected = await selectIronCurtainInternalSubnet(docker, name, { hostCidrs: [] });

    expect(selected).toMatch(/\/29$/u);
    expect(selected).not.toBe(baseline);
    expect(createNetwork).not.toHaveBeenCalled();
  });

  it('derives only usable host addresses from allocator-selected /29 networks', () => {
    expect(ironCurtainInternalSubnetHostAddress('172.24.10.8/29', 2)).toBe('172.24.10.10');
    expect(ironCurtainInternalSubnetHostAddress('172.24.10.8/29', 4)).toBe('172.24.10.12');
    expect(() => ironCurtainInternalSubnetHostAddress('172.24.10.0/24', 2)).toThrow(/IPv4 \/29/u);
    expect(() => ironCurtainInternalSubnetHostAddress('172.24.10.8/29', 7)).toThrow(/six usable/u);
  });

  it('walks to another /29 when Docker reports an overlap race', async () => {
    const attempts: string[] = [];
    const createNetwork = vi.fn(async (_name: string, options?: { subnet?: string }) => {
      attempts.push(options?.subnet ?? '');
      if (attempts.length === 1) {
        throw Object.assign(new Error('overlap'), {
          code: 1,
          stdout: '',
          stderr: 'Pool overlaps with other one on this address space',
        });
      }
    });
    const docker = runtimeWithInventory({ createNetwork });
    const allocated = await createIronCurtainInternalNetwork(docker, 'ironcurtain-race000000', 'bundle-2', {
      hostCidrs: [],
    });

    expect(attempts).toHaveLength(2);
    expect(allocated.subnet).toBe(attempts[1]);
    expect(attempts[0]).not.toBe(attempts[1]);
  });

  it('shares failed-pool exclusion and reconciliation across allocation retries', async () => {
    const docker = runtimeWithInventory({});
    const reconcile = vi.fn(async () => {});
    const attempts: ReadonlySet<string>[] = [];

    const result = await withInternalNetworkAllocationRetry(
      { maxAttempts: 2, description: 'Test network', reconcile },
      async (excludedSubnets, attempt) => {
        attempts.push(new Set(excludedSubnets));
        if (attempt === 1) throw new InternalNetworkConnectivityError('unreachable', '172.20.1.0/29');
        return 'allocated';
      },
    );

    expect(result).toBe('allocated');
    expect(attempts[0]).toEqual(new Set());
    expect(attempts[1]).toEqual(new Set(['172.20.0.0/14']));
    expect(reconcile).toHaveBeenCalledOnce();
    expect(docker.removeNetwork).not.toHaveBeenCalled();
  });
});
