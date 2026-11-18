import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertAdmittedDockerWorkloadRuntimeAvailable,
  assertDockerWorkloadVariantAdmitted,
  DOCKER_WORKLOAD_DISABLE_HINT,
  resolvedDockerWorkloadConfigSchema,
  dockerWorkloadRequestedSchema,
  formatDockerWorkloadStatus,
  resolveDockerWorkloadConfig,
} from '../../src/docker-workload/config.js';
import { unsupportedNestedDockerHostReason } from '../../src/docker-workload/environment.js';

const checkAppleContainerAvailable = vi.fn();
const checkDockerAvailable = vi.fn();
vi.mock('../../src/docker/docker-endpoint.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/docker-endpoint.js')>()),
  resolveDockerEndpoint: async () => ({ host: 'unix:///var/run/docker.sock' }),
}));

vi.mock('../../src/docker/apple-container-manager.js', () => ({ checkAppleContainerAvailable }));
vi.mock('../../src/docker/docker-probe.js', () => ({ checkDockerAvailable }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  release: () => '6.18.33.2-microsoft-standard-WSL2',
}));

beforeEach(() => {
  vi.clearAllMocks();
  checkAppleContainerAvailable.mockResolvedValue({ available: true });
  checkDockerAvailable.mockResolvedValue({
    available: true,
    server: {
      architecture: 'amd64',
      operatingSystem: 'Docker Desktop',
      osType: 'linux',
      serverVersion: '29.4.1',
      kernelVersion: '6.18',
      cgroupVersion: '2',
      securityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
    },
  });
});

