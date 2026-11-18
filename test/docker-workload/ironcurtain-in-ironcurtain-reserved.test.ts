/**
 * Reserved IronCurtain-in-IronCurtain scaffolding (WP-129: DWL-17, DOA-16).
 *
 * The hermetic self-hosting slice
 * (docs/designs/ironcurtain-in-ironcurtain-hermetic-slice.md) is reserved: it
 * is not scheduled and none of its product wiring exists. Three of its
 * foundations ship anyway and are kept on purpose:
 *
 * - the Docker-workload lease's `paths.exchangeRoot`, which every lease ever
 *   written carries. The `paths` object is strict, and reconciliation parses
 *   every lease directory (closed ones included) and fences all nested-Docker
 *   admission on one it cannot read, so the field must keep parsing until a
 *   lease schema version bump retires it;
 * - `createParentProxyOutboundTransport`, the fixed-parent transport an inner
 *   coordinator would select;
 * - `src/docker/linux-dependency-abi.ts`, the Linux dependency ABI manifest and
 *   native-load probe the slice's harness would need.
 *
 * The first block pins "historical leases still parse" with lease records in
 * the shapes earlier releases wrote. The second is a static guard in the style
 * of test/pipeline-import-boundary.test.ts: the design document and each
 * foundation's defining module must call it reserved, and any production use
 * beyond today's (admission writing `exchangeRoot`, cleanup removing it) fails.
 * Wiring one means updating those documents, src/docker/CLAUDE.md and this
 * guard together.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '../../src/hash.js';
import { getDockerWorkloadLeaseDir } from '../../src/config/paths.js';
import {
  DOCKER_WORKLOAD_LEASE_SCHEMA_VERSION,
  loadDockerWorkloadLease,
  revokeDockerWorkloadLease,
} from '../../src/docker-workload/bundle-lease.js';
import { admitDockerWorkloadBundle } from '../../src/docker-workload/infrastructure.js';
import {
  ADMISSION_CONFIGURATION,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  useDockerWorkloadHome,
} from './helpers/infrastructure-harness.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DESIGN_DOC = 'docs/designs/ironcurtain-in-ironcurtain-hermetic-slice.md';
const getHome = useDockerWorkloadHome();

// ── Lease records as earlier releases wrote them ────────────────────────
// Literal values, not built through the current lease API, so a schema change
// cannot silently update them along with the code under test.

const OWNERSHIP_LABEL_KEY = 'com.ironcurtain.docker-workload.generation';
const V1_STATE_ROOT = '/Users/dev/.ironcurtain/docker-workload/state/dw-first-release-v1';
const V2_STATE_ROOT = '/Users/dev/.ironcurtain/docker-workload/state/dw-desktop-v2';

/** A closed version-1 Apple lease in the first nested-Docker release's shape (no `bundleRuntimeRoot`). */
const FIRST_RELEASE_V1_LEASE = {
  schemaVersion: 1,
  leaseId: 'dw-first-release-v1',
  bundleId: 'bundle-first-release-v1',
  generation: 'gen-first-release-v1',
  sequence: 6,
  status: 'closed',
  runtimeKind: 'apple-container',
  paths: {
    workspaceRoot: '/Users/dev/src/project',
    stateRoot: V1_STATE_ROOT,
    runtimeRoot: `${V1_STATE_ROOT}/daemon`,
    apiRoot: `${V1_STATE_ROOT}/api`,
    exchangeRoot: `${V1_STATE_ROOT}/exchange`,
    stagingRoot: `${V1_STATE_ROOT}/staging`,
  },
  bindings: { watchdogPolicySha256: '5'.repeat(64) },
  coordinator: { pid: 4242, startedAt: '2026-08-20T10:00:00.000Z', heartbeatAt: '2026-08-20T10:20:00.000Z' },
  cleanupInventoryGapMs: 500,
  resources: [
    {
      requestId: 'agent',
      kind: 'container',
      role: 'agent',
      requestedName: 'ic-dw-agent-first-release',
      ownershipLabelKey: OWNERSHIP_LABEL_KEY,
      ownershipLabelValue: 'gen-first-release-v1',
      requestedAt: '2026-08-20T10:00:01.000Z',
      observedId: 'apple-vm-first-release',
      observedAt: '2026-08-20T10:00:02.000Z',
      removal: {
        proof: 'immutable-id-absent',
        identity: 'apple-vm-first-release',
        capturedAt: '2026-08-20T10:20:01.000Z',
      },
    },
  ],
  cleanup: {
    exactOuterResourcesAbsent: true,
    stateRootAbsent: true,
    inventories: [
      { capturedAt: '2026-08-20T10:20:02.000Z', ownedResourceIds: [] },
      { capturedAt: '2026-08-20T10:20:02.500Z', ownedResourceIds: [] },
    ],
  },
  incident: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:20:03.000Z',
} as const;

