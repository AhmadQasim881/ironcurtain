import {
  createLegacyDockerWorkloadLease as createDockerWorkloadLease,
  type CreateLegacyDockerWorkloadLeaseOptions,
} from '../helpers/legacy-docker-workload-lease.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inventoryOwnedResourceIds,
  revokeDockerWorkloadOuterResources,
  revokeDockerWorkloadOuterResourcesBeforeLedger,
} from '../../src/docker-workload/bundle-revocation.js';
import {
  activateDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
} from '../../src/docker-workload/bundle-lease.js';
import type { DockerContainerInfo, DockerNetworkInfo, DockerVolumeInfo } from '../../src/docker/types.js';
import { createDockerManager, type ExecFileFn } from '../../src/docker/docker-manager.js';
import { createMockDocker } from '../helpers/docker-mocks.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Docker-workload exact outer-resource revocation', () => {
  it('deletes observed identities in container-volume-network order and preserves foreign resources', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    request(fixture, 'isolated-network', 'network', 'daemon-isolation', 'ic-network');
    request(fixture, 'api-volume', 'volume', 'daemon-api', 'ic-api-volume');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'daemon-sidecar', 'container-owned');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'isolated-network', 'network-owned');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'api-volume', 'ic-api-volume');
    activateDockerWorkloadLease(fixture.path, fixture.options.generation);

    const state = runtimeState(
      fixture.options.generation,
      [
        container('container-owned', 'ic-daemon', fixture.options.generation),
        container('container-foreign', 'unrelated', 'foreign-generation'),
      ],
      [
        network('network-owned', 'ic-network', fixture.options.generation),
        network('network-foreign', 'unrelated-network', 'foreign-generation'),
      ],
      [volume('ic-api-volume', fixture.options.generation), volume('foreign-volume', 'foreign-generation')],
    );
    const result = await revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation);
    expect(result).toEqual({
      removedResourceIds: ['container-owned', 'ic-api-volume', 'network-owned'],
      finalOwnedResourceIds: [],
    });
    expect(state.calls).toEqual([
      'stop:container-owned',
      'remove:container-owned',
      'remove-volume:ic-api-volume',
      'remove-network:network-owned',
    ]);
    expect(state.containers.map((value) => value.id)).toEqual(['container-foreign']);
    expect(state.networks.map((value) => value.id)).toEqual(['network-foreign']);
    expect(state.volumes.map((value) => value.id)).toEqual(['foreign-volume']);
    expect(loadDockerWorkloadLease(fixture.path).resources.every((resource) => resource.removal !== null)).toBe(true);
  });

  it('recovers the create-before-observation window by exact name plus generation, then records the ID', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    const state = runtimeState(fixture.options.generation, [
      container('recovered-container-id', 'ic-daemon', fixture.options.generation),
    ]);

    await revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation);
    expect(loadDockerWorkloadLease(fixture.path).resources[0]).toMatchObject({
      observedId: 'recovered-container-id',
      removal: { proof: 'immutable-id-absent', identity: 'recovered-container-id' },
    });
  });

  it('records requested-name absence when a crash happened before runtime creation', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    const state = runtimeState(fixture.options.generation, []);
    await revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toMatchObject({
      proof: 'requested-name-absent',
      identity: 'ic-daemon',
    });
  });

  it('refuses a colliding foreign name and never calls remove', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    const state = runtimeState(fixture.options.generation, [container('foreign-id', 'ic-daemon', 'wrong-generation')]);
    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).rejects.toThrow(/wrong generation label/u);
    expect(state.calls).toEqual([]);
    expect(state.containers).toHaveLength(1);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toBeNull();
  });

  it('recovers a volume create-before-observation window only with exact generation ownership', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'api-volume', 'volume', 'daemon-api', 'ic-api-volume');
    const state = runtimeState(
      fixture.options.generation,
      [],
      [],
      [volume('ic-api-volume', fixture.options.generation)],
    );

    await revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation);
    expect(state.calls).toEqual(['remove-volume:ic-api-volume']);
    expect(loadDockerWorkloadLease(fixture.path).resources[0]).toMatchObject({
      observedId: 'ic-api-volume',
      removal: { proof: 'immutable-id-absent', identity: 'ic-api-volume' },
    });
  });

  it('refuses to remove a colliding foreign volume name', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'api-volume', 'volume', 'daemon-api', 'ic-api-volume');
    const state = runtimeState(fixture.options.generation, [], [], [volume('ic-api-volume', 'foreign-generation')]);

    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).rejects.toThrow(/wrong generation label/u);
    expect(state.calls).toEqual([]);
  });

  it('does not claim cleanup when the runtime silently fails to remove an exact ID', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'daemon-sidecar', 'container-owned');
    activateDockerWorkloadLease(fixture.path, fixture.options.generation);
    const state = runtimeState(fixture.options.generation, [
      container('container-owned', 'ic-daemon', fixture.options.generation),
    ]);
    state.removeFails = true;
    let failOpenExistsCalls = 0;
    state.runtime.containerExists = async () => {
      failOpenExistsCalls += 1;
      return false;
    };
    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).rejects.toThrow(/still exists/u);
    expect(failOpenExistsCalls).toBe(0);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toBeNull();
    await expect(inventoryOwnedResourceIds(state.runtime, loadDockerWorkloadLease(fixture.path))).resolves.toEqual([
      'container-owned',
    ]);
  });

  it('does not record immutable-ID absence when the authoritative post-remove inventory fails', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'daemon-sidecar', 'container-owned');
    activateDockerWorkloadLease(fixture.path, fixture.options.generation);
    const state = runtimeState(fixture.options.generation, [
      container('container-owned', 'ic-daemon', fixture.options.generation),
    ]);
    const listContainers = state.runtime.listContainers.bind(state.runtime);
    let inventoryCalls = 0;
    state.runtime.listContainers = async () => {
      inventoryCalls += 1;
      if (inventoryCalls === 2) throw new Error('scripted post-remove inventory timeout');
      return listContainers();
    };

    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).rejects.toThrow(/post-remove inventory timeout/u);
    expect(state.containers).toEqual([]);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toBeNull();
  });
});

