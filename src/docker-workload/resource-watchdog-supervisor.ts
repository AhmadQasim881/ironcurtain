/** Coordinator-independent process wrapper for the host resource watchdog. */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { sha256HexSchema as sha256Schema, stableStringify } from '../hash.js';
import { assertCanonicalHostPath, writeStableJsonAtomic } from '../hardened-fs.js';
import {
  dockerWorkloadCleanupProofSchema,
  lifecycleIdentifierSchema as identifierSchema,
  timestampSchema,
  watchdogSampleSummarySchema as sampleSchema,
} from '../zod-helpers.js';
import { createContainerRuntime } from '../docker/container-runtime.js';
import type { ContainerRuntime } from '../docker/types.js';
import { inventoryOwnedResourceIds, revokeDockerWorkloadOuterResourcesBeforeLedger } from './bundle-revocation.js';
import { toWatchdogCleanupProof } from './bundle-cleanup.js';
import {
  loadDockerWorkloadLease,
  recordDockerWorkloadLeaseIncident,
  type DockerWorkloadCleanupProof,
  type DockerWorkloadLease,
} from './bundle-lease.js';
import {
  DockerWorkloadCleanupPreconditionError,
  isDockerWorkloadLifecycleClaimBusy,
  performSerializedDockerWorkloadCleanup,
  tryAcquireDockerWorkloadLifecycleClaim,
  type DockerWorkloadLifecycleClaimHandle,
} from './cleanup-ownership.js';
import {
  RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION,
  RESOURCE_WATCHDOG_TRIP_CODES,
  resourceWatchdogPolicySchema,
  ResourceWatchdog,
  type ResourceWatchdogAttestation,
  type ResourceWatchdogPolicy,
  type ResourceWatchdogSample,
  type ResourceWatchdogTrip,
} from '../docker/resource-watchdog.js';
import { createObservedStorageSampler, type DockerDesktopStorageProbe } from './observed-storage.js';
import { releaseDockerWorkloadEmergencyReserve } from './emergency-reserve.js';
import {
  lateObservationGapMs,
  monotonicNow as defaultMonotonicNow,
  PeerProgressTracker,
  resolveMonotonicClock,
} from '../docker/peer-liveness.js';
import { DOCKER_WORKLOAD_STALE_HEARTBEAT_MS, loadLeaseWatchdogPolicy } from './watchdog-policy.js';
import { boundIncidentDetail, incidentDetailFromError, preserveOriginalFailure } from './incident-detail.js';

/**
 * Supervisor status and stop-request protocol. Lease version 3 changed only the
 * coordinator record, so v2 and v3 generations both speak protocol 2; v1
 * generations keep protocol 1 until they close.
 */
export const RESOURCE_WATCHDOG_SUPERVISOR_SCHEMA_VERSION = 2;
export const MAX_RESOURCE_WATCHDOG_SUPERVISOR_JSON_BYTES = 1024 * 1024;
/** Bound on persisted free-text details (UTF-16 code units, as the schema counts them). */
const MAX_STATUS_DETAIL_CHARS = 8192;
/** Default stderr log of a launched supervisor, beside its status file in the lease directory. */
export const RESOURCE_WATCHDOG_SUPERVISOR_STDERR_FILE = 'supervisor-stderr.log';

/** The detached entrypoint's file name without its extension (`.ts` from source, `.js` in a build). */
const SUPERVISOR_ENTRYPOINT_BASENAME = 'resource-watchdog-supervisor-main';
/** Most stderr bytes a startup failure reads back from the log. */
const STARTUP_STDERR_TAIL_BYTES = 4096;
/** Parent Node options that select how modules load, and take a value. */
const LOADER_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--conditions',
  '-C',
]);
/** Parent Node flags that change how modules load or how their errors read. */
const LOADER_FLAGS: ReadonlySet<string> = new Set([
  '--enable-source-maps',
  '--experimental-strip-types',
  '--experimental-transform-types',
  '--no-experimental-strip-types',
]);

/**
 * Exact-recovery attempts the supervisor makes for its own lease once it is
 * an incident (a failed coordinator teardown, a failed trip revocation, or
 * its own failed cleanup of a silent coordinator), before it leaves the lease
 * to startup reconciliation and the operator.
 */
export const WATCHDOG_INCIDENT_RECOVERY_MAX_ATTEMPTS = 8;
const WATCHDOG_INCIDENT_RECOVERY_BASE_DELAY_MS = 5_000;
const WATCHDOG_INCIDENT_RECOVERY_MAX_DELAY_MS = 300_000;

/** Delay after failed attempt `attempt` (1-based): 5 s doubling, capped at 5 minutes. */
export function watchdogIncidentRecoveryBackoffMs(attempt: number): number {
  return Math.min(
    WATCHDOG_INCIDENT_RECOVERY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    WATCHDOG_INCIDENT_RECOVERY_MAX_DELAY_MS,
  );
}

const stopRequestSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(RESOURCE_WATCHDOG_SUPERVISOR_SCHEMA_VERSION)]),
    leaseId: identifierSchema,
    generation: identifierSchema,
    requestedAt: timestampSchema,
    cleanup: dockerWorkloadCleanupProofSchema,
  })
  .strict();
const tripSchema = z
  .object({
    code: z.enum(RESOURCE_WATCHDOG_TRIP_CODES),
    atMs: z.number().int().nonnegative(),
    detail: z.string().min(1).max(MAX_STATUS_DETAIL_CHARS),
    overshootBytes: z.number().int().nonnegative(),
    overshootWithinFrozenMaximum: z.boolean(),
  })
  .strict();