/** The same generation while it was still active, before its coordinator revoked it. */
const ACTIVE_V1_LEASE = {
  ...FIRST_RELEASE_V1_LEASE,
  sequence: 3,
  status: 'active',
  resources: [{ ...FIRST_RELEASE_V1_LEASE.resources[0], removal: null }],
  cleanup: null,
  updatedAt: '2026-08-20T10:00:03.000Z',
} as const;

/** A closed version-2 Docker Desktop lease with its captured endpoint and complete watchdog policy. */
const DESKTOP_V2_LEASE = {
  schemaVersion: 2,
  leaseId: 'dw-desktop-v2',
  bundleId: 'bundle-desktop-v2',
  generation: 'gen-desktop-v2',
  sequence: 9,
  status: 'closed',
  runtimeKind: 'docker',
  dockerEndpoint: { host: 'unix:///Users/dev/.docker/run/docker.sock' },
  paths: {
    workspaceRoot: '/Users/dev/src/project',
    stateRoot: V2_STATE_ROOT,
    bundleRuntimeRoot: '/Users/dev/.ironcurtain/run/bundledeskto',
    runtimeRoot: `${V2_STATE_ROOT}/daemon`,
    apiRoot: `${V2_STATE_ROOT}/api`,
    exchangeRoot: `${V2_STATE_ROOT}/exchange`,
    stagingRoot: `${V2_STATE_ROOT}/staging`,
  },
  bindings: {
    watchdogPolicy: {
      schemaVersion: 1,
      policyId: 'docker-workload-observed-state-v1',
      targetRoot: V2_STATE_ROOT,
      targetDevice: 16_777_232,
      targetInode: 4_823_102,
      stateClasses: [
        { id: 'daemon-state', kind: 'directory', relativePath: 'daemon', required: false },
        { id: 'api-state', kind: 'directory', relativePath: 'api', required: false },
        { id: 'exchange-state', kind: 'directory', relativePath: 'exchange', required: false },
        { id: 'staging-state', kind: 'directory', relativePath: 'staging', required: false },
      ],
      sampleIntervalMs: 5000,
      sampleTimeoutMs: 5000,
      staleAfterMs: 30_000,
      softEvidenceBytes: 4_294_967_296,
      hardSafetyBytes: 8_589_934_592,
      hostReserveBytes: 2_147_483_648,
      maximumOvershootBytes: 1_073_741_824,
      cleanupInventoryGapMs: 500,
    },
  },
  coordinator: { pid: 5151, startedAt: '2026-10-02T09:00:00.000Z', heartbeatAt: '2026-10-02T09:40:00.000Z' },
  cleanupInventoryGapMs: 500,
  resources: [
    {
      requestId: 'nested-daemon',
      kind: 'container',
      role: 'nested-daemon',
      requestedName: 'ic-dw-daemon-desktop-v2',
      ownershipLabelKey: OWNERSHIP_LABEL_KEY,
      ownershipLabelValue: 'gen-desktop-v2',
      requestedAt: '2026-10-02T09:00:01.000Z',
      observedId: 'a'.repeat(64),
      observedAt: '2026-10-02T09:00:02.000Z',
      removal: { proof: 'immutable-id-absent', identity: 'a'.repeat(64), capturedAt: '2026-10-02T09:40:01.000Z' },
    },
    {
      requestId: 'daemon-api',
      kind: 'volume',
      role: 'daemon-api',
      requestedName: 'ic-dw-daemon-api-desktop-v2',
      ownershipLabelKey: OWNERSHIP_LABEL_KEY,
      ownershipLabelValue: 'gen-desktop-v2',
      requestedAt: '2026-10-02T09:00:01.500Z',
      observedId: 'ic-dw-daemon-api-desktop-v2',
      observedAt: '2026-10-02T09:00:01.800Z',
      removal: {
        proof: 'immutable-id-absent',
        identity: 'ic-dw-daemon-api-desktop-v2',
        capturedAt: '2026-10-02T09:40:01.500Z',
      },
    },
  ],
  cleanup: {
    exactOuterResourcesAbsent: true,
    stateRootAbsent: true,
    inventories: [
      { capturedAt: '2026-10-02T09:40:02.000Z', ownedResourceIds: [] },
      { capturedAt: '2026-10-02T09:40:02.500Z', ownedResourceIds: [] },
    ],
  },
  incident: null,
  createdAt: '2026-10-02T09:00:00.000Z',
  updatedAt: '2026-10-02T09:40:03.000Z',
} as const;

