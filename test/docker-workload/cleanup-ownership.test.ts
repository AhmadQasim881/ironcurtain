import { createLegacyDockerWorkloadLease as createDockerWorkloadLease } from '../helpers/legacy-docker-workload-lease.js';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateDockerWorkloadLease,
  closeDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
  revokeDockerWorkloadLease,
  type DockerWorkloadCleanupProof,
} from '../../src/docker-workload/bundle-lease.js';
import {
  DockerWorkloadCleanupPreconditionError,
  performSerializedDockerWorkloadCleanup,
  tryAcquireDockerWorkloadLifecycleClaim,
  tryHeartbeatDockerWorkloadLease,
} from '../../src/docker-workload/cleanup-ownership.js';
import {
  createDockerWorkloadEmergencyReserve,
  DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE,
} from '../../src/docker-workload/emergency-reserve.js';
import { captureCleanupProof, removeExactBundleState } from '../../src/docker-workload/bundle-cleanup.js';
import { getBundleRuntimeRootForHome } from '../../src/config/paths.js';
import { createMockDocker } from '../helpers/docker-mocks.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Docker-workload lifecycle ownership', () => {
  it('cleans the deterministic runtime root for a canonical historical lease without a recorded binding', () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-historical-root-'));
    temporaryDirectories.push(directory);
    const ironCurtainHome = join(directory, 'home');
    const leaseId = 'lease-cleanup-historical-root-001';
    const bundleId = 'bundle-cleanup-historical-root-001';
    const leaseDirectory = join(ironCurtainHome, 'docker-workload', 'leases', leaseId);
    const leasePath = join(leaseDirectory, 'lease.json');
    const stateRoot = join(ironCurtainHome, 'docker-workload', 'state', leaseId);
    const workspaceRoot = join(directory, 'workspace');
    const bundleRuntimeRoot = getBundleRuntimeRootForHome(ironCurtainHome, bundleId);
    const neighborRuntimeRoot = getBundleRuntimeRootForHome(ironCurtainHome, 'neighbor-cleanup-historical-root-001');
    mkdirSync(leaseDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    mkdirSync(bundleRuntimeRoot, { recursive: true, mode: 0o700 });
    mkdirSync(neighborRuntimeRoot, { recursive: true, mode: 0o700 });
    createDockerWorkloadLease(leasePath, {
      leaseId,
      bundleId,
      generation: 'generation-cleanup-historical-root-001',
      runtimeKind: 'docker',
      paths: {
        workspaceRoot,
        stateRoot,
        runtimeRoot: join(stateRoot, 'runtime'),
        apiRoot: join(stateRoot, 'api'),
        exchangeRoot: join(stateRoot, 'exchange'),
        stagingRoot: join(stateRoot, 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
    });

    removeExactBundleState(loadDockerWorkloadLease(leasePath), leasePath);

    expect(existsSync(stateRoot)).toBe(false);
    expect(existsSync(bundleRuntimeRoot)).toBe(false);
    expect(existsSync(workspaceRoot)).toBe(true);
    expect(existsSync(neighborRuntimeRoot)).toBe(true);
    expect(existsSync(leasePath)).toBe(true);
  });

  it('returns an already-closed proof even when no cleanup budget remains', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-closed-budget-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const generation = 'generation-cleanup-closed-budget-001';
    const initial = new Date('2026-07-20T12:00:00.000Z');
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-closed-budget-001',
      bundleId: 'bundle-cleanup-closed-budget-001',
      generation,
      runtimeKind: 'apple-container',
      paths: {
        workspaceRoot,
        stateRoot: join(directory, 'absent-state'),
        runtimeRoot: join(directory, 'absent-state', 'runtime'),
        apiRoot: join(directory, 'absent-state', 'api'),
        exchangeRoot: join(directory, 'absent-state', 'exchange'),
        stagingRoot: join(directory, 'absent-state', 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: initial,
    });
    revokeDockerWorkloadLease(leasePath, generation, initial);
    const cleanup: DockerWorkloadCleanupProof = {
      exactOuterResourcesAbsent: true,
      stateRootAbsent: true,
      inventories: [
        { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
        { capturedAt: '2026-07-20T12:00:00.100Z', ownedResourceIds: [] },
      ],
    };
    closeDockerWorkloadLease(leasePath, generation, cleanup, new Date('2026-07-20T12:00:00.100Z'));
    const listContainers = vi.fn(async () => []);

    await expect(
      performSerializedDockerWorkloadCleanup({
        runtime: { ...createMockDocker(), listContainers },
        leasePath,
        generation,
        targetDevice: 0,
        targetInode: 0,
        gapMs: 100,
        clock: () => new Date('2026-07-20T12:00:10.000Z'),
        sleep: async () => {},
        waitForOwner: true,
        timeoutMs: 0,
      }),
    ).resolves.toEqual({ alreadyClosed: true, cleanup });
    expect(listContainers).not.toHaveBeenCalled();
  });

  it('does not start another destructive phase after the cooperative cleanup budget expires', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-budget-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const stateRoot = join(directory, 'state');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const target = lstatSync(stateRoot);
    const generation = 'generation-cleanup-budget-001';
    const initialMs = Date.parse('2026-07-20T12:00:00.000Z');
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-budget-001',
      bundleId: 'bundle-cleanup-budget-001',
      generation,
      runtimeKind: 'apple-container',
      paths: {
        workspaceRoot,
        stateRoot,
        runtimeRoot: join(stateRoot, 'runtime'),
        apiRoot: join(stateRoot, 'api'),
        exchangeRoot: join(stateRoot, 'exchange'),
        stagingRoot: join(stateRoot, 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date(initialMs),
    });
    requestDockerWorkloadOuterResource(leasePath, generation, {
      requestId: 'resource-cleanup-budget-001',
      kind: 'container',
      role: 'agent',
      requestedName: 'ic-cleanup-budget',
      ownershipLabelKey: 'com.ironcurtain.docker-workload.generation',
    });
    observeDockerWorkloadOuterResource(
      leasePath,
      generation,
      'resource-cleanup-budget-001',
      'container-cleanup-budget-001',
    );
    activateDockerWorkloadLease(leasePath, generation);

    let currentMs = initialMs;
    const stop = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const listContainers = vi.fn(async () => {
      currentMs += 101;
      return [
        {
          id: 'container-cleanup-budget-001',
          name: 'ic-cleanup-budget',
          created: new Date(initialMs).toISOString(),
          running: true,
          labels: { 'com.ironcurtain.docker-workload.generation': generation },
        },
      ];
    });
    const runtime = { ...createMockDocker(), stop, remove, listContainers };

    await expect(
      performSerializedDockerWorkloadCleanup({
        runtime,
        leasePath,
        generation,
        targetDevice: target.dev,
        targetInode: target.ino,
        gapMs: 100,
        clock: () => new Date(currentMs),
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
        },
        waitForOwner: true,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/cooperative bound/u);

    expect(listContainers).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(loadDockerWorkloadLease(leasePath).status).toBe('incident');
  });

  it('timestamps cleanup inventories only after each authoritative inventory completes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-timestamp-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const generation = 'generation-cleanup-timestamp-001';
    const initialMs = Date.parse('2026-07-20T12:00:00.000Z');
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-timestamp-001',
      bundleId: 'bundle-cleanup-timestamp-001',
      generation,
      runtimeKind: 'apple-container',
      paths: {
        workspaceRoot,
        stateRoot: join(directory, 'absent-state'),
        runtimeRoot: join(directory, 'absent-state', 'runtime'),
        apiRoot: join(directory, 'absent-state', 'api'),
        exchangeRoot: join(directory, 'absent-state', 'exchange'),
        stagingRoot: join(directory, 'absent-state', 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date(initialMs),
    });

    let currentMs = initialMs;
    let inventoryCalls = 0;
    const runtime = {
      ...createMockDocker(),
      async listContainers() {
        inventoryCalls += 1;
        currentMs += inventoryCalls === 1 ? 30_000 : 5_000;
        return [];
      },
    };
    const proof = await captureCleanupProof(
      runtime,
      loadDockerWorkloadLease(leasePath),
      100,
      () => new Date(currentMs),
      async (milliseconds) => {
        currentMs += milliseconds;
      },
    );

    expect(inventoryCalls).toBe(2);
    expect(proof.inventories).toEqual([
      { capturedAt: '2026-07-20T12:00:30.000Z', ownedResourceIds: [] },
      { capturedAt: '2026-07-20T12:00:35.100Z', ownedResourceIds: [] },
    ]);
  });

  it('records an incident when authoritative inventory remains unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-inventory-failure-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const stateRoot = join(directory, 'state');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const target = lstatSync(stateRoot);
    const generation = 'generation-cleanup-inventory-failure-001';
    const initialMs = Date.parse('2026-07-20T12:00:00.000Z');
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-inventory-failure-001',
      bundleId: 'bundle-cleanup-inventory-failure-001',
      generation,
      runtimeKind: 'apple-container',
      paths: {
        workspaceRoot,
        stateRoot,
        runtimeRoot: join(stateRoot, 'runtime'),
        apiRoot: join(stateRoot, 'api'),
        exchangeRoot: join(stateRoot, 'exchange'),
        stagingRoot: join(stateRoot, 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date(initialMs),
    });
    let currentMs = initialMs;
    const runtime = {
      ...createMockDocker(),
      async listContainers(): Promise<never> {
        throw new Error('authoritative Apple inventory timed out twice');
      },
    };

    await expect(
      performSerializedDockerWorkloadCleanup({
        runtime,
        leasePath,
        generation,
        targetDevice: target.dev,
        targetInode: target.ino,
        gapMs: 100,
        clock: () => new Date(currentMs),
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
        },
        waitForOwner: true,
      }),
    ).rejects.toThrow(/timed out twice/u);
    expect(loadDockerWorkloadLease(leasePath)).toMatchObject({
      status: 'incident',
      incident: {
        code: 'docker-workload-cleanup-failed',
        detail: 'authoritative Apple inventory timed out twice',
      },
      cleanup: null,
    });
  });

  it('records a bounded incident and rethrows the original error when a 100-container inventory fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-long-error-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const stateRoot = join(directory, 'state');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const target = lstatSync(stateRoot);
    const generation = 'generation-cleanup-long-error-001';
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-long-error-001',
      bundleId: 'bundle-cleanup-long-error-001',
      generation,
      runtimeKind: 'docker',
      paths: {
        workspaceRoot,
        stateRoot,
        runtimeRoot: join(stateRoot, 'runtime'),
        apiRoot: join(stateRoot, 'api'),
        exchangeRoot: join(stateRoot, 'exchange'),
        stagingRoot: join(stateRoot, 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
    });
    requestDockerWorkloadOuterResource(leasePath, generation, {
      requestId: 'agent-container',
      kind: 'container',
      role: 'agent',
      requestedName: 'ic-dw-agent',
      ownershipLabelKey: 'com.ironcurtain.docker-workload.generation',
    });
    observeDockerWorkloadOuterResource(leasePath, generation, 'agent-container', 'f'.repeat(64));
    activateDockerWorkloadLease(leasePath, generation);
    // Node's execFile message repeats the whole argv before the daemon's
    // stderr: an inspect of every container on a 100-container host.
    const hostIds = Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, '0'));
    const inventoryError = Object.assign(
      new Error(
        `Command failed: docker --host unix:///var/run/docker.sock container inspect ${hostIds.join(' ')}\nError response from daemon: simulated daemon failure`,
      ),
      { code: 1, stdout: '', stderr: 'Error response from daemon: simulated daemon failure' },
    );
    expect(inventoryError.message.length).toBeGreaterThan(4096);
    const runtime = {
      ...createMockDocker(),
      async listContainers(): Promise<never> {
        throw inventoryError;
      },
    };
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');

    // The original failure, not a lease-schema error, reaches the caller.
    await expect(
      performSerializedDockerWorkloadCleanup({
        runtime,
        leasePath,
        generation,
        targetDevice: target.dev,
        targetInode: target.ino,
        gapMs: 100,
        clock: () => new Date(currentMs),
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
        },
        waitForOwner: true,
      }),
    ).rejects.toBe(inventoryError);
    const lease = loadDockerWorkloadLease(leasePath);
    expect(lease).toMatchObject({ status: 'incident', incident: { code: 'docker-workload-cleanup-failed' } });
    const detail = lease.incident?.detail ?? '';
    expect(detail.length).toBeLessThanOrEqual(4096);
    expect(detail).toMatch(/^Command failed: docker --host unix:\/\/\/var\/run\/docker\.sock container inspect /u);
    expect(detail).toMatch(/characters omitted/u);
    expect(detail).toMatch(/Error response from daemon: simulated daemon failure$/u);
  });

  it('keeps the original cleanup failure primary when recording the incident also fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-record-failure-'));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const stateRoot = join(directory, 'state');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const target = lstatSync(stateRoot);
    const generation = 'generation-cleanup-record-failure-001';
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-record-failure-001',
      bundleId: 'bundle-cleanup-record-failure-001',
      generation,
      runtimeKind: 'apple-container',
      paths: {
        workspaceRoot,
        stateRoot,
        runtimeRoot: join(stateRoot, 'runtime'),
        apiRoot: join(stateRoot, 'api'),
        exchangeRoot: join(stateRoot, 'exchange'),
        stagingRoot: join(stateRoot, 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
    });
    const inventoryError = new Error('authoritative Apple inventory unavailable');
    const runtime = {
      ...createMockDocker(),
      async listContainers(): Promise<never> {
        // The lease becomes unreadable before the failure can be recorded.
        chmodSync(leasePath, 0o644);
        throw inventoryError;
      },
    };
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');

    const failure = performSerializedDockerWorkloadCleanup({
      runtime,
      leasePath,
      generation,
      targetDevice: target.dev,
      targetInode: target.ino,
      gapMs: 100,
      clock: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
      },
      waitForOwner: true,
    });
    await expect(failure).rejects.toMatchObject({
      cause: inventoryError,
      errors: [inventoryError, expect.objectContaining({ message: expect.stringMatching(/owner-only/u) })],
    });
    await expect(failure).rejects.toThrow(/^authoritative Apple inventory unavailable \(recording this failure/u);
  });

  it('blocks a heartbeat after stale revalidation until cleanup has durably closed the lease', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-workload-cleanup-owner-'));
    temporaryDirectories.push(directory);
    const leasePath = join(directory, 'control', 'lease.json');
    const stateRoot = join(directory, 'state');
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(join(directory, 'control'), { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const target = lstatSync(stateRoot);
    const generation = 'generation-cleanup-owner-001';
    const initialHeartbeat = '2026-07-20T12:00:00.000Z';
    createDockerWorkloadLease(leasePath, {
      leaseId: 'lease-cleanup-owner-001',
      bundleId: 'bundle-cleanup-owner-001',
      generation,
      runtimeKind: 'docker',
      paths: {
        workspaceRoot,
        stateRoot,
        runtimeRoot: join(stateRoot, 'runtime'),
        apiRoot: join(stateRoot, 'api'),
        exchangeRoot: join(stateRoot, 'exchange'),
        stagingRoot: join(stateRoot, 'staging'),
      },
      bindings: {
        catalogSha256: '2'.repeat(64),
        innerDockerCatalogSha256: '7'.repeat(64),
        profileSha256: '3'.repeat(64),
        watchdogPolicySha256: '5'.repeat(64),
        toolchainDigest: '6'.repeat(64),
      },
      cleanupInventoryGapMs: 100,
      now: new Date(initialHeartbeat),
    });
    let currentMs = Date.parse(initialHeartbeat);
    let heartbeatAttempted = false;
    let heartbeatAccepted = true;
    let revokingHeartbeatError: unknown;
    const runtime = {
      ...createMockDocker(),
      async listContainers() {
        return [];
      },
      async listNetworks() {
        return [];
      },
    };

    await performSerializedDockerWorkloadCleanup({
      runtime,
      leasePath,
      generation,
      targetDevice: target.dev,
      targetInode: target.ino,
      gapMs: 100,
      clock: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
      },
      waitForOwner: true,
      revalidate: (lease) => expect(lease.coordinator.heartbeatAt).toBe(initialHeartbeat),
      afterRevalidate: () => {
        currentMs += 1_000;
        heartbeatAttempted = true;
        heartbeatAccepted = tryHeartbeatDockerWorkloadLease({
          leasePath,
          generation,
          clock: () => new Date(currentMs),
        });
        expect(loadDockerWorkloadLease(leasePath).coordinator.heartbeatAt).toBe(initialHeartbeat);
      },
      onRevoking: () => {
        try {
          heartbeatDockerWorkloadLease(leasePath, generation, new Date(currentMs));
        } catch (error) {
          revokingHeartbeatError = error;
        }
      },
    });

    expect(heartbeatAttempted).toBe(true);
    expect(heartbeatAccepted).toBe(false);
    expect(revokingHeartbeatError).toEqual(expect.objectContaining({ message: expect.stringMatching(/revoking/u) }));
    expect(loadDockerWorkloadLease(leasePath)).toMatchObject({
      status: 'closed',
      coordinator: { heartbeatAt: initialHeartbeat },
    });
  });
});

