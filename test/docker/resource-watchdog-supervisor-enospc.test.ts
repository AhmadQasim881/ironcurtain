/**
 * Revocation under a full disk. Every durable write the supervisor and the
 * lease make (`writeFileSync`/`writeSync` on a descriptor: lease rewrites,
 * lock candidates, status) is made to fail with ENOSPC. The exact containers
 * and the daemon volume must still be stopped and removed.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ full: false, refusedWrites: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const refuse = (): never => {
    disk.refusedWrites += 1;
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC',
      errno: -28,
      syscall: 'write',
    });
  };
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) =>
      disk.full ? refuse() : actual.writeFileSync(...args),
    writeSync: (...args: Parameters<typeof actual.writeSync>) =>
      disk.full ? refuse() : (actual.writeSync as (...values: unknown[]) => number)(...args),
  };
});

const { runResourceWatchdogSupervisor, loadResourceWatchdogSupervisorStatus } =
  await import('../../src/docker-workload/resource-watchdog-supervisor.js');
const {
  activateDockerWorkloadLease,
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
} = await import('../../src/docker-workload/bundle-lease.js');
const { buildRuntimeWatchdogPolicy, DOCKER_WORKLOAD_STALE_HEARTBEAT_MS, loadFrozenWatchdogPolicyTemplate } =
  await import('../../src/docker-workload/watchdog-policy.js');
const { createDockerWorkloadEmergencyReserve, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE } =
  await import('../../src/docker-workload/emergency-reserve.js');
const { createMockDocker } = await import('../helpers/docker-mocks.js');

const LABEL_KEY = 'com.ironcurtain.docker-workload.generation';
const GENERATION = 'generation-enospc-001';
const temporaryDirectories: string[] = [];

afterEach(() => {
  disk.full = false;
  disk.refusedWrites = 0;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'watchdog-enospc-')));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  const stateRoot = join(directory, 'state');
  mkdirSync(stateRoot);
  const stats = lstatSync(stateRoot);
  const template = loadFrozenWatchdogPolicyTemplate(resolve('config/docker-workload/resource-watchdog-policy.json'));
  const policy = buildRuntimeWatchdogPolicy(
    { ...template, softEvidenceBytes: 256 * 1024, hardSafetyBytes: 1024 * 1024, hostReserveBytes: 1 },
    'docker',
    { root: stateRoot, device: stats.dev, inode: stats.ino },
  );
  const paths = {
    leasePath: join(directory, 'lease.json'),
    policyPath: join(directory, 'policy.json'),
    statusPath: join(directory, 'status.json'),
    stopRequestPath: join(directory, 'stop.json'),
  };
  writeFileSync(paths.policyPath, `${JSON.stringify(policy)}\n`, { mode: 0o400 });
  createDockerWorkloadLease(paths.leasePath, {
    leaseId: 'lease-enospc-001',
    bundleId: 'bundle-enospc-001',
    generation: GENERATION,
    runtimeKind: 'docker',
    dockerEndpoint: { host: 'unix:///var/run/docker.sock' },
    paths: {
      workspaceRoot: join(directory, 'workspace'),
      stateRoot,
      runtimeRoot: join(stateRoot, 'daemon'),
      apiRoot: join(stateRoot, 'api'),
      exchangeRoot: join(stateRoot, 'exchange'),
      stagingRoot: join(stateRoot, 'staging'),
    },
    bindings: { watchdogPolicy: policy },
    cleanupInventoryGapMs: policy.cleanupInventoryGapMs,
  });
  const ledgered = [
    { requestId: 'volume', kind: 'volume', role: 'daemon-api', name: 'ic-dw-daemon-api-enospc' },
    { requestId: 'daemon', kind: 'container', role: 'nested-daemon', name: 'ic-dw-nested-daemon-enospc' },
    { requestId: 'agent', kind: 'container', role: 'agent', name: 'ic-agent-enospc' },
  ] as const;
  for (const resource of ledgered) {
    requestDockerWorkloadOuterResource(paths.leasePath, GENERATION, {
      requestId: resource.requestId,
      kind: resource.kind,
      role: resource.role,
      requestedName: resource.name,
      ownershipLabelKey: LABEL_KEY,
    });
    observeDockerWorkloadOuterResource(paths.leasePath, GENERATION, resource.requestId, resource.name);
  }
  activateDockerWorkloadLease(paths.leasePath, GENERATION);
  const reservePath = createDockerWorkloadEmergencyReserve(directory, 64 * 1024);

  const labels = { [LABEL_KEY]: GENERATION };
  const containers = new Set(['ic-dw-nested-daemon-enospc', 'ic-agent-enospc']);
  const volumes = new Set(['ic-dw-daemon-api-enospc']);
  const calls: string[] = [];
  /** Whether the emergency reserve was still held at each container stop. */
  const reserveAtStop: boolean[] = [];
  const runtime = {
    ...createMockDocker(),
    listContainers: () =>
      Promise.resolve([...containers].map((name) => ({ id: name, name, created: '', running: true, labels }))),
    listNetworks: () => Promise.resolve([]),
    listVolumes: () =>
      Promise.resolve(
        [...volumes].map((name) => ({ id: name, name, created: '', labels, driver: 'local', mountpoint: '/m' })),
      ),
    stop: (id: string) => {
      calls.push(`stop:${id}`);
      reserveAtStop.push(existsSync(reservePath));
      return Promise.resolve();
    },
    remove: (id: string) => {
      calls.push(`remove:${id}`);
      containers.delete(id);
      return Promise.resolve();
    },
    removeVolume: (name: string) => {
      calls.push(`remove-volume:${name}`);
      volumes.delete(name);
      return Promise.resolve();
    },
  };
  return { directory, paths, policy, runtime, calls, reserveAtStop, containers, volumes };
}

