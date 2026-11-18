import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeAppleContainerRootfs } from '../../src/docker/apple-container-manager.js';
import { ResourceWatchdog } from '../../src/docker/resource-watchdog.js';
import {
  activateDockerWorkloadLease,
  bindDockerWorkloadOuterResourceStorage,
  createDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
} from '../../src/docker-workload/bundle-lease.js';
import { DOCKER_DESKTOP_SIDECAR_DATA_ROOT } from '../../src/docker-workload/docker-desktop-sidecar.js';
import {
  DOCKER_DESKTOP_RUNTIME_DISK_ARGV,
  DOCKER_DESKTOP_RUNTIME_DISK_PATH,
  createDockerDesktopStorageProbe,
  createObservedStorageSampler,
  parseRuntimeDiskStat,
  type DockerDesktopStorageProbe,
  type RuntimeDiskReading,
} from '../../src/docker-workload/observed-storage.js';
import {
  buildRuntimeWatchdogPolicy,
  loadFrozenWatchdogPolicyTemplate,
} from '../../src/docker-workload/watchdog-policy.js';
import { createMockDocker } from '../helpers/docker-mocks.js';

const TEMPLATE = loadFrozenWatchdogPolicyTemplate(resolve('config/docker-workload/resource-watchdog-policy.json'));
const KEY = 'com.ironcurtain.docker-workload.generation';
const GENERATION = 'generation-observed-001';
const GIB = 1024 * 1024 * 1024;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'observed-storage-')));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function leaseFor(runtimeKind: 'docker' | 'apple-container') {
  const directory = fixtureRoot();
  const stateRoot = join(directory, 'state');
  mkdirSync(stateRoot, { mode: 0o700 });
  const stats = lstatSync(stateRoot);
  const policy = buildRuntimeWatchdogPolicy(TEMPLATE, runtimeKind, {
    root: stateRoot,
    device: stats.dev,
    inode: stats.ino,
  });
  const leasePath = join(directory, 'lease.json');
  createDockerWorkloadLease(leasePath, {
    leaseId: `lease-${runtimeKind}`,
    bundleId: `bundle-${runtimeKind}`,
    generation: GENERATION,
    runtimeKind,
    ...(runtimeKind === 'docker' ? { dockerEndpoint: { host: 'unix:///var/run/docker.sock' } } : {}),
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
  const ledger = (requestId: string, kind: 'container' | 'volume', role: string, name: string): void => {
    requestDockerWorkloadOuterResource(leasePath, GENERATION, {
      requestId,
      kind,
      role,
      requestedName: name,
      ownershipLabelKey: KEY,
    });
    observeDockerWorkloadOuterResource(leasePath, GENERATION, requestId, name);
  };
  return { directory, leasePath, policy, ledger };
}

function appleFixture() {
  const fixture = leaseFor('apple-container');
  fixture.ledger('agent-vm', 'container', 'agent', 'ic-agent-vm');
  const appRoot = join(fixture.directory, 'app-root');
  const rootfs = join(appRoot, 'containers', 'ic-agent-vm', 'rootfs.ext4');
  mkdirSync(dirname(rootfs), { recursive: true, mode: 0o700 });
  // The runtime clones the image into the VM's rootfs before it starts.
  writeFileSync(rootfs, Buffer.alloc(256 * 1024, 7));
  bindDockerWorkloadOuterResourceStorage(
    fixture.leasePath,
    GENERATION,
    'agent-vm',
    describeAppleContainerRootfs(appRoot, 'ic-agent-vm'),
  );
  const sample = createObservedStorageSampler({
    policy: fixture.policy,
    readLease: () => loadDockerWorkloadLease(fixture.leasePath),
    runtime: createMockDocker(),
    now: () => 1_000,
    monotonicNow: () => 1_000,
  });
  const activate = (): void => {
    activateDockerWorkloadLease(
      fixture.leasePath,
      GENERATION,
      new Date(),
      new Map([['agent-vm', lstatSync(rootfs).blocks * 512]]),
    );
  };
  return { ...fixture, rootfs, sample, activate };
}

const signal = new AbortController().signal;
const MIB = 1024 * 1024;

describe('Apple observed storage', () => {
  it('charges the VM rootfs image for allocated blocks above the activation baseline', async () => {
    const fixture = appleFixture();
    // Trusted bootstrap: nothing is charged before activation records the baseline.
    writeFileSync(fixture.rootfs, Buffer.alloc(512 * 1024, 3), { flag: 'a' });
    expect((await fixture.sample(signal)).allocatedBytes).toBe(0);

    fixture.activate();
    expect((await fixture.sample(signal)).allocatedBytes).toBe(0);

    writeFileSync(fixture.rootfs, Buffer.alloc(MIB, 5), { flag: 'a' });
    const grown = await fixture.sample(signal);
    expect(grown.allocatedBytes).toBeGreaterThanOrEqual(MIB);
    expect(grown.allocatedBytes).toBeLessThan(MIB + 256 * 1024);
    expect(grown.classes).toEqual([
      expect.objectContaining({ id: 'apple-vm-rootfs', exists: true, allocatedBytes: grown.allocatedBytes }),
    ]);

    // A sparse logical extension allocates nothing, so it charges nothing.
    truncateSync(fixture.rootfs, 512 * MIB);
    const sparse = await fixture.sample(signal);
    expect(sparse.allocatedBytes).toBeLessThan(MIB + 256 * 1024);
  });

  it('refuses a substituted rootfs image and treats a deleted VM as holding no storage', async () => {
    const fixture = appleFixture();
    fixture.activate();
    const replacement = `${fixture.rootfs}.new`;
    writeFileSync(replacement, Buffer.alloc(64 * 1024, 1));
    renameSync(replacement, fixture.rootfs);
    await expect(fixture.sample(signal)).rejects.toThrow(/rootfs image identity changed/u);

    rmSync(fixture.rootfs);
    expect((await fixture.sample(signal)).allocatedBytes).toBe(0);
  });

  it('fails closed on an observed Apple container with no bound rootfs image', async () => {
    const fixture = leaseFor('apple-container');
    fixture.ledger('agent-vm', 'container', 'agent', 'ic-agent-vm');
    const sample = createObservedStorageSampler({
      policy: fixture.policy,
      readLease: () => loadDockerWorkloadLease(fixture.leasePath),
      runtime: createMockDocker(),
      now: () => 1_000,
      monotonicNow: () => 1_000,
    });
    await expect(sample(signal)).rejects.toThrow(/no bound rootfs image/u);
  });

  it('rejects a symlinked or foreign rootfs path when binding at create', () => {
    const appRoot = join(fixtureRoot(), 'app-root');
    mkdirSync(join(appRoot, 'containers', 'real'), { recursive: true });
    writeFileSync(join(appRoot, 'containers', 'real', 'rootfs.ext4'), 'x');
    mkdirSync(join(appRoot, 'containers', 'linked'));
    symlinkSync(
      join(appRoot, 'containers', 'real', 'rootfs.ext4'),
      join(appRoot, 'containers', 'linked', 'rootfs.ext4'),
    );
    expect(() => describeAppleContainerRootfs(appRoot, '../real')).toThrow(/safe path segment/u);
    expect(() => describeAppleContainerRootfs(appRoot, 'linked')).toThrow(/not a real runtime-owned file/u);
    expect(() => describeAppleContainerRootfs(appRoot, 'absent')).toThrow(/ENOENT/u);
    expect(describeAppleContainerRootfs(appRoot, 'real')).toMatchObject({
      kind: 'host-file',
      path: join(appRoot, 'containers', 'real', 'rootfs.ext4'),
    });
  });
});

class FakeDesktopProbe implements DockerDesktopStorageProbe {
  disk: RuntimeDiskReading = { availableBytes: 40 * GIB, usedBytes: 20 * GIB };
  volumes = new Map<string, number | null>([['ic-dw-daemon-api-test', 0]]);
  diskFailure: Error | undefined;
  readonly diskReads: string[] = [];
  volumeReads = 0;

  readRuntimeDisk(containerId: string): Promise<RuntimeDiskReading> {
    this.diskReads.push(containerId);
    return this.diskFailure === undefined ? Promise.resolve({ ...this.disk }) : Promise.reject(this.diskFailure);
  }

  measureVolumes(): Promise<ReadonlyMap<string, number | null>> {
    this.volumeReads += 1;
    return Promise.resolve(new Map(this.volumes));
  }
}

function desktopFixture() {
  const fixture = leaseFor('docker');
  fixture.ledger('daemon-volume', 'volume', 'daemon-api', 'ic-dw-daemon-api-test');
  fixture.ledger('daemon', 'container', 'nested-daemon', 'nested-daemon-container');
  const probe = new FakeDesktopProbe();
  const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
  const sample = createObservedStorageSampler({
    policy: fixture.policy,
    readLease: () => loadDockerWorkloadLease(fixture.leasePath),
    runtime: createMockDocker(),
    now: () => time.wallMs,
    monotonicNow: () => time.monotonicMs,
    dockerDesktopProbe: probe,
  });
  const advance = (milliseconds: number): void => {
    time.wallMs += milliseconds;
    time.monotonicMs += milliseconds;
  };
  return { ...fixture, probe, sample, time, advance };
}

/** Let the background readings settle. */
async function settle(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

describe('Docker Desktop observed storage', () => {
  it('reads the VM disk every sample and sizes the daemon volume on its slower cadence', async () => {
    const fixture = desktopFixture();
    const first = await fixture.sample(signal);
    // Both readings are pending on the very first sample.
    expect(first.runtimeAvailableBytes).toBeUndefined();
    expect(first.allocatedBytes).toBe(0);
    await settle();

    fixture.probe.volumes.set('ic-dw-daemon-api-test', 3 * GIB);
    fixture.advance(5_000);
    const second = await fixture.sample(signal);
    expect(second.runtimeAvailableBytes).toBe(40 * GIB);
    // The volume grew after the only sizing so far; the next one is not due yet.
    expect(second.allocatedBytes).toBe(0);
    await settle();
    expect(fixture.probe.diskReads).toEqual(['nested-daemon-container', 'nested-daemon-container']);
    expect(fixture.probe.volumeReads).toBe(1);

    fixture.advance(60_000);
    await fixture.sample(signal);
    await settle();
    fixture.advance(5_000);
    expect((await fixture.sample(signal)).allocatedBytes).toBe(3 * GIB);
    expect(fixture.probe.volumeReads).toBe(2);
  });

  it('resizes the volume as soon as the VM disk has grown by the overshoot bound', async () => {
    const fixture = desktopFixture();
    await fixture.sample(signal);
    await settle();
    fixture.advance(5_000);
    await fixture.sample(signal);
    await settle();
    expect(fixture.probe.volumeReads).toBe(1);

    fixture.probe.disk = { availableBytes: 38 * GIB, usedBytes: 22 * GIB };
    fixture.probe.volumes.set('ic-dw-daemon-api-test', 9 * GIB);
    fixture.advance(5_000);
    await fixture.sample(signal);
    await settle();
    fixture.advance(5_000);
    await fixture.sample(signal);
    await settle();
    // Two seconds' worth of growth, well inside the 60 s volume interval.
    expect(fixture.probe.volumeReads).toBe(2);
    fixture.advance(5_000);
    expect((await fixture.sample(signal)).allocatedBytes).toBe(9 * GIB);
  });

  it('trips the hard threshold when the daemon volume grows past it (fake probe)', async () => {
    const fixture = desktopFixture();
    const trips: string[] = [];
    const watchdog = new ResourceWatchdog(fixture.policy, {
      sample: fixture.sample,
      schedule: false,
      now: () => fixture.time.wallMs,
      monotonicNow: () => fixture.time.monotonicMs,
      onTrip: (trip) => {
        trips.push(trip.code);
        return Promise.resolve();
      },
    });
    await watchdog.start();
    await settle();
    fixture.probe.volumes.set('ic-dw-daemon-api-test', fixture.policy.hardSafetyBytes + MIB);
    for (let tick = 0; tick < 16 && trips.length === 0; tick += 1) {
      fixture.advance(5_000);
      await watchdog.tick();
      await settle();
    }
    expect(trips).toEqual(['hard-state-threshold']);
    expect(watchdog.trip?.sample?.allocatedBytes).toBe(fixture.policy.hardSafetyBytes + MIB);
  });

  it('trips the runtime reserve when the shared VM disk runs low', async () => {
    const fixture = desktopFixture();
    const trips: string[] = [];
    const watchdog = new ResourceWatchdog(fixture.policy, {
      sample: fixture.sample,
      schedule: false,
      now: () => fixture.time.wallMs,
      monotonicNow: () => fixture.time.monotonicMs,
      onTrip: (trip) => {
        trips.push(trip.code);
        return Promise.resolve();
      },
    });
    fixture.probe.disk = { availableBytes: GIB, usedBytes: 59 * GIB };
    await watchdog.start();
    await settle();
    fixture.advance(5_000);
    await watchdog.tick();
    expect(trips).toEqual(['runtime-reserve']);
  });

  it('tolerates a slow VM disk reading until its staleness bound, then fails closed', async () => {
    const fixture = desktopFixture();
    await fixture.sample(signal);
    await settle();
    // Every reading after the first one fails from here on.
    fixture.probe.diskFailure = new Error('docker exec timed out');
    // Staleness counts from the sample that first saw the last good reading.
    for (let elapsedMs = 5_000; elapsedMs <= 30_000; elapsedMs += 5_000) {
      fixture.advance(5_000);
      expect((await fixture.sample(signal)).runtimeAvailableBytes).toBe(40 * GIB);
      await settle();
    }
    fixture.advance(5_000);
    await expect(fixture.sample(signal)).rejects.toThrow(/VM disk reading has not completed for 30000ms.*timed out/u);
  });

  it('fails closed when the Engine cannot size the daemon volume', async () => {
    const fixture = desktopFixture();
    fixture.probe.volumes.set('ic-dw-daemon-api-test', null);
    await fixture.sample(signal);
    await settle();
    fixture.advance(5_000);
    await expect(fixture.sample(signal)).rejects.toThrow(/could not size daemon volume/u);
  });

  it('measures nothing until the sidecar and volume exist', async () => {
    const fixture = leaseFor('docker');
    const probe = new FakeDesktopProbe();
    const sample = createObservedStorageSampler({
      policy: fixture.policy,
      readLease: () => loadDockerWorkloadLease(fixture.leasePath),
      runtime: createMockDocker(),
      now: () => 1_000,
      monotonicNow: () => 1_000,
      dockerDesktopProbe: probe,
    });
    expect(await sample(signal)).toMatchObject({ allocatedBytes: 0, classes: [{ exists: false }] });
    expect(probe.diskReads).toEqual([]);
    expect(probe.volumeReads).toBe(0);
  });

  it('reads the VM disk as uid 0 through the sidecar mount point of the daemon volume', async () => {
    const calls: unknown[][] = [];
    const runtime = {
      ...createMockDocker(),
      exec: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ exitCode: 0, stdout: '4096 1000 400 300\n', stderr: '' });
      },
      measureVolumeUsage: () => Promise.resolve(new Map([['volume', 12]])),
    };
    const probe = createDockerDesktopStorageProbe(runtime);
    expect(await probe.readRuntimeDisk('daemon-id', 5_000)).toEqual({
      availableBytes: 300 * 4096,
      usedBytes: 600 * 4096,
    });
    expect(calls).toEqual([['daemon-id', DOCKER_DESKTOP_RUNTIME_DISK_ARGV, 5_000, '0:0']]);
    expect(DOCKER_DESKTOP_RUNTIME_DISK_PATH).toBe(dirname(DOCKER_DESKTOP_SIDECAR_DATA_ROOT));
    expect(await probe.measureVolumes(1_000)).toEqual(new Map([['volume', 12]]));
  });

  it('rejects malformed or inconsistent statfs output', () => {
    expect(() => parseRuntimeDiskStat('4096 10 20 5')).toThrow(/inconsistent/u);
    expect(() => parseRuntimeDiskStat('4096 10 5')).toThrow(/unexpected statfs line/u);
    expect(() => parseRuntimeDiskStat('4096 -10 5 5')).toThrow(/unexpected statfs line/u);
    expect(() => parseRuntimeDiskStat('0 10 5 5')).toThrow(/inconsistent/u);
  });
});
