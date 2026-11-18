import type { DockerEndpoint } from '../docker/docker-endpoint.js';
/** Runtime facts select an implemented profile; version strings are diagnostics. */
import { release } from 'node:os';
import type { DockerServerFacts } from '../docker/docker-probe.js';
import type { ContainerRuntimeKind } from '../docker/container-runtime.js';

export interface DockerWorkloadEnvironment {
  readonly dockerEndpoint?: DockerEndpoint;
  readonly profile: 'macos-desktop' | 'wsl-desktop' | 'apple-container';
  readonly architecture: 'amd64' | 'arm64';
  readonly egressTransport: 'tcp' | 'unix';
  readonly server?: DockerServerFacts;
}

export function dockerWorkloadRuntimeKind(environment: DockerWorkloadEnvironment): ContainerRuntimeKind {
  return environment.profile === 'apple-container' ? 'apple-container' : 'docker';
}

/**
 * Capacity of the Docker Desktop VM that runs every outer container, from the
 * admitted server facts (`docker info` NCPU and MemTotal). Memory uses the
 * same 1 MB = 1,000,000 bytes convention as the host-capacity clamp. Undefined
 * for Apple Container or when the daemon did not report both values; the
 * clamp then falls back to the host's own capacity.
 */
export function dockerDesktopVmCapacity(
  environment: DockerWorkloadEnvironment | undefined,
): { readonly cpus: number; readonly memoryMb: number } | undefined {
  const server = environment?.profile === 'apple-container' ? undefined : environment?.server;
  if (server?.cpus === undefined || server.memoryBytes === undefined) return undefined;
  return { cpus: server.cpus, memoryMb: Math.floor(server.memoryBytes / 1_000_000) };
}

export function isWsl2Host(platform: NodeJS.Platform, hostRelease: string): boolean {
  return platform === 'linux' && /microsoft.*wsl2|wsl2.*microsoft/i.test(hostRelease);
}

/** Host facts that decide whether secure nested Docker can be offered at all. */
export interface NestedDockerHost {
  readonly platform: NodeJS.Platform;
  readonly release: string;
}

/**
 * Why secure nested Docker can never be admitted on this host, or `undefined`
 * on a qualified platform: macOS (Docker Desktop, or Apple Container on Apple
 * silicon) or WSL2 with Docker Desktop. It is the same darwin/WSL2 test that
 * admission applies before any provisioning; Docker server facts are checked
 * later by the availability preflight. The settings editors (CLI and web UI)
 * use it to refuse turning `dockerWorkload.enabled` on, because while it is on
 * every Docker agent session goes through admission and would fail.
 */
export function unsupportedNestedDockerHostReason(
  host: NestedDockerHost = { platform: process.platform, release: release() },
): string | undefined {
  if (host.platform === 'darwin' || isWsl2Host(host.platform, host.release)) return undefined;
  const where =
    host.platform === 'linux' ? 'native Linux (Docker Engine or Docker Desktop for Linux)' : `${host.platform} hosts`;
  return `Nested Docker is not yet supported on ${where}. It requires macOS with Docker Desktop or Apple Container, or Windows with WSL2 and Docker Desktop.`;
}

/**
 * Oldest Docker Engine whose bridge driver enforces
 * `com.docker.network.bridge.gateway_mode_ipv4/ipv6=isolated`, which the
 * fixed-relay networks of the online modes depend on (DD-PROXY preflight).
 */
export const MIN_ONLINE_DOCKER_ENGINE_MAJOR = 28;

/** Network access of the admitted configuration; `offline` creates no relay network. */
export type DockerWorkloadEnvironmentNetworkAccess = 'offline' | 'images' | 'packages';

