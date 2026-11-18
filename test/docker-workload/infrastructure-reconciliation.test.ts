import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admitDockerWorkloadBundle,
  reconcileDockerWorkloadLeases,
  DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
  type DockerWorkloadAdmissionOptions,
  type ReconcileDockerWorkloadOptions,
  type WatchdogSupervisorController,
} from '../../src/docker-workload/infrastructure.js';
import type { ResourceWatchdogSupervisorStatus } from '../../src/docker-workload/resource-watchdog-supervisor.js';
import {
  activateDockerWorkloadLease,
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recoverDockerWorkloadLeaseIncident,
  recordDockerWorkloadLeaseIncident,
  requestDockerWorkloadOuterResource,
} from '../../src/docker-workload/bundle-lease.js';
import { getDockerWorkloadLeaseDir, getDockerWorkloadStateRoot } from '../../src/config/paths.js';
import { loadFrozenWatchdogPolicyTemplate, renderWatchdogPolicy } from '../../src/docker-workload/watchdog-policy.js';
import { createRecordingDockerWorkloadAuditSink } from '../../src/docker-workload/lifecycle-evidence.js';
import { tryAcquireDockerWorkloadLifecycleClaim } from '../../src/docker-workload/cleanup-ownership.js';
import type { DockerContainerInfo } from '../../src/docker/types.js';
import {
  createLegacyDockerWorkloadLease,
  createVersion2DockerWorkloadLease,
} from '../helpers/legacy-docker-workload-lease.js';
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
} from './helpers/infrastructure-harness.js';

const KEY = DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY;
const getHome = useDockerWorkloadHome();

interface SeedResource {
  readonly requestId: string;
  readonly kind: 'container' | 'network';
  readonly role: 'agent' | 'nested-daemon' | 'fixed-relay' | 'proxy' | 'network' | 'transport-network';
  readonly name: string;
  readonly observedId?: string;
}

function seedLease(options: {
  readonly leaseId: string;
  readonly heartbeatIso: string;
  readonly runtimeKind?: 'docker' | 'apple-container';
  readonly resources?: readonly SeedResource[];
  readonly activate?: boolean;
  readonly schemaVersion?: 1 | 2 | 3;
}): { readonly leaseId: string; readonly leasePath: string; readonly generation: string } {
  const { leaseId } = options;
  const stateRoot = getDockerWorkloadStateRoot(leaseId);
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (const subdir of ['daemon', 'api', 'exchange', 'staging']) {
    mkdirSync(join(stateRoot, subdir), { recursive: true, mode: 0o700 });
  }
  const leaseDir = getDockerWorkloadLeaseDir(leaseId);
  mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
  const template = loadFrozenWatchdogPolicyTemplate(WATCHDOG_TEMPLATE_PATH);
  const loadedPolicy = renderWatchdogPolicy(
    template,
    options.runtimeKind ?? 'docker',
    stateRoot,
    join(leaseDir, 'policy.json'),
  );
  const generation = `gen-${leaseId}`;
  const now = new Date(options.heartbeatIso);
  const leasePath = join(leaseDir, 'lease.json');
  const leaseOptions = {
    leaseId,
    bundleId: `bundle-${leaseId}`,
    generation,
    runtimeKind: options.runtimeKind ?? 'docker',
    paths: {
      workspaceRoot: join(getHome(), 'workspace'),
      stateRoot,
      runtimeRoot: join(stateRoot, 'daemon'),
      apiRoot: join(stateRoot, 'api'),
      exchangeRoot: join(stateRoot, 'exchange'),
      stagingRoot: join(stateRoot, 'staging'),
    },
    cleanupInventoryGapMs: loadedPolicy.policy.cleanupInventoryGapMs,
    coordinatorPid: process.pid,
    now,
  };
  const currentOptions = {
    ...leaseOptions,
    dockerEndpoint: leaseOptions.runtimeKind === 'docker' ? { host: 'unix:///var/run/docker.sock' } : undefined,
    bindings: { watchdogPolicy: loadedPolicy.policy },
  };
  if (options.schemaVersion === 1) {
    createLegacyDockerWorkloadLease(leasePath, {
      ...leaseOptions,
      bindings: { watchdogPolicySha256: loadedPolicy.sha256 },
    });
  } else if (options.schemaVersion === 2) {
    createVersion2DockerWorkloadLease(leasePath, currentOptions);
  } else createDockerWorkloadLease(leasePath, currentOptions);
  for (const resource of options.resources ?? []) {
    requestDockerWorkloadOuterResource(
      leasePath,
      generation,
      {
        requestId: resource.requestId,
        kind: resource.kind,
        role: resource.role,
        requestedName: resource.name,
        ownershipLabelKey: KEY,
      },
      now,
    );
    if (resource.observedId !== undefined) {
      observeDockerWorkloadOuterResource(leasePath, generation, resource.requestId, resource.observedId, now);
    }
  }
  if (options.activate) activateDockerWorkloadLease(leasePath, generation, now);
  return { leaseId, leasePath, generation };
}

