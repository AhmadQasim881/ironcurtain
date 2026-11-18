import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertResourceWatchdogSupervisorFresh,
  loadResourceWatchdogSupervisorStatus,
  requestResourceWatchdogSupervisorStop,
  runResourceWatchdogSupervisor,
} from '../../src/docker-workload/resource-watchdog-supervisor.js';
import {
  activateDockerWorkloadLease,
  bindDockerWorkloadOuterResourceStorage,
  closeDockerWorkloadLease,
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recordDockerWorkloadLeaseIncident,
  requestDockerWorkloadOuterResource,
  revokeDockerWorkloadLease,
  type CreateDockerWorkloadLeaseOptions,
  type DockerWorkloadCleanupProof,
} from '../../src/docker-workload/bundle-lease.js';
import { describeAppleContainerRootfs } from '../../src/docker/apple-container-manager.js';
import {
  buildRuntimeWatchdogPolicy,
  loadFrozenWatchdogPolicyTemplate,
} from '../../src/docker-workload/watchdog-policy.js';
import { tryAcquireDockerWorkloadLifecycleClaim } from '../../src/docker-workload/cleanup-ownership.js';
import { MAX_INCIDENT_DETAIL_CODE_POINTS } from '../../src/docker-workload/incident-detail.js';
import { createDockerWorkloadEmergencyReserve } from '../../src/docker-workload/emergency-reserve.js';
import type { ResourceWatchdogPolicy } from '../../src/docker/resource-watchdog.js';
import { createMockDocker } from '../helpers/docker-mocks.js';
import {
  createLegacyDockerWorkloadLease,
  createVersion2DockerWorkloadLease,
} from '../helpers/legacy-docker-workload-lease.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('detached resource-watchdog supervisor core', () => {
  it('revokes and closes independently when the initial sample crosses the hard threshold', async () => {
    const fixture = supervisorFixture('trip');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    writeFileSync(join(fixture.stateRoot, 'daemon', 'state.bin'), Buffer.alloc(8192, 1));
    const policy = writePolicy(fixture, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLease(fixture, policy.policy);
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
      },
    });

    expect(loadDockerWorkloadLease(fixture.paths.leasePath)).toMatchObject({ status: 'closed', cleanup: {} });
    expect(() => lstatSync(fixture.stateRoot)).toThrow();
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: { code: 'hard-state-threshold' },
    });
  });

  it('publishes bounded incidents that keep the real cause when trip revocation fails with an argv-sized error', async () => {
    const fixture = supervisorFixture('trip-long-error');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    writeFileSync(join(fixture.stateRoot, 'daemon', 'state.bin'), Buffer.alloc(8192, 1));
    const policy = writePolicy(fixture, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLease(fixture, policy.policy);
    const hostIds = Array.from({ length: 300 }, (_, index) => index.toString(16).padStart(64, '0'));
    const inventoryError = new Error(
      `Command failed: docker --host unix:///var/run/docker.sock container inspect ${hostIds.join(' ')}\nError response from daemon: simulated daemon failure`,
    );
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');

    const run = runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: {
        ...emptyRuntime(),
        async listContainers(): Promise<never> {
          throw inventoryError;
        },
      },
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
      },
    });
    await expect(run).rejects.toMatchObject({ cause: inventoryError });

    const status = loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath);
    expect(status).toMatchObject({ state: 'incident', trip: { code: 'hard-state-threshold' } });
    expect(status.detail?.length).toBeLessThanOrEqual(4096);
    expect(status.detail).toMatch(/^Command failed: docker .*characters omitted.*simulated daemon failure$/u);
    const lease = loadDockerWorkloadLease(fixture.paths.leasePath);
    expect(lease).toMatchObject({ status: 'incident', incident: { code: 'docker-workload-cleanup-failed' } });
    expect(lease.incident?.detail).toBe(status.detail);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
  ] as const)(
    'accepts normal shutdown with a running generation-v%i supervisor (protocol v%i)',
    async (version, protocol) => {
      const fixture = supervisorFixture('normal');
      mkdirSync(join(fixture.stateRoot, 'daemon'));
      const policy = writePolicy(fixture, {
        softEvidenceBytes: 512 * 1024 * 1024,
        hardSafetyBytes: 1024 * 1024 * 1024,
      });
      if (version === 1) {
        createLegacyDockerWorkloadLease(fixture.paths.leasePath, {
          ...fixture.leaseOptions,
          bindings: { watchdogPolicySha256: policy.sha256 },
        });
      } else if (version === 2) {
        createVersion2DockerWorkloadLease(fixture.paths.leasePath, {
          ...fixture.leaseOptions,
          bindings: { watchdogPolicy: policy.policy },
        });
      } else createLease(fixture, policy.policy);
      const running = runResourceWatchdogSupervisor({ ...fixture.paths, runtime: emptyRuntime() });
      const ready = await waitForReady(fixture.paths.statusPath);
      assertResourceWatchdogSupervisorFresh(
        ready,
        {
          leaseId: fixture.leaseOptions.leaseId,
          generation: fixture.leaseOptions.generation,
          ...(version === 1 ? { policySha256: policy.sha256 } : { policy: policy.policy }),
        },
        1000,
        new Date(ready.updatedAt),
      );

      revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
      rmSync(fixture.stateRoot, { recursive: true, force: true });
      const cleanup: DockerWorkloadCleanupProof = {
        exactOuterResourcesAbsent: true,
        stateRootAbsent: true,
        inventories: [
          { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
          { capturedAt: '2026-07-20T12:00:00.200Z', ownedResourceIds: [] },
        ],
      };
      const closed = closeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation, cleanup);
      requestResourceWatchdogSupervisorStop(fixture.paths.stopRequestPath, closed, cleanup);
      expect(JSON.parse(readFileSync(fixture.paths.stopRequestPath, 'utf8'))).toMatchObject({
        schemaVersion: protocol,
      });
      await running;
      expect(loadDockerWorkloadLease(fixture.paths.leasePath)).toMatchObject({
        status: 'closed',
        schemaVersion: version,
      });
      expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
        schemaVersion: protocol,
        state: 'closed',
        detail: 'durable lease cleanup observed',
      });
    },
  );

  it('compares policy values without binding JSON formatting and rejects threshold substitution', async () => {
    const fixture = supervisorFixture('policy-values');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const { policy } = writePolicy(fixture, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLease(fixture, policy);
    chmodSync(fixture.paths.policyPath, 0o600);
    writeFileSync(
      fixture.paths.policyPath,
      JSON.stringify(Object.fromEntries(Object.entries(policy).reverse()), null, 2),
    );
    chmodSync(fixture.paths.policyPath, 0o400);
    let now = Date.parse('2026-07-20T12:00:00.000Z');
    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(now),
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');

    const changed = supervisorFixture('policy-substitution');
    mkdirSync(join(changed.stateRoot, 'daemon'));
    const original = writePolicy(changed, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLease(changed, original.policy);
    chmodSync(changed.paths.policyPath, 0o600);
    writeFileSync(changed.paths.policyPath, JSON.stringify({ ...original.policy, hardSafetyBytes: 2048 }));
    chmodSync(changed.paths.policyPath, 0o400);
    await expect(runResourceWatchdogSupervisor({ ...changed.paths, runtime: emptyRuntime() })).rejects.toThrow(
      /does not match/,
    );
    expect(loadDockerWorkloadLease(changed.paths.leasePath).status).toBe('admitting');
  });

  it('keeps the original byte comparison for a legacy generation', async () => {
    const fixture = supervisorFixture('legacy-policy');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLegacyDockerWorkloadLease(fixture.paths.leasePath, {
      ...fixture.leaseOptions,
      bindings: { watchdogPolicySha256: policy.sha256 },
    });
    chmodSync(fixture.paths.policyPath, 0o600);
    writeFileSync(fixture.paths.policyPath, JSON.stringify(policy.policy, null, 2));
    chmodSync(fixture.paths.policyPath, 0o400);
    await expect(runResourceWatchdogSupervisor({ ...fixture.paths, runtime: emptyRuntime() })).rejects.toThrow(
      /does not match/,
    );
  });

  it('resumes a revoking lease after a prior cleanup owner disappears', async () => {
    const fixture = supervisorFixture('stale-coordinator');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.policy);
    revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    let currentMs = Date.parse('2026-07-20T12:01:00.000Z');

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
      },
    });

    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(() => lstatSync(fixture.stateRoot)).toThrow();
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      detail: 'stale coordinator triggered exact cleanup',
    });
  });

  it('retries exact recovery of an incident lease with backoff instead of exiting', async () => {
    const fixture = supervisorFixture('incident-retry');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, ROOMY_THRESHOLDS);
    createLease(fixture, policy.policy);
    const daemon = ledgerResource(fixture, 'res-daemon', 'container', 'nested-daemon', 'ic-incident-daemon');
    activateDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    // The coordinator's teardown failed: Docker Desktop restarted under it.
    recordDockerWorkloadLeaseIncident(fixture.paths.leasePath, fixture.leaseOptions.generation, {
      code: 'docker-workload-cleanup-failed',
      detail: 'Docker Desktop restarted during teardown',
    });
    const outer = statefulRuntime(fixture, [daemon], []);
    const listContainers = outer.runtime.listContainers;
    let unavailableInventories = 2;
    outer.runtime.listContainers = () =>
      unavailableInventories-- > 0 ? Promise.reject(new Error('Docker Desktop is restarting')) : listContainers();
    let currentMs = Date.parse('2026-07-20T12:01:00.000Z');
    const published: string[] = [];

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: outer.runtime,
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        const detail = loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath).detail;
        if (detail !== null && published.at(-1) !== detail) published.push(detail);
        currentMs += milliseconds;
      },
    });

    expect(loadDockerWorkloadLease(fixture.paths.leasePath)).toMatchObject({
      status: 'closed',
      incident: { code: 'docker-workload-cleanup-failed' },
    });
    expect(outer.calls).toEqual(['stop:ic-incident-daemon', 'remove:ic-incident-daemon']);
    expect(published).toContainEqual(
      expect.stringMatching(/exact recovery attempt 1 failed \(Docker Desktop is restarting\); retrying in 5s/u),
    );
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      detail: 'lease incident recovered by the watchdog supervisor (attempt 2)',
    });
  });

  it('stays up after a failed trip revocation and recovers the resulting incident', async () => {
    const fixture = supervisorFixture('trip-retry');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, { softEvidenceBytes: 512, hardSafetyBytes: 1024 });
    createLease(fixture, policy.policy);
    const daemon = ledgerResource(fixture, 'res-daemon', 'container', 'nested-daemon', 'ic-trip-daemon');
    activateDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    const outer = statefulRuntime(fixture, [daemon], []);
    const listContainers = outer.runtime.listContainers;
    let restarting = false;
    let refusedInventories = 0;
    outer.runtime.listContainers = () => {
      if (!restarting || refusedInventories >= 3) return listContainers();
      refusedInventories += 1;
      return Promise.reject(new Error('Docker Desktop is restarting'));
    };
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: outer.runtime,
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
        heartbeatIfLive(fixture, currentMs);
        if (!restarting) {
          // The bundle crosses the hard threshold just as Docker Desktop restarts.
          writeFileSync(join(fixture.stateRoot, 'daemon', 'state.bin'), Buffer.alloc(8192, 1));
          restarting = true;
        }
      },
    });

    expect(refusedInventories).toBe(3);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath)).toMatchObject({
      status: 'closed',
      incident: { code: 'docker-workload-cleanup-failed' },
    });
    expect(outer.calls).toEqual(['stop:ic-trip-daemon', 'remove:ic-trip-daemon']);
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: { code: 'hard-state-threshold' },
      detail: 'lease incident recovered by the watchdog supervisor (attempt 1)',
    });
  });

  it('stays up and retries when its own cleanup of a silent coordinator fails', async () => {
    const fixture = supervisorFixture('stale-retry');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, { ...ROOMY_THRESHOLDS, ...SHIPPED_TIMING });
    createLease(fixture, policy.policy);
    const daemon = ledgerResource(fixture, 'res-daemon', 'container', 'nested-daemon', 'ic-stale-daemon');
    activateDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    const outer = statefulRuntime(fixture, [daemon], []);
    const listContainers = outer.runtime.listContainers;
    let refusedInventories = 0;
    // Docker Desktop restarts just as the silent coordinator's bundle is revoked.
    outer.runtime.listContainers = () => {
      if (leaseStatus(fixture) !== 'revoking' || refusedInventories >= 2) return listContainers();
      refusedInventories += 1;
      return Promise.reject(new Error('Docker Desktop is restarting'));
    };
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: outer.runtime,
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        time.wallMs += milliseconds;
        time.monotonicMs += milliseconds;
      },
    });

    expect(refusedInventories).toBe(2);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath)).toMatchObject({
      status: 'closed',
      incident: { code: 'docker-workload-cleanup-failed' },
    });
    expect(outer.calls).toEqual(expect.arrayContaining(['stop:ic-stale-daemon', 'remove:ic-stale-daemon']));
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      detail: 'lease incident recovered by the watchdog supervisor (attempt 2)',
    });
  });

  it('cleans an active lease once its coordinator is silent for 30s of supervisor-monotonic time', async () => {
    const fixture = supervisorFixture('stale-active');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, { ...ROOMY_THRESHOLDS, ...SHIPPED_TIMING });
    createLease(fixture, policy.policy);
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    let revokedAtMonotonicMs: number | undefined;

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        if (revokedAtMonotonicMs === undefined && leaseStatus(fixture) === 'revoking') {
          revokedAtMonotonicMs = time.monotonicMs;
        }
        time.wallMs += milliseconds;
        time.monotonicMs += milliseconds;
      },
    });

    expect(revokedAtMonotonicMs).toBeGreaterThanOrEqual(30_000);
    expect(revokedAtMonotonicMs).toBeLessThan(30_000 + SHIPPED_TIMING.sampleIntervalMs);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(() => lstatSync(fixture.stateRoot)).toThrow();
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: null,
      detail: 'stale coordinator triggered exact cleanup',
    });
  });

  it('does not let a backward wall-clock step postpone cleanup of a silent coordinator', async () => {
    const fixture = supervisorFixture('stepped-back');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, { ...ROOMY_THRESHOLDS, ...SHIPPED_TIMING });
    createLease(fixture, policy.policy);
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    let sleeps = 0;
    let revokedAtMonotonicMs: number | undefined;

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        sleeps += 1;
        if (revokedAtMonotonicMs === undefined && leaseStatus(fixture) === 'revoking') {
          revokedAtMonotonicMs = time.monotonicMs;
        }
        // One hour back: the last heartbeat now reads as written in the future.
        time.wallMs += sleeps === 1 ? -60 * 60_000 : milliseconds;
        time.monotonicMs += milliseconds;
      },
    });

    expect(revokedAtMonotonicMs).toBeGreaterThanOrEqual(30_000);
    expect(revokedAtMonotonicMs).toBeLessThan(30_000 + SHIPPED_TIMING.sampleIntervalMs);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
  });

  it('neither trips nor revokes when the wall clock jumps 10 minutes while the monotonic clock stands still', async () => {
    const fixture = supervisorFixture('wall-jump');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, { ...ROOMY_THRESHOLDS, ...SHIPPED_TIMING });
    createLease(fixture, policy.policy);
    const startedAtMs = Date.parse('2026-07-20T12:00:00.000Z');
    const time = { wallMs: startedAtMs, monotonicMs: 0 };
    let sleeps = 0;
    let beforeRevocation: BeforeRevocation | undefined;

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        sleeps += 1;
        if (sleeps === 3) {
          time.wallMs += 10 * 60_000;
        } else {
          time.wallMs += milliseconds;
          time.monotonicMs += milliseconds;
        }
        // The live coordinator heartbeats first on every interval, as in the audit repro.
        if (!heartbeatIfLive(fixture, time.wallMs)) return;
        if (sleeps === 12) beforeRevocation = revokeAsCoordinator(fixture, time.wallMs);
      },
    });

    expect(beforeRevocation?.leaseStatus).toBe('admitting');
    expect(beforeRevocation?.supervisorStatus).toMatchObject({ state: 'ready', trip: null });
    // Samples kept being published after the jump.
    expect(Date.parse(beforeRevocation?.supervisorStatus.updatedAt ?? '')).toBeGreaterThan(startedAtMs + 10 * 60_000);
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: null,
    });
  });

  it('grants a heartbeating coordinator a fresh window after the supervisor itself was paused on both clocks', async () => {
    const fixture = supervisorFixture('host-pause');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, { ...ROOMY_THRESHOLDS, ...SHIPPED_TIMING });
    createLease(fixture, policy.policy);
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    let sleeps = 0;
    let beforeRevocation: BeforeRevocation | undefined;

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        sleeps += 1;
        if (sleeps === 3) {
          // Host sleep on a VM whose monotonic clock counts the pause: no
          // process ran, so the coordinator has not heartbeated either.
          time.wallMs += 60_000;
          time.monotonicMs += 60_000;
          return;
        }
        time.wallMs += milliseconds;
        time.monotonicMs += milliseconds;
        if (!heartbeatIfLive(fixture, time.wallMs)) return;
        if (sleeps === 10) beforeRevocation = revokeAsCoordinator(fixture, time.wallMs);
      },
    });

    expect(beforeRevocation?.leaseStatus).toBe('admitting');
    expect(beforeRevocation?.supervisorStatus).toMatchObject({ state: 'ready', trip: null });
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: null,
    });
  });

  it('trips on its fresh sample when only the supervisor stalls while state crosses the hard threshold', async () => {
    const fixture = supervisorFixture('supervisor-stall');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 64 * 1024,
      hardSafetyBytes: 128 * 1024,
      ...SHIPPED_TIMING,
    });
    createLease(fixture, policy.policy);
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    let sleeps = 0;

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        sleeps += 1;
        if (sleeps === 3) {
          // Only the supervisor stalls for a minute; the bundle keeps writing.
          time.wallMs += 60_000;
          time.monotonicMs += 60_000;
          writeFileSync(join(fixture.stateRoot, 'daemon', 'grown.bin'), Buffer.alloc(256 * 1024, 1));
        } else {
          time.wallMs += milliseconds;
          time.monotonicMs += milliseconds;
        }
        heartbeatIfLive(fixture, time.wallMs);
      },
    });

    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: { code: 'hard-state-threshold' },
    });
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(() => lstatSync(fixture.stateRoot)).toThrow();
  });

  it('defers samples during a 30s claimed create and publishes a real sample immediately after release', async () => {
    const fixture = supervisorFixture('long-create');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
      sampleIntervalMs: 5_000,
      sampleTimeoutMs: 5_000,
      staleAfterMs: 30_000,
    });
    createLease(fixture, policy.policy);
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');
    let allowAdvance = false;
    let createClaim: ReturnType<typeof tryAcquireDockerWorkloadLifecycleClaim> | undefined;
    let nextHeartbeatMs = currentMs + 5_000;
    let releaseAtMs = Number.POSITIVE_INFINITY;
    const running = runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: emptyRuntime(),
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        while (!allowAdvance) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        currentMs += Math.max(milliseconds, 1_000);
        while (createClaim !== undefined && currentMs >= nextHeartbeatMs) {
          heartbeatDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation, new Date(currentMs));
          nextHeartbeatMs += 5_000;
        }
        if (createClaim !== undefined && currentMs >= releaseAtMs) {
          createClaim.release();
          createClaim = undefined;
        }
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    });
    const ready = await waitForReady(fixture.paths.statusPath);
    const initialStatusAt = Date.parse(ready.updatedAt);
    createClaim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: fixture.paths.leasePath });
    releaseAtMs = currentMs + 31_000;
    allowAdvance = true;

    let fresh: ReturnType<typeof loadResourceWatchdogSupervisorStatus>;
    try {
      fresh = await waitForStatus(
        fixture.paths.statusPath,
        (status) =>
          status.state === 'ready' && status.lastSample !== null && Date.parse(status.updatedAt) > initialStatusAt,
      );
    } catch (error) {
      releaseOptionalClaim(createClaim);
      createClaim = undefined;
      throw new Error(`long-create test stalled at ${currentMs} (release ${releaseAtMs})`, { cause: error });
    }
    expect(currentMs).toBeGreaterThanOrEqual(releaseAtMs);
    expect(fresh.trip).toBeNull();
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('admitting');

    revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    await running;
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
  });

  it('rejects a stale heartbeat or a status bound to another policy', () => {
    const fixture = supervisorFixture('freshness');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.policy);
    const status = {
      schemaVersion: 2 as const,
      leaseId: fixture.leaseOptions.leaseId,
      generation: fixture.leaseOptions.generation,
      supervisorPid: process.pid,
      state: 'ready' as const,
      policy: policy.policy,
      policyId: 'apple-observed-disk-v1',
      startedAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:00:00.000Z',
      lastSample: null,
      trip: null,
      detail: null,
    };
    expect(() =>
      assertResourceWatchdogSupervisorFresh(
        status,
        {
          leaseId: status.leaseId,
          generation: status.generation,
          policy: { ...policy.policy, hardSafetyBytes: policy.policy.hardSafetyBytes + 1 },
        },
        1000,
        new Date(status.updatedAt),
      ),
    ).toThrow(/binding mismatch/u);
    expect(() =>
      assertResourceWatchdogSupervisorFresh(
        status,
        { leaseId: status.leaseId, generation: status.generation, policy: status.policy },
        100,
        new Date('2026-07-20T12:00:00.100Z'),
      ),
    ).toThrow(/stale/u);
  });

  it('keeps its control plane outside the state tree it may delete', async () => {
    const fixture = supervisorFixture('control-path');
    chmodSync(fixture.stateRoot, 0o700);
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.policy);
    await expect(
      runResourceWatchdogSupervisor({
        ...fixture.paths,
        statusPath: join(fixture.stateRoot, 'status.json'),
        runtime: emptyRuntime(),
      }),
    ).rejects.toThrow(/control files.*outside/u);
  });

  it('remeasures normal-stop state instead of trusting coordinator cleanup booleans', async () => {
    const fixture = supervisorFixture('forged-stop');
    mkdirSync(join(fixture.stateRoot, 'daemon'));
    const policy = writePolicy(fixture, {
      softEvidenceBytes: 512 * 1024 * 1024,
      hardSafetyBytes: 1024 * 1024 * 1024,
    });
    createLease(fixture, policy.policy);
    const running = runResourceWatchdogSupervisor({ ...fixture.paths, runtime: emptyRuntime() });
    await waitForReady(fixture.paths.statusPath);
    revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    const forgedCleanup: DockerWorkloadCleanupProof = {
      exactOuterResourcesAbsent: true,
      stateRootAbsent: true,
      inventories: [
        { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
        { capturedAt: '2026-07-20T12:00:00.200Z', ownedResourceIds: [] },
      ],
    };
    const closed = closeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation, forgedCleanup);
    requestResourceWatchdogSupervisorStop(fixture.paths.stopRequestPath, closed, forgedCleanup);
    await expect(running).rejects.toThrow(/state root still exists/u);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'incident',
      detail: expect.stringMatching(/state root still exists/u),
    });
  });
});

