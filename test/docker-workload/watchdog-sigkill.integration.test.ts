/**
 * Cross-process proof that the detached resource-watchdog supervisor survives
 * a coordinator SIGKILL and still enforces bundle revocation.
 *
 * A real coordinator-role child process creates the lease, renders the policy,
 * and launches the real detached supervisor through the production spawn path
 * (`launchDetachedResourceWatchdogSupervisor` -> resource-watchdog-supervisor-main).
 * The test then SIGKILLs the coordinator and proves the supervisor is still
 * alive, does not revoke while nothing has tripped, and — once the Docker
 * Desktop daemon volume grows past the frozen hard threshold after the
 * coordinator is dead — revokes the leased containers and volume, removes the
 * exact bundle state, closes the lease with a two-inventory cleanup proof, and
 * exits. The volume size reaches the supervisor the production way: the
 * outer Engine's `system df` report, parsed by DockerManager.
 *
 * Hermetic: no Docker daemon. The supervisor's DockerManager resolves a
 * stateful `docker` stub from PATH; the stub logs every invocation to a JSONL
 * evidence file the test asserts against.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getBundleRuntimeRoot } from '../../src/config/paths.js';
import type { BundleId } from '../../src/session/types.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import {
  loadResourceWatchdogSupervisorStatus,
  type ResourceWatchdogSupervisorStatus,
} from '../../src/docker-workload/resource-watchdog-supervisor.js';
import { getProcessStartIdentity } from '../../src/docker-workload/process-lock.js';
import type { WatchdogPolicyTemplate } from '../../src/docker-workload/watchdog-policy.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const coordinatorPath = join(repoRoot, 'test', 'docker-workload', 'fixtures', 'watchdog-sigkill-coordinator.ts');
const dockerStubPath = join(repoRoot, 'test', 'docker-workload', 'fixtures', 'watchdog-sigkill-docker-stub.mjs');
const entrypointPath = join(repoRoot, 'src', 'docker-workload', 'resource-watchdog-supervisor-main.ts');

const GENERATION = 'generation-sigkill-cross-001';
const CONTAINER_ID = `cafe${'0123456789abcdef'.repeat(3)}baseddecafc0ffee`;
const CONTAINER_NAME = 'ironcurtain-sigkill-agent-001';
const PROXY_CONTAINER_ID = `face${'fedcba9876543210'.repeat(3)}cafe0123456789`;
const PROXY_CONTAINER_NAME = 'ironcurtain-sigkill-proxy-001';
const NETWORK_ID = `beef${'0011223344556677'.repeat(3)}feed89abcdef01`;
const NETWORK_NAME = 'ironcurtain-sigkill-network-001';
const DAEMON_CONTAINER_ID = `d00d${'89abcdef01234567'.repeat(3)}0123456789abcd`;
const DAEMON_CONTAINER_NAME = 'ironcurtain-sigkill-nested-daemon-001';
const VOLUME_NAME = 'ic-dw-daemon-api-sigkill001';
const LABEL_KEY = 'ironcurtain.workload.generation';

const template: WatchdogPolicyTemplate = {
  schemaVersion: 2,
  policyId: 'sigkill-cross-process-watchdog-v2',
  coverage: {
    docker: {
      runtimeReserveBytes: 1,
      stateClasses: [
        {
          id: 'desktop-daemon-volume',
          kind: 'docker-volume',
          role: 'daemon-api',
          sampleIntervalMs: 1000,
          sampleTimeoutMs: 5000,
          staleAfterMs: 20_000,
        },
      ],
    },
  },
  sampleIntervalMs: 100,
  sampleTimeoutMs: 500,
  // Generous staleness bound so CI scheduling hiccups cannot fake a
  // sample-stale trip; hard-threshold detection still happens on the next
  // ~100ms tick after the breach.
  staleAfterMs: 2000,
  softEvidenceBytes: 256 * 1024,
  hardSafetyBytes: 1024 * 1024,
  hostReserveBytes: 1,
  maximumOvershootBytes: 16 * 1024 * 1024,
  cleanupInventoryGapMs: 100,
};

const temporaryDirectories: string[] = [];
const spawnedChildren: ChildProcess[] = [];
const detachedProcesses: TrackedProcess[] = [];

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) killChildIfRunning(child);
  for (const tracked of detachedProcesses.splice(0)) killTrackedProcessIfSameInstance(tracked);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface TrackedProcess {
  readonly pid: number;
  readonly processIdentity: string;
}

describe('resource watchdog supervisor across a coordinator SIGKILL', () => {
  it('outlives the coordinator and revokes a post-mortem hard-threshold breach', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchdog-sigkill-'));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    const binDir = join(directory, 'bin');
    const stubDir = join(directory, 'stub');
    mkdirSync(binDir);
    mkdirSync(stubDir);
    const ironCurtainHome = join(directory, 'home');
    const stateRoot = join(ironCurtainHome, 'docker-workload', 'state', 'lease-sigkill-cross-001');
    const leasePath = join(directory, 'lease.json');
    const statusPath = join(directory, 'status.json');
    const resultPath = join(directory, 'coordinator-result.json');
    const configPath = join(stubDir, 'config.json');
    const logPath = join(stubDir, 'invocations.log');
    const volumeSizePath = join(stubDir, 'volume-size');
    writeFileSync(volumeSizePath, '0B\n', { mode: 0o600 });
    const bundleId = 'bundle-sigkill-cross-001';
    const bundleRuntimeRoot = withIronCurtainHome(ironCurtainHome, () => getBundleRuntimeRoot(bundleId as BundleId));
    const neighboringRuntimeRoot = withIronCurtainHome(ironCurtainHome, () =>
      getBundleRuntimeRoot('neighbor-sigkill-cross-001' as BundleId),
    );
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(bundleRuntimeRoot, { recursive: true });
    mkdirSync(neighboringRuntimeRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(bundleRuntimeRoot, 'runtime-marker'), 'owned by the crashed bundle\n');
    const neighboringMarker = join(neighboringRuntimeRoot, 'unrelated-marker');
    const workspaceMarker = join(workspaceRoot, 'workspace-marker');
    writeFileSync(neighboringMarker, 'owned by another bundle\n');
    writeFileSync(workspaceMarker, 'workspace data\n');

    writeFileSync(
      configPath,
      `${JSON.stringify({
        controlDir: directory,
        leaseId: 'lease-sigkill-cross-001',
        bundleId,
        generation: GENERATION,
        containerId: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        proxyContainerId: PROXY_CONTAINER_ID,
        proxyContainerName: PROXY_CONTAINER_NAME,
        daemonContainerId: DAEMON_CONTAINER_ID,
        daemonContainerName: DAEMON_CONTAINER_NAME,
        volumeName: VOLUME_NAME,
        volumeSizePath,
        networkId: NETWORK_ID,
        networkName: NETWORK_NAME,
        labelKey: LABEL_KEY,
        labelValue: GENERATION,
        template,
        logPath,
        removedMarkerPath: join(stubDir, 'agent-removed.marker'),
        proxyRemovedMarkerPath: join(stubDir, 'proxy-removed.marker'),
        networkRemovedMarkerPath: join(stubDir, 'network-removed.marker'),
        daemonRemovedMarkerPath: join(stubDir, 'daemon-removed.marker'),
        volumeRemovedMarkerPath: join(stubDir, 'volume-removed.marker'),
      })}\n`,
      { mode: 0o600 },
    );
    const dockerShim = join(binDir, 'docker');
    // Execute the plain-JavaScript stub through the native `env` shim in its
    // shebang. It clears NODE_OPTIONS before Node starts, while the coordinator
    // and detached supervisor retain the tsx loader they need.
    symlinkSync(dockerStubPath, dockerShim);

    // IDE auto-attach instrumentation can delay each short-lived Docker stub
    // while it contends for a debugger port, eventually tripping DockerManager's
    // command timeout and violating this test's hermetic process boundary.
    const childEnv = { ...process.env };
    delete childEnv.VSCODE_INSPECTOR_OPTIONS;
    delete childEnv.VSCODE_INJECTION;
    childEnv.NODE_OPTIONS = '--import tsx';
    childEnv.IRONCURTAIN_HOME = ironCurtainHome;
    childEnv.IRONCURTAIN_WATCHDOG_DOCKER_STUB_CONFIG = configPath;
    childEnv.PATH = `${binDir}:${process.env.PATH ?? ''}`;

    const coordinator = spawn(process.execPath, [coordinatorPath, configPath, entrypointPath, resultPath], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedChildren.push(coordinator);
    const coordinatorPid = coordinator.pid;
    expect(coordinatorPid).toBeDefined();
    let coordinatorStderr = '';
    coordinator.stderr.on('data', (chunk: Buffer) => {
      coordinatorStderr += chunk.toString('utf8');
    });
    coordinator.stdout.resume();
    const coordinatorExit = watchExit(coordinator);

    let supervisorPid: number | undefined;
    let supervisorProcess: TrackedProcess | undefined;
    try {
      // Coordinator admits the bundle and launches the detached supervisor.
      await pollUntil(
        30_000,
        () => existsSync(resultPath),
        () => {
          const exited = coordinatorExit.exited ? ` (coordinator exited early)` : '';
          return `coordinator never reported a launch result${exited}: ${coordinatorStderr}`;
        },
      );
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
        readonly supervisorPid?: number;
        readonly error?: string;
      };
      if (result.error !== undefined || result.supervisorPid === undefined) {
        throw new Error(
          `coordinator failed before launch completed: ${result.error ?? 'no pid'}\n${coordinatorStderr}`,
        );
      }
      supervisorPid = result.supervisorPid;
      supervisorProcess = trackDetachedProcess(supervisorPid);
      detachedProcesses.push(supervisorProcess);
      expect(loadResourceWatchdogSupervisorStatus(statusPath)).toMatchObject({
        supervisorPid,
        state: 'ready',
        policyId: template.policyId,
      });

      // Negative proof: while the coordinator is alive and heartbeating, the
      // supervisor only measures (VM-disk statfs and Engine volume sizes) and
      // never revokes.
      const heartbeatBefore = loadDockerWorkloadLease(leasePath).coordinator.heartbeatAt;
      const negativeDeadline = Date.now() + 600;
      while (Date.now() < negativeDeadline) {
        expect(loadResourceWatchdogSupervisorStatus(statusPath).state).toBe('ready');
        expect(loadDockerWorkloadLease(leasePath).status).toBe('active');
        expect(readInvocations(logPath).filter((args) => !isMeasurement(args))).toEqual([]);
        await sleep(50);
      }
      await pollUntil(
        5000,
        () => readInvocations(logPath).some((args) => args[0] === 'system' && args[1] === 'df'),
        () => 'watchdog supervisor never sized the daemon volume through the Engine',
      );
      expect(readInvocations(logPath)).toContainEqual([
        'exec',
        '--user',
        '0:0',
        DAEMON_CONTAINER_ID,
        '/bin/busybox',
        'stat',
        '-f',
        '-c',
        '%S %b %f %a',
        '/home/codespace/.local/share',
      ]);
      await pollUntil(
        3000,
        () => Date.parse(loadDockerWorkloadLease(leasePath).coordinator.heartbeatAt) > Date.parse(heartbeatBefore),
        () => 'coordinator stub never advanced its lease heartbeat',
      );
      expect(coordinatorExit.exited).toBe(false);

      // SIGKILL the coordinator (no graceful exit) and prove the detached
      // supervisor survives and still does not revoke without a trip.
      coordinator.kill('SIGKILL');
      await pollUntil(
        5000,
        () => coordinatorExit.exited,
        () => 'coordinator did not die from SIGKILL',
      );
      expect(processIsSameInstance(supervisorProcess)).toBe(true);
      const survivalDeadline = Date.now() + 500;
      while (Date.now() < survivalDeadline) {
        expect(processIsSameInstance(supervisorProcess)).toBe(true);
        expect(loadResourceWatchdogSupervisorStatus(statusPath).state).toBe('ready');
        await sleep(50);
      }

      // Grow the daemon volume past the frozen hard threshold now that the
      // coordinator is dead; the orphaned supervisor must detect and revoke on
      // its own.
      const breachedAtMs = Date.now();
      writeFileSync(volumeSizePath, '2.1MB\n');
      let status: ResourceWatchdogSupervisorStatus | undefined;
      await pollUntil(
        20_000,
        () => {
          status = loadResourceWatchdogSupervisorStatus(statusPath);
          if (status.state === 'incident') {
            throw new Error(`watchdog supervisor incident instead of revocation: ${status.detail ?? 'unknown'}`);
          }
          return status.state === 'closed';
        },
        () => `watchdog supervisor never closed after the breach (state=${status?.state ?? 'unknown'})`,
      );
      const detectionLatencyMs = Date.now() - breachedAtMs;
      expect(status).toMatchObject({
        state: 'closed',
        supervisorPid,
        trip: { code: 'hard-state-threshold' },
      });

      // Revocation duty: exact container removal proof, exact state removal,
      // and a closed lease carrying the two-empty-inventory cleanup proof.
      const lease = loadDockerWorkloadLease(leasePath);
      expect(lease).toMatchObject({
        status: 'closed',
        cleanup: { exactOuterResourcesAbsent: true, stateRootAbsent: true },
      });
      expect(lease.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: 'agent-container-001',
            observedId: CONTAINER_ID,
            removal: expect.objectContaining({ proof: 'immutable-id-absent', identity: CONTAINER_ID }),
          }),
          expect.objectContaining({
            requestId: 'transport-proxy-001',
            observedId: PROXY_CONTAINER_ID,
            removal: expect.objectContaining({ proof: 'immutable-id-absent', identity: PROXY_CONTAINER_ID }),
          }),
          expect.objectContaining({
            requestId: 'transport-network-001',
            observedId: NETWORK_ID,
            removal: expect.objectContaining({ proof: 'immutable-id-absent', identity: NETWORK_ID }),
          }),
          expect.objectContaining({
            requestId: 'nested-daemon-001',
            observedId: DAEMON_CONTAINER_ID,
            removal: expect.objectContaining({ proof: 'immutable-id-absent', identity: DAEMON_CONTAINER_ID }),
          }),
          expect.objectContaining({
            requestId: 'daemon-api-volume-001',
            observedId: VOLUME_NAME,
            removal: expect.objectContaining({ proof: 'immutable-id-absent', identity: VOLUME_NAME }),
          }),
        ]),
      );
      expect(existsSync(stateRoot)).toBe(false);
      expect(existsSync(bundleRuntimeRoot)).toBe(false);
      expect(existsSync(neighboringMarker)).toBe(true);
      expect(existsSync(workspaceMarker)).toBe(true);
      expect(existsSync(leasePath)).toBe(true);

      // The docker stub proves the runtime side of revocation was exercised
      // with the exact leased identity.
      const invocations = readInvocations(logPath);
      expect(
        invocations.some((args) => args[0] === 'container' && args[1] === 'inspect' && args.includes(CONTAINER_ID)),
        JSON.stringify(invocations),
      ).toBe(true);
      expect(
        invocations.some(
          (args) => args[0] === 'container' && args[1] === 'inspect' && args.includes(PROXY_CONTAINER_ID),
        ),
      ).toBe(true);
      expect(invocations).toContainEqual(['stop', '-t', '10', CONTAINER_ID]);
      expect(invocations).toContainEqual(['stop', '-t', '10', PROXY_CONTAINER_ID]);
      expect(invocations).toContainEqual(['rm', '-f', CONTAINER_ID]);
      expect(invocations).toContainEqual(['rm', '-f', PROXY_CONTAINER_ID]);
      expect(invocations).toContainEqual(['stop', '-t', '10', DAEMON_CONTAINER_ID]);
      expect(invocations).toContainEqual(['rm', '-f', DAEMON_CONTAINER_ID]);
      expect(invocations).toContainEqual(['volume', 'rm', VOLUME_NAME]);
      expect(invocations).toContainEqual(['network', 'rm', NETWORK_ID]);
      // Revocation is independent of durable writes: every exact container and
      // the volume are gone before the ledgered pass removes the network.
      const volumeRemoveIndex = invocations.findIndex((args) => args[0] === 'volume' && args[1] === 'rm');
      const stopIndex = invocations.findIndex((args) => args[0] === 'stop');
      const removeIndex = invocations.findIndex((args) => args[0] === 'rm');
      const networkRemoveIndex = invocations.findIndex((args) => args[0] === 'network' && args[1] === 'rm');
      const postRemoveInventoryIndex = invocations.findIndex(
        (args, index) => index > networkRemoveIndex && args[0] === 'container' && args[1] === 'ls',
      );
      expect(stopIndex).toBeLessThan(removeIndex);
      expect(removeIndex).toBeLessThan(networkRemoveIndex);
      expect(volumeRemoveIndex).toBeLessThan(networkRemoveIndex);
      expect(networkRemoveIndex).toBeLessThan(postRemoveInventoryIndex);
      // Owned inventories are filtered by the daemon to this generation's
      // label; presence checks inspect the exact observed IDs. Nothing lists
      // every container on the host.
      const ownedFilter = ['--filter', `label=${LABEL_KEY}=${GENERATION}`];
      const ownedContainerInventory = ['container', 'ls', '--all', '--no-trunc', '--quiet', ...ownedFilter];
      expect(invocations[postRemoveInventoryIndex]).toEqual(ownedContainerInventory);
      expect(invocations.slice(removeIndex + 1)).not.toContainEqual(['inspect', CONTAINER_ID]);
      expect(invocations.slice(removeIndex + 1)).toContainEqual(['container', 'inspect', CONTAINER_ID]);
      const inventoryCalls = invocations.filter((args) => args[0] === 'container' && args[1] === 'ls');
      // The final revocation check plus the two cleanup-proof inventories.
      expect(inventoryCalls.length).toBeGreaterThanOrEqual(3);
      for (const call of inventoryCalls) {
        expect(call).toEqual(ownedContainerInventory);
      }
      for (const call of invocations.filter((args) => args[0] === 'network' && args[1] === 'ls')) {
        expect(call).toEqual(['network', 'ls', '--no-trunc', '--quiet', ...ownedFilter]);
      }

      // The supervisor exits after completing its duty.
      await pollUntil(
        5000,
        () => !processIsSameInstance(supervisorProcess as TrackedProcess),
        () => 'watchdog supervisor did not exit after closing its lease',
      );
      // Cleanup is identity-fenced: an absent process or a future process that
      // reuses this PID cannot be mistaken for the detached supervisor.
      expect(processIsSameInstance(supervisorProcess)).toBe(false);
      expect(detectionLatencyMs).toBeLessThan(15_000);
      console.info(`watchdog SIGKILL cross-process detection-to-closed latency: ${detectionLatencyMs}ms`);
    } finally {
      if (supervisorProcess !== undefined) killTrackedProcessIfSameInstance(supervisorProcess);
      killChildIfRunning(coordinator);
    }
  }, 60_000);
});

function readInvocations(logPath: string): readonly string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/** Read-only observations the supervisor makes every sample or volume interval. */
function isMeasurement(args: readonly string[]): boolean {
  return (
    (args[0] === 'exec' && args.includes('stat')) ||
    (args[0] === 'system' && args[1] === 'df') ||
    (args[0] === 'container' && (args[1] === 'ls' || args[1] === 'inspect')) ||
    (args[0] === 'volume' && (args[1] === 'ls' || args[1] === 'inspect'))
  );
}

function withIronCurtainHome<T>(home: string, operation: () => T): T {
  const previous = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = home;
  try {
    return operation();
  } finally {
    if (previous === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previous;
  }
}

function watchExit(child: ChildProcess): { exited: boolean } {
  const state = { exited: false };
  child.once('exit', () => {
    state.exited = true;
  });
  return state;
}

function trackDetachedProcess(pid: number): TrackedProcess {
  const processIdentity = getProcessStartIdentity(pid);
  if (processIdentity === undefined) throw new Error(`detached process ${pid} exited before its identity was captured`);
  return { pid, processIdentity };
}

function processIsSameInstance(tracked: TrackedProcess): boolean {
  try {
    return getProcessStartIdentity(tracked.pid) === tracked.processIdentity;
  } catch {
    return false;
  }
}

function killTrackedProcessIfSameInstance(tracked: TrackedProcess): void {
  if (!processIsSameInstance(tracked)) return;
  try {
    process.kill(tracked.pid, 'SIGKILL');
  } catch {
    // The exact process exited after the identity check.
  }
}

function killChildIfRunning(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // The child exited after the handle state check.
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function pollUntil(timeoutMs: number, condition: () => boolean, describeFailure: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error(describeFailure());
    await sleep(25);
  }
}
