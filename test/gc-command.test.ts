import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDockerGcCommand } from '../src/docker/gc-command.js';
import {
  IRONCURTAIN_MANAGED_LABEL,
  IRONCURTAIN_OWNER_PID_LABEL,
  IRONCURTAIN_OWNER_TOKEN_LABEL,
} from '../src/docker/docker-resource-lifecycle.js';
import type { ContainerRuntimeKind } from '../src/docker/container-runtime.js';
import type { ContainerRuntime, DockerContainerInfo } from '../src/docker/types.js';

/** A dead owner's container: the same labels a crashed session leaves behind. */
function orphan(name: string): DockerContainerInfo {
  return {
    id: `${name}-id`,
    name,
    created: '2026-01-01T00:00:00.000Z',
    running: true,
    labels: {
      [IRONCURTAIN_MANAGED_LABEL]: 'true',
      // PID 0 is never a live process; use an implausible but valid PID instead.
      [IRONCURTAIN_OWNER_PID_LABEL]: '2147483646',
      [IRONCURTAIN_OWNER_TOKEN_LABEL]: `${name}-token`,
    },
  };
}

function containerOnlyRuntime(containers: DockerContainerInfo[]): ContainerRuntime {
  return {
    supportsImageSnapshots: false,
    listContainers: vi.fn(async () => containers),
    remove: vi.fn(async () => {}),
    containerExists: vi.fn(async () => false),
  } as unknown as ContainerRuntime;
}

describe('ironcurtain gc', () => {
  let home: string;
  const previousHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-gc-command-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('inspects Apple Container VMs with --runtime apple-container', async () => {
    const created: ContainerRuntimeKind[] = [];
    const apple = containerOnlyRuntime([orphan('ironcurtain-pty-crashed')]);
    const output: string[] = [];

    await runDockerGcCommand(['--runtime', 'apple-container', '--force'], {
      createRuntime: (kind) => {
        created.push(kind);
        return apple;
      },
      write: (text) => output.push(text),
    });

    expect(created).toEqual(['apple-container']);
    expect(apple.remove).toHaveBeenCalledWith('ironcurtain-pty-crashed-id');
    expect(output.join('')).toContain('[apple-container] Reclaimed 1 container(s) and 0 network(s).');
    expect(output.join('')).toContain('ironcurtain-pty-crashed (dead)');
  });

  it('defaults to Docker and only plans removals without --force', async () => {
    const created: ContainerRuntimeKind[] = [];
    const docker = containerOnlyRuntime([orphan('ironcurtain-abc')]);
    const output: string[] = [];

    await runDockerGcCommand([], {
      createRuntime: (kind) => {
        created.push(kind);
        return docker;
      },
      write: (text) => output.push(text),
    });

    expect(created).toEqual(['docker']);
    expect(docker.remove).not.toHaveBeenCalled();
    expect(output.join('')).toContain('[docker] Would reclaim 1 container(s)');
    expect(output.join('')).toContain('Re-run with --force');
  });

  it('reports every runtime with --runtime all even when one is unavailable', async () => {
    const output: string[] = [];

    await runDockerGcCommand(['--runtime', 'all'], {
      createRuntime: (kind) =>
        kind === 'docker'
          ? ({
              supportsImageSnapshots: true,
              listContainers: vi.fn(async () => {
                throw new Error('Cannot connect to the Docker daemon');
              }),
            } as unknown as ContainerRuntime)
          : containerOnlyRuntime([]),
      write: (text) => output.push(text),
    });

    const text = output.join('');
    expect(text).toContain('[apple-container] Would reclaim 0 container(s)');
    expect(text).toContain('Could not inspect docker: Cannot connect to the Docker daemon');
  });

  it('rejects an unknown runtime', async () => {
    await expect(runDockerGcCommand(['--runtime', 'podman'], { write: () => {} })).rejects.toThrow(/Unknown --runtime/);
  });
});