describe('detached resource-watchdog supervisor over runtime storage', () => {
  it('revokes the bundle when the Docker Desktop daemon volume grows past the hard threshold (fake probe)', async () => {
    const fixture = supervisorFixture('desktop-volume');
    const policy = writeRuntimePolicy(fixture, 'docker');
    createLease(fixture, policy);
    const daemon = ledgerResource(fixture, 'nested-daemon', 'container', 'nested-daemon', 'ic-dw-nested-daemon-1');
    const volume = ledgerResource(fixture, 'daemon-volume', 'volume', 'daemon-api', 'ic-dw-daemon-api-1');
    const agent = ledgerResource(fixture, 'agent', 'container', 'agent', 'ic-agent-1');
    const outer = statefulRuntime(fixture, [daemon, agent], [volume]);
    const probe = {
      volumeBytes: 0,
      diskReads: 0,
      readRuntimeDisk: () => {
        probe.diskReads += 1;
        return Promise.resolve({ availableBytes: 40 * 1024 ** 3, usedBytes: 20 * 1024 ** 3 });
      },
      measureVolumes: () => Promise.resolve(new Map([[volume.name, probe.volumeBytes]])),
    };
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    let sleeps = 0;

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: outer.runtime,
      storageProbe: probe,
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        sleeps += 1;
        time.wallMs += milliseconds;
        time.monotonicMs += milliseconds;
        // The nested daemon pulls and builds: its VFS data root grows.
        if (sleeps === 3) probe.volumeBytes = policy.hardSafetyBytes + 1024 * 1024;
        heartbeatIfLive(fixture, time.wallMs);
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    });

    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: { code: 'hard-state-threshold' },
    });
    expect(probe.diskReads).toBeGreaterThan(0);
    // Exact containers, then the volume holding the data, all removed.
    expect(outer.calls).toEqual(
      expect.arrayContaining([
        `stop:${agent.name}`,
        `remove:${agent.name}`,
        `stop:${daemon.name}`,
        `remove:${daemon.name}`,
        `remove-volume:${volume.name}`,
      ]),
    );
    const lease = loadDockerWorkloadLease(fixture.paths.leasePath);
    expect(lease.status).toBe('closed');
    expect(lease.resources.every((resource) => resource.removal !== null)).toBe(true);
    expect(() => lstatSync(fixture.stateRoot)).toThrow();
  });

  it('publishes the allocated blocks of an Apple VM rootfs image above its activation baseline', async () => {
    const fixture = supervisorFixture('apple-rootfs', 'apple-container');
    const policy = writeRuntimePolicy(fixture, 'apple-container');
    createLease(fixture, policy);
    const agent = ledgerResource(fixture, 'agent', 'container', 'agent', 'ic-agent-vm');
    const appRoot = join(fixture.directory, 'app-root');
    const rootfs = join(appRoot, 'containers', agent.name, 'rootfs.ext4');
    mkdirSync(join(appRoot, 'containers', agent.name), { recursive: true });
    writeFileSync(rootfs, Buffer.alloc(128 * 1024, 1));
    bindDockerWorkloadOuterResourceStorage(
      fixture.paths.leasePath,
      fixture.leaseOptions.generation,
      agent.requestId,
      describeAppleContainerRootfs(appRoot, agent.name),
    );
    activateDockerWorkloadLease(
      fixture.paths.leasePath,
      fixture.leaseOptions.generation,
      new Date(),
      new Map([[agent.requestId, lstatSync(rootfs).blocks * 512]]),
    );
    const outer = statefulRuntime(fixture, [agent], []);
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    const published: number[] = [];
    let sleeps = 0;

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: outer.runtime,
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        sleeps += 1;
        time.wallMs += milliseconds;
        time.monotonicMs += milliseconds;
        const lastSample = loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath).lastSample;
        if (lastSample !== null) published.push(lastSample.allocatedBytes);
        // The VM writes inner image layers: real blocks land in its rootfs image.
        if (sleeps === 2) writeFileSync(rootfs, Buffer.alloc(512 * 1024, 2), { flag: 'a' });
        if (sleeps === 4) writeFileSync(rootfs, Buffer.alloc(2 * 1024 * 1024, 3), { flag: 'a' });
        heartbeatIfLive(fixture, time.wallMs);
      },
    });

    expect(published[0]).toBe(0);
    expect(published).toContainEqual(expect.any(Number));
    expect(Math.max(...published)).toBeGreaterThanOrEqual(512 * 1024);
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: { code: 'hard-state-threshold' },
    });
    expect(outer.calls).toEqual(expect.arrayContaining([`stop:${agent.name}`, `remove:${agent.name}`]));
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
  });

  it('refuses to run a runtime-storage policy without its storage sampler inputs', async () => {
    const fixture = supervisorFixture('apple-unbound', 'apple-container');
    const policy = writeRuntimePolicy(fixture, 'apple-container');
    createLease(fixture, policy);
    ledgerResource(fixture, 'agent', 'container', 'agent', 'ic-agent-vm');
    const outer = statefulRuntime(fixture, [], []);
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');
    // The first sample cannot measure an unbound VM: startup fails closed and revokes.
    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: outer.runtime,
      now: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
      },
    });
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: { code: 'sample-error', detail: expect.stringMatching(/no bound rootfs image/u) },
    });
  });

  it('stops the tripped bundle before it frees the emergency reserve for the ledgered evidence', async () => {
    const fixture = supervisorFixture('reserve-order');
    const policy = writeRuntimePolicy(fixture, 'docker');
    createLease(fixture, policy);
    const daemon = ledgerResource(fixture, 'nested-daemon', 'container', 'nested-daemon', 'ic-dw-nested-daemon-2');
    const volume = ledgerResource(fixture, 'daemon-volume', 'volume', 'daemon-api', 'ic-dw-daemon-api-2');
    const agent = ledgerResource(fixture, 'agent', 'container', 'agent', 'ic-agent-2');
    activateDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    const reservePath = createDockerWorkloadEmergencyReserve(fixture.directory, 64 * 1024);
    const outer = observeStops(statefulRuntime(fixture, [daemon, agent], [volume]), fixture, reservePath);
    const probe = {
      readRuntimeDisk: () => Promise.resolve({ availableBytes: 40 * 1024 ** 3, usedBytes: 20 * 1024 ** 3 }),
      measureVolumes: () => Promise.resolve(new Map([[volume.name, policy.hardSafetyBytes + 1024 * 1024]])),
    };
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: outer.runtime,
      storageProbe: probe,
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        time.wallMs += milliseconds;
        time.monotonicMs += milliseconds;
        heartbeatIfLive(fixture, time.wallMs);
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    });

    // A bundle that is still writing while it is stopped finds no freed
    // reserve to consume, and no lease write has happened yet.
    expect(outer.stops).toEqual([`${agent.name}:active:reserve=true`, `${daemon.name}:active:reserve=true`]);
    expect(outer.calls).toContain(`remove-volume:${volume.name}`);
    // Freed afterwards, for the proof writes that then closed the lease.
    expect(existsSync(reservePath)).toBe(false);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: { code: 'hard-state-threshold' },
    });
  });

  it("stops a silent coordinator's bundle before the first lease write and before freeing the reserve", async () => {
    const fixture = supervisorFixture('stale-desktop');
    const policy = writeRuntimePolicy(fixture, 'docker');
    createLease(fixture, policy);
    const daemon = ledgerResource(fixture, 'nested-daemon', 'container', 'nested-daemon', 'ic-dw-nested-daemon-3');
    const volume = ledgerResource(fixture, 'daemon-volume', 'volume', 'daemon-api', 'ic-dw-daemon-api-3');
    const agent = ledgerResource(fixture, 'agent', 'container', 'agent', 'ic-agent-3');
    activateDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation);
    const reservePath = createDockerWorkloadEmergencyReserve(fixture.directory, 64 * 1024);
    const outer = observeStops(statefulRuntime(fixture, [daemon, agent], [volume]), fixture, reservePath);
    const probe = {
      readRuntimeDisk: () => Promise.resolve({ availableBytes: 40 * 1024 ** 3, usedBytes: 20 * 1024 ** 3 }),
      measureVolumes: () => Promise.resolve(new Map([[volume.name, 0]])),
    };
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };

    // The coordinator never heartbeats: after 30 s the supervisor cleans up.
    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: outer.runtime,
      storageProbe: probe,
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        time.wallMs += milliseconds;
        time.monotonicMs += milliseconds;
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    });

    expect(outer.stops).toEqual([`${agent.name}:active:reserve=true`, `${daemon.name}:active:reserve=true`]);
    expect(outer.calls).toContain(`remove-volume:${volume.name}`);
    expect(existsSync(reservePath)).toBe(false);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    expect(loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath)).toMatchObject({
      state: 'closed',
      trip: null,
      detail: 'stale coordinator triggered exact cleanup',
    });
  });

  it('revokes on a trip whose detail is longer than the persisted status allows', async () => {
    const fixture = supervisorFixture('long-detail');
    const policy = writeRuntimePolicy(fixture, 'docker');
    createLease(fixture, policy);
    const daemon = ledgerResource(fixture, 'nested-daemon', 'container', 'nested-daemon', 'ic-dw-nested-daemon-4');
    const volume = ledgerResource(fixture, 'daemon-volume', 'volume', 'daemon-api', 'ic-dw-daemon-api-4');
    const outer = statefulRuntime(fixture, [daemon], [volume]);
    // A runtime CLI that panics answers with its whole stack trace.
    const trace = `panic: runtime error\n${'goroutine 1 [running]:\n'.repeat(1_000)}`;
    const probe = {
      readRuntimeDisk: () => Promise.reject(new Error(trace)),
      measureVolumes: () => Promise.resolve(new Map([[volume.name, 0]])),
    };
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };

    await runResourceWatchdogSupervisor({
      ...fixture.paths,
      runtime: outer.runtime,
      storageProbe: probe,
      now: () => new Date(time.wallMs),
      monotonicNow: () => time.monotonicMs,
      sleep: async (milliseconds) => {
        time.wallMs += milliseconds;
        time.monotonicMs += milliseconds;
        heartbeatIfLive(fixture, time.wallMs);
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      },
    });

    // The stale VM-disk reading tripped with the whole trace as its detail;
    // the status could not hold it, yet nothing stood in the way of revocation.
    expect(outer.calls).toEqual([`stop:${daemon.name}`, `remove:${daemon.name}`, `remove-volume:${volume.name}`]);
    expect(loadDockerWorkloadLease(fixture.paths.leasePath).status).toBe('closed');
    const status = loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath);
    expect(status).toMatchObject({ state: 'closed', trip: { code: 'sample-error' } });
    // Bounded like every incident detail: the head (what failed) and the tail
    // (the end of the trace) are kept around an omission marker, on one line.
    const detail = status.trip?.detail ?? '';
    expect(Array.from(detail).length).toBeLessThanOrEqual(MAX_INCIDENT_DETAIL_CODE_POINTS);
    expect(detail).toMatch(/^Docker Desktop VM disk reading has not completed for \d+ms: panic: /u);
    expect(detail).toMatch(/ \[\.\.\. \d+ characters omitted \.\.\.\] .*goroutine 1 \[running\]:$/u);
    expect(detail).not.toMatch(/\n/u);
  });
});

