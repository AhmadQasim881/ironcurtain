import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDockerManager } from '../src/docker/docker-manager.js';
import {
  createIronCurtainInternalNetwork,
  reconcileIronCurtainDockerResources,
  releaseManagedResourceLease,
} from '../src/docker/docker-resource-lifecycle.js';

const enabled = process.env.INTEGRATION_TEST === '1';

describe.skipIf(!enabled)('Docker resource lifecycle integration', () => {
  const docker = createDockerManager();
  let networkName: string | undefined;
  const extraNetworks: string[] = [];
  let child: ChildProcess | undefined;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-docker-crash-'));
    previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(async () => {
    child?.kill('SIGKILL');
    if (networkName) await docker.removeNetwork(networkName);
    for (const name of extraNetworks.splice(0)) await docker.removeNetwork(name);
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('allocates a labeled /29 and reconciles it after its owner lease is released', async () => {
    const bundleId = randomUUID();
    networkName = `ironcurtain-${bundleId.replace(/-/g, '').slice(0, 12)}`;

    const allocated = await createIronCurtainInternalNetwork(docker, networkName, bundleId);
    expect(allocated.subnet).toMatch(/\/29$/);
    expect(allocated.subnet).not.toMatch(/^192\.168\./);
    await expect(docker.networkExists?.(networkName)).resolves.toBe(true);

    // This process stays alive: the released tombstone authorizes the reclaim.
    expect(releaseManagedResourceLease(bundleId)).toBe('released');
    const result = await reconcileIronCurtainDockerResources(docker);

    expect(result.removedNetworks).toContain(networkName);
    await expect(docker.networkExists?.(networkName)).resolves.toBe(false);
    networkName = undefined;
  });

  it('never reclaims either of two concurrently live bundles in one home', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const names = [first, second].map((id) => `ironcurtain-${id.replace(/-/g, '').slice(0, 12)}`);
    extraNetworks.push(...names);
    await createIronCurtainInternalNetwork(docker, names[0], first);
    await createIronCurtainInternalNetwork(docker, names[1], second);

    // The second session's startup reconciliation.
    const result = await reconcileIronCurtainDockerResources(docker);

    expect(result.removedNetworks).not.toContain(names[0]);
    expect(result.removedNetworks).not.toContain(names[1]);
    await expect(docker.networkExists?.(names[0])).resolves.toBe(true);
    await expect(docker.networkExists?.(names[1])).resolves.toBe(true);
    releaseManagedResourceLease(first);
    releaseManagedResourceLease(second);
  });

  it('reclaims a network after its real owner process is killed with SIGKILL', async () => {
    const bundleId = randomUUID();
    networkName = `ironcurtain-${bundleId.replace(/-/g, '').slice(0, 12)}`;
    const fixture = resolve(import.meta.dirname, 'fixtures', 'docker-network-owner.ts');
    child = spawn(process.execPath, ['--import', 'tsx', fixture, networkName, bundleId], {
      env: { ...process.env, IRONCURTAIN_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const allocation = await new Promise<{ subnet: string }>((resolveAllocation, reject) => {
      let stdout = '';
      let stderr = '';
      child?.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const newline = stdout.indexOf('\n');
        if (newline >= 0) resolveAllocation(JSON.parse(stdout.slice(0, newline)) as { subnet: string });
      });
      child?.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child?.once('error', reject);
      child?.once('exit', (code) => {
        if (code !== null) reject(new Error(`owner exited before allocation (${code}): ${stderr}`));
      });
    });
    expect(allocation.subnet).toMatch(/\/29$/);

    const exited = new Promise<void>((resolveExit) => child?.once('exit', () => resolveExit()));
    child.kill('SIGKILL');
    await exited;
    child = undefined;

    const result = await reconcileIronCurtainDockerResources(docker);
    expect(result.removedNetworks).toContain(networkName);
    await expect(docker.networkExists?.(networkName)).resolves.toBe(false);
    networkName = undefined;
  });
});
