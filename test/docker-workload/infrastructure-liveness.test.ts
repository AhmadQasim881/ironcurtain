/**
 * The coordinator's watch over its detached supervisor across host sleep and
 * clock steps: liveness is judged by when the coordinator saw the supervisor's
 * status change on its own monotonic clock, never by wall-clock age.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admitDockerWorkloadBundle,
  type DockerWorkloadBundleHandle,
  type WatchdogSupervisorController,
} from '../../src/docker-workload/infrastructure.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import {
  createRecordingDockerWorkloadAuditSink,
  type DockerWorkloadAuditSink,
} from '../../src/docker-workload/lifecycle-evidence.js';
import type { ResourceWatchdogSupervisorStatus } from '../../src/docker-workload/resource-watchdog-supervisor.js';
import {
  ADMISSION_CONFIGURATION,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeSupervisor,
  useDockerWorkloadHome,
  type EventRuntime,
} from './helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();

interface Timeline {
  wallMs: number;
  monotonicMs: number;
}

function advance(time: Timeline, milliseconds: number): void {
  time.wallMs += milliseconds;
  time.monotonicMs += milliseconds;
}

/** A bound supervisor whose last published status time the test controls. */
interface ScriptedSupervisor extends WatchdogSupervisorController {
  publish(atWallMs: number): void;
}

function scriptedSupervisor(time: Timeline): ScriptedSupervisor {
  const base = createFakeSupervisor({ clock: () => new Date(time.wallMs), closeLeaseOnStop: true });
  let attested: ResourceWatchdogSupervisorStatus | undefined;
  let publishedAtMs = time.wallMs;
  let stopped = false;
  return {
    ...base,
    async launch(options) {
      const launched = await base.launch(options);
      attested = launched.status;
      publishedAtMs = Date.parse(launched.status.updatedAt);
      return launched;
    },
    readStatus() {
      if (attested === undefined) return undefined;
      if (stopped) return { ...attested, state: 'closed' };
      return {
        ...attested,
        updatedAt: new Date(publishedAtMs).toISOString(),
        lastSample: { sampledAtMs: publishedAtMs, availableBytes: 100_000_000_000, allocatedBytes: 4096 },
      };
    },
    requestStop(stopRequestPath, lease, cleanup, now) {
      base.requestStop(stopRequestPath, lease, cleanup, now);
      stopped = true;
    },
    publish(atWallMs) {
      publishedAtMs = atWallMs;
    },
  };
}

async function bringUp(
  time: Timeline,
  runtime: EventRuntime,
  supervisor: ScriptedSupervisor,
  auditSink?: DockerWorkloadAuditSink,
  afterSleep?: () => void,
): Promise<DockerWorkloadBundleHandle> {
  const handle = await admitDockerWorkloadBundle({
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    bundleId: 'bundle-liveness-001',
    workspaceRoot: join(getHome(), 'workspace'),
    configuration: ADMISSION_CONFIGURATION,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    auditSink,
    clock: () => new Date(time.wallMs),
    monotonicClock: () => time.monotonicMs,
    sleep: async (milliseconds) => {
      advance(time, milliseconds);
      afterSleep?.();
    },
    pidAlive: () => true,
    supervisor,
    startHeartbeat: false,
  });
  runtime.setLeasePath(handle.leasePath);
  await handle.attestWatchdog();
  const requestedName = 'nested-daemon-test';
  const grant = handle.precommitOuterResource({ kind: 'container', role: 'nested-daemon', requestedName });
  const containerId = await runtime.runtime.create({
    name: requestedName,
    image: 'ironcurtain-nested-daemon',
    mounts: [],
    network: 'none',
    env: {},
    command: [],
    labels: grant.labels,
  });
  grant.observed(containerId);
  await handle.activate();
  return handle;
}