/** Record, at each container stop, the lease state and whether the emergency reserve is still held. */
function observeStops<T extends ReturnType<typeof statefulRuntime>>(
  outer: T,
  fixture: ReturnType<typeof supervisorFixture>,
  reservePath: string,
): T & { readonly stops: string[] } {
  const stops: string[] = [];
  const stop = outer.runtime.stop;
  outer.runtime.stop = (id: string) => {
    stops.push(`${id}:${leaseStatus(fixture)}:reserve=${existsSync(reservePath)}`);
    return stop(id);
  };
  return Object.assign(outer, { stops });
}

interface LedgeredFixtureResource {
  readonly requestId: string;
  readonly kind: 'container' | 'volume';
  readonly name: string;
}

function ledgerResource(
  fixture: ReturnType<typeof supervisorFixture>,
  requestId: string,
  kind: 'container' | 'volume',
  role: string,
  name: string,
): LedgeredFixtureResource {
  requestDockerWorkloadOuterResource(fixture.paths.leasePath, fixture.leaseOptions.generation, {
    requestId,
    kind,
    role,
    requestedName: name,
    ownershipLabelKey: OWNERSHIP_LABEL_KEY,
  });
  observeDockerWorkloadOuterResource(fixture.paths.leasePath, fixture.leaseOptions.generation, requestId, name);
  return { requestId, kind, name };
}