/**
 * The same version-2 generation while it was still active. Version 2 is a
 * historical shape too: it predates the coordinator's `processIdentity`, and
 * its supervisor (from that release) may still be rereading it.
 */
const ACTIVE_V2_LEASE = {
  ...DESKTOP_V2_LEASE,
  sequence: 4,
  status: 'active',
  resources: DESKTOP_V2_LEASE.resources.map((resource) => ({ ...resource, removal: null })),
  cleanup: null,
  updatedAt: '2026-10-02T09:00:03.000Z',
} as const;

const CLOSED_HISTORICAL_LEASES = [FIRST_RELEASE_V1_LEASE, DESKTOP_V2_LEASE] as const;
const ACTIVE_HISTORICAL_LEASES = [ACTIVE_V1_LEASE, ACTIVE_V2_LEASE] as const;

/** The exact bytes the lease writer persists: canonical JSON plus a newline. */
function canonicalLeaseBytes(record: object): string {
  const text = stableStringify(record);
  if (text === undefined) throw new Error('lease fixture must serialize');
  return `${text}\n`;
}

describe('reserved lease paths.exchangeRoot', () => {
  it('keeps parsing the lease shapes earlier releases wrote, exchangeRoot included', () => {
    for (const record of [...CLOSED_HISTORICAL_LEASES, ...ACTIVE_HISTORICAL_LEASES]) {
      const path = join(getHome(), `${record.leaseId}-${record.status}.json`);
      writeFileSync(path, canonicalLeaseBytes(record), { mode: 0o600 });
      expect(loadDockerWorkloadLease(path)).toEqual(record);
    }
  });

  it.each(ACTIVE_HISTORICAL_LEASES)(
    'keeps exchangeRoot when newer code updates a version-$schemaVersion lease an older supervisor still reads',
    (record) => {
      const path = join(getHome(), 'lease.json');
      writeFileSync(path, canonicalLeaseBytes(record), { mode: 0o600 });

      const revoked = revokeDockerWorkloadLease(path, record.generation, new Date('2026-11-11T12:00:00.000Z'));

      // Never upgraded in place: the older supervisor must still parse it.
      expect(revoked).toMatchObject({ schemaVersion: record.schemaVersion, status: 'revoking' });
      expect(revoked.paths).toEqual(record.paths);
      expect(loadDockerWorkloadLease(path)).toMatchObject({ schemaVersion: record.schemaVersion, paths: record.paths });
    },
  );

  it('admits a new bundle beside closed historical leases and keeps writing exchangeRoot', async () => {
    for (const record of CLOSED_HISTORICAL_LEASES) {
      const leaseDir = getDockerWorkloadLeaseDir(record.leaseId);
      mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(leaseDir, 'lease.json'), canonicalLeaseBytes(record), { mode: 0o600 });
    }
    const runtime = createEventRuntime();
    const clock = createFakeClock('2026-11-11T12:00:00.000Z');

    const handle = await admitDockerWorkloadBundle({
      runtime: runtime.runtime,
      runtimeKind: 'docker',
      bundleId: 'bundle-after-history',
      workspaceRoot: join(getHome(), 'workspace'),
      configuration: ADMISSION_CONFIGURATION,
      watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
      watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => true,
      supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
      startHeartbeat: false,
    });

    // Every lease schema version requires the field, and every release parses every lease directory.
    const admitted = loadDockerWorkloadLease(handle.leasePath);
    expect(admitted).toMatchObject({ schemaVersion: DOCKER_WORKLOAD_LEASE_SCHEMA_VERSION, status: 'admitting' });
    expect(admitted.paths.exchangeRoot).toBe(join(admitted.paths.stateRoot, 'exchange'));
    // Closed leases are parsed and skipped: no runtime call, no rewrite.
    expect(runtime.events).toEqual([]);
    for (const record of CLOSED_HISTORICAL_LEASES) {
      expect(readFileSync(join(getDockerWorkloadLeaseDir(record.leaseId), 'lease.json'), 'utf8')).toBe(
        canonicalLeaseBytes(record),
      );
    }
  });
});

// ── Static guard: reserved means unwired and documented ─────────────────

/** Trees holding code that runs outside the test runner. */
const PRODUCTION_TREES = ['src', 'scripts', 'docker'];
const SOURCE_FILE = /\.[cm]?[jt]s$/u;
const TEST_FILE = /(?:^|\/)__tests__\/|\.test\.[cm]?[jt]s$|\.d\.ts$/u;

