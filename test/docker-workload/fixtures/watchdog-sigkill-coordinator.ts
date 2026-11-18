/**
 * Coordinator-role stub for the watchdog SIGKILL cross-process test.
 *
 * Plays the production coordinator faithfully: renders the per-session
 * Docker Desktop watchdog policy, creates the bundle lease (bound to its own
 * PID), records the observed agent, nested-daemon sidecar, daemon volume,
 * proxy, and network, activates the lease, launches the
 * detached watchdog supervisor via the production spawn path, then heartbeats
 * the lease until the test SIGKILLs it. It never exits on its own.
 *
 * argv: <sharedConfigPath> <entrypointPath> <resultPath>
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBundleRuntimeRootForHome } from '../../../src/config/paths.js';
import {
  activateDockerWorkloadLease,
  createDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
} from '../../../src/docker-workload/bundle-lease.js';
import { tryHeartbeatDockerWorkloadLease } from '../../../src/docker-workload/cleanup-ownership.js';
import { renderWatchdogPolicy, type WatchdogPolicyTemplate } from '../../../src/docker-workload/watchdog-policy.js';
import { launchDetachedResourceWatchdogSupervisor } from '../../../src/docker-workload/resource-watchdog-supervisor.js';

interface SharedFixtureConfig {
  readonly controlDir: string;
  readonly leaseId: string;
  readonly bundleId: string;
  readonly generation: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly proxyContainerId: string;
  readonly proxyContainerName: string;
  readonly daemonContainerId: string;
  readonly daemonContainerName: string;
  readonly volumeName: string;
  readonly networkId: string;
  readonly networkName: string;
  readonly labelKey: string;
  readonly labelValue: string;
  readonly template: WatchdogPolicyTemplate;
}

const sharedConfigPath = process.argv.at(2);
const entrypointPath = process.argv.at(3);
const resultPath = process.argv.at(4);
if (sharedConfigPath === undefined || entrypointPath === undefined || resultPath === undefined) {
  throw new Error('watchdog SIGKILL coordinator requires config, entrypoint, and result paths');
}

try {
  const config = JSON.parse(readFileSync(sharedConfigPath, 'utf8')) as SharedFixtureConfig;
  const ironCurtainHome = process.env.IRONCURTAIN_HOME;
  if (ironCurtainHome === undefined) throw new Error('watchdog SIGKILL coordinator requires IRONCURTAIN_HOME');
  const stateRoot = join(ironCurtainHome, 'docker-workload', 'state', config.leaseId);
  mkdirSync(join(stateRoot, 'staging'), { recursive: true });
  const leasePath = join(config.controlDir, 'lease.json');
  const policyPath = join(config.controlDir, 'policy.json');
  const statusPath = join(config.controlDir, 'status.json');
  const stopRequestPath = join(config.controlDir, 'stop.json');

  const rendered = renderWatchdogPolicy(config.template, 'docker', stateRoot, policyPath);
  createDockerWorkloadLease(leasePath, {
    leaseId: config.leaseId,
    bundleId: config.bundleId,
    generation: config.generation,
    runtimeKind: 'docker',
    dockerEndpoint: { host: 'unix:///var/run/docker.sock' },
    paths: {
      workspaceRoot: join(config.controlDir, 'workspace'),
      stateRoot,
      bundleRuntimeRoot: getBundleRuntimeRootForHome(ironCurtainHome, config.bundleId),
      runtimeRoot: join(stateRoot, 'runtime'),
      apiRoot: join(stateRoot, 'api'),
      exchangeRoot: join(stateRoot, 'exchange'),
      stagingRoot: join(stateRoot, 'staging'),
    },
    bindings: {
      watchdogPolicy: rendered.policy,
    },
    cleanupInventoryGapMs: config.template.cleanupInventoryGapMs,
  });
  requestDockerWorkloadOuterResource(leasePath, config.generation, {
    requestId: 'agent-container-001',
    kind: 'container',
    role: 'agent',
    requestedName: config.containerName,
    ownershipLabelKey: config.labelKey,
  });
  observeDockerWorkloadOuterResource(leasePath, config.generation, 'agent-container-001', config.containerId);
  requestDockerWorkloadOuterResource(leasePath, config.generation, {
    requestId: 'daemon-api-volume-001',
    kind: 'volume',
    role: 'daemon-api',
    requestedName: config.volumeName,
    ownershipLabelKey: config.labelKey,
  });
  observeDockerWorkloadOuterResource(leasePath, config.generation, 'daemon-api-volume-001', config.volumeName);
  requestDockerWorkloadOuterResource(leasePath, config.generation, {
    requestId: 'nested-daemon-001',
    kind: 'container',
    role: 'nested-daemon',
    requestedName: config.daemonContainerName,
    ownershipLabelKey: config.labelKey,
  });
  observeDockerWorkloadOuterResource(leasePath, config.generation, 'nested-daemon-001', config.daemonContainerId);
  requestDockerWorkloadOuterResource(leasePath, config.generation, {
    requestId: 'transport-proxy-001',
    kind: 'container',
    role: 'proxy',
    requestedName: config.proxyContainerName,
    ownershipLabelKey: config.labelKey,
  });
  observeDockerWorkloadOuterResource(leasePath, config.generation, 'transport-proxy-001', config.proxyContainerId);
  requestDockerWorkloadOuterResource(leasePath, config.generation, {
    requestId: 'transport-network-001',
    kind: 'network',
    role: 'transport-network',
    requestedName: config.networkName,
    ownershipLabelKey: config.labelKey,
  });
  observeDockerWorkloadOuterResource(leasePath, config.generation, 'transport-network-001', config.networkId);
  activateDockerWorkloadLease(leasePath, config.generation);

  const launched = await launchDetachedResourceWatchdogSupervisor({
    leasePath,
    policyPath,
    statusPath,
    stopRequestPath,
    entrypointPath,
    startupTimeoutMs: 30_000,
  });

  writeResultAtomically(resultPath, { coordinatorPid: process.pid, supervisorPid: launched.pid });

  // Heartbeat forever; only the test's SIGKILL ends this process. A terminal
  // lease would make heartbeats throw, but by then this process is dead.
  setInterval(() => {
    try {
      tryHeartbeatDockerWorkloadLease({ leasePath, generation: config.generation, clock: () => new Date() });
    } catch {
      // Transient lock contention; the next interval retries.
    }
  }, 100);
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeResultAtomically(resultPath, { error: message });
  process.exit(1);
}

/** Write-then-rename so the test never observes a partially written result file. */
function writeResultAtomically(path: string, result: object): void {
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  renameSync(tempPath, path);
}