/** An outer runtime holding exactly the ledgered objects; records stop/remove calls. */
function statefulRuntime(
  fixture: ReturnType<typeof supervisorFixture>,
  containers: readonly LedgeredFixtureResource[],
  volumes: readonly LedgeredFixtureResource[],
) {
  const labels = { [OWNERSHIP_LABEL_KEY]: fixture.leaseOptions.generation };
  const liveContainers = new Set(containers.map((resource) => resource.name));
  const liveVolumes = new Set(volumes.map((resource) => resource.name));
  const calls: string[] = [];
  const runtime = {
    ...createMockDocker(),
    listContainers: () =>
      Promise.resolve(
        [...liveContainers].map((name) => ({ id: name, name, created: '', running: true, labels: { ...labels } })),
      ),
    listNetworks: () => Promise.resolve([]),
    listVolumes: () =>
      Promise.resolve(
        [...liveVolumes].map((name) => ({
          id: name,
          name,
          created: '',
          labels: { ...labels },
          driver: 'local',
          mountpoint: '/m',
        })),
      ),
    stop: (id: string) => {
      calls.push(`stop:${id}`);
      return Promise.resolve();
    },
    remove: (id: string) => {
      calls.push(`remove:${id}`);
      liveContainers.delete(id);
      return Promise.resolve();
    },
    removeVolume: (name: string) => {
      calls.push(`remove-volume:${name}`);
      liveVolumes.delete(name);
      return Promise.resolve();
    },
  };
  return { runtime, calls };
}

