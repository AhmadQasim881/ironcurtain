/**
 * Owner-lease process identity across wall-clock steps.
 *
 * On Linux procps prints `ps -o lstart` as the wall-clock boot time (`btime`
 * in /proc/stat) plus the process's start ticks, and btime moves whenever the
 * wall clock is stepped (NTP or timesyncd after a suspend, VM or WSL clock
 * jumps, `date -s`). Leases that recorded lstart therefore stopped matching
 * their live owners after a step, and the next session start reclaimed those
 * owners' containers and networks as `pid-reused`. Leases now record the
 * process-start identity of `../src/docker-workload/process-lock.ts`, which on
 * Linux is the kernel boot ID plus `/proc/<pid>/stat` start ticks.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The identity is measured synchronously, so these are the APIs a `ps` could run through.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    execSync: vi.fn(actual.execSync),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import {
  IRONCURTAIN_MANAGED_LABEL,
  IRONCURTAIN_OWNER_PID_LABEL,
  IRONCURTAIN_OWNER_TOKEN_LABEL,
  listOwnerLeaseBundleIds,
  managedResourceLabels,
  reconcileIronCurtainDockerResources,
  releaseManagedResourceLease,
} from '../src/docker/docker-resource-lifecycle.js';
import { getProcessStartIdentity } from '../src/docker-workload/process-lock.js';
import type { ContainerRuntime, DockerContainerInfo, DockerNetworkInfo } from '../src/docker/types.js';

const onLinux = process.platform === 'linux';

/** Field 22 (`starttime`, clock ticks after boot) of /proc/self/stat, parsed independently of the code under test. */
function selfStartTicks(): string {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  // comm (field 2) may hold spaces and parentheses; field 3 follows the last ") ".
  return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[22 - 3];
}

function bootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

/** Inventory that reflects removals, so a reclaimed resource disappears from the next listing. */
function inventory(input: { containers?: DockerContainerInfo[]; networks?: DockerNetworkInfo[] }) {
  const containers = [...(input.containers ?? [])];
  const networks = (input.networks ?? []).map((entry) => ({ ...entry, containerIds: [...entry.containerIds] }));
  const runtime = {
    supportsImageSnapshots: true,
    listContainers: vi.fn(async () => containers.slice()),
    listNetworks: vi.fn(async () => networks.map((entry) => ({ ...entry }))),
    remove: vi.fn(async (id: string) => {
      const index = containers.findIndex((entry) => entry.id === id);
      if (index >= 0) containers.splice(index, 1);
      for (const entry of networks) entry.containerIds = entry.containerIds.filter((attached) => attached !== id);
    }),
    removeNetwork: vi.fn(async (name: string) => {
      const index = networks.findIndex((entry) => entry.name === name);
      if (index >= 0) networks.splice(index, 1);
    }),
    containerExists: vi.fn(async (id: string) => containers.some((entry) => entry.id === id)),
    networkExists: vi.fn(async (name: string) => networks.some((entry) => entry.name === name)),
  };
  return { runtime: runtime as unknown as ContainerRuntime, containers, networks };
}

function container(labels: Record<string, string>): DockerContainerInfo {
  return { id: 'agent-id', name: 'ironcurtain-pty-live', created: '2026-11-14T08:00:00.000Z', running: true, labels };
}

function network(labels: Record<string, string>): DockerNetworkInfo {
  return {
    id: 'network-id',
    name: 'ironcurtain-0123456789ab',
    created: '2026-11-14T08:00:00.000Z',
    labels,
    subnets: ['172.20.0.0/29'],
    containerIds: ['agent-id'],
  };
}