const supervisorStatusBaseSchema = z
  .object({
    leaseId: identifierSchema,
    generation: identifierSchema,
    supervisorPid: z.number().int().positive(),
    state: z.enum(['starting', 'ready', 'revoking', 'closed', 'incident']),
    policyId: identifierSchema,
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    lastSample: sampleSchema.nullable(),
    trip: tripSchema.nullable(),
    detail: z.string().min(1).max(MAX_STATUS_DETAIL_CHARS).nullable(),
  })
  .strict();
const supervisorStatusSchema = z
  .discriminatedUnion('schemaVersion', [
    supervisorStatusBaseSchema.extend({ schemaVersion: z.literal(1), policySha256: sha256Schema }),
    supervisorStatusBaseSchema.extend({
      schemaVersion: z.literal(RESOURCE_WATCHDOG_SUPERVISOR_SCHEMA_VERSION),
      policy: resourceWatchdogPolicySchema,
    }),
  ])
  .superRefine((status, context) => {
    if (status.schemaVersion === 2 && status.policyId !== status.policy.policyId) {
      context.addIssue({ code: 'custom', message: 'watchdog supervisor policy ID does not match its snapshot' });
    }
  });

export type ResourceWatchdogSupervisorStatus = z.infer<typeof supervisorStatusSchema>;
export type ResourceWatchdogSupervisorStopRequest = z.infer<typeof stopRequestSchema>;

export interface RunResourceWatchdogSupervisorOptions {
  readonly leasePath: string;
  readonly policyPath: string;
  readonly statusPath: string;
  readonly stopRequestPath: string;
  readonly runtime?: ContainerRuntime;
  /** Wall clock for persisted status, trip, and cleanup evidence. */
  readonly now?: () => Date;
  /**
   * Observer-local monotonic clock for every liveness judgement. Defaults to
   * `performance.now()`, or to `now` when only that is injected.
   */
  readonly monotonicNow?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam over the Docker Desktop storage readings; production reads them through `runtime`. */
  readonly storageProbe?: DockerDesktopStorageProbe;
}

export interface LaunchDetachedResourceWatchdogSupervisorOptions extends Omit<
  RunResourceWatchdogSupervisorOptions,
  'runtime' | 'now' | 'monotonicNow' | 'sleep' | 'storageProbe'
> {
  /** Usually {@link resolveResourceWatchdogSupervisorEntrypoint}; checked to exist before spawning. */
  readonly entrypointPath: string;
  readonly startupTimeoutMs: number;
  /**
   * Owner-only file that receives the child's stderr, truncated at each launch.
   * Defaults to {@link RESOURCE_WATCHDOG_SUPERVISOR_STDERR_FILE} beside the status file.
   */
  readonly stderrLogPath?: string;
}

/**
 * Run inside the detached child process until normal cleanup or a trip closes the lease.
 *
 * Coordinator liveness is judged by when this process saw `coordinator.heartbeatAt`
 * change, on its own monotonic clock, never by comparing that timestamp with the
 * local wall clock. `lease.sequence` is no liveness signal: every writer bumps it.
 *
 * Revocation must not depend on durable writes. A trip publishes a
 * best-effort `revoking` status, stops and removes the exact containers and
 * volumes without writing anything, and only then frees the lease's
 * emergency reserve (so the stopped bundle cannot consume it) and runs the
 * ledgered cleanup. Status publication after attestation is best-effort,
 * building the record included: a full disk can make the record stale (the
 * coordinator then tears down on its own) but can never stop this process
 * from enforcing.
 */
