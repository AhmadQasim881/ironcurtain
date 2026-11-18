/**
 * Interrupt handling in runPtySession (DINF-13): a SIGINT/SIGTERM/SIGHUP during
 * setup must run the normal teardown instead of killing the process with the
 * container, network and owner lease left behind, and must stop setup before
 * the next allocation.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logger from '../../src/logger.js';

const state = vi.hoisted(() => ({
  prepare: undefined as (() => Promise<unknown>) | undefined,
  destroyed: [] as unknown[],
  createdContainers: 0,
  removeBundleRuntimeRoot: vi.fn(),
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

vi.mock('../../src/session/session-metadata.js', () => ({ updateSessionMetadata: vi.fn() }));
vi.mock('../../src/docker/claude-md-seed.js', () => ({ buildDockerClaudeMd: () => '' }));

vi.mock('../../src/docker/docker-infrastructure.js', () => ({
  prepareDockerInfrastructure: () => (state.prepare ? state.prepare() : Promise.reject(new Error('no infra'))),
  activateNestedDockerWorkload: vi.fn(),
  attachDockerDesktopAgentEgressNetwork: vi.fn(),
  resolveNestedDockerAgentWiring: () => ({ appleNestedDaemon: undefined, env: {}, namedVolumeMounts: [] }),
  resolveNestedDockerOuterAgentImage: (_infra: unknown, image: string) => image,
  buildAgentUidRemap: () => ({}),
  buildDockerDesktopTransportCreateLimits: () => ({}),
  buildUdsSocketMounts: () => [],
  buildDockerWorkloadEgressMounts: () => [],
  buildDockerBuildShimMounts: () => [],
  buildDockerOwnershipLabels: () => ({ bundleLabel: 'bundle', labels: undefined }),
  stopDockerWorkloadEgress: async () => {},
  createLedgeredAgentContainer: vi.fn(async () => {
    state.createdContainers += 1;
    return 'container-id';
  }),
  createDockerSessionTransportNetwork: vi.fn(),
  createDockerSessionTransportProxy: vi.fn(),
  dockerWorkloadSessionMetadata: vi.fn(() => ({ leaseId: 'admitted-lease' })),
  removeBundleRuntimeRoot: state.removeBundleRuntimeRoot,
  writeAptProxyConfigViaExec: vi.fn(),
  checkDockerContainerWritableStorage: vi.fn(),
  checkHostOnlyConnectivity: vi.fn(),
  checkInternalNetworkConnectivity: vi.fn(),
}));

vi.mock('../../src/docker/container-lifecycle.js', () => ({
  destroyBundleOuterResources: async (options: unknown) => {
    state.destroyed.push(options);
    return 'none';
  },
}));

import type { AgentId } from '../../src/docker/agent-adapter.js';
import { runPtySession } from '../../src/docker/pty-session.js';
import { updateSessionMetadata } from '../../src/session/session-metadata.js';

/** The SIGINT listener runPtySession installed (not vitest's or another test's). */
function newListener(signal: NodeJS.Signals, before: ReadonlySet<unknown>): () => void {
  const listener = process.listeners(signal).find((candidate) => !before.has(candidate));
  if (!listener) throw new Error(`runPtySession installed no ${signal} handler`);
  return listener;
}