describe('Docker-workload revocation before the ledger', () => {
  it('stops and removes only exact generation-owned containers and volumes without writing the lease', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    const generation = fixture.options.generation;
    request(fixture, 'agent-container', 'container', 'agent', 'ic-agent');
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    request(fixture, 'pending-relay', 'container', 'fixed-relay', 'ic-relay');
    request(fixture, 'squatted-proxy', 'container', 'proxy', 'ic-proxy');
    request(fixture, 'isolated-network', 'network', 'daemon-isolation', 'ic-network');
    request(fixture, 'api-volume', 'volume', 'daemon-api', 'ic-api-volume');
    observeDockerWorkloadOuterResource(fixture.path, generation, 'agent-container', 'agent-owned');
    observeDockerWorkloadOuterResource(fixture.path, generation, 'daemon-sidecar', 'daemon-owned');
    observeDockerWorkloadOuterResource(fixture.path, generation, 'squatted-proxy', 'proxy-owned');
    observeDockerWorkloadOuterResource(fixture.path, generation, 'isolated-network', 'network-owned');
    observeDockerWorkloadOuterResource(fixture.path, generation, 'api-volume', 'ic-api-volume');
    const before = readFileSync(fixture.path);
    const state = runtimeState(
      generation,
      [
        container('agent-owned', 'ic-agent', generation),
        container('daemon-owned', 'ic-daemon', generation),
        // Created before its observation was recorded: found by exact name plus label.
        container('relay-created', 'ic-relay', generation),
        // The observed ID now names a container another generation relabelled.
        container('proxy-owned', 'ic-proxy', 'foreign-generation'),
        container('foreign', 'unrelated', 'foreign-generation'),
      ],
      [network('network-owned', 'ic-network', generation)],
      [volume('ic-api-volume', generation), volume('foreign-volume', 'foreign-generation')],
    );

    const result = await revokeDockerWorkloadOuterResourcesBeforeLedger(
      state.runtime,
      loadDockerWorkloadLease(fixture.path),
    );

    expect(state.calls).toEqual([
      'stop:agent-owned',
      'remove:agent-owned',
      'stop:daemon-owned',
      'remove:daemon-owned',
      'stop:relay-created',
      'remove:relay-created',
      'remove-volume:ic-api-volume',
    ]);
    expect(result.removedResourceIds).toEqual(['agent-owned', 'daemon-owned', 'relay-created', 'ic-api-volume']);
    expect(result.failures).toEqual([expect.stringMatching(/^proxy-owned: .*generation label/u)]);
    expect(state.containers.map((value) => value.id)).toEqual(['proxy-owned', 'foreign']);
    expect(state.networks.map((value) => value.id)).toEqual(['network-owned']);
    expect(state.volumes.map((value) => value.id)).toEqual(['foreign-volume']);
    // Nothing durable was written: the ledgered pass records the proofs later.
    expect(readFileSync(fixture.path)).toEqual(before);

    // The ledgered pass that follows refuses the relabelled container just as
    // this one did; once it is gone, that pass finds every identity absent
    // and records the proofs.
    state.containers.splice(
      state.containers.findIndex((value) => value.id === 'proxy-owned'),
      1,
    );
    await revokeDockerWorkloadOuterResources(state.runtime, fixture.path, generation);
    const lease = loadDockerWorkloadLease(fixture.path);
    expect(lease.resources.find((resource) => resource.requestId === 'agent-container')?.removal).toMatchObject({
      proof: 'immutable-id-absent',
      identity: 'agent-owned',
    });
  });

  it('decides presence by exact inspect, never by listing every container on the host', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    const generation = fixture.options.generation;
    request(fixture, 'agent-container', 'container', 'agent', 'ic-agent');
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    request(fixture, 'squatted-proxy', 'container', 'proxy', 'ic-proxy');
    request(fixture, 'api-volume', 'volume', 'daemon-api', 'ic-api-volume');
    observeDockerWorkloadOuterResource(fixture.path, generation, 'agent-container', 'agent-owned');
    observeDockerWorkloadOuterResource(fixture.path, generation, 'api-volume', 'ic-api-volume');
    const before = readFileSync(fixture.path);
    const foreign = Array.from({ length: 100 }, (_, index) =>
      container(`container-foreign-${index}`, `unrelated-${index}`, 'foreign-generation'),
    );
    const state = exactRuntimeState(
      generation,
      [
        container('agent-owned', 'ic-agent', generation),
        // Created before its observation was recorded: found by exact-name inspect.
        container('daemon-created', 'ic-daemon', generation),
        // A same-named container of another generation is left alone.
        container('proxy-squatter', 'ic-proxy', 'foreign-generation'),
        ...foreign,
      ],
      [],
      [volume('ic-api-volume', generation)],
    );

    const result = await revokeDockerWorkloadOuterResourcesBeforeLedger(
      state.runtime,
      loadDockerWorkloadLease(fixture.path),
    );

    expect(state.inventories).toEqual([]);
    expect(state.inspects).toEqual([
      'container:agent-owned',
      'container:ic-daemon',
      'container:ic-proxy',
      'volume:ic-api-volume',
    ]);
    expect(state.calls).toEqual([
      'stop:agent-owned',
      'remove:agent-owned',
      'stop:daemon-created',
      'remove:daemon-created',
      'remove-volume:ic-api-volume',
    ]);
    expect(result.removedResourceIds).toEqual(['agent-owned', 'daemon-created', 'ic-api-volume']);
    expect(result.failures).toEqual([expect.stringMatching(/^proxy-squatter: .*generation label/u)]);
    expect(state.containers).toHaveLength(101);
    expect(readFileSync(fixture.path)).toEqual(before);
  });

  it('records a failed exact inspect and still revokes the other resources', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    const generation = fixture.options.generation;
    request(fixture, 'agent-container', 'container', 'agent', 'ic-agent');
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    observeDockerWorkloadOuterResource(fixture.path, generation, 'agent-container', 'agent-owned');
    observeDockerWorkloadOuterResource(fixture.path, generation, 'daemon-sidecar', 'daemon-owned');
    const state = exactRuntimeState(generation, [
      container('agent-owned', 'ic-agent', generation),
      container('daemon-owned', 'ic-daemon', generation),
    ]);
    const inspectContainer = state.runtime.inspectContainer.bind(state.runtime);
    state.runtime.inspectContainer = async (term: string) => {
      if (term === 'agent-owned') throw new Error(`Cannot connect to the Docker daemon ${'x'.repeat(4096)}`);
      return inspectContainer(term);
    };

    const result = await revokeDockerWorkloadOuterResourcesBeforeLedger(
      state.runtime,
      loadDockerWorkloadLease(fixture.path),
    );

    expect(state.calls).toEqual(['stop:daemon-owned', 'remove:daemon-owned']);
    expect(result.removedResourceIds).toEqual(['daemon-owned']);
    expect(result.failures).toEqual([expect.stringMatching(/^agent-owned: Cannot connect to the Docker daemon/u)]);
    expect(result.failures[0].length).toBeLessThanOrEqual('agent-owned: '.length + 512);
  });

  it('never throws when the runtime cannot even list its inventory', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'agent-container', 'container', 'agent', 'ic-agent');
    const runtime = {
      ...createMockDocker(),
      listContainers: () => Promise.reject(new Error('Docker Desktop is not responding')),
    };
    const result = await revokeDockerWorkloadOuterResourcesBeforeLedger(runtime, loadDockerWorkloadLease(fixture.path));
    expect(result).toEqual({
      removedResourceIds: [],
      failures: [expect.stringMatching(/^container inventory: Docker Desktop is not responding/u)],
    });
  });
});