export async function runResourceWatchdogSupervisor(options: RunResourceWatchdogSupervisorOptions): Promise<void> {
  assertCanonicalPrivatePath(options.statusPath, 'watchdog supervisor status');
  assertCanonicalPrivatePath(options.stopRequestPath, 'watchdog supervisor stop request');
  const now = options.now ?? (() => new Date());
  const injectedNow = options.now;
  const monotonicNow = resolveMonotonicClock(
    injectedNow === undefined ? undefined : () => injectedNow().getTime(),
    options.monotonicNow,
  );
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  let lease = loadDockerWorkloadLease(options.leasePath);
  const loadedPolicy = loadLeaseWatchdogPolicy(lease, options.policyPath);
  for (const controlPath of [options.leasePath, options.policyPath, options.statusPath, options.stopRequestPath]) {
    if (controlPath === lease.paths.stateRoot || controlPath.startsWith(`${lease.paths.stateRoot}/`)) {
      throw new Error('watchdog supervisor control files must be outside the revocable state root');
    }
  }
  const runtime =
    options.runtime ??
    createContainerRuntime(lease.runtimeKind, lease.schemaVersion === 1 ? undefined : lease.dockerEndpoint);
  if (
    lease.schemaVersion !== 1 &&
    lease.dockerEndpoint !== undefined &&
    runtime.dockerEndpoint?.host !== lease.dockerEndpoint.host
  ) {
    throw new Error('watchdog runtime does not match the recorded Docker endpoint');
  }
  const leaseDirectory = dirname(options.leasePath);
  const startedAt = now().toISOString();
  const baseStatus = {
    schemaVersion: watchdogSupervisorProtocolVersion(lease),
    leaseId: lease.leaseId,
    generation: lease.generation,
    supervisorPid: process.pid,
    ...watchdogSupervisorPolicyBinding(lease),
    policyId: loadedPolicy.policy.policyId,
    startedAt,
  } as const;
  let lastStatus = supervisorStatusSchema.parse({
    ...baseStatus,
    state: 'starting',
    updatedAt: startedAt,
    lastSample: null,
    trip: null,
    detail: null,
  });
  writeStrictJsonAtomic(options.statusPath, lastStatus);
  /**
   * Build the next status, record it in memory, and publish it if the disk
   * allows. Never throws: building runs here too, so not even a record the
   * status schema refuses can stand between a trip and its revocation.
   * Returns what kept the record off the disk (empty once it is written), so a
   * failure path can attach that to the error it reports without letting it
   * replace that error.
   */
  const publishStatus = (build: () => ResourceWatchdogSupervisorStatus): readonly unknown[] => {
    try {
      lastStatus = build();
      writeStrictJsonAtomic(options.statusPath, lastStatus);
      return [];
    } catch (statusError) {
      // A later successful write publishes the latest state. Enforcement
      // never waits on this record.
      return [statusError];
    }
  };
  /**
   * Stop and remove exact containers and volumes without any durable write,
   * then free the emergency reserve; never throws. The order matters: a
   * bundle still filling the disk would consume a reserve freed while it
   * runs, leaving nothing for the ledgered evidence the reserve exists for.
   */
  const revokeBeforeLedger = async (): Promise<void> => {
    let current = lease;
    try {
      current = loadDockerWorkloadLease(options.leasePath);
    } catch {
      // Revoke what the last good snapshot ledgered.
    }
    await revokeDockerWorkloadOuterResourcesBeforeLedger(runtime, current);
    releaseDockerWorkloadEmergencyReserve(leaseDirectory);
  };

  let attestation: ResourceWatchdogAttestation | undefined;
  let tripped: ResourceWatchdogTrip | undefined;
  let sampleClaim: DockerWorkloadLifecycleClaimHandle | undefined;
  const policy = loadedPolicy.policy;
  const storageSampler =
    policy.schemaVersion === RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION
      ? createObservedStorageSampler({
          policy,
          readLease: () => lease,
          runtime,
          now: () => now().getTime(),
          monotonicNow,
          ...(options.storageProbe === undefined ? {} : { dockerDesktopProbe: options.storageProbe }),
        })
      : undefined;
  const watchdog = new ResourceWatchdog(policy, {
    schedule: false,
    now: () => now().getTime(),
    monotonicNow,
    ...(storageSampler === undefined ? {} : { sample: storageSampler }),
    onTrip: async (trip) => {
      tripped = trip;
      const revoking = (): ResourceWatchdogSupervisorStatus =>
        statusUpdate(lastStatus, now(), {
          state: 'revoking',
          trip: compactTrip(trip),
          detail: trip.detail,
        });
      // Tell the coordinator promptly when the disk allows. Nothing durable,
      // this record included, gates the write-free revocation that follows.
      const announced = publishStatus(revoking).length === 0;
      await revokeBeforeLedger();
      // The bundle can no longer write and the reserve is free: retry a
      // record a full disk refused before revocation.
      if (!announced) publishStatus(revoking);
      // A trip happens inside a claimed sample: hand that claim to cleanup
      // instead of writing a new lock record.
      const heldClaim = sampleClaim;
      sampleClaim = undefined;
      try {
        const result = await performSerializedDockerWorkloadCleanup({
          runtime,
          leasePath: options.leasePath,
          generation: lease.generation,
          targetDevice: policy.targetDevice,
          targetInode: policy.targetInode,
          gapMs: policy.cleanupInventoryGapMs,
          clock: now,
          sleep,
          waitForOwner: true,
          ...(heldClaim === undefined ? {} : { claim: heldClaim }),
        });
        watchdog.stopAfterCleanup(toWatchdogCleanupProof(result.cleanup));
        publishStatus(() =>
          statusUpdate(lastStatus, now(), {
            state: 'closed',
            trip: compactTrip(trip),
            detail: 'resource trip revoked exact outer resources and completed cleanup',
          }),
        );
      } catch (error) {
        const detail = incidentDetailFromError(error);
        try {
          const current = loadDockerWorkloadLease(options.leasePath);
          if (current.status !== 'incident' && current.status !== 'closed') {
            recordDockerWorkloadLeaseIncident(
              options.leasePath,
              current.generation,
              { code: 'watchdog-revocation-failed', detail },
              now(),
            );
          }
        } catch {
          // Status remains authoritative evidence that revocation was not completed.
        }
        // A status the disk refuses travels with the revocation failure; it
        // never replaces it.
        throw preserveOriginalFailure(
          error,
          publishStatus(() =>
            statusUpdate(lastStatus, now(), {
              state: 'incident',
              trip: compactTrip(trip),
              detail,
            }),
          ),
        );
      }
    },
    onSoftEvidence: (sample) => {
      publishStatus(() => statusUpdate(lastStatus, now(), { lastSample: compactSample(sample) }));
    },
  });
  /**
   * One bounded exact-recovery attempt for this lease's incident, at most once
   * per backoff delay: the same serialized cleanup reconciliation runs, after
   * the same write-free stop a trip uses. Another lifecycle owner working on
   * the lease is not a failed attempt. Returns whether the supervisor is done.
   */
  const incidentRecovery = { attempts: 0, nextAttemptAtMs: Number.NEGATIVE_INFINITY };
  const retryIncidentRecovery = async (): Promise<'closed' | 'waiting' | 'gave-up'> => {
    if (monotonicNow() < incidentRecovery.nextAttemptAtMs) return 'waiting';
    incidentRecovery.attempts += 1;
    try {
      const result = await performSerializedDockerWorkloadCleanup({
        runtime,
        leasePath: options.leasePath,
        generation: lease.generation,
        targetDevice: policy.targetDevice,
        targetInode: policy.targetInode,
        gapMs: policy.cleanupInventoryGapMs,
        clock: now,
        sleep,
        waitForOwner: false,
        revalidate: (claimedLease) => {
          if (
            claimedLease.incident === null ||
            (claimedLease.status !== 'incident' && claimedLease.status !== 'revoking')
          ) {
            throw new DockerWorkloadCleanupPreconditionError(
              `lease state ${claimedLease.status} no longer awaits incident recovery`,
            );
          }
        },
        beforeLeaseMutation: revokeBeforeLedger,
      });
      // Someone else closed it meanwhile: the closed-lease path validates that proof.
      if (result.alreadyClosed) return 'waiting';
      watchdog.stopAfterCleanup(toWatchdogCleanupProof(result.cleanup));
      publishStatus(() =>
        statusUpdate(lastStatus, now(), {
          state: 'closed',
          detail: `lease incident recovered by the watchdog supervisor (attempt ${incidentRecovery.attempts})`,
        }),
      );
      return 'closed';
    } catch (error) {
      if (isDockerWorkloadLifecycleClaimBusy(error) || error instanceof DockerWorkloadCleanupPreconditionError) {
        incidentRecovery.attempts -= 1;
        return 'waiting';
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (incidentRecovery.attempts >= WATCHDOG_INCIDENT_RECOVERY_MAX_ATTEMPTS) {
        publishStatus(() =>
          statusUpdate(lastStatus, now(), {
            state: 'incident',
            detail:
              `lease incident: exact recovery failed ${incidentRecovery.attempts} times (${reason}); it awaits ` +
              'startup reconciliation or `ironcurtain docker-workload reconcile`',
          }),
        );
        return 'gave-up';
      }
      const delayMs = watchdogIncidentRecoveryBackoffMs(incidentRecovery.attempts);
      incidentRecovery.nextAttemptAtMs = monotonicNow() + delayMs;
      publishStatus(() =>
        statusUpdate(lastStatus, now(), {
          state: 'incident',
          detail: `lease incident: exact recovery attempt ${incidentRecovery.attempts} failed (${reason}); retrying in ${Math.round(delayMs / 1000)}s`,
        }),
      );
      return 'waiting';
    }
  };

  const validateCleanupOrPublishIncident = async (candidate: DockerWorkloadLease) => {
    try {
      return await validateDurableCleanup(runtime, candidate);
    } catch (error) {
      throw preserveOriginalFailure(
        error,
        publishStatus(() =>
          statusUpdate(lastStatus, now(), { state: 'incident', detail: incidentDetailFromError(error) }),
        ),
      );
    }
  };

  try {
    sampleClaim = await waitForSamplingClaim(options.leasePath, sleep);
    lease = loadDockerWorkloadLease(options.leasePath);
    if (lease.status === 'closed') {
      const cleanup = await validateCleanupOrPublishIncident(lease);
      watchdog.stopAfterCleanup(toWatchdogCleanupProof(cleanup));
      publishStatus(() =>
        statusUpdate(lastStatus, now(), { state: 'closed', detail: 'durable lease cleanup observed' }),
      );
      return;
    }
    attestation = await watchdog.start();
  } catch (error) {
    // A startup resource trip closes through onTrip and then makes start()
    // reject because no ready attestation exists. Only that proven terminal
    // path is success; a forged/invalid closed proof remains an incident.
    if (lastStatus.state === 'closed') return;
    throw error;
  } finally {
    sampleClaim?.release();
    sampleClaim = undefined;
  }
  // `ready` is the launch handshake: the coordinator admits nothing without it.
  lastStatus = statusUpdate(lastStatus, now(), {
    state: 'ready',
    lastSample: compactSample(attestation.firstSample),
    detail: 'watchdog startup attestation passed',
  });
  writeStrictJsonAtomic(options.statusPath, lastStatus);

  // Observed at the top of every iteration, in the cleanup revalidation, and
  // while sampling waits on a busy lifecycle claim. Each observation is cheap
  // and keeps the observer's own gaps short, so a late observation can only
  // mean this process was suspended, stopped, or starved.
  const coordinatorHeartbeat = new PeerProgressTracker({
    staleAfterMs: DOCKER_WORKLOAD_STALE_HEARTBEAT_MS,
    lateAfterMs: coordinatorHeartbeatLateAfterMs(policy),
    monotonicNow,
    wallNow: () => now().getTime(),
  });
  coordinatorHeartbeat.observe(lease.coordinator.heartbeatAt);

  for (;;) {
    await sleep(policy.sampleIntervalMs);
    lease = loadDockerWorkloadLease(options.leasePath);
    const coordinatorStale =
      (lease.status === 'admitting' || lease.status === 'active') &&
      coordinatorHeartbeat.observe(lease.coordinator.heartbeatAt).stale;
    if (lease.status === 'closed') {
      try {
        sampleClaim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: options.leasePath });
      } catch (error) {
        if (isDockerWorkloadLifecycleClaimBusy(error)) continue;
        throw error;
      }
      try {
        lease = loadDockerWorkloadLease(options.leasePath);
        if (lease.status !== 'closed') continue;
        const cleanup = await validateCleanupOrPublishIncident(lease);
        watchdog.stopAfterCleanup(toWatchdogCleanupProof(cleanup));
        publishStatus(() =>
          statusUpdate(lastStatus, now(), { state: 'closed', detail: 'durable lease cleanup observed' }),
        );
        return;
      } finally {
        sampleClaim.release();
        sampleClaim = undefined;
      }
    }
    const stopRequest = tryLoadStopRequest(options.stopRequestPath);
    if (stopRequest !== undefined) {
      try {
        sampleClaim = tryAcquireDockerWorkloadLifecycleClaim({ leasePath: options.leasePath });
      } catch (error) {
        if (isDockerWorkloadLifecycleClaimBusy(error)) continue;
        throw error;
      }
      try {
        lease = loadDockerWorkloadLease(options.leasePath);
        if (stopRequest.leaseId !== lease.leaseId || stopRequest.generation !== lease.generation) {
          throw new Error('watchdog supervisor stop request lease identity mismatch');
        }
        if (lease.status !== 'closed') {
          throw new Error(`watchdog supervisor refuses terminal stop from lease state ${lease.status}`);
        }
        const cleanup = await validateCleanupOrPublishIncident(lease);
        if (stableStringify(cleanup) !== stableStringify(stopRequest.cleanup)) {
          throw new Error('watchdog supervisor stop request cleanup proof does not match the durable lease proof');
        }
        watchdog.stopAfterCleanup(toWatchdogCleanupProof(cleanup));
      } finally {
        sampleClaim.release();
        sampleClaim = undefined;
      }
      publishStatus(() =>
        statusUpdate(lastStatus, now(), {
          state: 'closed',
          detail: 'coordinator cleanup proof accepted',
        }),
      );
      return;
    }
    if (lease.status === 'incident') {
      // Cleanup failed (a coordinator teardown, or this process's own trip
      // revocation). Keep the bundle's resources from lingering until the next
      // nested session: retry exact recovery with backoff, bounded.
      if ((await retryIncidentRecovery()) === 'waiting') continue;
      return;
    }
    if (lease.status === 'revoking' || coordinatorStale) {
      // Mutated by the cleanup hook; an object keeps the flag visible to flow analysis.
      const preLedger = { revoked: false };
      try {
        const result = await performSerializedDockerWorkloadCleanup({
          runtime,
          leasePath: options.leasePath,
          generation: lease.generation,
          targetDevice: policy.targetDevice,
          targetInode: policy.targetInode,
          gapMs: policy.cleanupInventoryGapMs,
          clock: now,
          sleep,
          waitForOwner: false,
          revalidate: (claimedLease) => {
            if (claimedLease.status === 'revoking') return;
            if (claimedLease.status !== 'admitting' && claimedLease.status !== 'active') {
              throw new DockerWorkloadCleanupPreconditionError(
                `lease state ${claimedLease.status} no longer permits supervisor cleanup`,
              );
            }
            if (!coordinatorHeartbeat.observe(claimedLease.coordinator.heartbeatAt).stale) {
              throw new DockerWorkloadCleanupPreconditionError(
                'coordinator heartbeat refreshed before cleanup ownership',
              );
            }
          },
          beforeLeaseMutation: async () => {
            preLedger.revoked = true;
            await revokeBeforeLedger();
          },
        });
        watchdog.stopAfterCleanup(toWatchdogCleanupProof(result.cleanup));
        publishStatus(() =>
          statusUpdate(lastStatus, now(), {
            state: 'closed',
            detail: 'stale coordinator triggered exact cleanup',
          }),
        );
        return;
      } catch (error) {
        if (isDockerWorkloadLifecycleClaimBusy(error) || error instanceof DockerWorkloadCleanupPreconditionError) {
          continue;
        }
        // Ownership itself failed (a lock record a full disk refused, for
        // example). The coordinator is stale or already revoking, so still
        // take the bundle down before giving up on the ledger.
        if (!preLedger.revoked) await revokeBeforeLedger();
        // A failed cleanup that recorded an incident is retried with backoff
        // by the incident branch, as after a failed trip revocation. Without
        // a durable incident there is nothing to retry from: fail as before.
        if (leaseRecordsIncident(options.leasePath)) continue;
        throw error;
      }
    }
    try {
      sampleClaim = await waitForSamplingClaim(options.leasePath, sleep, () => {
        const busyLease = loadDockerWorkloadLease(options.leasePath);
        if (busyLease.status !== 'admitting' && busyLease.status !== 'active') return false;
        if (coordinatorHeartbeat.observe(busyLease.coordinator.heartbeatAt).stale) return false;
        watchdog.deferSamplingForTrustedLifecycleOperation();
        return true;
      });
    } catch (error) {
      if (error instanceof LeaseLeftSamplingError) continue;
      // Taking the claim writes a lock record. If that fails (for example a
      // full disk), this process cannot sample under ownership: fail closed
      // rather than exit and leave the bundle unwatched.
      await watchdog.failClosed(
        'sample-error',
        `watchdog could not take its lifecycle claim: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (sampleClaim === undefined) continue;
    let sample: ResourceWatchdogSample | undefined;
    let revocationFailed = false;
    const tickClaim = sampleClaim;
    try {
      lease = loadDockerWorkloadLease(options.leasePath);
      if (lease.status !== 'admitting' && lease.status !== 'active') continue;
      sample = await watchdog.tick();
    } catch (error) {
      // A trip whose revocation failed has recorded an incident and published
      // it. Stay up and retry exact recovery (the incident branch) instead
      // of exiting with the bundle half revoked. When not even that incident
      // could be recorded (a disk refusing every write), there is no durable
      // state to retry from: fail as before, after the write-free revocation.
      if (watchdog.revocationError === undefined || !leaseRecordsIncident(options.leasePath)) throw error;
      revocationFailed = true;
    } finally {
      // onTrip hands this handle to cleanup, which releases it; process-lock
      // release is deliberately idempotent.
      tickClaim.release();
      sampleClaim = undefined;
    }
    if (revocationFailed) continue;
    if (sample !== undefined) {
      publishStatus(() => statusUpdate(lastStatus, now(), { lastSample: compactSample(sample) }));
    }
    if (tripped !== undefined) return;
  }
}

/**
 * The supervisor entrypoint that belongs to the running module: the `.ts`
 * source beside it under tsx (or vitest), the compiled `.js` beside it in a
 * build. Never another tree, so a source run cannot launch a stale `dist/`
 * build or wait out the startup deadline for a `dist/` that does not exist.
 */
export function resolveResourceWatchdogSupervisorEntrypoint(moduleUrl: string = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const extension = extname(modulePath);
  if (extension !== '.ts' && extension !== '.js') {
    throw new Error(`watchdog supervisor module has an unsupported extension: ${modulePath}`);
  }
  return join(dirname(modulePath), `${SUPERVISOR_ENTRYPOINT_BASENAME}${extension}`);
}

/**
 * The module-loading subset of the parent's Node options (for example tsx's
 * `--require`/`--import` pair), so a source run starts the supervisor through
 * the same loader. This is an allowlist on purpose: an inspector flag would
 * contend for the parent's debugger port, `-e`/`-p` would run their code
 * instead of the entrypoint, and `--watch` or `--test` would change what the
 * detached child is.
 */
export function supervisorLoaderExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
  const kept: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (LOADER_OPTIONS_WITH_VALUE.has(argument)) {
      const value = execArgv.at(index + 1);
      if (value !== undefined) kept.push(argument, value);
      index += 1;
      continue;
    }
    const separator = argument.indexOf('=');
    if ((separator > 0 && LOADER_OPTIONS_WITH_VALUE.has(argument.slice(0, separator))) || LOADER_FLAGS.has(argument)) {
      kept.push(argument);
    }
  }
  return kept;
}

/** Spawn a process-group-independent child and wait for its generation's attestation. */
export async function launchDetachedResourceWatchdogSupervisor(
  options: LaunchDetachedResourceWatchdogSupervisorOptions,
): Promise<{ readonly pid: number; readonly status: ResourceWatchdogSupervisorStatus }> {
  assertCanonicalHostPath(options.entrypointPath, 'watchdog supervisor entrypoint');
  if (
    !Number.isSafeInteger(options.startupTimeoutMs) ||
    options.startupTimeoutMs < 100 ||
    options.startupTimeoutMs > 60_000
  ) {
    throw new Error('watchdog supervisor startup timeout is invalid');
  }
  assertSupervisorEntrypointPresent(options.entrypointPath);
  const stderrLogPath =
    options.stderrLogPath ?? join(dirname(options.statusPath), RESOURCE_WATCHDOG_SUPERVISOR_STDERR_FILE);
  const stderrDescriptor = openSupervisorStderrLog(stderrLogPath);
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [
        ...supervisorLoaderExecArgv(),
        options.entrypointPath,
        '--lease',
        options.leasePath,
        '--policy',
        options.policyPath,
        '--status',
        options.statusPath,
        '--stop-request',
        options.stopRequestPath,
      ],
      { detached: true, stdio: ['ignore', 'ignore', stderrDescriptor], env: process.env },
    );
  } finally {
    // The child received its own copy of the descriptor during spawn.
    closeSync(stderrDescriptor);
  }
  let startupError: Error | undefined;
  let exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
  child.once('error', (error) => {
    startupError = error;
  });
  // Without this, a child that dies at once (a module that fails to load)
  // looks exactly like a slow one until the whole startup deadline passes.
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  const pid = child.pid;
  try {
    if (pid === undefined) throw new Error('watchdog supervisor child has no process ID');
    const deadline = defaultMonotonicNow() + options.startupTimeoutMs;
    for (;;) {
      if (startupError !== undefined) throw new Error('watchdog supervisor failed to start', { cause: startupError });
      // Read the exit before the status: a child that published a terminal
      // status and then exited still attested.
      const exitedBeforeRead = exited;
      let status: ResourceWatchdogSupervisorStatus | undefined;
      let statusError: unknown;
      try {
        status = loadResourceWatchdogSupervisorStatus(options.statusPath);
      } catch (error) {
        statusError = error;
      }
      if (status !== undefined) {
        if (status.supervisorPid !== pid) throw new Error('watchdog supervisor status process ID mismatch');
        if (status.state === 'ready' || status.state === 'closed') {
          child.unref();
          return { pid, status };
        }
        if (status.state === 'incident') {
          throw new Error(`watchdog supervisor startup incident: ${status.detail ?? 'unknown'}`);
        }
      }
      if (exitedBeforeRead !== undefined) {
        throw new Error(
          `watchdog supervisor exited during startup ${describeChildExit(exitedBeforeRead)}` +
            stderrTailSuffix(stderrLogPath),
          { cause: statusError },
        );
      }
      // A startup trip that is revoking keeps its own bounded cleanup; only a
      // supervisor that never got past `starting` is held to the deadline.
      if ((status === undefined || status.state === 'starting') && defaultMonotonicNow() >= deadline) {
        throw new Error(
          `watchdog supervisor did not attest before the startup deadline${stderrTailSuffix(stderrLogPath)}`,
          { cause: statusError },
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

/** Fail before spawning when the entrypoint is absent, instead of after the startup deadline. */
function assertSupervisorEntrypointPresent(entrypointPath: string): void {
  let stats;
  try {
    stats = statSync(entrypointPath);
  } catch (error) {
    throw new Error(
      `watchdog supervisor entrypoint is missing: ${entrypointPath} (rebuild with \`npm run build\`, or run from source with tsx)`,
      { cause: error },
    );
  }
  if (!stats.isFile()) throw new Error(`watchdog supervisor entrypoint is not a regular file: ${entrypointPath}`);
}

/**
 * A fresh owner-only log for one supervisor launch. The supervisor writes only
 * bounded fatal records to it (see resource-watchdog-supervisor-main.ts), and
 * every reader takes a bounded tail.
 */
function openSupervisorStderrLog(path: string): number {
  assertCanonicalPrivatePath(path, 'watchdog supervisor stderr log');
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('watchdog supervisor stderr log must be a regular file');
    fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

/** The bounded end of the supervisor's stderr log, or `''` when it is empty or unreadable. */
export function readResourceWatchdogSupervisorStderrTail(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return '';
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size === 0) return '';
    const length = Math.min(stats.size, STARTUP_STDERR_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(descriptor, buffer, 0, length, stats.size - length);
    const text = buffer
      .subarray(0, read)
      .toString('utf8')
      .replace(/^\uFFFD+/u, '');
    return text.trim() === '' ? '' : boundIncidentDetail(text);
  } catch {
    return '';
  } finally {
    closeSync(descriptor);
  }
}

function stderrTailSuffix(path: string): string {
  const tail = readResourceWatchdogSupervisorStderrTail(path);
  return tail === '' ? '' : `: ${tail}`;
}

function describeChildExit(exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null }): string {
  if (exit.signal !== null) return `on signal ${exit.signal}`;
  return `with exit code ${exit.code ?? 'unknown'}`;
}