describe('Docker-workload cleanup under disk pressure', () => {
  function pressureFixture(label: string) {
    const directory = mkdtempSync(join(tmpdir(), `docker-workload-cleanup-${label}-`));
    temporaryDirectories.push(directory);
    const controlDir = join(directory, 'control');
    const leasePath = join(controlDir, 'lease.json');
    const stateRoot = join(directory, 'state');
    mkdirSync(controlDir, { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    const generation = `generation-cleanup-${label}-001`;
    createDockerWorkloadLease(leasePath, {
      leaseId: `lease-cleanup-${label}-001`,
      bundleId: `bundle-cleanup-${label}-001`,
      generation,
      runtimeKind: 'docker',
      paths: {
        workspaceRoot: join(directory, 'workspace'),
        stateRoot,
        runtimeRoot: join(stateRoot, 'runtime'),
        apiRoot: join(stateRoot, 'api'),
        exchangeRoot: join(stateRoot, 'exchange'),
        stagingRoot: join(stateRoot, 'staging'),
      },
      bindings: { watchdogPolicySha256: '5'.repeat(64) },
      cleanupInventoryGapMs: 100,
    });
    createDockerWorkloadEmergencyReserve(controlDir, 64 * 1024);
    const stats = lstatSync(stateRoot);
    const runtime = {
      ...createMockDocker(),
      listContainers: () => Promise.resolve([]),
      listNetworks: () => Promise.resolve([]),
    };
    const clock = { ms: Date.parse('2026-07-20T12:00:00.000Z') };
    const options = {
      runtime,
      leasePath,
      generation,
      targetDevice: stats.dev,
      targetInode: stats.ino,
      gapMs: 100,
      clock: () => new Date(clock.ms),
      sleep: (milliseconds: number) => {
        clock.ms += milliseconds;
        return Promise.resolve();
      },
      waitForOwner: true,
    };
    return { controlDir, leasePath, options };
  }

  it('adopts a held lifecycle claim, runs the pre-ledger hook first, and then frees the reserve', async () => {
    const fixture = pressureFixture('adopted-claim');
    const held = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: fixture.leasePath });
    const order: string[] = [];
    const reserveHeld = (): boolean => existsSync(join(fixture.controlDir, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE));
    const result = await performSerializedDockerWorkloadCleanup({
      ...fixture.options,
      claim: held,
      beforeLeaseMutation: () => {
        order.push(`hook:${loadDockerWorkloadLease(fixture.leasePath).status}:reserve=${reserveHeld()}`);
        return Promise.resolve();
      },
      onRevoking: (from) => {
        order.push(`first-write:${from}:reserve=${reserveHeld()}`);
      },
    });
    expect(result.alreadyClosed).toBe(false);
    // The hook (the supervisor's write-free revocation) ran before the first
    // lease write while the reserve was still held, so a bundle that was still
    // writing could not take it; the reserve was freed before that write.
    expect(order).toEqual(['hook:admitting:reserve=true', 'first-write:admitting:reserve=false']);
    expect(loadDockerWorkloadLease(fixture.leasePath).status).toBe('closed');
    // The adopted claim was released, so a new owner can take the lifecycle.
    tryAcquireDockerWorkloadLifecycleClaim({ leasePath: fixture.leasePath }).release();
  });

  it('keeps the reserve for a lease whose revalidation refuses cleanup', async () => {
    const fixture = pressureFixture('refused');
    const hook = vi.fn(() => Promise.resolve());
    await expect(
      performSerializedDockerWorkloadCleanup({
        ...fixture.options,
        waitForOwner: false,
        revalidate: () => {
          throw new DockerWorkloadCleanupPreconditionError('coordinator heartbeat refreshed before cleanup ownership');
        },
        beforeLeaseMutation: hook,
      }),
    ).rejects.toThrow(/heartbeat refreshed/u);
    expect(hook).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.controlDir, DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE))).toBe(true);
    expect(loadDockerWorkloadLease(fixture.leasePath).status).toBe('admitting');
  });
});
