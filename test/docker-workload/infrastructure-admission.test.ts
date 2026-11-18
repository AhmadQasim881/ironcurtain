import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admitDockerWorkloadBundle,
  DockerWorkloadAdmissionBusyError,
  DockerWorkloadAdmissionFencedError,
  reconcileDockerWorkloadLeases,
  type DockerWorkloadAdmissionOptions,
} from '../../src/docker-workload/infrastructure.js';
import { labelledContainer, seedDockerWorkloadLease } from './helpers/seed-lease.js';
import {
  getDockerWorkloadLeaseDir,
  getDockerWorkloadRoot,
  getDockerWorkloadStateRoot,
} from '../../src/config/paths.js';
import { loadDockerWorkloadLease, revokeDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import { tryAcquireDockerWorkloadLifecycleClaim } from '../../src/docker-workload/cleanup-ownership.js';
import { createRecordingDockerWorkloadAuditSink } from '../../src/docker-workload/lifecycle-evidence.js';
import { DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE } from '../../src/docker-workload/emergency-reserve.js';
import { DOCKER_WORKLOAD_EMERGENCY_RESERVE_BYTES } from '../../src/docker-workload/watchdog-policy.js';
import {
  ADMISSION_CONFIGURATION,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  useDockerWorkloadHome,
  type EventRuntime,
  type FakeClock,
  type FakeSupervisor,
} from './helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();

function baseOptions(
  clock: FakeClock,
  runtime: EventRuntime,
  supervisor: FakeSupervisor,
  auditSink?: DockerWorkloadAdmissionOptions['auditSink'],
): DockerWorkloadAdmissionOptions {
  return {
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    bundleId: 'bundle-admission-001',
    workspaceRoot: join(getHome(), 'workspace'),
    configuration: ADMISSION_CONFIGURATION,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    auditSink,
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor,
    startHeartbeat: false,
  };
}

describe('Docker-workload admission (§8.2 order)', () => {
  it('validates the watchdog template before creating lease-specific directories', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const leaseId = 'dw-invalid-template';

    await expect(
      admitDockerWorkloadBundle({
        ...baseOptions(clock, runtime, supervisor),
        leaseId,
        watchdogPolicyTemplatePath: join(getHome(), 'missing-watchdog-policy.json'),
      }),
    ).rejects.toThrow();

    expect(existsSync(getDockerWorkloadLeaseDir(leaseId))).toBe(false);
    expect(existsSync(getDockerWorkloadStateRoot(leaseId))).toBe(false);
  });

  it('preallocates the emergency reserve beside the lease', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor));
    const reserve = lstatSync(join(getDockerWorkloadLeaseDir(handle.leaseId), DOCKER_WORKLOAD_EMERGENCY_RESERVE_FILE));
    expect(reserve.isFile()).toBe(true);
    expect(reserve.size).toBe(DOCKER_WORKLOAD_EMERGENCY_RESERVE_BYTES);
    expect(reserve.mode & 0o777).toBe(0o600);
    expect(handle.loadedPolicy.policy).toMatchObject({ schemaVersion: 2, runtimeKind: 'docker' });
  });

  it('refuses a runtime the frozen policy gives no storage coverage before creating lease state', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const leaseId = 'dw-uncovered-runtime';
    await expect(
      admitDockerWorkloadBundle({
        ...baseOptions(clock, runtime, supervisor),
        leaseId,
        watchdogPolicyTemplatePath: resolve('test/docker-workload/fixtures/watchdog-policy-apple-only.json'),
      }),
    ).rejects.toThrow(/no storage coverage for the docker runtime/u);
    expect(existsSync(getDockerWorkloadLeaseDir(leaseId))).toBe(false);
    expect(existsSync(getDockerWorkloadStateRoot(leaseId))).toBe(false);
  });

  it('binds an Apple VM rootfs image at create and records its activation baseline', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const handle = await admitDockerWorkloadBundle({
      ...baseOptions(clock, runtime, supervisor),
      runtimeKind: 'apple-container',
    });
    runtime.setLeasePath(handle.leasePath);
    await handle.attestWatchdog();
    const grant = handle.precommitOuterResource({ kind: 'container', role: 'agent', requestedName: 'ic-agent-vm' });
    const id = await runtime.runtime.create({
      name: 'ic-agent-vm',
      image: 'ironcurtain-claude-code',
      mounts: [],
      network: 'none',
      env: {},
      command: [],
      labels: grant.labels,
    });
    grant.observed(id);
    await grant.bindStorage();
    const bound = loadDockerWorkloadLease(handle.leasePath).resources[0]?.storage;
    expect(bound).toMatchObject({ kind: 'host-file', baselineAllocatedBytes: null });
    // The bootstrap grows the image before release; the baseline is taken at activation.
    writeFileSync(bound?.path ?? '', Buffer.alloc(64 * 1024, 9), { flag: 'a' });

    await handle.activate();
    const activated = loadDockerWorkloadLease(handle.leasePath).resources[0]?.storage;
    expect(activated?.baselineAllocatedBytes).toBe(lstatSync(bound?.path ?? '').blocks * 512);
    expect(activated?.baselineAllocatedBytes).toBeGreaterThanOrEqual(64 * 1024);
  });

  it('fails closed when an Apple runtime cannot locate container storage', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    delete (runtime.runtime as { describeContainerStorage?: unknown }).describeContainerStorage;
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const handle = await admitDockerWorkloadBundle({
      ...baseOptions(clock, runtime, supervisor),
      runtimeKind: 'apple-container',
    });
    await handle.attestWatchdog();
    const grant = handle.precommitOuterResource({ kind: 'container', role: 'agent', requestedName: 'ic-agent-vm' });
    grant.observed('ic-agent-vm');
    await expect(grant.bindStorage()).rejects.toThrow(/cannot locate container storage/u);
    await expect(handle.activate()).rejects.toThrow(/cannot measure the storage of ic-agent-vm/u);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });

  it('ledgers before create, attests the watchdog before the nested-daemon create, and observes before use', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const sink = createRecordingDockerWorkloadAuditSink();
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor, sink));
    runtime.setLeasePath(handle.leasePath);

    const status = await handle.attestWatchdog();
    expect(status.state).toBe('ready');
    handle.assertWatchdogFresh();
    expect(runtime.events).toEqual([]);

    const requestedName = 'nested-daemon-test';
    const grant = handle.precommitOuterResource({ kind: 'container', role: 'nested-daemon', requestedName });
    const ledgered = loadDockerWorkloadLease(handle.leasePath).resources;
    expect(ledgered).toHaveLength(1);
    expect(ledgered[0]).toMatchObject({ requestedName, observedId: null });
    expect(runtime.events).toEqual([]);

    const containerId = await runtime.runtime.create({
      name: requestedName,
      image: 'ironcurtain-nested-daemon',
      mounts: [],
      network: 'none',
      env: {},
      command: [],
      labels: grant.labels,
    });
    grant.observed(containerId, { args: ['create', requestedName] });
    expect(loadDockerWorkloadLease(handle.leasePath).resources[0].observedId).toBe(containerId);

    await runtime.runtime.start(containerId);
    await handle.activate();
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');

    expect(sink.events.map((event) => event.kind)).toEqual([
      'admission-decision',
      'watchdog-attested',
      'outer-create',
      'lease-transition',
    ]);
  });

  it('aborts admission on watchdog attestation failure, leaving a reconcilable lease and no created resources', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, launch: 'throw' });
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor));
    runtime.setLeasePath(handle.leasePath);

    await expect(handle.attestWatchdog()).rejects.toThrow(/incident|attestation/u);
    expect(runtime.events).toEqual([]);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');

    const reconcileClock = createFakeClock('2026-07-20T13:00:00.000Z');
    const reconciliation = await reconcileDockerWorkloadLeases({
      runtime: runtime.runtime,
      runtimeKind: 'docker',
      clock: reconcileClock.clock,
      sleep: reconcileClock.sleep,
      pidAlive: () => true,
      supervisor: createFakeSupervisor({ clock: reconcileClock.clock, statusMode: 'absent' }),
    });
    expect(reconciliation.reconciled).toEqual([handle.leaseId]);
    expect(reconciliation.fenced).toEqual([]);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
  });

  it('keeps an append-only registry-pull provenance log in the lease evidence that outlives teardown', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor));
    const digest = `sha256:${'c'.repeat(64)}`;

    handle.recordRegistryPull({
      originId: 'docker-hub',
      operation: 'manifest-pull',
      method: 'GET',
      destination: { hostname: 'registry-1.docker.io', port: 443 },
      status: 200,
      repository: 'library/alpine',
      reference: digest,
      requestedDigest: digest,
      resolvedDigest: digest,
      sizeBytes: 1024,
    });
    await handle.teardown();

    expect(handle.registryPullProvenancePath).toBe(
      join(getDockerWorkloadLeaseDir(handle.leaseId), 'evidence', 'registry-pull-provenance.jsonl'),
    );
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    const lines = readFileSync(handle.registryPullProvenancePath, 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        kind: 'registry-pull',
        leaseId: handle.leaseId,
        generation: handle.generation,
        bundleId: 'bundle-admission-001',
        requestedDigest: digest,
        resolvedDigest: digest,
      }),
    ]);
  });

  it('rejects activation while any requested outer resource is unobserved', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor));
    await handle.attestWatchdog();
    handle.precommitOuterResource({
      kind: 'container',
      role: 'nested-daemon',
      requestedName: 'nested-daemon-test',
    });
    await expect(handle.activate()).rejects.toThrow(/before every requested outer resource is observed/u);
  });

  it('cannot release the agent when cleanup wins the activation lifecycle claim', async () => {
    let currentMs = Date.parse('2026-07-20T12:00:00.000Z');
    let releaseCleanupClaim: (() => void) | undefined;
    const clock: FakeClock = {
      clock: () => new Date(currentMs),
      sleep: async (milliseconds) => {
        currentMs += milliseconds;
        releaseCleanupClaim?.();
        releaseCleanupClaim = undefined;
      },
      advance: (milliseconds) => {
        currentMs += milliseconds;
      },
    };
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const handle = await admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor));
    runtime.setLeasePath(handle.leasePath);
    await handle.attestWatchdog();
    const requestedName = 'nested-daemon-test';
    const grant = handle.precommitOuterResource({ kind: 'container', role: 'nested-daemon', requestedName });
    const id = await runtime.runtime.create({
      name: requestedName,
      image: 'nested-daemon',
      mounts: [],
      network: 'none',
      env: {},
      command: [],
      labels: grant.labels,
    });
    grant.observed(id);
    const cleanupClaim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: handle.leasePath });
    releaseCleanupClaim = () => {
      revokeDockerWorkloadLease(handle.leasePath, handle.generation, clock.clock());
      cleanupClaim.release();
    };
    let agentReleased = false;

    await expect(
      (async () => {
        await handle.activate();
        agentReleased = true;
      })(),
    ).rejects.toThrow(/revoking.*activation is rejected/u);

    expect(agentReleased).toBe(false);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('revoking');
    await handle.teardown();
  });
});