describe('Docker-workload revocation cost does not grow with the host', () => {
  const OWNED_FILTER = 'com.ironcurtain.docker-workload.generation=generation-revocation-001';

  it('inventories through daemon-side label filters and checks presence by exact inspect', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    request(fixture, 'isolated-network', 'network', 'daemon-isolation', 'ic-network');
    request(fixture, 'api-volume', 'volume', 'daemon-api', 'ic-api-volume');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'daemon-sidecar', 'container-owned');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'isolated-network', 'network-owned');
    // The volume stays unobserved (a crash before observation), so the lease is still admitting.
    const foreign = Array.from({ length: 100 }, (_, index) =>
      container(`container-foreign-${index}`, `unrelated-${index}`, 'foreign-generation'),
    );
    const state = exactRuntimeState(
      fixture.options.generation,
      [container('container-owned', 'ic-daemon', fixture.options.generation), ...foreign],
      [network('network-owned', 'ic-network', fixture.options.generation)],
      [volume('ic-api-volume', fixture.options.generation)],
    );

    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).resolves.toEqual({
      removedResourceIds: ['container-owned', 'ic-api-volume', 'network-owned'],
      finalOwnedResourceIds: [],
    });

    // Every inventory is filtered to this generation; none lists the host.
    expect(state.inventories).toEqual([
      `containers:${OWNED_FILTER}`,
      `networks:${OWNED_FILTER}`,
      `volumes:${OWNED_FILTER}`,
    ]);
    // Presence: the observed IDs before and after removal, and the
    // precommitted name of the unobserved volume.
    expect(state.inspects).toEqual([
      'container:container-owned',
      'container:container-owned',
      'volume:ic-api-volume',
      'volume:ic-api-volume',
      'network:network-owned',
      'network:network-owned',
    ]);
    expect(state.containers).toHaveLength(100);
  });

  it('still refuses a same-named resource with a foreign label found by exact-name inspect', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    const state = exactRuntimeState(fixture.options.generation, [
      container('foreign-id', 'ic-daemon', 'wrong-generation'),
    ]);

    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).rejects.toThrow(/wrong generation label: foreign-id/u);
    expect(state.calls).toEqual([]);
    expect(state.inspects).toEqual(['container:ic-daemon']);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toBeNull();
  });

  it('decides exact-name absence from the full inventory when inspect resolves a different object', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    const state = exactRuntimeState(fixture.options.generation, []);
    // Docker resolves an unknown name term as an immutable-ID prefix.
    state.runtime.inspectContainer = async (term: string) => {
      state.inspects.push(`container:${term}`);
      return container('ic-daemon-prefixed-id', 'some-other-container', 'foreign-generation');
    };

    await revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation);

    expect(state.inventories).toContain('containers:<all>');
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toMatchObject({
      proof: 'requested-name-absent',
      identity: 'ic-daemon',
    });
  });

  it('never treats a failed exact inspect as absence', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'daemon-sidecar', 'container-owned');
    activateDockerWorkloadLease(fixture.path, fixture.options.generation);
    const state = exactRuntimeState(fixture.options.generation, [
      container('container-owned', 'ic-daemon', fixture.options.generation),
    ]);
    state.runtime.inspectContainer = async () => {
      throw new Error('Cannot connect to the Docker daemon');
    };

    await expect(
      revokeDockerWorkloadOuterResources(state.runtime, fixture.path, fixture.options.generation),
    ).rejects.toThrow(/Cannot connect to the Docker daemon/u);
    expect(state.calls).toEqual([]);
    expect(loadDockerWorkloadLease(fixture.path).resources[0].removal).toBeNull();
  });

  it('on a 100-container host the Docker manager never inspects a foreign container', async () => {
    const fixture = leaseFixture();
    createDockerWorkloadLease(fixture.path, fixture.options);
    request(fixture, 'daemon-sidecar', 'container', 'nested-daemon', 'ic-daemon');
    observeDockerWorkloadOuterResource(fixture.path, fixture.options.generation, 'daemon-sidecar', OWNED_CONTAINER_ID);
    activateDockerWorkloadLease(fixture.path, fixture.options.generation);
    const host = simulatedDockerHost(fixture.options.generation, 100);

    await expect(
      revokeDockerWorkloadOuterResources(createDockerManager(host.exec), fixture.path, fixture.options.generation),
    ).resolves.toMatchObject({ removedResourceIds: [OWNED_CONTAINER_ID], finalOwnedResourceIds: [] });

    const inspected = host.calls
      .filter((args) => args[0] === 'container' && args[1] === 'inspect')
      .flatMap((args) => args.slice(2));
    expect(inspected.length).toBeGreaterThan(0);
    expect(inspected.every((id) => id === OWNED_CONTAINER_ID)).toBe(true);
    for (const args of host.calls.filter((call) => call[0] === 'container' && call[1] === 'ls')) {
      expect(args).toEqual(['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `label=${OWNED_FILTER}`]);
    }
  });
});