/** Do not orphan a detached supervisor whose startup attestation was rejected. */
async function terminateChild(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  await waitForChildExit(child, 500);
  if (childHasExited(child)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
  await waitForChildExit(child, 500);
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const done = (): void => {
      clearTimeout(timer);
      child.off('exit', done);
      child.off('error', done);
      resolvePromise();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
    child.once('error', done);
  });
}

export function requestResourceWatchdogSupervisorStop(
  path: string,
  lease: Pick<DockerWorkloadLease, 'leaseId' | 'generation' | 'schemaVersion'>,
  cleanup: DockerWorkloadCleanupProof,
  now = new Date(),
): void {
  writeStrictJsonAtomic(
    path,
    stopRequestSchema.parse({
      // An old supervisor keeps its original protocol until that generation
      // closes, even if the coordinator has since been upgraded.
      schemaVersion: watchdogSupervisorProtocolVersion(lease),
      leaseId: lease.leaseId,
      generation: lease.generation,
      requestedAt: now.toISOString(),
      cleanup,
    }),
  );
}

export function loadResourceWatchdogSupervisorStatus(path: string): ResourceWatchdogSupervisorStatus {
  return loadStrictJson(path, 'watchdog supervisor status', supervisorStatusSchema);
}

export type ResourceWatchdogSupervisorExpectation = {
  readonly leaseId: string;
  readonly generation: string;
} & WatchdogSupervisorPolicyBinding;