interface ReservedFoundation {
  /** How the design document's "Implementation status" section names it. */
  readonly name: string;
  readonly definedIn: string;
  /** A use in comment-stripped production code. */
  readonly use: RegExp;
  /** Production modules that touch it today, sorted; anything else is new wiring. */
  readonly expectedUsers: readonly string[];
  /** A test that uses it, proving the pattern is not vacuous. */
  readonly exercisedBy: string;
  /** What its defining module must say while it stays reserved. */
  readonly marker: RegExp;
}

const RESERVED_FOUNDATIONS: readonly ReservedFoundation[] = [
  {
    name: 'paths.exchangeRoot',
    definedIn: 'src/docker-workload/bundle-lease.ts',
    use: /\bexchangeRoot\b/u,
    // Admission writes it and cleanup removes it; nothing mounts it.
    expectedUsers: ['src/docker-workload/bundle-cleanup.ts', 'src/docker-workload/infrastructure.ts'],
    exercisedBy: 'test/docker/bundle-lease.test.ts',
    marker: /Reserved for the IronCurtain-in-IronCurtain slice/u,
  },
  {
    name: 'createParentProxyOutboundTransport',
    definedIn: 'src/docker/outbound-transport.ts',
    use: /\bcreateParentProxyOutboundTransport\b/u,
    expectedUsers: [],
    exercisedBy: 'test/docker/outbound-transport.test.ts',
    marker: /Not yet wired/u,
  },
  {
    name: 'linux-dependency-abi.ts',
    definedIn: 'src/docker/linux-dependency-abi.ts',
    use: /['"`][^'"`\n]*\blinux-dependency-abi(?:\.[cm]?[jt]s)?['"`]/u,
    expectedUsers: [],
    exercisedBy: 'test/docker/linux-dependency-abi.test.ts',
    marker: /Not yet wired/u,
  },
];

/** Repo-relative paths of every non-test source file under `dir`, sorted. */
function listProductionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, dir))) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const rel = `${dir}/${entry}`;
    if (statSync(resolve(ROOT, rel)).isDirectory()) {
      out.push(...listProductionSources(rel));
    } else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(rel)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** The file's code with block and line comments removed, so a doc mention is not a use. */
function codeOf(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** One `## ` section of a Markdown document, heading included. */
function sectionOf(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start === -1) return '';
  const next = markdown.indexOf('\n## ', start + heading.length + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

describe('reserved IronCurtain-in-IronCurtain foundations', () => {
  const productionSources = PRODUCTION_TREES.flatMap(listProductionSources);

  it('scans every production tree', () => {
    for (const tree of PRODUCTION_TREES) {
      expect(productionSources.some((file) => file.startsWith(`${tree}/`))).toBe(true);
    }
    for (const foundation of RESERVED_FOUNDATIONS) expect(productionSources).toContain(foundation.definedIn);
  });

  it('the design document marks the slice reserved and lists every foundation', () => {
    const doc = readFileSync(resolve(ROOT, DESIGN_DOC), 'utf-8');
    // The dated Status line every design doc carries (test/design-doc-status.test.ts).
    expect(doc).toMatch(/^\*\*Status \(\d{4}-\d{2}-\d{2}\):\*\* Reserved\b/mu);
    const status = sectionOf(doc, '## Implementation status');
    expect(status, `${DESIGN_DOC} must keep its "Implementation status" section`).not.toBe('');
    expect(status, 'the "Implementation status" section must itself call the slice reserved').toMatch(
      /\bslice is reserved\b/u,
    );
    for (const foundation of RESERVED_FOUNDATIONS) expect(status).toContain(foundation.name);
  });

  it.each(RESERVED_FOUNDATIONS)('$name gains no new production use and stays documented as reserved', (foundation) => {
    expect(foundation.use.test(readFileSync(resolve(ROOT, foundation.exercisedBy), 'utf-8'))).toBe(true);

    const users = productionSources.filter(
      (file) => file !== foundation.definedIn && foundation.use.test(codeOf(file)),
    );
    expect(
      users,
      `${foundation.name} is reserved IronCurtain-in-IronCurtain scaffolding, so new production use is new ` +
        `wiring. Update ${DESIGN_DOC} ("Implementation status"), the comment in ${foundation.definedIn}, ` +
        `src/docker/CLAUDE.md and this guard together.`,
    ).toEqual(foundation.expectedUsers);

    const source = readFileSync(resolve(ROOT, foundation.definedIn), 'utf-8');
    expect(source, `${foundation.definedIn} must say ${foundation.name} is reserved`).toMatch(foundation.marker);
    expect(source).toContain(DESIGN_DOC);
  });
});