const OWNED_CONTAINER_ID = 'a'.repeat(64);

/**
 * `docker` CLI behaviour for a host with `foreignCount` unrelated containers
 * and one container owned by `generation`, served through the Docker manager's
 * exec seam.
 */
function simulatedDockerHost(generation: string, foreignCount: number) {
  const labelKey = 'com.ironcurtain.docker-workload.generation';
  const containers = new Map<string, { readonly name: string; readonly labels: Record<string, string> }>([
    [OWNED_CONTAINER_ID, { name: 'ic-daemon', labels: { [labelKey]: generation } }],
    ...Array.from(
      { length: foreignCount },
      (_, index) =>
        [
          index.toString(16).padStart(64, 'f'),
          { name: `unrelated-${index}`, labels: { [labelKey]: 'foreign-generation' } },
        ] as const,
    ),
  ]);
  const calls: string[][] = [];
  const fail = (stderr: string) =>
    Object.assign(new Error(`Command failed: docker ${calls.at(-1)?.join(' ')}\n${stderr}`), {
      code: 1,
      stdout: '',
      stderr,
    });
  const exec: ExecFileFn = async (_cmd, rawArgs) => {
    const args = [...rawArgs];
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'ls') {
      const filter = args.includes('--filter')
        ? args[args.indexOf('--filter') + 1]?.replace(/^label=/u, '')
        : undefined;
      const ids = [...containers].filter(([, value]) => matchesLabelFilter(value.labels, filter)).map(([id]) => id);
      return { stdout: ids.length === 0 ? '' : `${ids.join('\n')}\n`, stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const requested = args.slice(2);
      const missing = requested.find((id) => !containers.has(id));
      if (missing !== undefined) throw fail(`Error: No such container: ${missing}`);
      return {
        stdout: JSON.stringify(
          requested.map((id) => ({
            Id: id,
            Name: `/${containers.get(id)?.name ?? ''}`,
            Config: { Labels: containers.get(id)?.labels ?? {} },
            State: { Running: true },
          })),
        ),
        stderr: '',
      };
    }
    if (args[0] === 'stop') return { stdout: '', stderr: '' };
    if (args[0] === 'rm' && args[1] === '-f') {
      containers.delete(args[2] ?? '');
      return { stdout: '', stderr: '' };
    }
    throw fail(`unsupported docker invocation: ${args.join(' ')}`);
  };
  return { exec, calls };
}

