/**
 * Seed a current-schema Docker-workload lease on disk, as an earlier (now
 * crashed or failed) coordinator would have left it, under the per-test
 * IRONCURTAIN_HOME. Used by the admission and operator-command tests.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDockerWorkloadLeaseDir, getDockerWorkloadStateRoot } from '../../../src/config/paths.js';
import {
  activateDockerWorkloadLease,
  createDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recordDockerWorkloadLeaseIncident,
  requestDockerWorkloadOuterResource,
} from '../../../src/docker-workload/bundle-lease.js';
import { DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY } from '../../../src/docker-workload/infrastructure.js';
import {
  loadFrozenWatchdogPolicyTemplate,
  renderWatchdogPolicy,
} from '../../../src/docker-workload/watchdog-policy.js';
import type { DockerContainerInfo } from '../../../src/docker/types.js';
import { WATCHDOG_TEMPLATE_PATH } from './infrastructure-harness.js';

export interface SeededLease {
  readonly leaseId: string;
  readonly leasePath: string;
  readonly generation: string;
}

export function seedDockerWorkloadLease(options: {
  readonly home: string;
  readonly leaseId: string;
  readonly heartbeatIso: string;
  /** Observed outer containers, by requested name and immutable ID. */
  readonly containers?: readonly { readonly name: string; readonly id: string }[];
  readonly incident?: { readonly code: string; readonly detail: string };
  /** Ownership label key recorded for every seeded resource (default: the shared key). */
  readonly ownershipLabelKey?: string;
}): SeededLease {
  const { leaseId } = options;
  const stateRoot = getDockerWorkloadStateRoot(leaseId);
  mkdirSync(join(stateRoot, 'staging'), { recursive: true, mode: 0o700 });
  const leaseDir = getDockerWorkloadLeaseDir(leaseId);
  mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
  const loadedPolicy = renderWatchdogPolicy(
    loadFrozenWatchdogPolicyTemplate(WATCHDOG_TEMPLATE_PATH),
    'docker',
    stateRoot,
    join(leaseDir, 'policy.json'),
  );
  const generation = `gen-${leaseId}`;
  const now = new Date(options.heartbeatIso);
  const leasePath = join(leaseDir, 'lease.json');
  createDockerWorkloadLease(leasePath, {
    leaseId,
    bundleId: `bundle-${leaseId}`,
    generation,
    runtimeKind: 'docker',
    dockerEndpoint: { host: 'unix:///var/run/docker.sock' },
    paths: {
      workspaceRoot: join(options.home, 'workspace'),
      stateRoot,
      runtimeRoot: join(stateRoot, 'daemon'),
      apiRoot: join(stateRoot, 'api'),
      exchangeRoot: join(stateRoot, 'exchange'),
      stagingRoot: join(stateRoot, 'staging'),
    },
    bindings: { watchdogPolicy: loadedPolicy.policy },
    cleanupInventoryGapMs: loadedPolicy.policy.cleanupInventoryGapMs,
    coordinatorPid: process.pid,
    now,
  });
  for (const [index, container] of (options.containers ?? []).entries()) {
    const requestId = `res-${index}`;
    requestDockerWorkloadOuterResource(
      leasePath,
      generation,
      {
        requestId,
        kind: 'container',
        role: index === 0 ? 'nested-daemon' : 'agent',
        requestedName: container.name,
        ownershipLabelKey: options.ownershipLabelKey ?? DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
      },
      now,
    );
    observeDockerWorkloadOuterResource(leasePath, generation, requestId, container.id, now);
  }
  if ((options.containers ?? []).length > 0) activateDockerWorkloadLease(leasePath, generation, now);
  if (options.incident !== undefined) {
    recordDockerWorkloadLeaseIncident(leasePath, generation, options.incident, new Date(now.getTime() + 1000));
  }
  return { leaseId, leasePath, generation };
}

/** A running outer container carrying `generation`'s ownership label. */
export function labelledContainer(id: string, name: string, generation: string): DockerContainerInfo {
  return {
    id,
    name,
    created: '2026-07-20T12:00:00Z',
    running: true,
    labels: { [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: generation },
  };
}