describe('secure nested Docker configuration', () => {
  it.each(['offline', 'images', 'packages'] as const)(
    'parses the complete resolved %s configuration',
    (networkAccess) => {
      const configuration = resolveDockerWorkloadConfig({ enabled: true, networkAccess }, { memoryMb: 8192, cpus: 4 });
      const parsed = resolvedDockerWorkloadConfigSchema.parse(configuration);
      expect(parsed).toEqual(configuration);
      expect(parsed).not.toBe(configuration);
    },
  );

  it.each([
    { networkAccess: 'public' },
    { resources: { memoryMb: 4096, cpus: 2, pids: { desired: 512, required: false } } },
    { resources: { memoryMb: 1, cpus: 2, pids: { desired: 512, required: false }, diskMb: null } },
    { resources: { memoryMb: 4096, cpus: Infinity, pids: { desired: 512, required: false }, diskMb: null } },
    { resources: { memoryMb: 4096, cpus: 2, pids: { desired: 1, required: false }, diskMb: null } },
    { resources: { memoryMb: 4096, cpus: 2, pids: { desired: 512, required: false, extra: true }, diskMb: null } },
    { unknown: true },
  ])('rejects incomplete, unbounded, or extra evidence fields: %j', (override) => {
    expect(
      resolvedDockerWorkloadConfigSchema.safeParse({
        ...resolveDockerWorkloadConfig({ enabled: true }),
        ...override,
      }).success,
    ).toBe(false);
  });

  it('resolves absence, an empty object, and explicit false to the same authority-free value', () => {
    const disabled = { enabled: false } as const;
    expect(resolveDockerWorkloadConfig(undefined)).toEqual(disabled);
    expect(resolveDockerWorkloadConfig({})).toEqual(disabled);
    expect(resolveDockerWorkloadConfig({ enabled: false, backend: 'apple-container' })).toEqual(disabled);
  });

  it('materializes the admitted macOS developer policy when explicitly enabled', () => {
    expect(resolveDockerWorkloadConfig({ enabled: true })).toEqual({
      enabled: true,
      networkAccess: 'images',
      acceptObservedDiskRisk: true,
      resources: {
        memoryMb: 4096,
        cpus: 2,
        daemonShare: 0.5,
        pids: { desired: 4096, required: false },
        diskMb: null,
      },
    });
  });

  it('keeps a configured daemon share and takes the PID budget from dockerResources.pidsLimit', () => {
    expect(dockerWorkloadRequestedSchema.parse({ enabled: true, resources: { daemonShare: 0.7 } })).toEqual({
      enabled: true,
      networkAccess: 'images',
      resources: { daemonShare: 0.7 },
    });
    // Legacy defaults beside the share are still absorbed.
    expect(
      dockerWorkloadRequestedSchema.parse({
        enabled: false,
        resources: { daemonShare: 0.3, pids: { desired: 512, required: false }, diskMb: null },
      }),
    ).toEqual({ enabled: false, resources: { daemonShare: 0.3 } });
    for (const daemonShare of [0, 0.05, 0.95, 1, Number.NaN]) {
      expect(dockerWorkloadRequestedSchema.safeParse({ enabled: true, resources: { daemonShare } }).success).toBe(
        false,
      );
    }
    expect(
      resolveDockerWorkloadConfig({ enabled: true, resources: { daemonShare: 0.7 } }, { pidsLimit: 10_000 }),
    ).toMatchObject({ resources: { daemonShare: 0.7, pids: { desired: 10_000, required: false } } });
    // An unlimited or tiny ordinary ceiling falls back into the nested bounds.
    expect(resolveDockerWorkloadConfig({ enabled: true }, { pidsLimit: 64 })).toMatchObject({
      resources: { pids: { desired: 512 } },
    });
    expect(resolveDockerWorkloadConfig({ enabled: true }, {})).toMatchObject({
      resources: { pids: { desired: 4096 } },
    });
  });

  it('conservatively migrates old network choices and accepts every canonical network mode', () => {
    expect(dockerWorkloadRequestedSchema.parse({ enabled: true })).toEqual({
      enabled: true,
      networkAccess: 'images',
    });
    expect(dockerWorkloadRequestedSchema.parse({ enabled: true, imageIngress: 'public-registry' })).toEqual({
      enabled: true,
      networkAccess: 'images',
    });
    expect(dockerWorkloadRequestedSchema.parse({ enabled: false, imageIngress: 'public-registry' })).toEqual({
      enabled: false,
      networkAccess: 'images',
    });
    expect(dockerWorkloadRequestedSchema.parse({ enabled: false, imageIngress: 'preloaded-only' })).toEqual({
      enabled: false,
      networkAccess: 'offline',
    });
    expect(dockerWorkloadRequestedSchema.parse({ enabled: true, networkAccess: 'public' })).toEqual({
      enabled: true,
      networkAccess: 'packages',
    });
    for (const networkAccess of ['offline', 'images', 'packages'] as const) {
      expect(resolveDockerWorkloadConfig({ enabled: true, networkAccess })).toMatchObject({ networkAccess });
    }
    expect(dockerWorkloadRequestedSchema.safeParse({ enabled: true, networkAccess: 'unrestricted' }).success).toBe(
      false,
    );
    expect(
      dockerWorkloadRequestedSchema.safeParse({
        enabled: true,
        imageIngress: 'public-registry',
        networkAccess: 'images',
      }).success,
    ).toBe(false);
  });

  it('accepts and removes safe legacy implementation defaults', () => {
    expect(
      dockerWorkloadRequestedSchema.parse({
        enabled: true,
        tier: 'developer-only',
        backend: 'apple-container',
        imageMode: 'preloaded-catalog',
        imageIngress: 'preloaded-only',
        daemonState: 'ephemeral',
        hostPortPublishing: false,
        buildEgress: 'disabled',
        acceptObservedDiskRisk: true,
        resources: { pids: { desired: 512, required: false }, diskMb: null },
      }),
    ).toEqual({ enabled: true, networkAccess: 'offline' });

    expect(
      dockerWorkloadRequestedSchema.parse({
        enabled: false,
        networkAccess: 'images',
        tier: 'developer-only',
        backend: 'apple-container',
        imageMode: 'preloaded-catalog',
        daemonState: 'ephemeral',
        hostPortPublishing: false,
        buildEgress: 'disabled',
        acceptObservedDiskRisk: true,
        resources: { pids: { desired: 512, required: false }, diskMb: null },
      }),
    ).toEqual({ enabled: false, networkAccess: 'images' });
  });

  it('rejects unsupported legacy intent with an actionable replacement', () => {
    for (const [request, replacement] of [
      [{ enabled: true, backend: 'docker' }, 'containerRuntime'],
      [{ enabled: true, buildEgress: 'ironcurtain-dockerfiles' }, 'build egress'],
      [{ enabled: true, acceptObservedDiskRisk: false }, 'observed-disk policy'],
      [{ enabled: true, resources: { memoryMb: 8192 } }, 'dockerResources.memoryMb'],
      [{ enabled: true, resources: { cpus: 4 } }, 'dockerResources.cpus'],
      [{ enabled: true, resources: { pids: { desired: 1024 } } }, 'PID targets'],
      [{ enabled: true, resources: { pids: { required: true } } }, 'PID enforcement'],
      [{ enabled: true, resources: { diskMb: 8192 } }, 'disk limits'],
    ] as const) {
      const result = dockerWorkloadRequestedSchema.safeParse(request);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('expected unsupported legacy intent to fail');
      expect(result.error.issues.map((issue) => issue.message).join('\n')).toContain(replacement);
    }
  });

  it('admits the resolved Apple runtime and Docker only on Darwin', () => {
    const enabled = resolveDockerWorkloadConfig({ enabled: true });
    expect(() => assertDockerWorkloadVariantAdmitted(enabled, 'apple-container', 'darwin')).not.toThrow();
    expect(() => assertDockerWorkloadVariantAdmitted(enabled, 'docker', 'darwin')).not.toThrow();
    expect(() => assertDockerWorkloadVariantAdmitted(enabled, 'docker', 'linux', '6.8.0-generic')).toThrow(
      /macOS and WSL2 with Docker Desktop/u,
    );
  });

  it('tells the user how to restore ordinary sessions when it refuses the host', () => {
    const enabled = resolveDockerWorkloadConfig({ enabled: true });
    expect(() => assertDockerWorkloadVariantAdmitted(enabled, 'docker', 'linux', '7.0.0-42-generic')).toThrow(
      `not this linux host; no image, relay, daemon, or lease action was performed. ${DOCKER_WORKLOAD_DISABLE_HINT}`,
    );
    expect(DOCKER_WORKLOAD_DISABLE_HINT).toContain('set dockerWorkload.enabled to false');
  });

  it('refuses exactly the hosts the settings editors refuse', () => {
    const enabled = resolveDockerWorkloadConfig({ enabled: true });
    for (const host of [
      { platform: 'darwin', release: '25.0.0' },
      { platform: 'linux', release: '7.0.0-42-generic' },
      { platform: 'freebsd', release: '14.1-RELEASE' },
    ] as const) {
      const refusedBySettings = unsupportedNestedDockerHostReason(host) !== undefined;
      const admit = () => assertDockerWorkloadVariantAdmitted(enabled, 'docker', host.platform, host.release);
      if (refusedBySettings) expect(admit).toThrow(/not this .* host/u);
      else expect(admit).not.toThrow();
    }
  });

  it('preserves feature-off without applying the runtime or platform admission gate', () => {
    expect(() => assertDockerWorkloadVariantAdmitted(undefined, 'docker', 'linux')).not.toThrow();
    expect(() =>
      assertDockerWorkloadVariantAdmitted(resolveDockerWorkloadConfig({ enabled: false }), 'docker', 'linux'),
    ).not.toThrow();
  });

  it.each(['darwin', 'linux'] as const)('preflights only the selected runtime on %s', async (platform) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      await expect(assertAdmittedDockerWorkloadRuntimeAvailable('docker')).resolves.toMatchObject({
        architecture: 'amd64',
        profile: platform === 'darwin' ? 'macos-desktop' : 'wsl-desktop',
      });
      expect(checkDockerAvailable).toHaveBeenCalledOnce();
      expect(checkAppleContainerAvailable).not.toHaveBeenCalled();

      vi.clearAllMocks();
      checkAppleContainerAvailable.mockResolvedValue({ available: true });
      await expect(assertAdmittedDockerWorkloadRuntimeAvailable('apple-container')).resolves.toMatchObject({
        profile: 'apple-container',
      });
      expect(checkAppleContainerAvailable).toHaveBeenCalledOnce();
      expect(checkDockerAvailable).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('reports selected-runtime availability failures with probe detail', async () => {
    checkDockerAvailable.mockResolvedValueOnce({
      available: false,
      reason: 'Docker not available',
      detailedMessage: 'Start Docker Desktop.',
    });
    await expect(assertAdmittedDockerWorkloadRuntimeAvailable('docker')).rejects.toThrow(
      /Docker runtime is unavailable: Docker not available \(Start Docker Desktop\.\)/u,
    );
    checkDockerAvailable.mockResolvedValueOnce({ available: false, reason: 'Docker not available' });
    await expect(assertAdmittedDockerWorkloadRuntimeAvailable('docker')).rejects.toThrow(
      `Docker runtime is unavailable: Docker not available. ${DOCKER_WORKLOAD_DISABLE_HINT}`,
    );

    checkAppleContainerAvailable.mockResolvedValueOnce({
      available: false,
      reason: 'container services not running',
      detailedMessage: 'Start them first.',
    });
    await expect(assertAdmittedDockerWorkloadRuntimeAvailable('apple-container')).rejects.toThrow(
      /Apple runtime is unavailable: container services not running \(Start them first\.\)/u,
    );
  });

  it('holds only the online network modes to the isolated-relay engine requirement', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      checkDockerAvailable.mockResolvedValue({
        available: true,
        server: {
          architecture: 'arm64',
          operatingSystem: 'Docker Desktop',
          osType: 'linux',
          serverVersion: '27.5.1',
          kernelVersion: '6.10',
          cgroupVersion: '2',
          securityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
        },
      });
      await expect(assertAdmittedDockerWorkloadRuntimeAvailable('docker', 'offline')).resolves.toMatchObject({
        profile: 'macos-desktop',
      });
      await expect(assertAdmittedDockerWorkloadRuntimeAvailable('docker', 'images')).rejects.toThrow(
        `Update Docker Desktop, or use networkAccess "offline". ${DOCKER_WORKLOAD_DISABLE_HINT}`,
      );
      // Without a mode the stricter online requirement applies.
      await expect(assertAdmittedDockerWorkloadRuntimeAvailable('docker')).rejects.toThrow(/Docker Engine 28/u);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('refuses a non-Desktop macOS engine before any provisioning, with the disable hint', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      checkDockerAvailable.mockResolvedValueOnce({
        available: true,
        server: {
          architecture: 'arm64',
          operatingSystem: 'OrbStack',
          osType: 'linux',
          serverVersion: '28.3.3',
          kernelVersion: '6.15',
          cgroupVersion: '2',
          securityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
        },
      });
      await expect(assertAdmittedDockerWorkloadRuntimeAvailable('docker', 'images')).rejects.toThrow(
        /Nested Docker on macOS requires Docker Desktop; the selected server reports operating system "OrbStack".*To run ordinary Docker sessions/u,
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('adds the disable hint when the selected Docker server is not a qualified profile', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      checkDockerAvailable.mockResolvedValueOnce({
        available: true,
        server: {
          architecture: 'amd64',
          operatingSystem: 'Ubuntu 26.04.1 LTS',
          osType: 'linux',
          serverVersion: '29.1.3',
          kernelVersion: '6.18',
          cgroupVersion: '2',
          securityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
        },
      });
      const failure = assertAdmittedDockerWorkloadRuntimeAvailable('docker');
      await expect(failure).rejects.toThrow(
        `Nested Docker on WSL2 requires Docker Desktop; the selected server is not Docker Desktop. ${DOCKER_WORKLOAD_DISABLE_HINT}`,
      );
      await expect(failure).rejects.toHaveProperty('cause.message', expect.stringContaining('not Docker Desktop'));
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('rejects raw runtime authority', () => {
    for (const forbidden of [
      { image: 'docker:latest' },
      { mounts: ['/var/run/docker.sock:/docker.sock'] },
      { capAdd: ['SYS_ADMIN'] },
      { securityOpt: ['unconfined'] },
      { relayTarget: 'attacker.example:443' },
      { runtimeArgs: ['--privileged'] },
    ]) {
      expect(dockerWorkloadRequestedSchema.safeParse({ enabled: true, ...forbidden }).success).toBe(false);
    }
  });

  it('clamps inherited ordinary resources to the nested resource envelope', () => {
    expect(resolveDockerWorkloadConfig({ enabled: true }, { memoryMb: 6, cpus: 0.01 })).toMatchObject({
      resources: { memoryMb: 512, cpus: 0.25 },
    });
    expect(resolveDockerWorkloadConfig({ enabled: true }, { memoryMb: 2_000_000, cpus: 2048 })).toMatchObject({
      resources: { memoryMb: 1024 * 1024, cpus: 1024 },
    });
  });

  it('formats effective enabled-state network status for user-visible entrypoints', () => {
    expect(formatDockerWorkloadStatus(resolveDockerWorkloadConfig(undefined))).toBeUndefined();
    expect(formatDockerWorkloadStatus(resolveDockerWorkloadConfig({ enabled: true }))).toBe(
      'Nested Docker: enabled · network: Docker Hub/GHCR images only',
    );
    expect(formatDockerWorkloadStatus(resolveDockerWorkloadConfig({ enabled: true, networkAccess: 'offline' }))).toBe(
      'Nested Docker: enabled · network: offline',
    );
    expect(formatDockerWorkloadStatus(resolveDockerWorkloadConfig({ enabled: true, networkAccess: 'packages' }))).toBe(
      'Nested Docker: enabled · network: public packages + Docker Hub/GHCR (strict proxy)',
    );
  });

  it('absorbs the safe legacy disk defaults without hidden risk configuration', () => {
    expect(
      dockerWorkloadRequestedSchema.safeParse({
        enabled: true,
        resources: { diskMb: null },
      }).success,
    ).toBe(true);
    const resolved = resolveDockerWorkloadConfig({ enabled: true });
    if (!resolved.enabled) expect.unreachable('an explicit opt-in resolves to an enabled configuration');
    expect(resolved.resources.diskMb).toBeNull();
  });
});