function leaseFixture(): {
  readonly path: string;
  /** A previous release's (schema 1) lease: recovery must still revoke its resources. */
  readonly options: CreateLegacyDockerWorkloadLeaseOptions;
} {
  const directory = mkdtempSync(join(tmpdir(), 'docker-workload-revocation-'));
  temporaryDirectories.push(directory);
  return {
    path: join(directory, 'lease.json'),
    options: {
      leaseId: 'lease-revocation-001',
      bundleId: 'bundle-revocation-001',
      generation: 'generation-revocation-001',
      runtimeKind: 'docker',
      paths: {
        workspaceRoot: '/workspace/repository',
        stateRoot: '/private/tmp/ic-state',
        runtimeRoot: '/private/tmp/ic-runtime',
        apiRoot: '/private/tmp/ic-api',
        exchangeRoot: '/private/tmp/ic-exchange',
        stagingRoot: '/private/tmp/ic-staging',
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date('2026-07-20T12:00:00.000Z'),
    },
  };
}

function request(
  fixture: ReturnType<typeof leaseFixture>,
  requestId: string,
  kind: 'container' | 'network' | 'volume',
  role: string,
  requestedName: string,
): void {
  requestDockerWorkloadOuterResource(fixture.path, fixture.options.generation, {
    requestId,
    kind,
    role,
    requestedName,
    ownershipLabelKey: 'com.ironcurtain.docker-workload.generation',
  });
}

function container(id: string, name: string, generation: string): DockerContainerInfo {
  return {
    id,
    name,
    created: '2026-07-20T12:00:00Z',
    running: true,
    labels: { 'com.ironcurtain.docker-workload.generation': generation },
  };
}

function network(id: string, name: string, generation: string): DockerNetworkInfo {
  return {
    id,
    name,
    created: '2026-07-20T12:00:00Z',
    labels: { 'com.ironcurtain.docker-workload.generation': generation },
    subnets: [],
    containerIds: [],
  };
}

function volume(name: string, generation: string): DockerVolumeInfo {
  return {
    id: name,
    name,
    created: '2026-07-20T12:00:00Z',
    labels: { 'com.ironcurtain.docker-workload.generation': generation },
    driver: 'local',
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  };
}

/** Label filter as Docker applies it: `key` or `key=value`. */
function matchesLabelFilter(labels: Readonly<Record<string, string>>, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  const separator = filter.indexOf('=');
  if (separator === -1) return Object.hasOwn(labels, filter);
  return labels[filter.slice(0, separator)] === filter.slice(separator + 1);
}

/**
 * {@link runtimeState} plus the Docker manager's exact single-object inspects and
 * daemon-side label filters, recording every inventory and inspect it serves.
 */
function exactRuntimeState(
  generation: string,
  initialContainers: readonly DockerContainerInfo[],
  initialNetworks: readonly DockerNetworkInfo[] = [],
  initialVolumes: readonly DockerVolumeInfo[] = [],
) {
  const state = runtimeState(generation, initialContainers, initialNetworks, initialVolumes);
  const inventories: string[] = [];
  const inspects: string[] = [];
  const findIn = <T extends { readonly id: string; readonly name: string }>(resources: readonly T[], term: string) =>
    structuredClone(resources.find((resource) => resource.id === term) ?? resources.find((r) => r.name === term));
  const runtime = {
    ...state.runtime,
    async listContainers(options?: { readonly labelFilter?: string }) {
      inventories.push(`containers:${options?.labelFilter ?? '<all>'}`);
      return structuredClone(
        state.containers.filter((value) => matchesLabelFilter(value.labels, options?.labelFilter)),
      );
    },
    async listNetworks(options?: { readonly labelFilter?: string }) {
      inventories.push(`networks:${options?.labelFilter ?? '<all>'}`);
      return structuredClone(state.networks.filter((value) => matchesLabelFilter(value.labels, options?.labelFilter)));
    },
    async listVolumes(options?: { readonly labelFilter?: string }) {
      inventories.push(`volumes:${options?.labelFilter ?? '<all>'}`);
      return structuredClone(state.volumes.filter((value) => matchesLabelFilter(value.labels, options?.labelFilter)));
    },
    async inspectContainer(term: string) {
      inspects.push(`container:${term}`);
      return findIn(state.containers, term);
    },
    async inspectNetwork(term: string) {
      inspects.push(`network:${term}`);
      return findIn(state.networks, term);
    },
    async inspectVolume(term: string) {
      inspects.push(`volume:${term}`);
      return findIn(state.volumes, term);
    },
  };
  return { ...state, runtime, inventories, inspects };
}

function runtimeState(
  _generation: string,
  initialContainers: readonly DockerContainerInfo[],
  initialNetworks: readonly DockerNetworkInfo[] = [],
  initialVolumes: readonly DockerVolumeInfo[] = [],
) {
  const containers = structuredClone(initialContainers) as DockerContainerInfo[];
  const networks = structuredClone(initialNetworks) as DockerNetworkInfo[];
  const volumes = structuredClone(initialVolumes) as DockerVolumeInfo[];
  const calls: string[] = [];
  const state = {
    containers,
    networks,
    volumes,
    calls,
    removeFails: false,
    runtime: {
      ...createMockDocker(),
      async listContainers() {
        return structuredClone(containers);
      },
      async listNetworks() {
        return structuredClone(networks);
      },
      async listVolumes() {
        return structuredClone(volumes);
      },
      async stop(id: string) {
        calls.push(`stop:${id}`);
      },
      async remove(id: string) {
        calls.push(`remove:${id}`);
        if (!state.removeFails) {
          const index = containers.findIndex((containerValue) => containerValue.id === id);
          if (index !== -1) containers.splice(index, 1);
        }
      },
      async containerExists(id: string) {
        return containers.some((containerValue) => containerValue.id === id);
      },
      async removeNetwork(id: string) {
        calls.push(`remove-network:${id}`);
        const index = networks.findIndex((networkValue) => networkValue.id === id);
        if (index !== -1) networks.splice(index, 1);
      },
      async removeVolume(id: string) {
        calls.push(`remove-volume:${id}`);
        const index = volumes.findIndex((volumeValue) => volumeValue.id === id);
        if (index !== -1) volumes.splice(index, 1);
      },
    },
  };
  return state;
}
