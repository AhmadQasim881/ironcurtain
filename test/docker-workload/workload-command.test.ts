import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getDockerWorkloadLeaseDir,
  getDockerWorkloadRoot,
  getDockerWorkloadStateRoot,
} from '../../src/config/paths.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import {
  admitDockerWorkloadBundle,
  DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
  inspectDockerWorkloadLeases,
} from '../../src/docker-workload/infrastructure.js';
import {
  reconcileDockerWorkloadLeasesAtStartup,
  runDockerWorkloadCommand,
  type DockerWorkloadCommandDeps,
} from '../../src/docker-workload/workload-command.js';
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
import { labelledContainer, seedDockerWorkloadLease } from './helpers/seed-lease.js';

const getHome = useDockerWorkloadHome();
const NOW = '2026-07-20T12:00:00.000Z';

function commandDeps(runtime: EventRuntime, clock: FakeClock, output: string[]): DockerWorkloadCommandDeps {
  return {
    write: (text) => output.push(text),
    runtimeFor: () => runtime.runtime,
    selectedRuntime: () => Promise.resolve({ runtime: runtime.runtime, kind: 'docker' }),
    lifecycle: {
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => true,
      supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
    },
  };
}

/** An incident lease whose exact recovery refuses: its daemon container was renamed after observation. */
function seedUnrecoverableIncident() {
  const seeded = seedDockerWorkloadLease({
    home: getHome(),
    leaseId: 'dw-fenced',
    heartbeatIso: '2026-07-20T09:00:00.000Z',
    containers: [{ name: 'ic-fenced-daemon', id: 'fenced-daemon-id' }],
    incident: { code: 'docker-workload-cleanup-failed', detail: 'Docker Desktop stopped during teardown' },
  });
  const runtime = createEventRuntime({
    containers: [
      labelledContainer('fenced-daemon-id', 'ic-renamed-daemon', seeded.generation),
      { ...labelledContainer('foreign-id', 'someone-else', 'gen-foreign'), labels: {} },
    ],
  });
  return { seeded, runtime };
}