describe('PTY setup interrupts', () => {
  const directories: string[] = [];
  let originalHome: string | undefined;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'pty-interrupt-home-'));
    directories.push(home);
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.IRONCURTAIN_HOME = originalHome;
    else delete process.env.IRONCURTAIN_HOME;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    state.prepare = undefined;
    state.destroyed = [];
    state.createdContainers = 0;
    state.removeBundleRuntimeRoot.mockReset();
    vi.restoreAllMocks();
  });

  it('tears down and creates no container when Ctrl-C arrives during infrastructure setup', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), 'pty-interrupt-'));
    directories.push(directory);
    const before = new Set<unknown>(process.listeners('SIGINT'));
    const proxyStop = vi.fn(async () => {});
    const mitmStop = vi.fn(async () => {});
    const docker = { removeStaleContainer: vi.fn(), listContainers: vi.fn(async () => []) };

    state.prepare = async () => {
      // Ctrl-C while the proxies start (cooked terminal: SIGINT reaches us).
      newListener('SIGINT', before)();
      return {
        docker,
        proxy: { stop: proxyStop },
        mitmProxy: { stop: mitmStop },
        useTcp: false,
        runtimeKind: 'docker',
      };
    };

    const session = runPtySession({
      config: { userConfig: { modelProviders: { default: 'native' } } } as never,
      mode: { kind: 'docker', agent: 'claude-code' as AgentId },
      workspacePath: directory,
    });

    await expect(session).rejects.toMatchObject({ code: 'PTY_INTERRUPTED', signal: 'SIGINT' });
    expect(state.createdContainers).toBe(0);
    expect(docker.removeStaleContainer).not.toHaveBeenCalled();
    // The normal teardown ran: outer resources, proxies, runtime directory.
    expect(state.destroyed).toEqual([expect.objectContaining({ docker, containerId: null, context: 'PTY session' })]);
    expect(mitmStop).toHaveBeenCalledOnce();
    expect(proxyStop).toHaveBeenCalledOnce();
    expect(state.removeBundleRuntimeRoot).toHaveBeenCalledOnce();
    // Handlers are removed once the session is over.
    expect(process.listeners('SIGINT').filter((listener) => !before.has(listener))).toEqual([]);
  });

  it('persists an admitted Docker-workload lease before the interrupt tears the bundle down', async () => {
    // The §8.4 audit record must exist for every admitted lease, interrupted or not.
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.mocked(updateSessionMetadata).mockClear();
    const directory = mkdtempSync(join(tmpdir(), 'pty-interrupt-'));
    directories.push(directory);
    const before = new Set<unknown>(process.listeners('SIGINT'));
    const dockerWorkload = { teardown: vi.fn(async () => {}) };

    state.prepare = async () => {
      newListener('SIGINT', before)();
      return {
        docker: { removeStaleContainer: vi.fn() },
        proxy: { stop: vi.fn(async () => {}) },
        mitmProxy: { stop: vi.fn(async () => {}) },
        useTcp: false,
        runtimeKind: 'docker',
        dockerWorkload,
      };
    };

    const session = runPtySession({
      config: {
        userConfig: { modelProviders: { default: 'native' }, dockerWorkload: { enabled: true } },
      } as never,
      mode: { kind: 'docker', agent: 'claude-code' as AgentId },
      workspacePath: directory,
    });

    await expect(session).rejects.toMatchObject({ code: 'PTY_INTERRUPTED' });
    expect(updateSessionMetadata).toHaveBeenCalledWith(expect.any(String), {
      dockerWorkload: { leaseId: 'admitted-lease' },
    });
    expect(state.destroyed).toEqual([expect.objectContaining({ dockerWorkload, containerId: null })]);
  });

  it('runs the whole teardown when a closed terminal delivers SIGHUP twice', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const directory = mkdtempSync(join(tmpdir(), 'pty-interrupt-'));
    directories.push(directory);
    const before = new Set<unknown>(process.listeners('SIGHUP'));
    const proxyStop = vi.fn(async () => {});

    state.prepare = async () => {
      // The kernel's hangup, then the session leader's.
      const hangup = newListener('SIGHUP', before);
      hangup();
      hangup();
      return {
        docker: { removeStaleContainer: vi.fn() },
        proxy: { stop: proxyStop },
        mitmProxy: { stop: vi.fn(async () => {}) },
        useTcp: false,
        runtimeKind: 'docker',
      };
    };

    const session = runPtySession({
      config: { userConfig: { modelProviders: { default: 'native' } } } as never,
      mode: { kind: 'docker', agent: 'claude-code' as AgentId },
      workspacePath: directory,
    });

    await expect(session).rejects.toMatchObject({ code: 'PTY_INTERRUPTED', signal: 'SIGHUP' });
    expect(exit).not.toHaveBeenCalled();
    expect(state.destroyed).toHaveLength(1);
    expect(proxyStop).toHaveBeenCalledOnce();
  });

  it('forces exit on a second signal', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), 'pty-interrupt-'));
    directories.push(directory);
    const before = new Set<unknown>(process.listeners('SIGTERM'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let finishPrepare: (() => void) | undefined;

    state.prepare = () =>
      new Promise((_resolve, reject) => {
        finishPrepare = () => reject(new Error('setup aborted'));
      });

    const session = runPtySession({
      config: { userConfig: { modelProviders: { default: 'native' } } } as never,
      mode: { kind: 'docker', agent: 'claude-code' as AgentId },
      workspacePath: directory,
    });
    await vi.waitFor(() => expect(finishPrepare).toBeDefined());
    const handler = newListener('SIGTERM', before);
    handler();
    expect(exit).not.toHaveBeenCalled();
    handler();
    expect(exit).toHaveBeenCalledWith(143);

    finishPrepare?.();
    await expect(session).rejects.toMatchObject({ code: 'PTY_INTERRUPTED' });
  });
});
