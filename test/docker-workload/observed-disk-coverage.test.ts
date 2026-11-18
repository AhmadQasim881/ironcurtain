/**
 * The observed-disk ceiling measures real runtime storage: the frozen policy
 * and template shapes, the runtime readers that feed it, and the per-lease
 * emergency reserve.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceWatchdog,
  resourceWatchdogPolicySchema,
  type ResourceWatchdogSample,
} from '../../src/docker/resource-watchdog.js';
import {
  buildRuntimeWatchdogPolicy,
  loadFrozenWatchdogPolicyTemplate,
  renderWatchdogPolicy,
  type WatchdogPolicyTemplate,
} from '../../src/docker-workload/watchdog-policy.js';
import { createDockerManager, parseDockerVolumeUsage, type ExecFileFn } from '../../src/docker/docker-manager.js';
import { createAppleContainerManager, parseAppleContainerAppRoot } from '../../src/docker/apple-container-manager.js';
import {
  createDockerWorkloadEmergencyReserve,
  DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE,
  releaseDockerWorkloadEmergencyReserve,
} from '../../src/docker-workload/emergency-reserve.js';

const TEMPLATE_PATH = resolve('config/docker-workload/resource-watchdog-policy.json');
const TEMPLATE = loadFrozenWatchdogPolicyTemplate(TEMPLATE_PATH);
const TARGET = { root: '/state', device: 1, inode: 2 } as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function privateDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'observed-disk-')));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

describe('frozen observed-disk template', () => {
  it('covers both admitted runtimes with real storage and no host-directory classes', () => {
    expect(TEMPLATE.coverage.docker?.stateClasses.map((stateClass) => stateClass.kind)).toEqual(['docker-volume']);
    expect(TEMPLATE.coverage['apple-container']?.stateClasses.map((stateClass) => stateClass.kind)).toEqual([
      'apple-container-rootfs',
    ]);
    expect(TEMPLATE.coverage.docker?.runtimeReserveBytes).toBe(2 * 1024 ** 3);
    // The removed daemon/api/exchange/staging classes measured empty host directories.
    expect(JSON.stringify(TEMPLATE)).not.toMatch(/relativePath|"directory"|daemon-state|staging-state/u);
  });

  it('renders one runtime-specific policy, Docker with its VM-disk reserve and Apple without one', () => {
    const docker = buildRuntimeWatchdogPolicy(TEMPLATE, 'docker', TARGET);
    expect(docker).toMatchObject({
      schemaVersion: 2,
      runtimeKind: 'docker',
      targetRoot: '/state',
      runtimeReserveBytes: 2 * 1024 ** 3,
      stateClasses: [{ kind: 'docker-volume', role: 'daemon-api' }],
    });
    const apple = buildRuntimeWatchdogPolicy(TEMPLATE, 'apple-container', TARGET);
    expect(apple).toMatchObject({ runtimeKind: 'apple-container', stateClasses: [{ kind: 'apple-container-rootfs' }] });
    expect(apple).not.toHaveProperty('runtimeReserveBytes');
  });

  it('does not admit a runtime the frozen template gives no storage coverage', () => {
    const appleOnly: WatchdogPolicyTemplate = {
      ...TEMPLATE,
      coverage: { 'apple-container': TEMPLATE.coverage['apple-container'] },
    };
    expect(() => buildRuntimeWatchdogPolicy(appleOnly, 'docker', TARGET)).toThrow(
      /no storage coverage for the docker runtime/u,
    );
    const directory = privateDirectory();
    const stateRoot = join(directory, 'state');
    mkdirSync(stateRoot);
    expect(() => renderWatchdogPolicy(appleOnly, 'docker', stateRoot, join(directory, 'policy.json'))).toThrow(
      /not admitted/u,
    );
    expect(existsSync(join(directory, 'policy.json'))).toBe(false);
  });

  it('rejects policies whose classes do not measure their runtime', () => {
    const docker = buildRuntimeWatchdogPolicy(TEMPLATE, 'docker', TARGET);
    expect(() => resourceWatchdogPolicySchema.parse({ ...docker, runtimeKind: 'apple-container' })).toThrow(
      /apple-container-rootfs storage/u,
    );
    expect(() => resourceWatchdogPolicySchema.parse({ ...docker, runtimeReserveBytes: undefined })).toThrow(
      /runtime disk reserve/u,
    );
    expect(() =>
      resourceWatchdogPolicySchema.parse({ ...docker, stateClasses: [...docker.stateClasses, ...docker.stateClasses] }),
    ).toThrow();
    // Host directories are the version-1 shape only.
    expect(() =>
      resourceWatchdogPolicySchema.parse({
        ...docker,
        stateClasses: [{ id: 'daemon-state', relativePath: 'daemon', kind: 'directory', required: false }],
      }),
    ).toThrow();
  });
});

describe('runtime-storage watchdog state machine', () => {
  const policy = buildRuntimeWatchdogPolicy(
    { ...TEMPLATE, softEvidenceBytes: 100, hardSafetyBytes: 200, hostReserveBytes: 50 },
    'docker',
    TARGET,
  );
  const sample = (changes: Partial<ResourceWatchdogSample>): ResourceWatchdogSample => ({
    sampledAtMs: 1,
    targetDevice: TARGET.device,
    targetInode: TARGET.inode,
    availableBytes: 10_000,
    runtimeAvailableBytes: 10 * 1024 ** 3,
    allocatedBytes: 0,
    classes: [
      { id: 'desktop-daemon-volume', path: 'volume', exists: true, allocatedBytes: changes.allocatedBytes ?? 0 },
    ],
    ...changes,
  });

  it('cannot fall back to host directory walks for a runtime-storage policy', () => {
    expect(() => new ResourceWatchdog(policy, { onTrip: () => Promise.resolve() })).toThrow(
      /requires an injected storage sampler/u,
    );
  });

  it('trips the runtime reserve before judging the volume, after the host reserve', async () => {
    const trips: string[] = [];
    const watchdog = (value: ResourceWatchdogSample) =>
      new ResourceWatchdog(policy, {
        sample: () => Promise.resolve(value),
        schedule: false,
        onTrip: (trip) => {
          trips.push(trip.code);
          return Promise.resolve();
        },
      });
    await expect(watchdog(sample({ runtimeAvailableBytes: 1, allocatedBytes: 500 })).start()).rejects.toThrow();
    await expect(
      watchdog(sample({ availableBytes: 1, runtimeAvailableBytes: 1, allocatedBytes: 500 })).start(),
    ).rejects.toThrow();
    await expect(watchdog(sample({ allocatedBytes: 500 })).start()).rejects.toThrow();
    await watchdog(sample({ runtimeAvailableBytes: undefined })).start();
    expect(trips).toEqual(['runtime-reserve', 'host-reserve', 'hard-state-threshold']);
  });

  it('fails closed on demand through the same revocation path', async () => {
    const onTrip = vi.fn(() => Promise.resolve());
    const watchdog = new ResourceWatchdog(policy, {
      sample: () => Promise.resolve(sample({})),
      schedule: false,
      onTrip,
    });
    await watchdog.start();
    await watchdog.failClosed('sample-error', 'lifecycle claim unavailable: ENOSPC');
    await watchdog.failClosed('sample-error', 'second call is a no-op');
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(watchdog.trip).toMatchObject({ code: 'sample-error', detail: 'lifecycle claim unavailable: ENOSPC' });
    await expect(watchdog.tick()).resolves.toBeUndefined();
  });
});

describe('Docker Engine volume sizes', () => {
  it('parses the CLI human sizes, unknown sizes, and an empty VM', () => {
    expect(
      parseDockerVolumeUsage(
        JSON.stringify([
          { Name: 'a', Size: '0B' },
          { Name: 'b', Size: '8.59GB' },
          { Name: 'c', Size: '1.234kB' },
          { Name: 'd', Size: 'N/A' },
        ]),
      ),
    ).toEqual(
      new Map<string, number | null>([
        ['a', 0],
        ['b', 8_590_000_000],
        ['c', 1234],
        ['d', null],
      ]),
    );
    expect(parseDockerVolumeUsage('null\n')).toEqual(new Map());
  });

  it('fails closed on any size it cannot read exactly', () => {
    expect(() => parseDockerVolumeUsage('[{"Name":"a","Size":"8.59 GB"}]')).toThrow(/unrecognized size/u);
    expect(() => parseDockerVolumeUsage('[{"Name":"a","Size":"1e+04B"}]')).toThrow(/unrecognized size/u);
    expect(() => parseDockerVolumeUsage('[{"Name":"a","Size":"1GiB"}]')).toThrow(/unrecognized size/u);
    expect(() => parseDockerVolumeUsage('[{"Name":"a","Size":"1GB"},{"Name":"a","Size":"1GB"}]')).toThrow(/twice/u);
    expect(() => parseDockerVolumeUsage('{"Name":"a"}')).toThrow(/bounded JSON array/u);
    expect(() => parseDockerVolumeUsage('not json')).toThrow(/not valid JSON/u);
  });

  it('asks the outer Engine for its own volume walk with the caller deadline', async () => {
    const calls: { args: readonly string[]; timeout?: number }[] = [];
    const exec: ExecFileFn = (_command, args, options) => {
      calls.push({ args, timeout: options.timeout });
      return Promise.resolve({ stdout: '[{"Name":"ic-dw-daemon-api-1","Size":"12.5MB"}]\n', stderr: '' });
    };
    const manager = createDockerManager(exec);
    expect(await manager.measureVolumeUsage?.(90_000)).toEqual(new Map([['ic-dw-daemon-api-1', 12_500_000]]));
    expect(calls).toEqual([{ args: ['system', 'df', '--verbose', '--format', '{{json .Volumes}}'], timeout: 90_000 }]);
  });
});

describe('Apple container rootfs location', () => {
  it('reads the application data root from the services report, else the default', () => {
    expect(
      parseAppleContainerAppRoot(
        'apiserver is running\napplication data root: /Volumes/Data/container-root/\napplication install root: /usr/local/\n',
        '/Users/me',
      ),
    ).toBe('/Volumes/Data/container-root');
    expect(parseAppleContainerAppRoot('apiserver is running\n', '/Users/me')).toBe(
      '/Users/me/Library/Application Support/com.apple.container',
    );
    expect(() => parseAppleContainerAppRoot('application data root: relative/root\n', '/Users/me')).toThrow(
      /must be absolute/u,
    );
  });

  it('pins the exact rootfs image of one container through the runtime', async () => {
    const appRoot = privateDirectory();
    const rootfs = join(appRoot, 'containers', 'ic-agent-vm', 'rootfs.ext4');
    mkdirSync(join(appRoot, 'containers', 'ic-agent-vm'), { recursive: true });
    writeFileSync(rootfs, Buffer.alloc(4096, 1));
    const calls: (readonly string[])[] = [];
    const exec: ExecFileFn = (_command, args) => {
      calls.push(args);
      return Promise.resolve({ stdout: `apiserver is running\napplication data root: ${appRoot}/\n`, stderr: '' });
    };
    const manager = createAppleContainerManager(exec, () => Promise.resolve({ available: true }));
    const stats = lstatSync(rootfs);
    expect(await manager.describeContainerStorage?.('ic-agent-vm')).toEqual({
      kind: 'host-file',
      path: rootfs,
      device: stats.dev,
      inode: stats.ino,
    });
    expect(calls).toEqual([['system', 'status']]);
    await expect(manager.describeContainerStorage?.('ic-absent-vm')).rejects.toThrow(/ENOENT/u);
  });
});

describe('per-lease emergency reserve', () => {
  it('holds real blocks until a cleanup frees it, idempotently', () => {
    const directory = privateDirectory();
    const path = createDockerWorkloadEmergencyReserve(directory, 256 * 1024);
    expect(path).toBe(join(directory, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE));
    const stats = lstatSync(path);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(stats.size).toBe(256 * 1024);
    expect(stats.blocks * 512).toBeGreaterThanOrEqual(256 * 1024);
    expect(() => createDockerWorkloadEmergencyReserve(directory, 4096)).toThrow(/EEXIST/u);
    expect(releaseDockerWorkloadEmergencyReserve(directory)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(releaseDockerWorkloadEmergencyReserve(directory)).toBe(false);
  });

  it('never removes anything but a regular reserve file', () => {
    const directory = privateDirectory();
    mkdirSync(join(directory, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE));
    expect(releaseDockerWorkloadEmergencyReserve(directory)).toBe(false);
    expect(lstatSync(join(directory, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE)).isDirectory()).toBe(true);
  });
});