describe('Docker-workload admission lock steal race', () => {
  const DEAD_OWNER_PID = 999_001;
  const LIVE_RACER_PID = 999_002;
  const SELF_IDENTITY = 'self-test-process-start';
  const DEAD_IDENTITY = 'dead-test-process-start';
  const LIVE_IDENTITY = 'live-racer-process-start';

  function lockOwner(pid: number, processIdentity: string, token: string) {
    return { schemaVersion: 1, pid, processIdentity, token, createdAtMs: Date.now() } as const;
  }

  function seedAdmissionLock(pid: number, processIdentity: string, token: string): string {
    const root = getDockerWorkloadRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const lockPath = join(root, 'admission.lock');
    writeFileSync(lockPath, `${JSON.stringify(lockOwner(pid, processIdentity, token))}\n`, { mode: 0o600 });
    return lockPath;
  }

  it('reclaims a stale lock whose owner is dead and proceeds with admission', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    seedAdmissionLock(DEAD_OWNER_PID, DEAD_IDENTITY, '00000000-0000-4000-8000-000000000001');

    const handle = await admitDockerWorkloadBundle({
      ...baseOptions(clock, runtime, supervisor),
      processIdentityForPid: (pid) => (pid === process.pid ? SELF_IDENTITY : undefined),
    });

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });

  it("does not delete a racer's freshly created live lock during a raced steal (reports busy)", async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const lockPath = seedAdmissionLock(DEAD_OWNER_PID, DEAD_IDENTITY, '00000000-0000-4000-8000-000000000002');

    // The moment we test the dead owner's liveness, a racer reclaims the stale
    // lock and installs its own LIVE lock. The reclaim must detect this and
    // leave the racer's lock intact rather than stealing it.
    let collided = false;
    const processIdentityForPid = (pid: number): string | undefined => {
      if (pid === process.pid) return SELF_IDENTITY;
      if (pid === DEAD_OWNER_PID) {
        if (!collided) {
          collided = true;
          writeFileSync(
            lockPath,
            `${JSON.stringify(lockOwner(LIVE_RACER_PID, LIVE_IDENTITY, '00000000-0000-4000-8000-000000000003'))}\n`,
            { mode: 0o600 },
          );
        }
        return undefined;
      }
      return pid === LIVE_RACER_PID ? LIVE_IDENTITY : undefined;
    };

    await expect(
      admitDockerWorkloadBundle({ ...baseOptions(clock, runtime, supervisor), processIdentityForPid }),
    ).rejects.toThrow(/is busy/u);

    // The racer's live lock survived — it was never stolen or deleted.
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: LIVE_RACER_PID });
  });
});