function writeRuntimePolicy(
  fixture: ReturnType<typeof supervisorFixture>,
  runtimeKind: 'docker' | 'apple-container',
): ResourceWatchdogPolicy {
  const stats = lstatSync(fixture.stateRoot);
  const template = loadFrozenWatchdogPolicyTemplate(resolve('config/docker-workload/resource-watchdog-policy.json'));
  const policy = buildRuntimeWatchdogPolicy(
    {
      ...template,
      softEvidenceBytes: 256 * 1024,
      hardSafetyBytes: 1024 * 1024,
      hostReserveBytes: 1,
      cleanupInventoryGapMs: 100,
    },
    runtimeKind,
    { root: fixture.stateRoot, device: stats.dev, inode: stats.ino },
  );
  writeFileSync(fixture.paths.policyPath, `${JSON.stringify(policy)}\n`, { mode: 0o400 });
  chmodSync(fixture.paths.policyPath, 0o400);
  return policy;
}

const OWNERSHIP_LABEL_KEY = 'com.ironcurtain.docker-workload.generation';

/** The shipped frozen timing: sample every 5s, time out at 5s, stale after 30s. */
const SHIPPED_TIMING = { sampleIntervalMs: 5_000, sampleTimeoutMs: 5_000, staleAfterMs: 30_000 } as const;
const ROOMY_THRESHOLDS = { softEvidenceBytes: 512 * 1024 * 1024, hardSafetyBytes: 1024 * 1024 * 1024 } as const;