/** Throw unless the status belongs to this exact lease, generation, and policy and is `ready`. */
export function assertResourceWatchdogSupervisorReady(
  status: ResourceWatchdogSupervisorStatus,
  expected: ResourceWatchdogSupervisorExpectation,
): ResourceWatchdogSupervisorStatus {
  const validated = supervisorStatusSchema.parse(status);
  if (
    validated.leaseId !== expected.leaseId ||
    validated.generation !== expected.generation ||
    !supervisorPolicyMatches(validated, expected)
  ) {
    throw new Error('watchdog supervisor status binding mismatch');
  }
  if (validated.state !== 'ready') throw new Error(`watchdog supervisor is not ready: ${validated.state}`);
  return validated;
}

/**
 * One-snapshot freshness for an observer with no history of this supervisor
 * (startup reconciliation). A live coordinator watches the status on its own
 * monotonic clock instead. This wall-clock comparison only ever preserves or
 * fences a lease; it never authorizes cleanup by itself.
 */
export function assertResourceWatchdogSupervisorFresh(
  status: ResourceWatchdogSupervisorStatus,
  expected: ResourceWatchdogSupervisorExpectation,
  staleAfterMs: number,
  now = new Date(),
): void {
  const validated = assertResourceWatchdogSupervisorReady(status, expected);
  if (now.getTime() - Date.parse(validated.updatedAt) >= staleAfterMs) {
    throw new Error('watchdog supervisor heartbeat is stale');
  }
}