describe('Docker-workload admission waits instead of failing busy', () => {
  const FOREIGN_PID = 999_003;
  const SELF_IDENTITY = 'admitting-process';
  const FOREIGN_IDENTITY = 'foreign-admitting-process';

  function seedForeignAdmissionLock(): string {
    const root = getDockerWorkloadRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const lockPath = join(root, 'admission.lock');
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: FOREIGN_PID,
        processIdentity: FOREIGN_IDENTITY,
        token: '00000000-0000-4000-8000-000000000009',
        createdAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    return lockPath;
  }

  /** Real event-loop turns, so concurrent admissions interleave as they would in production. */
  function yieldingClock(): FakeClock {
    const clock = createFakeClock();
    return {
      ...clock,
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      },
    };
  }

  it('admits two overlapping starts in one process one after the other', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });

    const [first, second] = await Promise.all([
      admitDockerWorkloadBundle({ ...baseOptions(clock, runtime, supervisor), leaseId: 'dw-overlap-a' }),
      admitDockerWorkloadBundle({ ...baseOptions(clock, runtime, supervisor), leaseId: 'dw-overlap-b' }),
    ]);

    expect([first.leaseId, second.leaseId]).toEqual(['dw-overlap-a', 'dw-overlap-b']);
    expect(loadDockerWorkloadLease(first.leasePath).status).toBe('admitting');
    expect(loadDockerWorkloadLease(second.leasePath).status).toBe('admitting');
    expect(existsSync(join(getDockerWorkloadRoot(), 'admission.lock'))).toBe(false);
  });

  it("waits for another process's admission critical section and names its holder once", async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    const lockPath = seedForeignAdmissionLock();
    const notices: string[] = [];
    let polls = 0;

    const handle = await admitDockerWorkloadBundle({
      ...baseOptions(clock, runtime, supervisor),
      processIdentityForPid: (pid) =>
        pid === process.pid
          ? SELF_IDENTITY
          : pid === FOREIGN_PID && existsSync(lockPath)
            ? FOREIGN_IDENTITY
            : undefined,
      onAdmissionWait: (message) => notices.push(message),
      sleep: async (milliseconds) => {
        clock.advance(milliseconds);
        polls += 1;
        // The other process finishes its short critical section.
        if (polls === 3) rmSync(lockPath);
      },
    });

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
    expect(polls).toBe(3);
    expect(notices).toEqual([expect.stringContaining(`held by pid ${FOREIGN_PID}`)]);
  });

  it('gives up as busy, naming the holder, once the bounded wait is spent', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock });
    seedForeignAdmissionLock();

    const admission = admitDockerWorkloadBundle({
      ...baseOptions(clock, runtime, supervisor),
      processIdentityForPid: (pid) =>
        pid === process.pid ? SELF_IDENTITY : pid === FOREIGN_PID ? FOREIGN_IDENTITY : undefined,
      admissionWaitMs: 1_000,
      onAdmissionWait: () => {},
    });

    await expect(admission).rejects.toBeInstanceOf(DockerWorkloadAdmissionBusyError);
    await expect(admission).rejects.toThrow(`admission is busy (owner pid ${FOREIGN_PID}) after waiting 1s`);
  });

  it('recovers a stale lease outside the global lock while an overlapping start waits for that recovery', async () => {
    const clock = yieldingClock();
    const seeded = seedDockerWorkloadLease({
      home: getHome(),
      leaseId: 'dw-crashed',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      containers: [{ name: 'ic-crashed-daemon', id: 'crashed-daemon-id' }],
    });
    const runtime = createEventRuntime({
      containers: [labelledContainer('crashed-daemon-id', 'ic-crashed-daemon', seeded.generation)],
    });
    let reachedStop: () => void = () => {};
    const stopReached = new Promise<void>((resolveStop) => {
      reachedStop = resolveStop;
    });
    let finishStop: () => void = () => {};
    const stopFinished = new Promise<void>((resolveStop) => {
      finishStop = resolveStop;
    });
    const stop = runtime.runtime.stop.bind(runtime.runtime);
    runtime.runtime.stop = async (id: string) => {
      reachedStop();
      await stopFinished;
      await stop(id);
    };
    const supervisor = createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' });
    const options = (leaseId: string): DockerWorkloadAdmissionOptions => ({
      ...baseOptions(clock, runtime, supervisor),
      leaseId,
      // The recorded coordinator is a different (dead) process start.
      processIdentityForPid: (pid) => (pid === process.pid ? SELF_IDENTITY : undefined),
    });

    const first = admitDockerWorkloadBundle(options('dw-first'));
    await stopReached;
    // Mid-recovery: the lease is being revoked under its own lifecycle claim,
    // and the global admission lock is not held.
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('revoking');
    expect(existsSync(join(getDockerWorkloadRoot(), 'admission.lock'))).toBe(false);

    const second = admitDockerWorkloadBundle(options('dw-second'));
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    finishStop();

    const [firstHandle, secondHandle] = await Promise.all([first, second]);
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('closed');
    expect(runtime.containers.map((container) => container.id)).toEqual([]);
    expect(loadDockerWorkloadLease(firstHandle.leasePath).status).toBe('admitting');
    expect(loadDockerWorkloadLease(secondHandle.leasePath).status).toBe('admitting');
  });

  it('names each fencing lease and the operator remediation in the refusal', async () => {
    const clock = createFakeClock();
    seedDockerWorkloadLease({
      home: getHome(),
      leaseId: 'dw-unrecoverable',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      containers: [{ name: 'ic-lost-daemon', id: 'lost-daemon-id' }],
      incident: { code: 'docker-workload-cleanup-failed', detail: 'Docker Desktop stopped during teardown' },
    });
    const runtime = createEventRuntime();
    runtime.runtime.listContainers = () => Promise.reject(new Error('Cannot connect to the Docker daemon'));
    const supervisor = createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' });

    const admission = admitDockerWorkloadBundle(baseOptions(clock, runtime, supervisor));

    await expect(admission).rejects.toBeInstanceOf(DockerWorkloadAdmissionFencedError);
    await expect(admission).rejects.toMatchObject({ leaseIds: ['dw-unrecoverable'] });
    await expect(admission).rejects.toThrow(
      /dw-unrecoverable \(original incident docker-workload-cleanup-failed .*Cannot connect to the Docker daemon\).*ironcurtain docker-workload status.*ironcurtain docker-workload clear <lease-id> --force/u,
    );
  });
});