interface BeforeRevocation {
  readonly leaseStatus: string;
  readonly supervisorStatus: ReturnType<typeof loadResourceWatchdogSupervisorStatus>;
}

function leaseStatus(fixture: ReturnType<typeof supervisorFixture>): string {
  return loadDockerWorkloadLease(fixture.paths.leasePath).status;
}

/** Heartbeat like a live coordinator; false once the lease no longer accepts heartbeats. */
function heartbeatIfLive(fixture: ReturnType<typeof supervisorFixture>, wallMs: number): boolean {
  const status = leaseStatus(fixture);
  if (status !== 'admitting' && status !== 'active') return false;
  heartbeatDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation, new Date(wallMs));
  return true;
}

/** Record what the supervisor had done on its own, then end the run the way a coordinator teardown starts. */
function revokeAsCoordinator(fixture: ReturnType<typeof supervisorFixture>, wallMs: number): BeforeRevocation {
  const before = {
    leaseStatus: leaseStatus(fixture),
    supervisorStatus: loadResourceWatchdogSupervisorStatus(fixture.paths.statusPath),
  };
  revokeDockerWorkloadLease(fixture.paths.leasePath, fixture.leaseOptions.generation, new Date(wallMs));
  return before;
}

function supervisorFixture(label: string, runtimeKind: 'docker' | 'apple-container' = 'docker') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `watchdog-supervisor-${label}-`)));
  temporaryDirectories.push(directory);
  const stateRoot = join(directory, 'state');
  mkdirSync(stateRoot);
  const leaseOptions: Omit<CreateDockerWorkloadLeaseOptions, 'bindings'> = {
    leaseId: `lease-${label}-001`,
    bundleId: `bundle-${label}-001`,
    generation: `generation-${label}-001`,
    runtimeKind,
    ...(runtimeKind === 'docker' ? { dockerEndpoint: { host: 'unix:///var/run/docker.sock' } } : {}),
    paths: {
      workspaceRoot: join(directory, 'workspace'),
      stateRoot,
      runtimeRoot: join(stateRoot, 'runtime'),
      apiRoot: join(stateRoot, 'api'),
      exchangeRoot: join(stateRoot, 'exchange'),
      stagingRoot: join(stateRoot, 'staging'),
    },
    cleanupInventoryGapMs: 100,
    now: new Date('2026-07-20T12:00:00.000Z'),
  };
  return {
    directory,
    stateRoot,
    leaseOptions,
    paths: {
      leasePath: join(directory, 'lease.json'),
      policyPath: join(directory, 'policy.json'),
      statusPath: join(directory, 'status.json'),
      stopRequestPath: join(directory, 'stop.json'),
    },
  };
}