describe('Docker-workload coordinator watch over its supervisor', () => {
  it('keeps the bundle when the wall clock jumps 10 minutes while the monotonic clock stands still', async () => {
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    const runtime = createEventRuntime();
    const supervisor = scriptedSupervisor(time);
    const handle = await bringUp(time, runtime, supervisor);
    advance(time, 5_000);
    supervisor.publish(time.wallMs);
    await handle.pollSupervisorHealth();

    time.wallMs += 10 * 60_000;
    await handle.pollSupervisorHealth();
    handle.assertWatchdogFresh();

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');
    expect(runtime.events.filter((event) => event.startsWith('remove:'))).toEqual([]);
  });

  it('gives the supervisor a fresh window after the monitor itself was paused, then tears down a watched silence', async () => {
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    const runtime = createEventRuntime();
    const supervisor = scriptedSupervisor(time);
    const sink = createRecordingDockerWorkloadAuditSink();
    const handle = await bringUp(time, runtime, supervisor, sink);

    // Host sleep on a VM whose monotonic clock counts the pause: nothing ran
    // and nothing published, so the monitor cannot blame the supervisor.
    advance(time, 60_000);
    await handle.pollSupervisorHealth();
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');
    // A gate still needs positive evidence of progress; lateness grants none.
    expect(() => handle.assertWatchdogFresh()).toThrow(/watchdog supervisor heartbeat is stale/u);

    // The supervisor stays silent while the monitor watches every interval.
    for (let watchedMs = 5_000; watchedMs < 30_000; watchedMs += 5_000) {
      advance(time, 5_000);
      await handle.pollSupervisorHealth();
      expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');
    }
    advance(time, 5_000);
    await handle.pollSupervisorHealth();

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('closed');
    expect(sink.events).toContainEqual(
      expect.objectContaining({ kind: 'incident', code: 'watchdog-supervisor-unhealthy' }),
    );
  });

  it('accepts the next published status after a long unobserved interval', async () => {
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    const runtime = createEventRuntime();
    const supervisor = scriptedSupervisor(time);
    const handle = await bringUp(time, runtime, supervisor);

    advance(time, 60_000);
    supervisor.publish(time.wallMs);
    handle.assertWatchdogFresh();
    await handle.pollSupervisorHealth();

    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('active');
  });

  it('waits for the next sample after a long gated create instead of failing on one that predates it', async () => {
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    const runtime = createEventRuntime();
    const supervisor = scriptedSupervisor(time);
    let createFinished = false;
    let polls = 0;
    const handle = await bringUp(time, runtime, supervisor, undefined, () => {
      if (!createFinished) return;
      polls += 1;
      // The supervisor takes the lifecycle claim back and publishes its next sample.
      if (polls === 3) supervisor.publish(time.wallMs);
    });
    advance(time, 1_000);

    const created = await handle.withOuterCreateClaim(async () => {
      // A sample finished while this create waited for the claim: it is newer
      // than the baseline read before the wait, and the pre-create gate is the
      // first to see it. The long create then excludes sampling for a minute.
      supervisor.publish(time.wallMs);
      handle.assertWatchdogFresh();
      advance(time, 60_000);
      createFinished = true;
      return 'created';
    });

    expect(created).toBe('created');
    expect(polls).toBe(3);
  });

  it('accepts a post-create sample dated before its baseline after a backward wall-clock step', async () => {
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    const runtime = createEventRuntime();
    const supervisor = scriptedSupervisor(time);
    let createFinished = false;
    let polls = 0;
    const handle = await bringUp(time, runtime, supervisor, undefined, () => {
      if (!createFinished) return;
      polls += 1;
      if (polls === 2) supervisor.publish(time.wallMs);
    });
    advance(time, 1_000);

    const created = await handle.withOuterCreateClaim(async () => {
      handle.assertWatchdogFresh();
      advance(time, 60_000);
      // The wall clock steps back an hour while the create runs, so the next
      // real sample carries an earlier timestamp than the pre-create baseline.
      time.wallMs -= 60 * 60_000;
      createFinished = true;
      return 'created';
    });

    expect(created).toBe('created');
    expect(polls).toBe(2);
  });

  it('fails a long create only after one stale window without a newer sample', async () => {
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    const runtime = createEventRuntime();
    const supervisor = scriptedSupervisor(time);
    const handle = await bringUp(time, runtime, supervisor);
    advance(time, 1_000);
    let createdAtMonotonicMs = 0;

    await expect(
      handle.withOuterCreateClaim(async () => {
        supervisor.publish(time.wallMs);
        handle.assertWatchdogFresh();
        advance(time, 60_000);
        createdAtMonotonicMs = time.monotonicMs;
      }),
    ).rejects.toThrow(/did not publish a fresh sample after outer create/u);
    expect(time.monotonicMs - createdAtMonotonicMs).toBeGreaterThanOrEqual(handle.loadedPolicy.policy.staleAfterMs);
  });
});
