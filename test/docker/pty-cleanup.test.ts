import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logger from '../../src/logger.js';

const state = vi.hoisted<{
  infrastructure: unknown;
  /** Replaces the scripted `infrastructure` result of prepareDockerInfrastructure when set. */
  prepare: (() => Promise<unknown>) | undefined;
  destroyArguments: unknown;
  destroyError: unknown;
  removeBundleRuntimeRoot: ReturnType<typeof vi.fn>;
  updateSessionMetadata: ReturnType<typeof vi.fn>;
}>(() => ({
  infrastructure: undefined,
  prepare: undefined,
  destroyArguments: undefined,
  destroyError: undefined,
  removeBundleRuntimeRoot: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

vi.mock('ora', () => ({
  default: () => ({
    isSpinning: true,
    start() {
      return this;
    },
    fail() {},
    succeed() {},
  }),
}));

vi.mock('../../src/session/index.js', () => ({
  // Like the real one, creates the session directory (the session claims it).
  buildSessionConfig: (config: unknown, sessionId: string) => {
    mkdirSync(`${process.env.IRONCURTAIN_HOME}/sessions/${sessionId}`, { recursive: true });
    return {
      config,
      sandboxDir: `/tmp/${sessionId}/sandbox`,
      escalationDir: `/tmp/${sessionId}/escalations`,
      systemPromptAugmentation: '',
      resolvedSkills: [],
      memoryEnabled: false,
      hostModelNotices: [],
    };
  },
}));

vi.mock('../../src/session/session-metadata.js', () => ({
  updateSessionMetadata: state.updateSessionMetadata,
}));

vi.mock('../../src/docker/claude-md-seed.js', () => ({ buildDockerClaudeMd: () => '' }));

vi.mock('../../src/docker/docker-infrastructure.js', () => ({
  prepareDockerInfrastructure: async () => (state.prepare ? state.prepare() : state.infrastructure),
  activateNestedDockerWorkload: vi.fn(),
  attachDockerDesktopAgentEgressNetwork: vi.fn(),
  resolveNestedDockerAgentWiring: () => ({ appleNestedDaemon: undefined, env: {}, namedVolumeMounts: [] }),
  resolveNestedDockerOuterAgentImage: (_infra: unknown, image: string) => image,
  buildAgentUidRemap: () => ({}),
  buildDockerDesktopTransportCreateLimits: () => ({}),
  buildDockerAgentTrustedCreateOptions: () => undefined,
  buildUdsSocketMounts: () => [],
  buildDockerWorkloadEgressMounts: () => [],
  dockerWorkloadEgressNetworkAccess: () => 'offline',
  stopDockerWorkloadEgress: async (egress?: {
    registry?: { listener: { stop(): Promise<void> } };
    packages?: { listener: { stop(): Promise<void> } };
  }) => {
    await Promise.allSettled([
      ...(egress?.packages ? [egress.packages.listener.stop()] : []),
      ...(egress?.registry ? [egress.registry.listener.stop()] : []),
    ]);
  },
  createLedgeredAgentContainer: vi.fn(),
  dockerWorkloadSessionMetadata: vi.fn((_handle: unknown, configuration: unknown, backend: string) => ({
    leaseId: 'lease-1',
    generation: 'generation-1',
    configuration,
    backend,
  })),
  removeBundleRuntimeRoot: state.removeBundleRuntimeRoot,
  selectOuterContainerResources: () => ({ memoryMb: undefined, cpus: undefined }),
  writeAptProxyConfigViaExec: vi.fn(),
  checkDockerContainerWritableStorage: vi.fn(),
  checkHostOnlyConnectivity: vi.fn(),
  checkInternalNetworkConnectivity: vi.fn(),
}));

vi.mock('../../src/docker/container-lifecycle.js', () => ({
  destroyBundleOuterResources: async (options: { dockerWorkload?: { teardown(): Promise<void> } }) => {
    state.destroyArguments = options;
    await options.dockerWorkload?.teardown();
    if (state.destroyError !== undefined) {
      throw state.destroyError instanceof Error ? state.destroyError : new Error('scripted non-Error cleanup failure');
    }
  },
}));

import { runPtySession } from '../../src/docker/pty-session.js';
import { InternalNetworkConnectivityError } from '../../src/docker/docker-resource-lifecycle.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';

describe('PTY early-initialization cleanup ownership', () => {
  const directories: string[] = [];
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pty-cleanup-home-'));
    directories.push(home);
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
  });

  /** Whether any session directory still holds its claim (resume.lock). */
  function anySessionClaimed(): boolean {
    const sessionsDir = join(home, 'sessions');
    return readdirSync(sessionsDir).some((id) => existsSync(join(sessionsDir, id, 'resume.lock')));
  }

  afterEach(() => {
    if (originalHome !== undefined) process.env.IRONCURTAIN_HOME = originalHome;
    else delete process.env.IRONCURTAIN_HOME;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    state.infrastructure = undefined;
    state.prepare = undefined;
    state.destroyArguments = undefined;
    state.destroyError = undefined;
    state.removeBundleRuntimeRoot.mockReset();
    state.updateSessionMetadata.mockReset();
  });

  it('revokes the workload and stops both proxies when capture begin throws', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), 'pty-cleanup-'));
    directories.push(directory);
    const teardown = vi.fn(async () => {});
    const proxyStop = vi.fn(async () => {});
    const mitmStop = vi.fn(async () => {});
    const registryStop = vi.fn(async () => {});
    const packageStop = vi.fn(async () => {});
    const docker = {};
    const dockerWorkload = { teardown };
    state.infrastructure = {
      docker,
      dockerWorkload,
      proxy: { stop: proxyStop },
      mitmProxy: { stop: mitmStop },
      dockerWorkloadEgress: {
        networkAccess: 'packages',
        registry: { listener: { stop: registryStop }, socketPath: '/tmp/registry.sock' },
        packages: { listener: { stop: packageStop }, socketPath: '/tmp/package.sock' },
      },
      useTcp: false,
      runtimeKind: 'apple-container',
      setTokenSessionId: () => {},
      beginCaptureSession: () => {
        throw new Error('scripted capture begin failure');
      },
    };

    await expect(
      runPtySession({
        config: {
          userConfig: {
            modelProviders: { default: 'native' },
            dockerWorkload: { enabled: true },
          },
        } as never,
        mode: { kind: 'docker', agent: 'claude-code' as AgentId },
        workspacePath: directory,
      }),
    ).rejects.toThrow(/scripted capture begin failure/u);

    expect(state.destroyArguments).toMatchObject({ docker, dockerWorkload });
    expect(teardown).toHaveBeenCalledOnce();
    expect(mitmStop).toHaveBeenCalledOnce();
    expect(proxyStop).toHaveBeenCalledOnce();
    expect(registryStop).toHaveBeenCalledOnce();
    expect(packageStop).toHaveBeenCalledOnce();
    expect(state.removeBundleRuntimeRoot).toHaveBeenCalledOnce();
    expect(state.updateSessionMetadata).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        dockerWorkload: expect.objectContaining({
          leaseId: 'lease-1',
          generation: 'generation-1',
          backend: 'apple-container',
        }),
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith('PTY setup failed: scripted capture begin failure');
    // The fresh session's claim on its directory is given back with the rest.
    expect(anySessionClaimed()).toBe(false);
    errorSpy.mockRestore();
  });

  it('stops proxies and removes the runtime root when resource verification fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pty-cleanup-'));
    directories.push(directory);
    const proxyStop = vi.fn(async () => {});
    const mitmStop = vi.fn(async () => {});
    state.destroyError = new Error('scripted runtime verification failure');
    state.infrastructure = {
      docker: {},
      proxy: { stop: proxyStop },
      mitmProxy: { stop: mitmStop },
      useTcp: false,
      setTokenSessionId: () => {},
      beginCaptureSession: () => {
        throw new Error('scripted capture begin failure');
      },
    };

    await expect(
      runPtySession({
        config: { userConfig: { modelProviders: { default: 'native' } } } as never,
        mode: { kind: 'docker', agent: 'claude-code' as AgentId },
        workspacePath: directory,
      }),
    ).rejects.toThrow(/scripted runtime verification failure/u);

    expect(mitmStop).toHaveBeenCalledOnce();
    expect(proxyStop).toHaveBeenCalledOnce();
    expect(state.removeBundleRuntimeRoot).toHaveBeenCalledOnce();
    expect(anySessionClaimed()).toBe(false);
  });

  it('claims the directory of every retried attempt and gives all of them back when the session ends', async () => {
    // A rejected internal network makes runPtySession start the session again
    // under a new ID; each attempt claims the directory it created, and every
    // claim is held until the session has ended.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), 'pty-cleanup-'));
    directories.push(directory);
    const sessionsDir = join(home, 'sessions');
    const claimed = (): string[] =>
      readdirSync(sessionsDir).filter((id) => existsSync(join(sessionsDir, id, 'resume.lock')));
    const claimedPerAttempt: string[][] = [];
    state.prepare = () => {
      claimedPerAttempt.push(claimed());
      return Promise.reject(
        claimedPerAttempt.length === 1
          ? new InternalNetworkConnectivityError('scripted unusable internal network', '10.200.0.0/24')
          : new Error('scripted failure of the retried attempt'),
      );
    };

    await expect(
      runPtySession({
        config: { userConfig: { modelProviders: { default: 'native' } } } as never,
        mode: { kind: 'docker', agent: 'claude-code' as AgentId },
        workspacePath: directory,
      }),
    ).rejects.toThrow(/scripted failure of the retried attempt/u);

    expect(claimedPerAttempt).toHaveLength(2);
    const [first, second] = claimedPerAttempt;
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(second).toEqual(expect.arrayContaining(first));
    expect(readdirSync(sessionsDir)).toHaveLength(2);
    expect(anySessionClaimed()).toBe(false);
    // The rejected network was logged as such before the retry.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retrying with another allocation (1/4)'));
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