type WatchdogSupervisorPolicyBinding = { readonly policySha256: string } | { readonly policy: ResourceWatchdogPolicy };

/** One compatibility seam for launch, readiness, and reconciliation. */
export function watchdogSupervisorPolicyBinding(lease: DockerWorkloadLease): WatchdogSupervisorPolicyBinding {
  return lease.schemaVersion === 1
    ? { policySha256: lease.bindings.watchdogPolicySha256 }
    : { policy: lease.bindings.watchdogPolicy };
}

/** Status and stop-request protocol spoken by a generation's supervisor. */
export function watchdogSupervisorProtocolVersion(
  lease: Pick<DockerWorkloadLease, 'schemaVersion'>,
): ResourceWatchdogSupervisorStatus['schemaVersion'] {
  return lease.schemaVersion === 1 ? 1 : RESOURCE_WATCHDOG_SUPERVISOR_SCHEMA_VERSION;
}

/**
 * Observation gap after which the supervisor itself was not watching the
 * coordinator, so the heartbeat gets one fresh window instead of the blame.
 */
function coordinatorHeartbeatLateAfterMs(policy: ResourceWatchdogPolicy): number {
  return lateObservationGapMs(DOCKER_WORKLOAD_STALE_HEARTBEAT_MS, policy.sampleIntervalMs, policy.sampleTimeoutMs);
}