describe('owner lease process identity', () => {
  let home: string;
  const previousHome = process.env.IRONCURTAIN_HOME;
  const leaseDir = (): string => resolve(home, 'run', 'docker-owners');
  const leaseFile = (token: string): string => resolve(leaseDir(), `${token}.json`);
  const readLease = (token: string): Record<string, unknown> =>
    JSON.parse(readFileSync(leaseFile(token), 'utf8')) as Record<string, unknown>;

  /** Labels for a resource owned by this (live) process under `token`, as `managedResourceLabels` stamps them. */
  function ownedLabels(token: string, bundleId: string): Record<string, string> {
    return {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      'ironcurtain.bundle': bundleId,
      [IRONCURTAIN_OWNER_PID_LABEL]: String(process.pid),
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: token,
    };
  }

  function writeLease(token: string, record: Record<string, unknown>): void {
    mkdirSync(leaseDir(), { recursive: true, mode: 0o700 });
    writeFileSync(leaseFile(token), JSON.stringify({ token, pid: process.pid, ...record }), { mode: 0o600 });
  }

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-owner-identity-'));
    process.env.IRONCURTAIN_HOME = home;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it.runIf(onLinux)('records the boot ID and /proc start ticks of the owner and runs no ps', async () => {
    const labels = managedResourceLabels('bundle-procfs');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];

    expect(readLease(token)).toMatchObject({
      leaseSchema: 2,
      pid: process.pid,
      identity: { kind: 'linux-boot-ticks', value: `${bootId()}:${selfStartTicks()}` },
    });

    const fake = inventory({ containers: [container(labels)], networks: [network(labels)] });
    const result = await reconcileIronCurtainDockerResources(fake.runtime);

    expect(result.decisions.map((decision) => [decision.classification, decision.action])).toEqual([
      ['live', 'retain'],
      ['live', 'retain'],
    ]);
    expect(fake.containers).toHaveLength(1);
    // Neither the lease nor the reconciliation consulted the process table through ps.
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    releaseManagedResourceLease('bundle-procfs');
  });

  it.runIf(onLinux)(
    'retains a live owner whose lease holds an lstart identity from an older version (clock stepped since)',
    async () => {
      // What earlier versions wrote: `ps -o lstart` as it read before the
      // wall clock was stepped. It no longer equals what ps prints today.
      const token = 'lease-written-before-the-step';
      writeLease(token, {
        leaseSchema: 1,
        identity: { bootId: bootId(), startedAt: 'Sat Nov 14 09:00:00 2026' },
        bundleId: 'bundle-older-version',
        runtime: 'docker',
        state: 'active',
        createdAt: '2026-11-14T09:00:01.000Z',
      });
      const labels = ownedLabels(token, 'bundle-older-version');
      const fake = inventory({ containers: [container(labels)], networks: [network(labels)] });

      const result = await reconcileIronCurtainDockerResources(fake.runtime);

      expect(result.removedContainers).toEqual([]);
      expect(result.removedNetworks).toEqual([]);
      expect(fake.runtime.remove).not.toHaveBeenCalled();
      expect(fake.runtime.removeNetwork).not.toHaveBeenCalled();
      expect(result.decisions.map((decision) => [decision.classification, decision.action])).toEqual([
        ['ambiguous', 'retain'],
        ['ambiguous', 'retain'],
      ]);
      expect(existsSync(leaseFile(token))).toBe(true);
    },
  );

  it.runIf(onLinux)('never prunes the lstart-format lease of a live owner that holds no resource yet', async () => {
    const token = 'pre-schema-lease';
    // The oldest records carry no schema, state or runtime.
    writeLease(token, { identity: { bootId: bootId(), startedAt: 'Sat Nov 14 09:00:00 2026' } });

    const result = await reconcileIronCurtainDockerResources(inventory({}).runtime);

    expect(result.prunedLeases).toBe(0);
    expect(existsSync(leaseFile(token))).toBe(true);
  });

  it.runIf(onLinux)('still reclaims a live PID whose lease records other start ticks or another boot', async () => {
    const ticks = selfStartTicks();
    const cases = [
      { token: 'recycled-pid', value: `${bootId()}:${BigInt(ticks) + 1n}` },
      { token: 'previous-boot', value: `00000000-0000-4000-8000-000000000000:${ticks}` },
    ];
    const containers: DockerContainerInfo[] = [];
    for (const { token, value } of cases) {
      writeLease(token, {
        leaseSchema: 2,
        identity: { kind: 'linux-boot-ticks', value },
        bundleId: `bundle-${token}`,
        runtime: 'docker',
        state: 'active',
        createdAt: '2026-11-14T09:00:01.000Z',
      });
      containers.push({ ...container(ownedLabels(token, `bundle-${token}`)), id: `${token}-id`, name: token });
    }
    const fake = inventory({ containers });

    const result = await reconcileIronCurtainDockerResources(fake.runtime);

    expect(result.removedContainers).toEqual(['recycled-pid', 'previous-boot']);
    expect(result.decisions.map((decision) => decision.classification)).toEqual(['pid-reused', 'pid-reused']);
    expect(fake.containers).toHaveLength(0);
    // Nothing carries their tokens any more, so the finished records are pruned too.
    expect(result.prunedLeases).toBe(2);
    expect(existsSync(leaseFile('recycled-pid'))).toBe(false);
  });

  it("still honours an older version's released tombstone while its owner lives", async () => {
    // A failed teardown under the previous version left this schema-1
    // tombstone. Its lstart identity is never compared, but the tombstone
    // alone authorizes the reclaim, even though its owner is still running.
    const token = 'released-by-older-version';
    writeLease(token, {
      leaseSchema: 1,
      identity: { bootId: 'boot-of-an-older-version', startedAt: 'Sat Nov 14 09:00:00 2026' },
      bundleId: 'bundle-released-earlier',
      runtime: 'docker',
      state: 'released',
      createdAt: '2026-11-14T09:00:01.000Z',
      releasedAt: '2026-11-14T09:30:00.000Z',
    });
    const labels = ownedLabels(token, 'bundle-released-earlier');
    const fake = inventory({ containers: [container(labels)], networks: [network(labels)] });

    const result = await reconcileIronCurtainDockerResources(fake.runtime);

    expect(result.decisions.map((decision) => [decision.classification, decision.action])).toEqual([
      ['released', 'reclaim'],
      ['released', 'reclaim'],
    ]);
    expect(fake.containers).toHaveLength(0);
    expect(fake.networks).toHaveLength(0);
    expect(result.prunedLeases).toBe(1);
    expect(existsSync(leaseFile(token))).toBe(false);
  });

  it('lists the bundles of older-version records, so retention still sees their containers', () => {
    const older = { bootId: 'boot-of-an-older-version', startedAt: 'Sat Nov 14 09:00:00 2026' };
    writeLease('schema-one', {
      leaseSchema: 1,
      identity: older,
      bundleId: 'bundle-schema-one',
      runtime: 'docker',
      state: 'active',
      createdAt: '2026-11-14T09:00:01.000Z',
    });
    writeLease('pre-schema', { identity: older, bundleId: 'bundle-pre-schema', createdAt: '2026-11-14T09:00:01.000Z' });
    writeLease('unknown-kind', {
      leaseSchema: 2,
      identity: { kind: 'pidfd-inode', value: 'measured-elsewhere' },
      bundleId: 'bundle-unknown-kind',
      runtime: 'docker',
      state: 'active',
      createdAt: '2026-11-14T09:00:01.000Z',
    });
    managedResourceLabels('bundle-current');

    // Unreadable records make `ironcurtain prune` keep every session and run;
    // the schema bump must not turn the older records into such records.
    expect(listOwnerLeaseBundleIds()).toEqual({
      bundleIds: new Set(['bundle-schema-one', 'bundle-pre-schema', 'bundle-current']),
      unreadable: 1,
    });
    releaseManagedResourceLease('bundle-current');
  });

  it.runIf(existsSync('/bin/ps'))('records the UTC ps start time on other platforms', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const labels = managedResourceLabels('bundle-lstart');
      const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];

      expect(readLease(token)).toMatchObject({
        leaseSchema: 2,
        identity: { kind: 'ps-lstart-utc', value: getProcessStartIdentity(process.pid) },
      });
      const fake = inventory({ containers: [container(labels)] });
      const result = await reconcileIronCurtainDockerResources(fake.runtime);
      expect(result.decisions).toEqual([expect.objectContaining({ classification: 'live', action: 'retain' })]);
      releaseManagedResourceLease('bundle-lstart');
    } finally {
      if (platform !== undefined) Object.defineProperty(process, 'platform', platform);
    }
  });
});