function reconcileOptions(runtime: EventRuntime, clock: FakeClock): ReconcileDockerWorkloadOptions {
  return {
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
  };
}

interface Timeline {
  wallMs: number;
  monotonicMs: number;
}

/**
 * Separate wall and monotonic clocks for the reconciler. `beforeSleep` runs at
 * each sleep before time advances, so it observes the state the pass left.
 */
function timedReconcileOptions(
  runtime: EventRuntime,
  time: Timeline,
  beforeSleep?: () => void,
): ReconcileDockerWorkloadOptions {
  const clock = (): Date => new Date(time.wallMs);
  return {
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    clock,
    monotonicClock: () => time.monotonicMs,
    sleep: async (milliseconds) => {
      beforeSleep?.();
      time.wallMs += milliseconds;
      time.monotonicMs += milliseconds;
    },
    pidAlive: () => true,
    supervisor: createFakeSupervisor({ clock }),
  };
}

function admissionOptions(runtime: EventRuntime, clock: FakeClock): DockerWorkloadAdmissionOptions {
  return {
    runtime: runtime.runtime,
    runtimeKind: 'docker',
    bundleId: 'bundle-fresh-001',
    workspaceRoot: join(getHome(), 'workspace'),
    configuration: ADMISSION_CONFIGURATION,
    watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
    watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    startHeartbeat: false,
  };
}

function container(id: string, name: string, generation: string): DockerContainerInfo {
  return { id, name, created: '2026-07-20T12:00:00Z', running: true, labels: { [KEY]: generation } };
}

function markIncident(
  seeded: ReturnType<typeof seedLease>,
  code = 'docker-workload-cleanup-failed',
  detail = 'authoritative Apple inventory timed out twice',
): void {
  recordDockerWorkloadLeaseIncident(
    seeded.leasePath,
    seeded.generation,
    { code, detail },
    new Date('2026-07-20T12:00:01.000Z'),
  );
}