function supervisorPolicyMatches(
  status: ResourceWatchdogSupervisorStatus,
  expected: WatchdogSupervisorPolicyBinding,
): boolean {
  return status.schemaVersion === 1
    ? 'policySha256' in expected && status.policySha256 === expected.policySha256
    : 'policy' in expected && isDeepStrictEqual(status.policy, expected.policy);
}

function leaseRecordsIncident(leasePath: string): boolean {
  try {
    return loadDockerWorkloadLease(leasePath).status === 'incident';
  } catch {
    return false;
  }
}

/** The lease closed while sampling waited for its claim; the next iteration validates the close. */
class LeaseLeftSamplingError extends Error {}

async function waitForSamplingClaim(
  leasePath: string,
  sleep: (milliseconds: number) => Promise<void>,
  onBusy?: () => boolean,
): Promise<DockerWorkloadLifecycleClaimHandle | undefined> {
  for (;;) {
    try {
      return tryAcquireDockerWorkloadLifecycleClaim({ leasePath });
    } catch (error) {
      if (!isDockerWorkloadLifecycleClaimBusy(error)) throw error;
      if (onBusy !== undefined && !onBusy()) return undefined;
      const lease = loadDockerWorkloadLease(leasePath);
      if (lease.status === 'closed') {
        throw new LeaseLeftSamplingError('Docker-workload lease closed before watchdog sampling', { cause: error });
      }
      await sleep(50);
    }
  }
}