export function resolveDockerWorkloadEnvironment(
  runtimeKind: 'docker' | 'apple-container',
  server?: DockerServerFacts,
  host: { readonly platform: NodeJS.Platform; readonly release: string } = {
    platform: process.platform,
    release: release(),
  },
  /** Omitted means an online mode: the stricter engine requirement applies. */
  networkAccess?: DockerWorkloadEnvironmentNetworkAccess,
): DockerWorkloadEnvironment {
  if (runtimeKind === 'apple-container') {
    return { profile: 'apple-container', architecture: 'arm64', egressTransport: 'unix' };
  }
  if (server === undefined) throw new Error('Nested Docker requires execution-platform and daemon facts');
  if (server.osType !== 'linux') throw new Error('Nested Docker requires a Linux Docker server');
  if (host.platform === 'darwin') {
    // Any Linux engine behind a local Unix socket looks alike to the endpoint
    // check. Refuse non-Desktop engines here, before any image, lease, relay,
    // or sidecar work, instead of letting them fail late and confusingly.
    if (!/docker desktop/i.test(server.operatingSystem)) {
      throw new Error(
        `Nested Docker on macOS requires Docker Desktop; the selected server reports operating system ${displayServerFact(
          server.operatingSystem,
        )}. OrbStack, Colima, Rancher Desktop, Podman machine, and remote engines behind a local socket are not supported`,
      );
    }
    if (server.cgroupVersion !== '2') {
      throw new Error('Nested Docker on macOS requires Docker Desktop with cgroup v2 outer resource enforcement');
    }
    assertOnlineEngineVersion(server, networkAccess);
    return { profile: 'macos-desktop', architecture: server.architecture, egressTransport: 'tcp', server };
  }
  if (!isWsl2Host(host.platform, host.release)) {
    throw new Error('Nested Docker on Linux requires WSL2 with Docker Desktop; native Linux Engine is unqualified');
  }
  if (!/docker desktop/i.test(server.operatingSystem)) {
    throw new Error('Nested Docker on WSL2 requires Docker Desktop; the selected server is not Docker Desktop');
  }
  if (server.architecture !== 'amd64') throw new Error('Nested Docker on WSL2 supports amd64 only');
  if (server.cgroupVersion !== '2')
    throw new Error('Nested Docker on WSL2 requires cgroup v2 outer resource enforcement');
  if (!server.securityOptions.some((option) => option.startsWith('name=seccomp'))) {
    throw new Error('Nested Docker requires Docker seccomp support');
  }
  const unexpected = server.securityOptions.filter(
    (option) => !option.startsWith('name=seccomp') && option !== 'name=cgroupns',
  );
  if (unexpected.length !== 0) {
    throw new Error(
      `Nested Docker WSL profile does not cover these enforcing security options: ${unexpected.join(', ')}`,
    );
  }
  assertOnlineEngineVersion(server, networkAccess);
  return { profile: 'wsl-desktop', architecture: 'amd64', egressTransport: 'unix', server };
}

/**
 * Online modes attach the agent and daemon to isolated relay networks. An
 * older engine does not enforce the isolated gateway mode they are created
 * with, so it is refused before any provisioning; `offline` creates no such
 * network and keeps working on older Desktop releases.
 */
function assertOnlineEngineVersion(
  server: DockerServerFacts,
  networkAccess: DockerWorkloadEnvironmentNetworkAccess | undefined,
): void {
  if (networkAccess === 'offline') return;
  const major = /^v?(\d+)\.\d+/u.exec(server.serverVersion)?.[1];
  if (major === undefined || Number.parseInt(major, 10) < MIN_ONLINE_DOCKER_ENGINE_MAJOR) {
    throw new Error(
      `Nested Docker images and packages network access require Docker Engine ${MIN_ONLINE_DOCKER_ENGINE_MAJOR} or later for isolated relay networks; the selected server reports ${displayServerFact(
        server.serverVersion,
      )}. Update Docker Desktop, or use networkAccess "offline"`,
    );
  }
}

/** Daemon-reported text quoted into an error: single line, bounded, JSON-quoted. */
function displayServerFact(value: string): string {
  return JSON.stringify(value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 80));
}