describe('ironcurtain docker-workload', () => {
  it('escapes JSON incident details while preserving the stored value', async () => {
    const detail = 'Neutral note\u0085\u202e\u034f';
    const seeded = seedDockerWorkloadLease({
      home: getHome(),
      leaseId: 'dw-json',
      heartbeatIso: NOW,
      incident: { code: 'docker-workload-cleanup-failed', detail },
    });
    const output: string[] = [];
    await runDockerWorkloadCommand(
      ['status', '--json'],
      commandDeps(createEventRuntime(), createFakeClock(NOW), output),
    );
    const out = output.join('');
    expect(out).not.toMatch(/\u0085|\u202e|\u034f/u);
    expect((JSON.parse(out) as { incident: { detail: string } }[])[0].incident.detail).toBe(
      loadDockerWorkloadLease(seeded.leasePath).incident?.detail,
    );
  });

  it('lists a fenced lease with its incident, resources, and runtime, and exits non-zero', async () => {
    const { runtime } = seedUnrecoverableIncident();
    const output: string[] = [];

    const code = await runDockerWorkloadCommand(['status'], commandDeps(runtime, createFakeClock(NOW), output));

    expect(code).toBe(1);
    const text = output.join('');
    expect(text).toContain('dw-fenced  incident  [blocks nested-Docker admission]');
    expect(text).toContain('incident docker-workload-cleanup-failed');
    expect(text).toContain('Docker Desktop stopped during teardown');
    expect(text).toContain('runtime docker at unix:///var/run/docker.sock');
    expect(text).toContain('container ic-fenced-daemon [nested-daemon] fenced-daemon-id: not proven removed');
    expect(text).toContain('ironcurtain docker-workload clear <lease-id> --force');

    const json: string[] = [];
    await runDockerWorkloadCommand(['status', '--json'], commandDeps(runtime, createFakeClock(NOW), json));
    expect(JSON.parse(json.join(''))).toEqual([
      expect.objectContaining({
        leaseId: 'dw-fenced',
        state: 'incident',
        fencesAdmission: true,
        status: 'incident',
        incident: expect.objectContaining({ code: 'docker-workload-cleanup-failed' }),
      }),
    ]);
  });

  it('plans a clear without touching anything, then clears with --force and unblocks admission', async () => {
    const { seeded, runtime } = seedUnrecoverableIncident();
    const clock = createFakeClock(NOW);

    const plan: string[] = [];
    expect(await runDockerWorkloadCommand(['clear', 'dw-fenced'], commandDeps(runtime, clock, plan))).toBe(0);
    expect(plan.join('')).toContain('container ic-renamed-daemon (fenced-daemon-id) generation gen-dw-fenced');
    expect(plan.join('')).toContain('Re-run with --force');
    expect(runtime.containers.map((container) => container.id)).toEqual(['fenced-daemon-id', 'foreign-id']);
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('incident');

    const output: string[] = [];
    const code = await runDockerWorkloadCommand(['clear', 'dw-fenced', '--force'], commandDeps(runtime, clock, output));

    expect(code).toBe(0);
    expect(output.join('')).toContain('Cleared dw-fenced: removed 1 object(s) carrying its generation label');
    // Only the object proven to be the lease's by its generation label went.
    expect(runtime.containers.map((container) => container.id)).toEqual(['foreign-id']);
    expect(existsSync(getDockerWorkloadLeaseDir('dw-fenced'))).toBe(false);
    expect(existsSync(getDockerWorkloadStateRoot('dw-fenced'))).toBe(false);
    // The record is kept for the evidence, outside the directory admission scans.
    const retired = join(getDockerWorkloadRoot(), 'cleared', 'dw-fenced', 'lease.json');
    expect(loadDockerWorkloadLease(retired)).toMatchObject({ leaseId: 'dw-fenced', status: 'incident' });
    // It was retired under its lifecycle claim, whose lock moved with it and was dropped there.
    expect(existsSync(join(getDockerWorkloadRoot(), 'cleared', 'dw-fenced', 'cleanup.lock'))).toBe(false);
    expect(inspectDockerWorkloadLeases({ clock: clock.clock })).toEqual([]);

    const handle = await admitDockerWorkloadBundle({
      runtime: runtime.runtime,
      runtimeKind: 'docker',
      bundleId: 'bundle-after-clear',
      workspaceRoot: join(getHome(), 'workspace'),
      configuration: ADMISSION_CONFIGURATION,
      watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
      watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => true,
      supervisor: createFakeSupervisor({ clock: clock.clock }),
      startHeartbeat: false,
    });
    expect(loadDockerWorkloadLease(handle.leasePath).status).toBe('admitting');
  });

  it('closes a lease through exact recovery when that now succeeds, before anything label-based', async () => {
    const seeded = seedDockerWorkloadLease({
      home: getHome(),
      leaseId: 'dw-recoverable',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      containers: [{ name: 'ic-daemon', id: 'daemon-id' }],
      incident: { code: 'docker-workload-cleanup-failed', detail: 'transient' },
    });
    const runtime = createEventRuntime({
      containers: [labelledContainer('daemon-id', 'ic-daemon', seeded.generation)],
    });
    const output: string[] = [];

    const code = await runDockerWorkloadCommand(
      ['clear', 'dw-recoverable', '--force'],
      commandDeps(runtime, createFakeClock(NOW), output),
    );

    expect(code).toBe(0);
    expect(output.join('')).toContain('Recovered dw-recoverable: exact recovery closed the lease');
    expect(loadDockerWorkloadLease(seeded.leasePath)).toMatchObject({
      status: 'closed',
      cleanup: { stateRootAbsent: true },
    });
  });

  it('refuses to clear a live lease or one whose runtime cannot be inventoried', async () => {
    const live = seedDockerWorkloadLease({ home: getHome(), leaseId: 'dw-live', heartbeatIso: NOW });
    const runtime = createEventRuntime();
    const output: string[] = [];
    expect(
      await runDockerWorkloadCommand(
        ['clear', 'dw-live', '--force'],
        commandDeps(runtime, createFakeClock(NOW), output),
      ),
    ).toBe(1);
    expect(output.join('')).toContain('Refused to clear dw-live: it is live');
    expect(loadDockerWorkloadLease(live.leasePath).status).toBe('admitting');

    const { seeded } = seedUnrecoverableIncident();
    runtime.runtime.listContainers = () => Promise.reject(new Error('Cannot connect to the Docker daemon'));
    const refused: string[] = [];
    expect(
      await runDockerWorkloadCommand(
        ['clear', 'dw-fenced', '--force'],
        commandDeps(runtime, createFakeClock(NOW), refused),
      ),
    ).toBe(1);
    expect(refused.join('')).toContain('cannot inventory its runtime, so absence cannot be proven');
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('incident');
  });

  it('clears an unreadable record that names no generation only when no unaccounted labelled object exists', async () => {
    const leaseDir = getDockerWorkloadLeaseDir('dw-corrupt');
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(leaseDir, 'lease.json'), '{not-json}\n', { mode: 0o600 });
    const accounted = seedDockerWorkloadLease({ home: getHome(), leaseId: 'dw-live-neighbour', heartbeatIso: NOW });
    const runtime = createEventRuntime({
      containers: [
        labelledContainer('neighbour-id', 'ic-neighbour', accounted.generation),
        labelledContainer('orphan-id', 'ic-orphan', 'gen-unaccounted'),
      ],
    });
    const clock = createFakeClock(NOW);

    const refused: string[] = [];
    expect(
      await runDockerWorkloadCommand(['clear', 'dw-corrupt', '--force'], commandDeps(runtime, clock, refused)),
    ).toBe(1);
    expect(refused.join('')).toContain('no readable lease accounts for');
    expect(refused.join('')).toContain('container ic-orphan (orphan-id) generation gen-unaccounted');
    expect(runtime.containers).toHaveLength(2);

    runtime.containers.splice(
      runtime.containers.findIndex((container) => container.id === 'orphan-id'),
      1,
    );
    const output: string[] = [];
    expect(
      await runDockerWorkloadCommand(['clear', 'dw-corrupt', '--force'], commandDeps(runtime, clock, output)),
    ).toBe(0);
    expect(output.join('')).toContain('Cleared dw-corrupt: the runtime held nothing with its generation label');
    expect(runtime.containers.map((container) => container.id)).toEqual(['neighbour-id']);
    expect(inspectDockerWorkloadLeases({ clock: clock.clock }).map((summary) => summary.leaseId)).toEqual([
      'dw-live-neighbour',
    ]);
  });

  it('reconciles stale leases on demand and at daemon startup', async () => {
    const seeded = seedDockerWorkloadLease({
      home: getHome(),
      leaseId: 'dw-crashed',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      containers: [{ name: 'ic-crashed', id: 'crashed-id' }],
    });
    const runtime = createEventRuntime({
      containers: [labelledContainer('crashed-id', 'ic-crashed', seeded.generation)],
    });
    const clock = createFakeClock(NOW);
    const deps = {
      ...commandDeps(runtime, clock, []),
      lifecycle: {
        ...commandDeps(runtime, clock, []).lifecycle,
        // The crashed coordinator was a different process start.
        processIdentityForPid: (pid: number) => (pid === process.pid ? 'a-later-process' : undefined),
      },
    };

    await expect(reconcileDockerWorkloadLeasesAtStartup(deps)).resolves.toBe(
      'nested-Docker lease recovery: 1 closed, 0 still fenced',
    );
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('closed');
    expect(runtime.containers).toEqual([]);
    await expect(reconcileDockerWorkloadLeasesAtStartup(deps)).resolves.toBeUndefined();

    const output: string[] = [];
    expect(await runDockerWorkloadCommand(['reconcile'], { ...deps, write: (text) => output.push(text) })).toBe(0);
    expect(output.join('')).toContain('Reconciled 0, preserved 0 live, 0 still fenced.');
  });

  it('refuses to remove host state through a state root that is no longer the recorded directory', async () => {
    const { seeded, runtime } = seedUnrecoverableIncident();
    // Something outside the IronCurtain home that a swapped state root points at.
    const outside = mkdtempSync(join(tmpdir(), 'dw-clear-outside-'));
    for (const subdir of ['api', 'daemon', 'exchange', 'staging']) {
      mkdirSync(join(outside, subdir));
      writeFileSync(join(outside, subdir, 'keep.txt'), 'not the bundle');
    }
    const stateRoot = getDockerWorkloadStateRoot('dw-fenced');
    rmSync(stateRoot, { recursive: true });
    symlinkSync(outside, stateRoot);
    const clock = createFakeClock(NOW);

    const plan: string[] = [];
    expect(await runDockerWorkloadCommand(['clear', 'dw-fenced'], commandDeps(runtime, clock, plan))).toBe(1);
    expect(plan.join('')).toContain('is not provably the directory the lease recorded');
    const output: string[] = [];
    expect(await runDockerWorkloadCommand(['clear', 'dw-fenced', '--force'], commandDeps(runtime, clock, output))).toBe(
      1,
    );

    expect(output.join('')).toContain('Refused to clear dw-fenced: its state root');
    expect(output.join('')).toContain('inspect and remove it by hand');
    for (const subdir of ['api', 'daemon', 'exchange', 'staging']) {
      expect(readFileSync(join(outside, subdir, 'keep.txt'), 'utf8')).toBe('not the bundle');
    }
    expect(lstatSync(stateRoot).isSymbolicLink()).toBe(true);
    expect(loadDockerWorkloadLease(seeded.leasePath).status).toBe('incident');
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses an unreadable record while its recorded coordinator runs or it is still being rewritten', async () => {
    // A live session's record that this version cannot parse (a newer schema).
    const seeded = seedDockerWorkloadLease({
      home: getHome(),
      leaseId: 'dw-newer',
      heartbeatIso: NOW,
      containers: [{ name: 'ic-newer-daemon', id: 'newer-daemon-id' }],
    });
    const record = JSON.parse(readFileSync(seeded.leasePath, 'utf8')) as {
      readonly coordinator: Readonly<Record<string, unknown>>;
    };
    const writeRecord = (coordinator: Readonly<Record<string, unknown>>, modifiedAt: Date): void => {
      writeFileSync(seeded.leasePath, `${JSON.stringify({ ...record, schemaVersion: 99, coordinator })}\n`, {
        mode: 0o600,
      });
      utimesSync(seeded.leasePath, modifiedAt, modifiedAt);
    };
    const runtime = createEventRuntime({
      containers: [labelledContainer('newer-daemon-id', 'ic-newer-daemon', seeded.generation)],
    });
    const clock = createFakeClock(NOW);
    const longAgo = new Date(Date.parse(NOW) - 3_600_000);

    // Quiet for an hour, but the coordinator process it names still runs.
    writeRecord(record.coordinator, longAgo);
    const live: string[] = [];
    expect(await runDockerWorkloadCommand(['clear', 'dw-newer', '--force'], commandDeps(runtime, clock, live))).toBe(1);
    expect(live.join('')).toContain(`the coordinator process its record names (pid ${process.pid}) is still running`);

    // Its coordinator is gone (the PID now belongs to another process start),
    // but something rewrote the record a second ago.
    writeRecord(
      { ...record.coordinator, processIdentity: 'an-earlier-process-start' },
      new Date(Date.parse(NOW) - 1000),
    );
    const rewritten: string[] = [];
    expect(
      await runDockerWorkloadCommand(['clear', 'dw-newer', '--force'], commandDeps(runtime, clock, rewritten)),
    ).toBe(1);
    expect(rewritten.join('')).toContain('its record was rewritten within the last 30s');
    expect(runtime.containers.map((container) => container.id)).toEqual(['newer-daemon-id']);
    expect(existsSync(seeded.leasePath)).toBe(true);

    // Quiescent and ownerless: cleared through the generation it still names.
    writeRecord({ ...record.coordinator, processIdentity: 'an-earlier-process-start' }, longAgo);
    const cleared: string[] = [];
    expect(await runDockerWorkloadCommand(['clear', 'dw-newer', '--force'], commandDeps(runtime, clock, cleared))).toBe(
      0,
    );
    expect(cleared.join('')).toContain('Cleared dw-newer: removed 1 object(s) carrying its generation label');
    expect(runtime.containers).toEqual([]);
  });

  it('counts an object as the lease’s when any of its label keys names the lease generation', async () => {
    const customKey = 'com.example.workload-owner';
    const seeded = seedDockerWorkloadLease({
      home: getHome(),
      leaseId: 'dw-custom-key',
      heartbeatIso: '2026-07-20T09:00:00.000Z',
      containers: [{ name: 'ic-custom-daemon', id: 'custom-daemon-id' }],
      incident: { code: 'docker-workload-cleanup-failed', detail: 'Docker Desktop stopped during teardown' },
      ownershipLabelKey: customKey,
    });
    const runtime = createEventRuntime({
      containers: [
        {
          ...labelledContainer('custom-daemon-id', 'ic-renamed-custom-daemon', seeded.generation),
          labels: { [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: 'gen-someone-else', [customKey]: seeded.generation },
        },
      ],
    });
    const output: string[] = [];

    expect(
      await runDockerWorkloadCommand(['clear', 'dw-custom-key'], commandDeps(runtime, createFakeClock(NOW), output)),
    ).toBe(0);

    expect(output.join('')).toContain(
      'container ic-renamed-custom-daemon (custom-daemon-id) generation gen-dw-custom-key',
    );
  });

  it('inventories through daemon-side label filters, never every object on the host', async () => {
    const { runtime } = seedUnrecoverableIncident();
    runtime.networks.push(
      { id: 'foreign-net-id', name: 'someone-elses-net', created: NOW, labels: {}, subnets: [], containerIds: [] },
      {
        id: 'fenced-net-id',
        name: 'ic-fenced-relay',
        created: NOW,
        labels: { [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: 'gen-dw-fenced' },
        subnets: [],
        containerIds: [],
      },
    );
    // A runtime that applies the filter itself, as Docker does, and records it.
    const filters: (string | undefined)[] = [];
    const applyFilter = <T extends { readonly labels: Readonly<Record<string, string>> }>(
      entries: readonly T[],
      labelFilter: string | undefined,
    ): T[] => {
      filters.push(labelFilter);
      if (labelFilter === undefined) return structuredClone([...entries]);
      const separator = labelFilter.indexOf('=');
      const key = separator === -1 ? labelFilter : labelFilter.slice(0, separator);
      const value = separator === -1 ? undefined : labelFilter.slice(separator + 1);
      return structuredClone(
        entries.filter(
          (entry) => Object.hasOwn(entry.labels, key) && (value === undefined || entry.labels[key] === value),
        ),
      );
    };
    runtime.runtime.listContainers = (options) =>
      Promise.resolve(applyFilter(runtime.containers, options?.labelFilter));
    runtime.runtime.listNetworks = (options) => Promise.resolve(applyFilter(runtime.networks, options?.labelFilter));
    const output: string[] = [];

    expect(
      await runDockerWorkloadCommand(['clear', 'dw-fenced'], commandDeps(runtime, createFakeClock(NOW), output)),
    ).toBe(0);

    const text = output.join('');
    expect(text).toContain('container ic-renamed-daemon (fenced-daemon-id) generation gen-dw-fenced');
    expect(text).toContain('network ic-fenced-relay (fenced-net-id) generation gen-dw-fenced');
    expect(text).not.toContain('someone');
    // One filtered listing per kind, each naming the lease's generation label.
    expect(filters).toEqual([
      `${DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY}=gen-dw-fenced`,
      `${DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY}=gen-dw-fenced`,
    ]);

    // A record that names no generation filters on the label key alone, so an
    // object of any generation no readable lease accounts for is still found.
    const leaseDir = getDockerWorkloadLeaseDir('dw-nameless');
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(leaseDir, 'lease.json'), '{not-json}\n', { mode: 0o600 });
    runtime.containers.push(labelledContainer('orphan-id', 'ic-orphan', 'gen-unaccounted'));
    filters.length = 0;
    const nameless: string[] = [];
    expect(
      await runDockerWorkloadCommand(['clear', 'dw-nameless'], commandDeps(runtime, createFakeClock(NOW), nameless)),
    ).toBe(1);
    expect(nameless.join('')).toContain('no readable lease accounts for');
    expect(nameless.join('')).toContain('container ic-orphan (orphan-id) generation gen-unaccounted');
    expect(nameless.join('')).not.toContain('fenced-daemon-id');
    expect(filters).toEqual([DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY, DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]);
  });

  it('never echoes a lease directory name raw', async () => {
    const leaseDir = join(getDockerWorkloadRoot(), 'leases', 'dw-\u001b]0;owned\u0007');
    mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(leaseDir, 'lease.json'), '{not-json}\n', { mode: 0o600 });
    const output: string[] = [];

    expect(
      await runDockerWorkloadCommand(['status'], commandDeps(createEventRuntime(), createFakeClock(NOW), output)),
    ).toBe(1);

    const text = output.join('');
    expect(text).toContain('unreadable  [blocks nested-Docker admission]');
    expect(text.includes('\u001b')).toBe(false);
    expect(text.includes('\u0007')).toBe(false);
  });

  it('rejects unknown commands and malformed lease ids', async () => {
    const runtime = createEventRuntime();
    const clock = createFakeClock(NOW);
    const output: string[] = [];
    expect(await runDockerWorkloadCommand(['prune'], commandDeps(runtime, clock, output))).toBe(2);
    expect(await runDockerWorkloadCommand(['clear'], commandDeps(runtime, clock, output))).toBe(2);
    expect(await runDockerWorkloadCommand(['clear', '../leases'], commandDeps(runtime, clock, output))).toBe(1);
    expect(output.join('')).toContain('Refused to clear ../leases: not a valid lease id');
  });
});