describe('Docker-workload crash reconciliation (§8.3 recovery)', () => {
  it('automatically recovers an incident with an already-absent resource and leftover state before admission', async () => {
    const runtime = createEventRuntime();
    const incident = seedLease({
      leaseId: 'dw-incident-absent',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-absent',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-already-absent',
          observedId: 'already-absent-id',
        },
      ],
      activate: true,
    });
    markIncident(incident);
    const original = loadDockerWorkloadLease(incident.leasePath).incident;
    expect(existsSync(getDockerWorkloadStateRoot(incident.leaseId))).toBe(true);

    const handle = await admitDockerWorkloadBundle(
      admissionOptions(runtime, createFakeClock('2026-07-20T12:00:02.000Z')),
    );

    const recovered = loadDockerWorkloadLease(incident.leasePath);
    expect(recovered).toMatchObject({ status: 'closed', incident: original, cleanup: { stateRootAbsent: true } });
    expect(existsSync(getDockerWorkloadStateRoot(incident.leaseId))).toBe(false);
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');

    const again = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:02.000Z')),
    );
    expect(again.reconciled).toEqual([]);
    expect(again.preserved).toEqual([handle.leaseId]);
    expect(loadDockerWorkloadLease(incident.leasePath)).toEqual(recovered);
  });

  it('does not re-fence a recovered lease when the old supervisor stop notification fails', async () => {
    const runtime = createEventRuntime();
    const incident = seedLease({
      leaseId: 'dw-incident-stop-notification',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
    });
    markIncident(incident);
    const original = loadDockerWorkloadLease(incident.leasePath).incident;
    const clock = createFakeClock('2026-07-20T12:00:02.000Z');
    const sink = createRecordingDockerWorkloadAuditSink();
    const supervisor: WatchdogSupervisorController = {
      ...createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
      requestStop() {
        throw new Error('old supervisor stop socket is unavailable');
      },
    };

    const handle = await admitDockerWorkloadBundle({
      ...admissionOptions(runtime, clock),
      supervisor,
      auditSink: sink,
    });

    expect(loadDockerWorkloadLease(incident.leasePath)).toMatchObject({
      status: 'closed',
      incident: original,
      cleanup: { exactOuterResourcesAbsent: true, stateRootAbsent: true },
    });
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        kind: 'incident',
        code: 'watchdog-supervisor-stop-notification-failed',
        detail: 'old supervisor stop socket is unavailable',
      }),
    );
  });

  it('reports post-close audit failure after continuing to recover later incident leases', async () => {
    const runtime = createEventRuntime();
    const firstIncident = seedLease({
      leaseId: 'dw-a-incident-post-close-audit',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
    });
    const secondIncident = seedLease({
      leaseId: 'dw-b-incident-after-audit-failure',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
    });
    markIncident(firstIncident);
    markIncident(secondIncident);
    const firstOriginal = loadDockerWorkloadLease(firstIncident.leasePath).incident;
    const secondOriginal = loadDockerWorkloadLease(secondIncident.leasePath).incident;
    const clock = createFakeClock('2026-07-20T12:00:02.000Z');

    await expect(
      admitDockerWorkloadBundle({
        ...admissionOptions(runtime, clock),
        auditSink: {
          emit(event) {
            if (event.leaseId === firstIncident.leaseId && event.kind === 'revocation-result') {
              throw new Error('audit storage is unavailable');
            }
          },
        },
      }),
    ).rejects.toThrow(/durably closed.*audit publication failed/u);

    expect(loadDockerWorkloadLease(firstIncident.leasePath)).toMatchObject({
      status: 'closed',
      incident: firstOriginal,
      cleanup: { exactOuterResourcesAbsent: true, stateRootAbsent: true },
    });
    expect(loadDockerWorkloadLease(secondIncident.leasePath)).toMatchObject({
      status: 'closed',
      incident: secondOriginal,
      cleanup: { exactOuterResourcesAbsent: true, stateRootAbsent: true },
    });
  });

  it('recovers only the exact owned resource, preserves foreign resources, and preserves a healthy active lease', async () => {
    const runtime = createEventRuntime({
      containers: [
        container('owned-incident-id', 'ic-owned-incident', 'gen-dw-a-incident'),
        container('healthy-id', 'ic-healthy', 'gen-dw-b-healthy'),
        { ...container('foreign-id', 'ic-foreign', 'foreign-generation'), labels: {} },
      ],
    });
    const incident = seedLease({
      leaseId: 'dw-a-incident',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-owned',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-owned-incident',
          observedId: 'owned-incident-id',
        },
      ],
      activate: true,
    });
    const healthy = seedLease({
      leaseId: 'dw-b-healthy',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-healthy',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-healthy',
          observedId: 'healthy-id',
        },
      ],
      activate: true,
    });
    markIncident(incident);
    const clock = createFakeClock('2026-07-20T12:00:02.000Z');

    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, clock),
      supervisor: createFakeSupervisor({ clock: clock.clock }),
    });

    expect(result).toEqual({ reconciled: [incident.leaseId], preserved: [healthy.leaseId], fenced: [] });
    expect(runtime.containers.map((entry) => entry.id).sort()).toEqual(['foreign-id', 'healthy-id']);
    expect(loadDockerWorkloadLease(incident.leasePath).status).toBe('closed');
    expect(loadDockerWorkloadLease(healthy.leasePath).status).toBe('active');
  });

  it('keeps the original incident and fences when exact ownership validation still fails', async () => {
    const runtime = createEventRuntime({
      containers: [{ ...container('wrong-label-id', 'ic-wrong-label', 'not-the-generation'), labels: {} }],
    });
    const incident = seedLease({
      leaseId: 'dw-incident-wrong-label',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-wrong-label',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-wrong-label',
          observedId: 'wrong-label-id',
        },
      ],
      activate: true,
    });
    markIncident(incident, 'original-inventory-loss', 'the first inventory could not be completed');
    const original = loadDockerWorkloadLease(incident.leasePath).incident;
    const clock = createFakeClock('2026-07-20T12:00:02.000Z');

    const result = await reconcileDockerWorkloadLeases(reconcileOptions(runtime, clock));

    expect(result.fenced).toEqual([incident.leaseId]);
    expect(runtime.containers.map((entry) => entry.id)).toEqual(['wrong-label-id']);
    expect(loadDockerWorkloadLease(incident.leasePath)).toMatchObject({ status: 'incident', incident: original });
    await expect(admitDockerWorkloadBundle(admissionOptions(runtime, clock))).rejects.toThrow(
      /dw-incident-wrong-label.*original-inventory-loss.*latest recovery failure.*wrong generation label/u,
    );
  });

  it('fences an incident create-before-observe collision with a foreign same-name resource', async () => {
    const runtime = createEventRuntime({
      containers: [container('foreign-same-name-id', 'ic-unobserved-collision', 'foreign-generation')],
    });
    const incident = seedLease({
      leaseId: 'dw-incident-unobserved-collision',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-unobserved-collision',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-unobserved-collision',
        },
      ],
    });
    markIncident(incident, 'original-create-loss', 'create result was not observed');
    const original = loadDockerWorkloadLease(incident.leasePath).incident;

    const result = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:02.000Z')),
    );

    expect(result.fenced).toEqual([incident.leaseId]);
    expect(runtime.containers.map((entry) => entry.id)).toEqual(['foreign-same-name-id']);
    expect(loadDockerWorkloadLease(incident.leasePath)).toMatchObject({ status: 'incident', incident: original });
  });

  it('audits the complete successful incident recovery sequence', async () => {
    const runtime = createEventRuntime({
      containers: [container('audit-owned-id', 'ic-audit-owned', 'gen-dw-incident-audit')],
    });
    const incident = seedLease({
      leaseId: 'dw-incident-audit',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      resources: [
        {
          requestId: 'res-audit-owned',
          kind: 'container',
          role: 'nested-daemon',
          name: 'ic-audit-owned',
          observedId: 'audit-owned-id',
        },
      ],
      activate: true,
    });
    markIncident(incident);
    const sink = createRecordingDockerWorkloadAuditSink();

    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:02.000Z')),
      auditSink: sink,
    });

    expect(result.reconciled).toEqual([incident.leaseId]);
    expect(sink.events.map((event) => event.kind)).toEqual([
      'lease-transition',
      'revocation-result',
      'cleanup-proof',
      'lease-transition',
    ]);
    expect(sink.events[0]).toMatchObject({ kind: 'lease-transition', from: 'incident', to: 'revoking' });
    expect(sink.events[1]).toMatchObject({ kind: 'revocation-result', removedResourceIds: ['audit-owned-id'] });
    expect(sink.events[3]).toMatchObject({ kind: 'lease-transition', from: 'revoking', to: 'closed' });
  });

  it('resumes a crash after incident-to-revoking transition', async () => {
    const runtime = createEventRuntime();
    const incident = seedLease({ leaseId: 'dw-incident-revoking', heartbeatIso: '2026-07-20T12:00:00.000Z' });
    markIncident(incident);
    const original = loadDockerWorkloadLease(incident.leasePath).incident;
    recoverDockerWorkloadLeaseIncident(incident.leasePath, incident.generation, new Date('2026-07-20T12:00:02.000Z'));

    const result = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:03.000Z')),
    );

    expect(result.reconciled).toEqual([incident.leaseId]);
    expect(loadDockerWorkloadLease(incident.leasePath)).toMatchObject({ status: 'closed', incident: original });
  });

  it('continues reconciling later incidents when an earlier incident remains unresolved', async () => {
    const failing = createEventRuntime();
    const failingRuntime = {
      ...failing.runtime,
      async listContainers(): Promise<never> {
        throw new Error('recorded Docker runtime inventory is unavailable');
      },
    };
    const succeeding = createEventRuntime();
    const first = seedLease({
      leaseId: 'dw-a-unresolved',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      runtimeKind: 'docker',
    });
    const second = seedLease({
      leaseId: 'dw-b-recoverable',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      runtimeKind: 'apple-container',
    });
    markIncident(first, 'first-failure', 'first runtime was unavailable');
    markIncident(second, 'second-failure', 'second runtime transiently failed');
    const clock = createFakeClock('2026-07-20T12:00:02.000Z');

    const result = await reconcileDockerWorkloadLeases({
      runtime: failingRuntime,
      runtimeKind: 'docker',
      runtimeForKind: (kind) => (kind === 'apple-container' ? succeeding.runtime : failingRuntime),
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => true,
      supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    });

    expect(result).toEqual({ reconciled: [second.leaseId], preserved: [], fenced: [first.leaseId] });
    expect(loadDockerWorkloadLease(first.leasePath)).toMatchObject({
      status: 'incident',
      incident: { code: 'first-failure', detail: 'first runtime was unavailable' },
    });
    expect(loadDockerWorkloadLease(second.leasePath)).toMatchObject({
      status: 'closed',
      incident: { code: 'second-failure', detail: 'second runtime transiently failed' },
    });
  });

  it('uses the recorded Docker endpoint after the selected context changes', async () => {
    const recorded = createEventRuntime();
    const selected = createEventRuntime();
    const selectedRuntime = { ...selected.runtime, dockerEndpoint: { host: 'unix:///different.sock' } };
    const stale = seedLease({ leaseId: 'dw-endpoint', heartbeatIso: '2026-07-20T09:00:00.000Z' });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');
    const requests: unknown[] = [];
    const result = await reconcileDockerWorkloadLeases({
      runtime: selectedRuntime,
      runtimeKind: 'docker',
      runtimeForKind: (kind, endpoint) => {
        requests.push({ kind, endpoint });
        return recorded.runtime;
      },
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => false,
      supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    });
    expect(requests).toEqual([{ kind: 'docker', endpoint: { host: 'unix:///var/run/docker.sock' } }]);
    expect(result.reconciled).toEqual(['dw-endpoint']);
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('closed');
    expect(selected.events).toEqual([]);
  });

  it('reconciles a stale lease before admitting a new bundle', async () => {
    const runtime = createEventRuntime();
    const stale = seedLease({ leaseId: 'dw-stale', heartbeatIso: '2026-07-20T10:00:00.000Z' });
    const handle = await admitDockerWorkloadBundle(
      admissionOptions(runtime, createFakeClock('2026-07-20T12:00:00.000Z')),
    );
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('closed');
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });

  it('reconciles a stale lease through its recorded runtime after backend selection changes', async () => {
    const recordedRuntime = createEventRuntime({
      containers: [container('recorded-id', 'ic-recorded', 'gen-dw-recorded-runtime')],
    });
    const selectedRuntime = createEventRuntime({
      containers: [{ ...container('foreign-apple-id', 'foreign-apple', 'foreign-generation'), labels: {} }],
    });
    const stale = seedLease({
      leaseId: 'dw-recorded-runtime',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        {
          requestId: 'res-recorded',
          kind: 'container',
          role: 'agent',
          name: 'ic-recorded',
          observedId: 'recorded-id',
        },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');

    const result = await reconcileDockerWorkloadLeases({
      runtime: selectedRuntime.runtime,
      runtimeKind: 'apple-container',
      runtimeForKind: (kind) => (kind === 'docker' ? recordedRuntime.runtime : selectedRuntime.runtime),
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => false,
      supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    });

    expect(result).toEqual({ reconciled: ['dw-recorded-runtime'], preserved: [], fenced: [] });
    expect(recordedRuntime.containers).toHaveLength(0);
    expect(selectedRuntime.containers.map((item) => item.id)).toEqual(['foreign-apple-id']);
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('closed');
  });

  it('fences rather than inventorying the wrong runtime when the recorded backend is unavailable', async () => {
    const recordedRuntime = createEventRuntime({
      containers: [container('still-running-id', 'ic-still-running', 'gen-dw-runtime-mismatch')],
    });
    const selectedRuntime = createEventRuntime();
    const stale = seedLease({
      leaseId: 'dw-runtime-mismatch',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        {
          requestId: 'res-mismatch',
          kind: 'container',
          role: 'agent',
          name: 'ic-still-running',
          observedId: 'still-running-id',
        },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');

    const result = await reconcileDockerWorkloadLeases({
      runtime: selectedRuntime.runtime,
      runtimeKind: 'apple-container',
      runtimeForKind: () => undefined,
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => false,
      supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    });

    expect(result.fenced).toEqual(['dw-runtime-mismatch']);
    expect(recordedRuntime.containers.map((item) => item.id)).toEqual(['still-running-id']);
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('incident');
  });

  it.each(['corrupt', 'symlink'] as const)('fences a %s lease marker and blocks new admission', async (kind) => {
    const leaseId = `dw-unreadable-${kind}`;
    const leaseDir = getDockerWorkloadLeaseDir(leaseId);
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    const leasePath = join(leaseDir, 'lease.json');
    if (kind === 'corrupt') {
      writeFileSync(leasePath, '{not-json}\n', { mode: 0o600 });
    } else {
      const target = join(leaseDir, 'foreign.json');
      writeFileSync(target, '{}\n', { mode: 0o600 });
      symlinkSync(target, leasePath);
    }
    const runtime = createEventRuntime();
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');

    const result = await reconcileDockerWorkloadLeases(reconcileOptions(runtime, clock));
    expect(result.fenced).toEqual([leaseId]);
    await expect(admitDockerWorkloadBundle(admissionOptions(runtime, clock))).rejects.toThrow(
      /unresolved leases block/u,
    );
  });

  it.each([1, 2, 3] as const)(
    'preserves and later recovers a v%i lease without upgrading its running supervisor protocol',
    async (schemaVersion) => {
      const runtime = createEventRuntime({ containers: [container('live-id', 'ic-live', 'gen-dw-live')] });
      const live = seedLease({
        leaseId: 'dw-live',
        schemaVersion,
        heartbeatIso: '2026-07-20T12:00:00.000Z',
        resources: [
          { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-live', observedId: 'live-id' },
        ],
        activate: true,
      });
      const clock = createFakeClock('2026-07-20T12:00:05.000Z');
      const result = await reconcileDockerWorkloadLeases({
        ...reconcileOptions(runtime, clock),
        supervisor: createFakeSupervisor({ clock: clock.clock }),
      });
      expect(result).toMatchObject({ preserved: ['dw-live'], reconciled: [], fenced: [] });
      expect(loadDockerWorkloadLease(live.leasePath).status).toBe('active');
      expect(runtime.containers.map((value) => value.id)).toEqual(['live-id']);
      const stopVersions: number[] = [];
      clock.advance(60_000);
      const recovered = await reconcileDockerWorkloadLeases({
        ...reconcileOptions(runtime, clock),
        supervisor: {
          ...createFakeSupervisor({ clock: clock.clock }),
          requestStop: (_path, lease) => {
            stopVersions.push(lease.schemaVersion);
          },
        },
      });
      expect(recovered).toMatchObject({ reconciled: ['dw-live'], preserved: [], fenced: [] });
      expect(stopVersions).toEqual([schemaVersion]);
      expect(loadDockerWorkloadLease(live.leasePath)).toMatchObject({ schemaVersion, status: 'closed' });
    },
  );

  it('deletes only exact generation-owned resources and preserves foreign objects (observed-but-unremoved)', async () => {
    const runtime = createEventRuntime({
      containers: [
        container('owned-id', 'ic-owned', 'gen-dw-observed'),
        container('foreign-id', 'ic-foreign', 'other-generation'),
      ],
    });
    const stale = seedLease({
      leaseId: 'dw-observed',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-owned', observedId: 'owned-id' },
      ],
      activate: true,
    });
    const result = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:00.000Z')),
    );
    expect(result.reconciled).toEqual(['dw-observed']);
    expect(runtime.containers.map((value) => value.id)).toEqual(['foreign-id']);
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('closed');
  });

  it('recovers the create-before-observe crash window by requested name plus generation label', async () => {
    const runtime = createEventRuntime({ containers: [container('crashed-id', 'ic-crashed', 'gen-dw-unobserved')] });
    const stale = seedLease({
      leaseId: 'dw-unobserved',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [{ requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-crashed' }],
    });
    const result = await reconcileDockerWorkloadLeases(
      reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:00.000Z')),
    );
    expect(result.reconciled).toEqual(['dw-unobserved']);
    expect(runtime.containers).toHaveLength(0);
    const closed = loadDockerWorkloadLease(stale.leasePath);
    expect(closed.status).toBe('closed');
    expect(closed.resources[0]).toMatchObject({ observedId: 'crashed-id' });
  });

  it('fences an ownerless lease while its detached supervisor owns cleanup', async () => {
    const runtime = createEventRuntime({ containers: [container('sup-id', 'ic-sup', 'gen-dw-sup')] });
    const stale = seedLease({
      leaseId: 'dw-sup',
      heartbeatIso: '2026-07-20T09:00:00.000Z', // coordinator heartbeat 3h stale
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-sup', observedId: 'sup-id' },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');
    const claim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: stale.leasePath });
    try {
      const result = await reconcileDockerWorkloadLeases({
        runtime: runtime.runtime,
        runtimeKind: 'docker',
        clock: clock.clock,
        sleep: clock.sleep,
        pidAlive: () => false,
        supervisor: createFakeSupervisor({ clock: clock.clock }),
      });
      expect(result).toMatchObject({ preserved: [], reconciled: [], fenced: ['dw-sup'] });
      expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('active');
      expect(runtime.containers.map((container) => container.id)).toEqual(['sup-id']);
    } finally {
      claim.release();
    }
  });

  it('fences recent coordinator death long enough for a starting supervisor to publish ownership', async () => {
    const runtime = createEventRuntime();
    const recent = seedLease({
      leaseId: 'dw-starting',
      heartbeatIso: '2026-07-20T12:00:00.000Z',
      activate: false,
    });
    const clock = createFakeClock('2026-07-20T12:00:05.000Z');
    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, clock),
      pidAlive: () => false,
    });
    expect(result).toMatchObject({ preserved: [], reconciled: [], fenced: ['dw-starting'] });
    expect(loadDockerWorkloadLease(recent.leasePath).status).toBe('admitting');
  });

  it('recovers an ownerless lease after its detached supervisor is gone', async () => {
    const runtime = createEventRuntime({ containers: [container('gone-id', 'ic-gone', 'gen-dw-gone')] });
    const stale = seedLease({
      leaseId: 'dw-gone',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-gone', observedId: 'gone-id' },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');
    const result = await reconcileDockerWorkloadLeases({
      runtime: runtime.runtime,
      runtimeKind: 'docker',
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => false,
      supervisor: createFakeSupervisor({ clock: clock.clock, alive: false }),
    });
    expect(result).toMatchObject({ preserved: [], reconciled: ['dw-gone'], fenced: [] });
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('closed');
    expect(runtime.containers).toHaveLength(0);
  });

  it('abandons stale recovery when the heartbeat refreshes before cleanup ownership', async () => {
    const runtime = createEventRuntime({ containers: [container('fresh-id', 'ic-fresh', 'gen-dw-refreshed')] });
    const seeded = seedLease({
      leaseId: 'dw-refreshed',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-fresh', observedId: 'fresh-id' },
      ],
      activate: true,
    });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');
    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, clock),
      runtimeKind: 'apple-container',
      runtimeForKind: () => {
        heartbeatDockerWorkloadLease(seeded.leasePath, seeded.generation, clock.clock());
        return runtime.runtime;
      },
    });

    expect(result).toEqual({ reconciled: [], preserved: [], fenced: ['dw-refreshed'] });
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('active');
    expect(runtime.containers.map((entry) => entry.id)).toEqual(['fresh-id']);
  });

  it('fails closed (fences) when a supervisor status exists but the rendered policy is unreadable', async () => {
    const runtime = createEventRuntime();
    const seeded = seedLease({ leaseId: 'dw-nopolicy', heartbeatIso: '2026-07-20T09:00:00.000Z' });
    // Delete the rendered policy: recovery must fence rather than reclaiming
    // resources without the exact cleanup target and policy binding.
    rmSync(join(getDockerWorkloadLeaseDir('dw-nopolicy'), 'policy.json'), { force: true });
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');
    const status: ResourceWatchdogSupervisorStatus = {
      schemaVersion: 1,
      leaseId: seeded.leaseId,
      generation: seeded.generation,
      supervisorPid: 555_555,
      state: 'ready',
      policySha256: 'a'.repeat(64),
      policyId: 'docker-workload-observed-state-v1',
      startedAt: clock.clock().toISOString(),
      updatedAt: clock.clock().toISOString(),
      lastSample: { sampledAtMs: clock.clock().getTime(), availableBytes: 1, allocatedBytes: 1 },
      trip: null,
      detail: 'ready',
    };
    // A fresh supervisor cannot turn an ownerless bundle into a live lease.
    const supervisor: WatchdogSupervisorController = {
      ...createFakeSupervisor({ clock: clock.clock }),
      readStatus: () => status,
    };
    const result = await reconcileDockerWorkloadLeases({
      runtime: runtime.runtime,
      runtimeKind: 'docker',
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => false,
      supervisor,
    });
    expect(result.fenced).toEqual(['dw-nopolicy']);
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('incident');
  });

  it('fences a lease whose recovery exceeds the bound, then retries it on the next admission', async () => {
    const runtime = createEventRuntime();
    const stale = seedLease({ leaseId: 'dw-slow', heartbeatIso: '2026-07-20T09:00:00.000Z' });
    const sink = createRecordingDockerWorkloadAuditSink();
    const jumpClock = createFakeClock('2026-07-20T12:00:00.000Z', 130_000);
    const result = await reconcileDockerWorkloadLeases({ ...reconcileOptions(runtime, jumpClock), auditSink: sink });
    expect(result.fenced).toEqual(['dw-slow']);
    expect(result.reconciled).toEqual([]);
    expect(loadDockerWorkloadLease(stale.leasePath).status).toBe('incident');
    expect(
      sink.events.some((event) => event.kind === 'incident' && event.code === 'docker-workload-recovery-fenced'),
    ).toBe(true);
    const original = loadDockerWorkloadLease(stale.leasePath).incident;

    const handle = await admitDockerWorkloadBundle(
      admissionOptions(runtime, createFakeClock('2026-07-20T12:10:00.000Z')),
    );
    expect(loadDockerWorkloadLease(stale.leasePath)).toMatchObject({ status: 'closed', incident: original });
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });

  it('watches a live coordinator whose heartbeat only looks stale and preserves it once it heartbeats', async () => {
    const runtime = createEventRuntime({ containers: [container('resumed-id', 'ic-resumed', 'gen-dw-resumed')] });
    const seeded = seedLease({
      leaseId: 'dw-resumed',
      // Written ten minutes before the host woke up; the coordinator has not run since.
      heartbeatIso: '2026-07-20T11:50:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-resumed', observedId: 'resumed-id' },
      ],
      activate: true,
    });
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    let polls = 0;

    const result = await reconcileDockerWorkloadLeases(
      timedReconcileOptions(runtime, time, () => {
        polls += 1;
        // The resumed coordinator's heartbeat interval fires a few seconds later.
        if (polls === 12) heartbeatDockerWorkloadLease(seeded.leasePath, seeded.generation, new Date(time.wallMs));
      }),
    );

    expect(result).toEqual({ reconciled: [], preserved: ['dw-resumed'], fenced: [] });
    expect(runtime.containers.map((entry) => entry.id)).toEqual(['resumed-id']);
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('active');
    expect(polls).toBe(12);
  });

  it.each([
    ['looks stale after a forward clock jump', '2026-07-20T11:50:00.000Z'],
    ['is from the future after a backward clock step', '2026-07-20T13:00:00.000Z'],
  ])(
    'recovers a live coordinator whose heartbeat %s only after one silent window of reconciler time',
    async (_label, heartbeatIso) => {
      const runtime = createEventRuntime({ containers: [container('silent-id', 'ic-silent', 'gen-dw-silent')] });
      const seeded = seedLease({
        leaseId: 'dw-silent',
        heartbeatIso,
        resources: [
          { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-silent', observedId: 'silent-id' },
        ],
        activate: true,
      });
      const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
      let revokedAtMonotonicMs: number | undefined;

      const result = await reconcileDockerWorkloadLeases(
        timedReconcileOptions(runtime, time, () => {
          if (revokedAtMonotonicMs === undefined && loadDockerWorkloadLease(seeded.leasePath).status === 'revoking') {
            revokedAtMonotonicMs = time.monotonicMs;
          }
        }),
      );

      expect(result).toEqual({ reconciled: ['dw-silent'], preserved: [], fenced: [] });
      expect(revokedAtMonotonicMs).toBeGreaterThanOrEqual(30_000);
      expect(revokedAtMonotonicMs).toBeLessThan(31_000);
      expect(runtime.containers).toHaveLength(0);
    },
  );

  it('recovers at once when the recorded coordinator PID now belongs to a different process', async () => {
    const runtime = createEventRuntime({ containers: [container('reused-id', 'ic-reused', 'gen-dw-reused')] });
    const seeded = seedLease({
      leaseId: 'dw-reused',
      heartbeatIso: '2026-07-20T11:50:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-reused', observedId: 'reused-id' },
      ],
      activate: true,
    });
    const time = { wallMs: Date.parse('2026-07-20T12:00:00.000Z'), monotonicMs: 0 };
    let revokedAtMonotonicMs: number | undefined;

    const result = await reconcileDockerWorkloadLeases({
      ...timedReconcileOptions(runtime, time, () => {
        if (revokedAtMonotonicMs === undefined && loadDockerWorkloadLease(seeded.leasePath).status === 'revoking') {
          revokedAtMonotonicMs = time.monotonicMs;
        }
      }),
      // The PID is alive, but its start identity is not the one the lease recorded.
      processIdentityForPid: (pid) => (pid === process.pid ? 'a-later-process-start' : undefined),
    });

    expect(result.reconciled).toEqual(['dw-reused']);
    expect(revokedAtMonotonicMs).toBe(0);
  });

  it('does not fence a dead coordinator whose heartbeat predates a backward clock step', async () => {
    const runtime = createEventRuntime({ containers: [container('stepped-id', 'ic-stepped', 'gen-dw-stepped-back')] });
    const seeded = seedLease({
      leaseId: 'dw-stepped-back',
      // An hour "in the future": the wall clock was stepped back after the coordinator died.
      heartbeatIso: '2026-07-20T13:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-stepped', observedId: 'stepped-id' },
      ],
      activate: true,
    });

    const result = await reconcileDockerWorkloadLeases({
      ...reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:00.000Z')),
      pidAlive: () => false,
    });

    expect(result).toEqual({ reconciled: [seeded.leaseId], preserved: [], fenced: [] });
    expect(runtime.containers).toHaveLength(0);
  });

  it('fences an argv-sized inventory failure with bounded lease and audit incidents on every pass', async () => {
    const runtime = createEventRuntime();
    const seeded = seedLease({
      leaseId: 'dw-long-error',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-long', observedId: 'long-id' },
      ],
      activate: true,
    });
    // An inspect of every container on a 300-container host, as execFile reports it.
    const hostIds = Array.from({ length: 300 }, (_, index) => index.toString(16).padStart(64, '0'));
    const failure = new Error(
      `Command failed: docker --host unix:///var/run/docker.sock container inspect ${hostIds.join(' ')}\nError response from daemon: simulated daemon failure`,
    );
    runtime.runtime.listContainers = async () => {
      throw failure;
    };
    const sink = createRecordingDockerWorkloadAuditSink();
    const options = { ...reconcileOptions(runtime, createFakeClock('2026-07-20T12:00:00.000Z')), auditSink: sink };

    // Pass 1 records the first incident; pass 2 is the incident recovery that
    // used to reject reconciliation with an audit-schema error.
    for (const pass of [1, 2]) {
      await expect(reconcileDockerWorkloadLeases(options), `pass ${pass}`).resolves.toMatchObject({
        fenced: [seeded.leaseId],
      });
    }

    const lease = loadDockerWorkloadLease(seeded.leasePath);
    expect(lease.status).toBe('incident');
    expect(lease.incident?.detail.length).toBeLessThanOrEqual(4096);
    expect(lease.incident?.detail).toMatch(/simulated daemon failure$/u);
    const incidents = sink.events.filter((event) => event.kind === 'incident');
    expect(incidents.length).toBeGreaterThanOrEqual(2);
    for (const incident of incidents) {
      expect(incident.detail.length).toBeLessThanOrEqual(4096);
      expect(incident.detail).toMatch(/^Command failed: docker .*characters omitted.*simulated daemon failure$/u);
    }
  });

  it('reports a failed incident audit with the fence instead of replacing the recovery failure', async () => {
    const runtime = createEventRuntime();
    seedLease({
      leaseId: 'dw-audit-down',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      resources: [
        { requestId: 'res-a', kind: 'container', role: 'nested-daemon', name: 'ic-audit', observedId: 'audit-id' },
      ],
      activate: true,
    });
    runtime.runtime.listContainers = async () => {
      throw new Error('authoritative inventory unavailable');
    };
    const clock = createFakeClock('2026-07-20T12:00:00.000Z');

    await expect(
      admitDockerWorkloadBundle({
        ...admissionOptions(runtime, clock),
        auditSink: {
          emit(event) {
            if (event.kind === 'incident') throw new Error('audit volume is full');
          },
        },
      }),
    ).rejects.toThrow(
      /dw-audit-down \(original incident docker-workload-cleanup-failed at [^:]+:[^:]+:[^:]+: authoritative inventory unavailable; latest recovery failure: authoritative inventory unavailable; incident audit publication failed: audit volume is full\)/u,
    );
  });
});