function writePolicy(
  fixture: ReturnType<typeof supervisorFixture>,
  thresholds: Pick<ResourceWatchdogPolicy, 'softEvidenceBytes' | 'hardSafetyBytes'> &
    Partial<Pick<ResourceWatchdogPolicy, 'sampleIntervalMs' | 'sampleTimeoutMs' | 'staleAfterMs'>>,
): { readonly policy: ResourceWatchdogPolicy; readonly sha256: string } {
  const stats = lstatSync(fixture.stateRoot);
  const policy: ResourceWatchdogPolicy = {
    schemaVersion: 1,
    policyId: 'apple-observed-disk-v1',
    targetRoot: fixture.stateRoot,
    targetDevice: stats.dev,
    targetInode: stats.ino,
    stateClasses: [{ id: 'daemon-state', relativePath: 'daemon', kind: 'directory', required: true }],
    sampleIntervalMs: 100,
    sampleTimeoutMs: 100,
    staleAfterMs: 300,
    ...thresholds,
    hostReserveBytes: 1,
    maximumOvershootBytes: 1024 * 1024,
    cleanupInventoryGapMs: 100,
  };
  const bytes = Buffer.from(`${JSON.stringify(policy)}\n`);
  writeFileSync(fixture.paths.policyPath, bytes, { mode: 0o400 });
  chmodSync(fixture.paths.policyPath, 0o400);
  return { policy, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function createLease(fixture: ReturnType<typeof supervisorFixture>, watchdogPolicy: ResourceWatchdogPolicy): void {
  createDockerWorkloadLease(fixture.paths.leasePath, {
    ...fixture.leaseOptions,
    bindings: { watchdogPolicy },
  });
}

function emptyRuntime() {
  return {
    ...createMockDocker(),
    async listContainers() {
      return [];
    },
    async listNetworks() {
      return [];
    },
  };
}

async function waitForReady(path: string) {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      const status = loadResourceWatchdogSupervisorStatus(path);
      if (status.state === 'ready') return status;
    } catch {
      // Atomic status file may not exist yet.
    }
    if (Date.now() >= deadline) throw new Error('watchdog supervisor did not become ready');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function waitForStatus(
  path: string,
  predicate: (status: ReturnType<typeof loadResourceWatchdogSupervisorStatus>) => boolean,
) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const status = loadResourceWatchdogSupervisorStatus(path);
    if (predicate(status)) return status;
    if (Date.now() >= deadline) {
      throw new Error(`watchdog supervisor did not publish the expected status: ${JSON.stringify(status)}`);
    }
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
}

function releaseOptionalClaim(claim: { release(): void } | undefined): void {
  claim?.release();
}
