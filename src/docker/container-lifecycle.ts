/**
 * Shared container lifecycle helpers used by both DockerAgentSession and
 * runPtySession to avoid duplicating stop/remove/network-cleanup logic.
 */

import type { ContainerRuntime } from './types.js';
import type { DockerWorkloadBundleHandle } from '../docker-workload/infrastructure.js';
import { finalizeManagedResourceLease, type ManagedLeaseFinalization } from './docker-resource-lifecycle.js';
import { errorMessage } from '../utils/error-message.js';
import * as logger from '../logger.js';

/** What a best-effort teardown could prove about the resources it removed. */
export interface ContainerCleanupResult {
  /** True only when every container and network passed to the cleanup was verified absent. */
  readonly verified: boolean;
  /** Resources that still existed after removal, or whose absence could not be checked. */
  readonly remaining: readonly string[];
}

/**
 * Stop and remove Docker containers and their per-session network in parallel.
 * Best-effort: individual failures are swallowed so one broken container
 * doesn't prevent cleanup of the others, but the result reports what could
 * not be verified gone so the owner lease can be finalized truthfully.
 */
export async function cleanupContainers(
  docker: ContainerRuntime,
  opts: {
    containerId: string | null;
    sidecarContainerId: string | null;
    networkName: string | null;
  },
): Promise<ContainerCleanupResult> {
  const cleanups: Promise<void>[] = [];
  const remaining: string[] = [];

  if (opts.containerId) {
    const cid = opts.containerId;
    cleanups.push(
      docker
        .stop(cid)
        .then(() => docker.remove(cid))
        .catch(() => {}),
    );
  }

  if (opts.sidecarContainerId) {
    const sid = opts.sidecarContainerId;
    cleanups.push(
      docker
        .stop(sid)
        .then(() => docker.remove(sid))
        .catch(() => {}),
    );
  }

  await Promise.all(cleanups);

  for (const id of [opts.containerId, opts.sidecarContainerId]) {
    if (!id) continue;
    if (await docker.containerExists(id).catch(() => true)) {
      logger.warn(`cleanupContainers: container ${id} still exists after removal`);
      remaining.push(`container ${id}`);
    }
  }

  // Remove per-session internal network after both containers are gone
  if (opts.networkName !== null) {
    await docker.removeNetwork(opts.networkName).catch(() => {});
    if (!docker.networkExists) {
      remaining.push(`network ${opts.networkName} (unverifiable)`);
    } else if (await docker.networkExists(opts.networkName).catch(() => true)) {
      logger.warn(`cleanupContainers: network ${opts.networkName} still exists after removal`);
      remaining.push(`network ${opts.networkName}`);
    }
  }

  return { verified: remaining.length === 0, remaining };
}

export interface DestroyBundleOuterResourcesOptions {
  readonly docker: ContainerRuntime;
  /** Present only for an admitted secure nested Docker-workload bundle. */
  readonly dockerWorkload: DockerWorkloadBundleHandle | undefined;
  readonly containerId: string | null;
  readonly sidecarContainerId: string | null;
  readonly networkName: string | null;
  /** The bundle id whose managed-resource owner lease should be finalized. */
  readonly bundleId: string;
  /** Call-site name, used to prefix a teardown-failure warning. */
  readonly context: string;
}

/**
 * Single teardown path for a bundle's outer resources, shared by
 * `destroyDockerInfrastructure`, the `assembleDockerInfrastructure` failure
 * path, and the PTY session `finally`.
 *
 * §8.3 ordering: an admitted Docker-workload bundle tears its LEDGERED outer
 * resources (including the multi-homed agent and its egress network) down
 * through the lease first, by exact identity with absence proofs.
 *
 * For an admitted Docker-workload bundle, the MCP/MITM(/PTY) transport and its
 * per-session network share that same ledger, so the detached watchdog can
 * remove every outer resource after a coordinator crash. `cleanupContainers`
 * remains a harmless belt-and-braces sweep and owns the transport lifecycle for
 * ordinary Docker sessions, which have no workload lease.
 *
 * Finally the managed-resource owner lease is finalized
 * (docs/designs/pty-gc-ownership.md): deleted when the teardown was verified
 * and no resource carries its token, otherwise left as a `released`
 * tombstone so the next reconciliation reclaims the leftovers even though
 * this (possibly long-lived) process is still running. A no-op for bundles
 * that never minted a lease (Docker-workload bundles).
 */
export async function destroyBundleOuterResources(
  options: DestroyBundleOuterResourcesOptions,
): Promise<ManagedLeaseFinalization> {
  if (options.dockerWorkload) {
    await options.dockerWorkload
      .teardown()
      .catch((err: unknown) =>
        logger.warn(`${options.context}: dockerWorkload.teardown() failed: ${errorMessage(err)}`),
      );
  }
  const cleanup = await cleanupContainers(options.docker, {
    containerId: options.containerId,
    sidecarContainerId: options.sidecarContainerId,
    networkName: options.networkName,
  });
  if (!cleanup.verified) {
    logger.warn(`${options.context}: teardown left or could not verify: ${cleanup.remaining.join(', ')}`);
  }
  return finalizeManagedResourceLease(options.bundleId, {
    runtime: options.docker,
    teardownVerified: cleanup.verified,
  });
}