async function validateDurableCleanup(
  runtime: ContainerRuntime,
  lease: DockerWorkloadLease,
): Promise<DockerWorkloadCleanupProof> {
  if (lease.status !== 'closed' || lease.cleanup === null) {
    throw new Error('watchdog supervisor requires a closed lease with durable cleanup proof');
  }
  if (lease.resources.some((resource) => resource.removal === null)) {
    throw new Error('watchdog supervisor refuses to stop before every outer-resource absence proof');
  }
  if (existsSync(lease.paths.stateRoot)) {
    throw new Error('watchdog supervisor refuses to stop while the exact state root still exists');
  }
  const actuallyOwned = await inventoryOwnedResourceIds(runtime, lease);
  if (actuallyOwned.length !== 0) {
    throw new Error(`watchdog supervisor refuses to stop while owned resources remain: ${actuallyOwned.join(',')}`);
  }
  return lease.cleanup;
}

function tryLoadStopRequest(path: string): ResourceWatchdogSupervisorStopRequest | undefined {
  if (!existsSync(path)) return undefined;
  return loadStrictJson(path, 'watchdog supervisor stop request', stopRequestSchema);
}

function compactSample(sample: ResourceWatchdogSample) {
  return {
    sampledAtMs: sample.sampledAtMs,
    availableBytes: sample.availableBytes,
    ...(sample.runtimeAvailableBytes === undefined ? {} : { runtimeAvailableBytes: sample.runtimeAvailableBytes }),
    allocatedBytes: sample.allocatedBytes,
  };
}

function compactTrip(trip: ResourceWatchdogTrip) {
  return {
    code: trip.code,
    atMs: trip.atMs,
    detail: boundIncidentDetail(trip.detail),
    overshootBytes: trip.overshootBytes,
    overshootWithinFrozenMaximum: trip.overshootWithinFrozenMaximum,
  };
}

/**
 * Every status write passes here, so free-text details are always bounded to
 * the status schema: a sampler failure can carry a CLI's whole stderr, a panic
 * trace included. The bound keeps the head and the tail, drops control
 * characters, and is never empty.
 */
function statusUpdate(
  current: ResourceWatchdogSupervisorStatus,
  now: Date,
  update: Partial<Pick<ResourceWatchdogSupervisorStatus, 'state' | 'lastSample' | 'trip' | 'detail'>>,
): ResourceWatchdogSupervisorStatus {
  const next = { ...current, ...update, updatedAt: now.toISOString() };
  return supervisorStatusSchema.parse({
    ...next,
    detail: next.detail === null ? null : boundIncidentDetail(next.detail),
    trip: next.trip === null ? null : { ...next.trip, detail: boundIncidentDetail(next.trip.detail) },
  });
}

function loadStrictJson<T>(path: string, label: string, schema: z.ZodType<T>): T {
  assertCanonicalPrivatePath(path, label);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  let bytes: Buffer;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw new Error(`${label} must be an owner-only regular file`);
    if (stats.size < 2 || stats.size > MAX_RESOURCE_WATCHDOG_SUPERVISOR_JSON_BYTES) {
      throw new Error(`${label} size is outside the allowed range`);
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  const value = schema.parse(parsed);
  if (!bytes.equals(Buffer.from(`${stableStringify(value)}\n`))) throw new Error(`${label} is not canonical JSON`);
  return value;
}

function writeStrictJsonAtomic(path: string, value: unknown): void {
  assertCanonicalPrivatePath(path, 'watchdog supervisor output');
  writeStableJsonAtomic(path, value, { mode: 0o600 });
}

function assertCanonicalPrivatePath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} path must be canonical and absolute`);
  const parent = statSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
    throw new Error(`${label} parent must be an owner-only directory`);
  }
  const relativePath = relative(dirname(path), path);
  if (relativePath === '' || relativePath.startsWith('..')) throw new Error(`${label} path is invalid`);
}