const REVOKED = [
  'stop:ic-agent-enospc',
  'remove:ic-agent-enospc',
  'stop:ic-dw-nested-daemon-enospc',
  'remove:ic-dw-nested-daemon-enospc',
  'remove-volume:ic-dw-daemon-api-enospc',
];

describe('watchdog revocation with a full disk', () => {
  it('still stops and removes the exact containers and volume when every durable write fails', async () => {
    const setup = fixture();
    let diskReads = 0;
    const probe = {
      readRuntimeDisk: () => {
        diskReads += 1;
        // The disk fills while the supervisor holds its sampling claim, just
        // before it judges the over-threshold volume.
        if (diskReads === 2) disk.full = true;
        return Promise.resolve({ availableBytes: 40 * 1024 ** 3, usedBytes: 20 * 1024 ** 3 });
      },
      measureVolumes: () => Promise.resolve(new Map([['ic-dw-daemon-api-enospc', 2 * 1024 * 1024]])),
    };
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');

    await expect(
      runResourceWatchdogSupervisor({
        ...setup.paths,
        runtime: setup.runtime,
        storageProbe: probe,
        now: () => new Date(currentMs),
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
          if (!disk.full) heartbeatDockerWorkloadLease(setup.paths.leasePath, GENERATION, new Date(currentMs));
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        },
      }),
    ).rejects.toThrow(/ENOSPC/u);

    expect(disk.refusedWrites).toBeGreaterThan(0);
    expect(setup.calls).toEqual(REVOKED);
    expect(setup.containers.size).toBe(0);
    expect(setup.volumes.size).toBe(0);
    // The bundle filling the disk was stopped while the reserve was still
    // held, so it could not consume it; only then was the reserve freed for
    // the evidence writes (which this simulated disk still refuses).
    expect(setup.reserveAtStop).toEqual([true, true]);
    expect(existsSync(join(setup.directory, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE))).toBe(false);
    // Nothing durable changed: the ledgered pass and every status write failed.
    expect(loadDockerWorkloadLease(setup.paths.leasePath).status).toBe('active');
    expect(loadResourceWatchdogSupervisorStatus(setup.paths.statusPath).state).toBe('ready');
  });

  it('fails closed and revokes when the full disk refuses its lifecycle-claim lock record', async () => {
    const setup = fixture();
    const probe = {
      readRuntimeDisk: () => Promise.resolve({ availableBytes: 40 * 1024 ** 3, usedBytes: 20 * 1024 ** 3 }),
      measureVolumes: () => Promise.resolve(new Map([['ic-dw-daemon-api-enospc', 0]])),
    };
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');

    await expect(
      runResourceWatchdogSupervisor({
        ...setup.paths,
        runtime: setup.runtime,
        storageProbe: probe,
        now: () => new Date(currentMs),
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
          // Full before the next sampling claim: taking it writes a lock candidate.
          disk.full = true;
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow(/ENOSPC/u);

    expect(setup.calls).toEqual(REVOKED);
    expect(loadDockerWorkloadLease(setup.paths.leasePath).status).toBe('active');
  });

  it("still revokes a silent coordinator's bundle when the full disk refuses the cleanup claim", async () => {
    const setup = fixture();
    const probe = {
      readRuntimeDisk: () => Promise.resolve({ availableBytes: 40 * 1024 ** 3, usedBytes: 20 * 1024 ** 3 }),
      measureVolumes: () => Promise.resolve(new Map([['ic-dw-daemon-api-enospc', 0]])),
    };
    const startMs = Date.parse('2026-07-20T12:00:00.000Z');
    let currentMs = startMs;

    await expect(
      runResourceWatchdogSupervisor({
        ...setup.paths,
        runtime: setup.runtime,
        storageProbe: probe,
        now: () => new Date(currentMs),
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
          // The coordinator never heartbeats. The disk fills exactly when the
          // supervisor judges it stale, so the claim that the stale cleanup
          // must write is the first thing the full disk refuses.
          if (currentMs - startMs >= DOCKER_WORKLOAD_STALE_HEARTBEAT_MS) disk.full = true;
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        },
      }),
    ).rejects.toThrow(/ENOSPC/u);

    expect(disk.refusedWrites).toBeGreaterThan(0);
    expect(setup.calls).toEqual(REVOKED);
    expect(setup.reserveAtStop).toEqual([true, true]);
    expect(existsSync(join(setup.directory, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE))).toBe(false);
    // The ledger never recorded anything: the claim was refused before any lease write.
    expect(loadDockerWorkloadLease(setup.paths.leasePath).status).toBe('active');
  });
});
