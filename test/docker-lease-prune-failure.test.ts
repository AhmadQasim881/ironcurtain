/**
 * Reconciliation must report the removals it made even when a finished owner
 * lease record cannot be deleted afterwards (EBUSY, EACCES): `ironcurtain gc
 * --force` would otherwise throw after reclaiming resources and print nothing,
 * and the record is simply retried by the next pass.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerRuntime, DockerContainerInfo } from '../src/docker/types.js';

const failing = vi.hoisted(() => ({ paths: new Set<string>() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>): void => {
      if (failing.paths.has(String(args[0]))) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${String(args[0])}'`), { code: 'EBUSY' });
      }
      actual.rmSync(...args);
    },
  };
});

import {
  IRONCURTAIN_OWNER_TOKEN_LABEL,
  managedResourceLabels,
  reconcileIronCurtainDockerResources,
  releaseManagedResourceLease,
} from '../src/docker/docker-resource-lifecycle.js';

function containerRuntime(containers: DockerContainerInfo[]): ContainerRuntime {
  return {
    supportsImageSnapshots: true,
    listContainers: vi.fn(async () => containers.slice()),
    listNetworks: vi.fn(async () => []),
    remove: vi.fn(async (id: string) => {
      const index = containers.findIndex((entry) => entry.id === id);
      if (index >= 0) containers.splice(index, 1);
    }),
    containerExists: vi.fn(async (id: string) => containers.some((entry) => entry.id === id)),
  } as unknown as ContainerRuntime;
}

describe('finished lease pruning', () => {
  let home: string;
  const previousHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-lease-prune-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    failing.paths.clear();
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('reports its removals when a finished record cannot be deleted and prunes it on a later pass', async () => {
    const labels = managedResourceLabels('bundle-busy-record');
    const record = resolve(home, 'run', 'docker-owners', `${labels[IRONCURTAIN_OWNER_TOKEN_LABEL]}.json`);
    expect(releaseManagedResourceLease('bundle-busy-record')).toBe('released');
    const containers: DockerContainerInfo[] = [
      { id: 'leftover-id', name: 'ironcurtain-leftover', created: '', running: true, labels },
    ];
    const docker = containerRuntime(containers);
    failing.paths.add(record);

    const first = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

    expect(first.removedContainers).toEqual(['ironcurtain-leftover']);
    expect(first.prunedLeases).toBe(0);
    expect(existsSync(record)).toBe(true);

    failing.paths.delete(record);
    const second = await reconcileIronCurtainDockerResources(docker, { pidAlive: () => true });

    expect(second.prunedLeases).toBe(1);
    expect(existsSync(record)).toBe(false);
  });
});
