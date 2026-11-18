import { describe, expect, it } from 'vitest';
import {
  dockerDesktopVmCapacity,
  isWsl2Host,
  resolveDockerWorkloadEnvironment,
  unsupportedNestedDockerHostReason,
} from '../../src/docker-workload/environment.js';
import { parseDockerServerFacts } from '../../src/docker/docker-probe.js';

const host = { platform: 'linux', release: '6.18.33.2-microsoft-standard-WSL2' } as const;
const server = parseDockerServerFacts({
  Architecture: 'x86_64',
  OperatingSystem: 'Docker Desktop',
  OSType: 'linux',
  ServerVersion: '29.4.1',
  KernelVersion: '6.18.33.2',
  CgroupVersion: '2',
  SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
});

describe('nested Docker environment selection', () => {
  it('reads the Desktop VM capacity from docker info and ignores absent or invalid values', () => {
    const reported = parseDockerServerFacts({
      Architecture: 'x86_64',
      OperatingSystem: 'Docker Desktop',
      OSType: 'linux',
      ServerVersion: '29.4.1',
      KernelVersion: '6.18.33.2',
      CgroupVersion: '2',
      SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
      NCPU: 6,
      MemTotal: 12_345_678_912,
    });
    expect(reported).toMatchObject({ cpus: 6, memoryBytes: 12_345_678_912 });
    expect(dockerDesktopVmCapacity(resolveDockerWorkloadEnvironment('docker', reported, host))).toEqual({
      cpus: 6,
      memoryMb: 12_345,
    });
    expect(server).not.toHaveProperty('cpus');
    expect(dockerDesktopVmCapacity(resolveDockerWorkloadEnvironment('docker', server, host))).toBeUndefined();
    const invalid = parseDockerServerFacts({
      Architecture: 'x86_64',
      OperatingSystem: 'Docker Desktop',
      OSType: 'linux',
      ServerVersion: '29.4.1',
      KernelVersion: '6.18.33.2',
      CgroupVersion: '2',
      SecurityOptions: [],
      NCPU: 0,
      MemTotal: '8GiB',
    });
    expect(invalid).not.toHaveProperty('cpus');
    expect(invalid).not.toHaveProperty('memoryBytes');
  });

  it('shares one WSL2 host detector across early and fact-based admission', () => {
    expect(isWsl2Host(host.platform, host.release)).toBe(true);
    expect(isWsl2Host('linux', '6.8.0-generic')).toBe(false);
    expect(isWsl2Host('darwin', host.release)).toBe(false);
  });

  it('selects WSL amd64 from server facts without exact version binding', () => {
    expect(resolveDockerWorkloadEnvironment('docker', server, host)).toMatchObject({
      profile: 'wsl-desktop',
      architecture: 'amd64',
      egressTransport: 'unix',
    });
    expect(
      resolveDockerWorkloadEnvironment(
        'docker',
        {
          ...server,
          serverVersion: '30.1.0',
          kernelVersion: '7.0.0',
        },
        host,
      ).profile,
    ).toBe('wsl-desktop');
  });

  it.each([
    [{ ...server, architecture: 'arm64' }, /amd64 only/],
    [{ ...server, operatingSystem: 'Ubuntu' }, /not Docker Desktop/],
    [{ ...server, cgroupVersion: '1' }, /cgroup v2/],
    [{ ...server, securityOptions: [] }, /seccomp/],
    [{ ...server, securityOptions: [...server.securityOptions, 'name=apparmor'] }, /enforcing security options/],
    [{ ...server, osType: 'windows' }, /Linux Docker server/],
  ] as const)('rejects unsupported server facts', (facts, message) => {
    expect(() => resolveDockerWorkloadEnvironment('docker', facts, host)).toThrow(message);
  });

  it('offers nested Docker in the settings only on macOS and WSL2', () => {
    expect(unsupportedNestedDockerHostReason({ platform: 'darwin', release: '25.0.0' })).toBeUndefined();
    expect(unsupportedNestedDockerHostReason(host)).toBeUndefined();
    expect(unsupportedNestedDockerHostReason({ platform: 'linux', release: '7.0.0-42-generic' })).toBe(
      'Nested Docker is not yet supported on native Linux (Docker Engine or Docker Desktop for Linux). It requires macOS with Docker Desktop or Apple Container, or Windows with WSL2 and Docker Desktop.',
    );
    // WSL1 kernels do not carry the WSL2 marker and are refused like native Linux.
    expect(unsupportedNestedDockerHostReason({ platform: 'linux', release: '4.4.0-19041-Microsoft' })).toContain(
      'native Linux',
    );
    expect(unsupportedNestedDockerHostReason({ platform: 'win32', release: '10.0.26100' })).toBe(
      'Nested Docker is not yet supported on win32 hosts. It requires macOS with Docker Desktop or Apple Container, or Windows with WSL2 and Docker Desktop.',
    );
  });

  it('does not turn WSL evidence into native Linux admission', () => {
    expect(() =>
      resolveDockerWorkloadEnvironment('docker', server, {
        platform: 'linux',
        release: '6.8.0-generic',
      }),
    ).toThrow(/native Linux Engine is unqualified/);
  });

  describe('macOS Docker Desktop admission', () => {
    const mac = { platform: 'darwin', release: '25.0.0' } as const;
    const desktop = { ...server, architecture: 'arm64' as const };

    it.each([
      ['OrbStack', 'OrbStack'],
      ['Colima', 'Ubuntu 24.04.1 LTS'],
      ['Rancher Desktop', 'Rancher Desktop WSL Distribution'],
      ['Podman machine', 'fedora'],
    ])('rejects a %s engine behind the local socket with a specific message', (_engine, operatingSystem) => {
      expect(() => resolveDockerWorkloadEnvironment('docker', { ...desktop, operatingSystem }, mac, 'images')).toThrow(
        `Nested Docker on macOS requires Docker Desktop; the selected server reports operating system ${JSON.stringify(
          operatingSystem,
        )}. OrbStack, Colima, Rancher Desktop, Podman machine, and remote engines behind a local socket are not supported`,
      );
    });

    it('rejects an engine without cgroup v2 outer resource enforcement', () => {
      expect(() =>
        resolveDockerWorkloadEnvironment('docker', { ...desktop, cgroupVersion: '1' }, mac, 'offline'),
      ).toThrow(/macOS requires Docker Desktop with cgroup v2/u);
    });

    it.each(['images', 'packages', undefined] as const)(
      'requires Engine 28 for isolated relay networks in %s mode',
      (networkAccess) => {
        expect(() =>
          resolveDockerWorkloadEnvironment('docker', { ...desktop, serverVersion: '27.5.1' }, mac, networkAccess),
        ).toThrow(
          /require Docker Engine 28 or later for isolated relay networks; the selected server reports "27\.5\.1"/u,
        );
        expect(
          resolveDockerWorkloadEnvironment('docker', { ...desktop, serverVersion: '28.0.4' }, mac, networkAccess)
            .profile,
        ).toBe('macos-desktop');
      },
    );

    it('admits an older Docker Desktop for offline mode, which creates no relay network', () => {
      expect(
        resolveDockerWorkloadEnvironment('docker', { ...desktop, serverVersion: '27.5.1' }, mac, 'offline'),
      ).toMatchObject({ profile: 'macos-desktop', egressTransport: 'tcp' });
    });

    it('refuses an unparseable engine version for online modes and quotes it safely', () => {
      expect(() =>
        resolveDockerWorkloadEnvironment('docker', { ...desktop, serverVersion: 'dev\u001b[2J' }, mac, 'images'),
      ).toThrow(/reports "dev \[2J"/u);
    });
  });

  it('requires Engine 28 on WSL2 Docker Desktop for online modes only', () => {
    const older = { ...server, serverVersion: '27.4.0' };
    expect(() => resolveDockerWorkloadEnvironment('docker', older, host, 'packages')).toThrow(/Docker Engine 28/u);
    expect(resolveDockerWorkloadEnvironment('docker', older, host, 'offline').profile).toBe('wsl-desktop');
  });

  it('preserves the macOS transport and explicit Apple arm64 placement', () => {
    expect(
      resolveDockerWorkloadEnvironment(
        'docker',
        { ...server, architecture: 'arm64' },
        {
          platform: 'darwin',
          release: '25.0.0',
        },
      ),
    ).toMatchObject({ architecture: 'arm64', egressTransport: 'tcp' });
    expect(resolveDockerWorkloadEnvironment('apple-container')).toMatchObject({
      architecture: 'arm64',
      egressTransport: 'unix',
    });
  });
});
