import { dockerEndpointSchema, type DockerEndpoint } from '../docker/docker-endpoint.js';
import { createContainerRuntime } from '../docker/container-runtime.js';
/**
 * Common secure nested Docker-workload lifecycle orchestration.
 *
 * Admission, per-outer-resource ledgering, watchdog attestation, activation,
 * teardown, and crash reconciliation for one Docker-capable bundle. This module
 * owns the §8.2 startup and §8.3 teardown ordering and shares the frozen
 * cleanup helpers with the detached watchdog supervisor so the three cleanup
 * call sites (supervisor trip, coordinator teardown, crash reconciliation)
 * cannot drift.
 *
 * It deliberately does NOT consult the temporary implementation fuse in
 * `config.ts`: this is the mechanism the product wiring calls only after that
 * fuse has already admitted the session. A guard test permits only type imports
 * from that module, so lifecycle code cannot call its admission functions.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  getBundleRuntimeRootForHome,
  getDockerWorkloadLeaseDir,
  getDockerWorkloadLeasesRoot,
  getDockerWorkloadRoot,
  getDockerWorkloadStateRoot,
  getIronCurtainHome,
} from '../config/paths.js';
import type { ContainerRuntime } from '../docker/types.js';
import type { ContainerRuntimeKind } from '../docker/container-runtime.js';
import {
  RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION,
  type LoadedResourceWatchdogPolicy,
} from '../docker/resource-watchdog.js';
import { lateObservationGapMs, PeerProgressTracker, resolveMonotonicClock } from '../docker/peer-liveness.js';
import type { ResolvedDockerWorkloadConfig } from './config.js';
// Type-only: daemon observations are deliberately field-compatible with the
// lifecycle evidence payloads, and a type import adds no runtime edge.
import type { PrivateDockerBootstrapObservation, PrivateDockerDaemonReadiness } from './private-docker.js';
import {
  activateDockerWorkloadLease,
  bindDockerWorkloadOuterResourceStorage,
  createDockerWorkloadLease,
  DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
  heartbeatDockerWorkloadLease,
  loadDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  recordDockerWorkloadLeaseIncident,
  returnDockerWorkloadLeaseRecoveryToIncident,
  requestDockerWorkloadOuterResource,
  type DockerWorkloadCleanupProof,
  type DockerWorkloadLease,
  type DockerWorkloadOuterResource,
} from './bundle-lease.js';
import type { DockerWorkloadRevocationResult } from './bundle-revocation.js';
import { assertExactTargetIdentity } from './bundle-cleanup.js';
import {
  DockerWorkloadCleanupPreconditionError,
  isDockerWorkloadLifecycleClaimBusy,
  performSerializedDockerWorkloadCleanup,
  tryHeartbeatDockerWorkloadLease,
  withDockerWorkloadLifecycleClaim,
} from './cleanup-ownership.js';
import {
  assertRuntimeWatchdogCoverage,
  DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS,
  DOCKER_WORKLOAD_RECOVERY_BOUND_MS,
  DOCKER_WORKLOAD_STALE_HEARTBEAT_MS,
  DOCKER_WORKLOAD_WATCHDOG_STARTUP_TIMEOUT_MS,
  loadFrozenWatchdogPolicyTemplate,
  loadLeaseWatchdogPolicy,
  renderWatchdogPolicy,
} from './watchdog-policy.js';
import {
  assertResourceWatchdogSupervisorFresh,
  assertResourceWatchdogSupervisorReady,
  launchDetachedResourceWatchdogSupervisor,
  loadResourceWatchdogSupervisorStatus,
  requestResourceWatchdogSupervisorStop,
  RESOURCE_WATCHDOG_SUPERVISOR_STDERR_FILE,
  watchdogSupervisorPolicyBinding,
  type LaunchDetachedResourceWatchdogSupervisorOptions,
  type ResourceWatchdogSupervisorStatus,
} from './resource-watchdog-supervisor.js';
import {
  DAEMON_READY_ATTESTATION,
  type DockerWorkloadAuditEventPayload,
  type DockerWorkloadAuditSink,
  type ExpandedOuterCreate,
} from './lifecycle-evidence.js';
import { createDockerWorkloadEmergencyReserve, releaseDockerWorkloadEmergencyReserve } from './emergency-reserve.js';
import {
  acquireProcessLock,
  getProcessStartIdentity,
  getSelfProcessStartIdentity,
  ProcessLockBusyError,
  type ProcessIdentityResolver,
  type ProcessLockHandle,
} from './process-lock.js';
import { boundIncidentDetail, incidentDetailFromError, preserveOriginalFailure } from './incident-detail.js';
import {
  createRegistryPullProvenanceSink,
  REGISTRY_PULL_PROVENANCE_FILE,
  type RegistryPullProvenanceSink,
} from './pull-provenance.js';
import type { RegistryPullProvenance } from '../docker/registry-egress-proxy.js';
import * as logger from '../logger.js';

export { DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY };

const LEASE_FILE = 'lease.json';
const POLICY_FILE = 'policy.json';
const STATUS_FILE = 'status.json';
const STOP_REQUEST_FILE = 'stop.json';
const EVIDENCE_DIR = 'evidence';
const ADMISSION_LOCK_FILE = 'admission.lock';
/**
 * Host-only state created under the lease state root. Only `staging` has a
 * consumer (the Apple selected-agent archive link). The lease still records
 * the historical daemon/api paths and the reserved `exchangeRoot` (see
 * bundle-lease.ts) so cleanup removes them if an older generation created
 * them, but nothing mounts or writes them, so they are no longer created or
 * measured. `exchangeRoot` belongs to the IronCurtain-in-IronCurtain slice,
 * which is reserved and not scheduled
 * (docs/designs/ironcurtain-in-ironcurtain-hermetic-slice.md).
 */
const STATE_SUBDIRS = ['staging'] as const;
const SUPERVISOR_STOP_TIMEOUT_MS = 10_000;
const SUPERVISOR_STOP_POLL_MS = 50;
const HEARTBEAT_CLAIM_RETRY_MS = 50;
const POST_CREATE_SAMPLE_POLL_MS = 50;
const ADMISSION_LOCK_ACQUIRE_ATTEMPTS = 16;
const ADMISSION_LOCK_POLL_MS = 200;
const RECONCILE_LIVENESS_POLL_MS = 250;

/**
 * How long an admission waits for another process's admission critical
 * section (fence detection and lease creation, a short synchronous step)
 * before it gives up as busy.
 */
export const DOCKER_WORKLOAD_ADMISSION_WAIT_MS = 60_000;

/**
 * Appended to every fenced-admission refusal: how an operator inspects,
 * retries, or retires an unresolved lease.
 */
export const DOCKER_WORKLOAD_FENCE_REMEDIATION =
  'Inspect them with `ironcurtain docker-workload status`, retry their exact recovery with ' +
  '`ironcurtain docker-workload reconcile` once the recorded container runtime is running, or remove what a ' +
  "lease's generation label still owns and retire its record with `ironcurtain docker-workload clear <lease-id> --force`";

/** Admission refused because unresolved leases fence it. `leaseIds` names them. */
export class DockerWorkloadAdmissionFencedError extends Error {
  readonly code = 'DOCKER_WORKLOAD_ADMISSION_FENCED';
  readonly leaseIds: readonly string[];

  constructor(fences: readonly { readonly leaseId: string; readonly detail: string }[]) {
    super(
      `refusing Docker-workload admission while unresolved leases block it: ${fences
        .map((fence) => fence.detail)
        .join(', ')}. ${DOCKER_WORKLOAD_FENCE_REMEDIATION}`,
    );
    this.name = 'DockerWorkloadAdmissionFencedError';
    this.leaseIds = fences.map((fence) => fence.leaseId);
  }
}

/** Another process held the admission critical section for the whole bounded wait. */
export class DockerWorkloadAdmissionBusyError extends Error {
  readonly code = 'DOCKER_WORKLOAD_ADMISSION_BUSY';
  readonly ownerPid: number | undefined;

  constructor(ownerPid: number | undefined, waitedMs: number, cause: unknown) {
    const owner = ownerPid === undefined ? '' : ` (owner pid ${ownerPid})`;
    super(`Docker-workload admission is busy${owner} after waiting ${Math.round(waitedMs / 1000)}s`, { cause });
    this.name = 'DockerWorkloadAdmissionBusyError';
    this.ownerPid = ownerPid;
  }
}

export type DockerWorkloadRuntimeKind = ContainerRuntimeKind;
export type OuterResourceKind = DockerWorkloadOuterResource['kind'];
export type OuterResourceRole =
  | 'agent'
  | 'nested-daemon'
  | 'daemon-api'
  | 'fixed-relay'
  | 'proxy'
  | 'network'
  | 'transport-network'
  | 'qualification-observer';

/**
 * A precommitted outer-resource ledger entry. The caller creates the runtime
 * object with its selected name and these ownership labels, then calls `observed()`
 * with the runtime's immutable ID (for networks the caller reads the ID back
 * via `listNetworks` — `createNetwork` returns void).
 */
export interface OuterResourceRegistration {
  readonly labels: Readonly<Record<string, string>>;
  observed(immutableId: string, expanded?: ExpandedOuterCreate): void;
  /**
   * After `observed`, pin the runtime-owned file that holds this container's
   * writable storage when the watchdog policy measures it (an Apple VM's rootfs
   * image). A no-op for everything else. Fails closed: a container whose
   * storage cannot be bound must not run.
   */
  bindStorage(): Promise<void>;
}

export interface OuterResourceRequest {
  readonly kind: OuterResourceKind;
  readonly role: OuterResourceRole;
  readonly requestedName: string;
}

/** Shared callback contract for a topology adapter creating one ledgered outer resource. */
export interface LedgeredOuterCreateSpec<
  Kind extends OuterResourceKind = OuterResourceKind,
  Role extends OuterResourceRole = OuterResourceRole,
> extends OuterResourceRequest {
  readonly kind: Kind;
  readonly role: Role;
  readonly launchesNestedDaemon?: boolean;
  readonly baseLabels?: Readonly<Record<string, string>>;
  readonly adjudicateObserved?: (immutableId: string) => Promise<void>;
}

export type LedgeredOuterCreateAuthority<
  Kind extends OuterResourceKind = OuterResourceKind,
  Role extends OuterResourceRole = OuterResourceRole,
> = (
  spec: LedgeredOuterCreateSpec<Kind, Role>,
  create: (
    requestedName: string,
    ownershipLabels: Readonly<Record<string, string>>,
  ) => Promise<{ readonly id: string; readonly expanded?: ExpandedOuterCreate }>,
) => Promise<{ readonly id: string }>;

/** Injectable seam over the detached watchdog supervisor process for tests. */
export interface WatchdogSupervisorController {
  launch(
    options: LaunchDetachedResourceWatchdogSupervisorOptions,
  ): Promise<{ readonly pid: number; readonly status: ResourceWatchdogSupervisorStatus }>;
  readStatus(statusPath: string): ResourceWatchdogSupervisorStatus | undefined;
  requestStop(
    stopRequestPath: string,
    lease: Pick<DockerWorkloadLease, 'leaseId' | 'generation' | 'schemaVersion'>,
    cleanup: DockerWorkloadCleanupProof,
    now: Date,
  ): void;
  isAlive(pid: number): boolean;
}

export interface DockerWorkloadAdmissionOptions {
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: DockerWorkloadRuntimeKind;
  readonly bundleId: string;
  readonly workspaceRoot: string;
  /** Complete resolved configuration recorded in the admission audit event. */
  readonly configuration: ResolvedDockerWorkloadConfig;
  readonly watchdogPolicyTemplatePath: string;
  readonly watchdogSupervisorEntrypointPath: string;
  readonly leaseId?: string;
  readonly generation?: string;
  readonly ownershipLabelKey?: string;
  readonly auditSink?: DockerWorkloadAuditSink;
  /** Wall clock for persisted lease, status, and audit timestamps. */
  readonly clock?: () => Date;
  /**
   * Observer-local monotonic clock for liveness and in-process deadlines.
   * Defaults to `performance.now()`, or to `clock` when only that is injected.
   */
  readonly monotonicClock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pidAlive?: (pid: number) => boolean;
  /** Test seam for process-start identity (locks and coordinator liveness); production reads the process table. */
  readonly processIdentityForPid?: ProcessIdentityResolver;
  /**
   * Resolve the runtime recorded by an older lease when backend selection
   * changed. `undefined` means that runtime is unavailable: the lease is
   * fenced, never inventoried through a different runtime.
   */
  readonly runtimeForKind?: (
    kind: DockerWorkloadRuntimeKind,
    endpoint?: DockerEndpoint,
  ) => ContainerRuntime | undefined;
  readonly supervisor?: WatchdogSupervisorController;
  /** Off for tests that must not leave a real host heartbeat interval running. */
  readonly startHeartbeat?: boolean;
  /** Bounded wait for another process's admission critical section; defaults to {@link DOCKER_WORKLOAD_ADMISSION_WAIT_MS}. */
  readonly admissionWaitMs?: number;
  /** Progress notice, naming the holder, while admission waits for another process; defaults to the logger. */
  readonly onAdmissionWait?: (message: string) => void;
}

export interface ReconcileDockerWorkloadOptions {
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: DockerWorkloadRuntimeKind;
  readonly auditSink?: DockerWorkloadAuditSink;
  readonly clock?: () => Date;
  /** Observer-local monotonic clock; defaults to `performance.now()`, or to `clock` when only that is injected. */
  readonly monotonicClock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pidAlive?: (pid: number) => boolean;
  /** Test seam for process-start identity (locks and coordinator liveness); production reads the process table. */
  readonly processIdentityForPid?: ProcessIdentityResolver;
  /**
   * Resolve the runtime recorded by an older lease when backend selection
   * changed. `undefined` means that runtime is unavailable: the lease is
   * fenced, never inventoried through a different runtime.
   */
  readonly runtimeForKind?: (
    kind: DockerWorkloadRuntimeKind,
    endpoint?: DockerEndpoint,
  ) => ContainerRuntime | undefined;
  readonly supervisor?: WatchdogSupervisorController;
  readonly recoveryBoundMs?: number;
  /** Missed-heartbeat bound; also the window a live coordinator is watched for before recovery. */
  readonly staleHeartbeatMs?: number;
}

export interface ReconcileDockerWorkloadResult {
  /** Lease IDs the frozen order deleted and closed. */
  readonly reconciled: readonly string[];
  /** Lease IDs left untouched because they are live. */
  readonly preserved: readonly string[];
  /** Lease IDs left fenced (incident); these block new admission. */
  readonly fenced: readonly string[];
}

export interface ReconcileDockerWorkloadHeldResult extends ReconcileDockerWorkloadResult {
  /** Current-pass reasons, used only to make admission failures actionable. */
  readonly fences: readonly { readonly leaseId: string; readonly detail: string }[];
}

/**
 * Where one lease stands, judged from a single snapshot without waiting,
 * recovering, or writing anything:
 *
 * - `closed`: cleanup is proven; nothing to do.
 * - `live`: a fresh, live coordinator owns it (and, once active, a fresh bound
 *   watchdog supervisor).
 * - `settling`: the coordinator heartbeat is recent but the lease is not
 *   provably live (a coordinator that just died, or a starting supervisor);
 *   it fences until the stale bound passes.
 * - `stale`: its coordinator is gone or silent; exact recovery is due.
 * - `incident`: cleanup could not be proven; exact recovery is retried.
 * - `unreadable`: a lease marker exists but cannot be parsed or trusted.
 */
export type DockerWorkloadLeaseState = 'closed' | 'live' | 'settling' | 'stale' | 'incident' | 'unreadable';

export interface DockerWorkloadLeaseSummary {
  readonly leaseId: string;
  readonly leasePath: string;
  readonly state: DockerWorkloadLeaseState;
  /** True when the lease refuses new nested-Docker admission. */
  readonly fencesAdmission: boolean;
  readonly detail: string;
  /** The validated record; absent when it is unreadable. */
  readonly lease?: DockerWorkloadLease;
}

export interface InspectDockerWorkloadLeasesOptions {
  readonly clock?: () => Date;
  readonly pidAlive?: (pid: number) => boolean;
  readonly processIdentityForPid?: ProcessIdentityResolver;
  readonly supervisor?: WatchdogSupervisorController;
  readonly staleHeartbeatMs?: number;
}

/** Cleanup is proven, but mandatory post-close audit publication failed. */
class DockerWorkloadPostCloseAuditError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'DockerWorkloadPostCloseAuditError';
  }
}

export interface DockerWorkloadTeardownResult {
  readonly alreadyClosed: boolean;
  readonly supervisorLost: boolean;
  readonly revocation?: DockerWorkloadRevocationResult;
  readonly cleanup?: DockerWorkloadCleanupProof;
}

/**
 * Reconcile every nonclosed lease, then admit one new bundle: create its
 * state-root subtree, render the frozen watchdog policy, and durably create the
 * host-only lease. No outer resource is created and the watchdog is not yet
 * attested — those are handle methods driven by the caller in §8.2 order.
 *
 * Recovery runs under per-lease lifecycle claims before the global critical
 * section; that section (an in-process queue, then the cross-process admission
 * lock, waited for up to `admissionWaitMs`) covers only fence detection and
 * lease creation. A lease still unresolved at that point refuses admission
 * with a {@link DockerWorkloadAdmissionFencedError} naming it.
 */
export async function admitDockerWorkloadBundle(
  options: DockerWorkloadAdmissionOptions,
): Promise<DockerWorkloadBundleHandle> {
  if (options.runtimeKind === 'docker') dockerEndpointSchema.parse(options.runtime.dockerEndpoint);
  const clock = options.clock ?? defaultClock;
  const monotonicClock = resolveLifecycleMonotonicClock(options);
  const sleep = options.sleep ?? defaultSleep;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const supervisor = options.supervisor ?? defaultSupervisorController;
  const root = getDockerWorkloadRoot();
  const reconcileOptions: ReconcileDockerWorkloadOptions = {
    ...options,
    clock,
    monotonicClock,
    sleep,
    pidAlive,
    supervisor,
  };

  // Exact recovery of stale and incident leases runs first and outside the
  // global critical section: every lease is recovered under its own
  // lifecycle claim, and a recovery another admission (or the watchdog)
  // already owns is waited for, bounded, rather than reported as busy.
  const recovery = await reconcileHeld(reconcileOptions, true);
  const recoveryDetails = new Map(recovery.fences.map((fence) => [fence.leaseId, fence.detail]));

  return withDockerWorkloadAdmissionLock(
    root,
    {
      processIdentityForPid: options.processIdentityForPid,
      monotonicClock,
      sleep,
      waitMs: options.admissionWaitMs ?? DOCKER_WORKLOAD_ADMISSION_WAIT_MS,
      onWait: options.onAdmissionWait ?? ((message) => logger.info(message)),
    },
    () => {
      // The critical section covers only fence detection and lease creation.
      // A lease that is still unresolved now (its recovery failed, another
      // process's recovery of it outlasted the wait, or it went stale since)
      // fences this admission: a new lease is never created beside it.
      const fences = inspectDockerWorkloadLeases(reconcileOptions)
        .filter((summary) => summary.fencesAdmission)
        .map((summary) => ({
          leaseId: summary.leaseId,
          detail: recoveryDetails.get(summary.leaseId) ?? `${summary.leaseId} (${summary.detail})`,
        }));
      if (fences.length > 0) throw new DockerWorkloadAdmissionFencedError(fences);
      return Promise.resolve(createAdmittedBundle(options, { clock, monotonicClock, sleep, supervisor }));
    },
  );
}

function createAdmittedBundle(
  options: DockerWorkloadAdmissionOptions,
  resolved: {
    readonly clock: () => Date;
    readonly monotonicClock: () => number;
    readonly sleep: (milliseconds: number) => Promise<void>;
    readonly supervisor: WatchdogSupervisorController;
  },
): DockerWorkloadBundleHandle {
  const { clock, monotonicClock, sleep, supervisor } = resolved;
  const leaseId = options.leaseId ?? `dw-${randomUUID()}`;
  const generation = options.generation ?? `gen-${randomUUID()}`;
  const ownershipLabelKey = options.ownershipLabelKey ?? DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY;

  // Validate the packaged policy, including real storage coverage for this
  // runtime, before creating lease-specific state. A broken or incomplete
  // install must fail without accumulating empty lease/state directories on
  // every retry.
  const template = loadFrozenWatchdogPolicyTemplate(options.watchdogPolicyTemplatePath);
  assertRuntimeWatchdogCoverage(template, options.runtimeKind);
  const leaseDir = getDockerWorkloadLeaseDir(leaseId);
  const stateRoot = getDockerWorkloadStateRoot(leaseId);
  createStateRootSubtree(stateRoot);
  mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
  const evidenceDir = join(leaseDir, EVIDENCE_DIR);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });

  const policyPath = join(leaseDir, POLICY_FILE);
  const loadedPolicy = renderWatchdogPolicy(template, options.runtimeKind, stateRoot, policyPath);

  const leasePath = join(leaseDir, LEASE_FILE);
  const coordinatorProcessIdentity = getSelfProcessStartIdentity(options.processIdentityForPid);
  if (coordinatorProcessIdentity === undefined) {
    throw new Error('could not determine the coordinator process start identity for the Docker-workload lease');
  }
  // Held until cleanup, which frees it before its first durable write. The
  // lease that follows is what lets any cleanup find it again.
  createDockerWorkloadEmergencyReserve(leaseDir);
  try {
    createDockerWorkloadLease(leasePath, {
      leaseId,
      bundleId: options.bundleId,
      generation,
      runtimeKind: options.runtimeKind,
      dockerEndpoint: options.runtimeKind === 'docker' ? options.runtime.dockerEndpoint : undefined,
      paths: leasePathsFor(options.workspaceRoot, stateRoot, options.bundleId),
      bindings: { watchdogPolicy: loadedPolicy.policy },
      cleanupInventoryGapMs: loadedPolicy.policy.cleanupInventoryGapMs,
      coordinatorPid: process.pid,
      coordinatorProcessIdentity,
      now: clock(),
    });
  } catch (error) {
    releaseDockerWorkloadEmergencyReserve(leaseDir);
    throw error;
  }

  emitAudit(options.auditSink, leaseId, generation, clock().toISOString(), {
    kind: 'admission-decision',
    decision: 'admitting',
    bundleId: options.bundleId,
    runtimeKind: options.runtimeKind,
    configuration: options.configuration,
    watchdogPolicy: loadedPolicy.policy,
    detail: 'reconciled outstanding leases and created a fresh admitting lease',
  });

  return new DockerWorkloadBundleHandle({
    runtime: options.runtime,
    runtimeKind: options.runtimeKind,
    bundleId: options.bundleId,
    leaseId,
    generation,
    leasePath,
    policyPath,
    statusPath: join(leaseDir, STATUS_FILE),
    stopRequestPath: join(leaseDir, STOP_REQUEST_FILE),
    loadedPolicy,
    ownershipLabelKey,
    supervisorEntrypointPath: options.watchdogSupervisorEntrypointPath,
    auditSink: options.auditSink,
    clock,
    monotonicClock,
    sleep,
    supervisor,
    startHeartbeat: options.startHeartbeat ?? true,
    processIdentityForPid: options.processIdentityForPid,
  });
}

/**
 * One bounded pass of exact recovery over every nonclosed lease. Each lease is
 * recovered under its own lifecycle claim, so the pass takes no global lock
 * and concurrent passes or admissions never collide on one; a lease whose
 * lifecycle another owner holds right now is reported fenced, not waited for.
 */
export async function reconcileDockerWorkloadLeases(
  options: ReconcileDockerWorkloadOptions,
): Promise<ReconcileDockerWorkloadResult> {
  const { reconciled, preserved, fenced } = await reconcileHeld(options, false);
  return { reconciled, preserved, fenced };
}

/**
 * Judge every lease from one snapshot: no wait, no recovery, no write. The
 * admission critical section uses it for fence detection, and the operator
 * status command and `doctor` use it to report what blocks admission.
 */
export function inspectDockerWorkloadLeases(
  options: InspectDockerWorkloadLeasesOptions = {},
): readonly DockerWorkloadLeaseSummary[] {
  const context: LeaseSnapshotContext = {
    now: (options.clock ?? defaultClock)(),
    pidAlive: options.pidAlive ?? defaultPidAlive,
    identityForPid: options.processIdentityForPid ?? getProcessStartIdentity,
    supervisor: options.supervisor ?? defaultSupervisorController,
    staleHeartbeatMs: options.staleHeartbeatMs ?? DOCKER_WORKLOAD_STALE_HEARTBEAT_MS,
  };
  const leasesRoot = getDockerWorkloadLeasesRoot();
  const summaries: DockerWorkloadLeaseSummary[] = [];
  for (const leaseId of listLeaseIds(leasesRoot)) {
    const leaseDir = join(leasesRoot, leaseId);
    const leasePath = join(leaseDir, LEASE_FILE);
    let lease: DockerWorkloadLease;
    try {
      lease = loadDockerWorkloadLease(leasePath);
    } catch (error) {
      if (pathEntryExistsWithoutFollowing(leasePath)) {
        summaries.push({
          leaseId,
          leasePath,
          state: 'unreadable',
          fencesAdmission: true,
          detail: `lease record is unreadable; exact recovery cannot be proven: ${errorText(error)}`,
        });
      }
      continue;
    }
    summaries.push({ leaseId, leasePath, lease, ...classifyLeaseSnapshot(lease, leaseDir, context) });
  }
  return summaries;
}

interface LeaseSnapshotContext {
  readonly now: Date;
  readonly pidAlive: (pid: number) => boolean;
  readonly identityForPid: ProcessIdentityResolver;
  readonly supervisor: WatchdogSupervisorController;
  readonly staleHeartbeatMs: number;
}

function classifyLeaseSnapshot(
  lease: DockerWorkloadLease,
  leaseDir: string,
  context: LeaseSnapshotContext,
): Pick<DockerWorkloadLeaseSummary, 'state' | 'fencesAdmission' | 'detail'> {
  if (lease.status === 'closed')
    return { state: 'closed', fencesAdmission: false, detail: 'closed with cleanup proof' };
  if (lease.incident !== null) {
    const recovering = lease.status === 'revoking' ? 'exact recovery is running or was interrupted; ' : '';
    return {
      state: 'incident',
      fencesAdmission: true,
      detail: `${recovering}incident ${lease.incident.code} at ${lease.incident.recordedAt}: ${lease.incident.detail}`,
    };
  }
  const heartbeatFresh = isHeartbeatAgeFresh(lease, context.now, context.staleHeartbeatMs);
  const coordinatorLive = heartbeatFresh && isCoordinatorProcessAlive(lease, context.pidAlive, context.identityForPid);
  if (isLeaseLive(lease, leaseDir, context.supervisor, coordinatorLive, context.now)) {
    return { state: 'live', fencesAdmission: false, detail: `owned by coordinator pid ${lease.coordinator.pid}` };
  }
  if (heartbeatFresh) {
    return { state: 'settling', fencesAdmission: true, detail: 'lifecycle is still owned or recently active' };
  }
  return { state: 'stale', fencesAdmission: true, detail: 'its coordinator is gone or silent; exact recovery is due' };
}

/**
 * Run one bounded exact-recovery attempt for a single lease, exactly as a
 * reconciliation pass would (live leases are preserved, recent ones fenced).
 * The operator `clear` command tries this before anything label-based.
 */
export async function recoverDockerWorkloadLease(
  leaseId: string,
  options: ReconcileDockerWorkloadOptions,
): Promise<ReconcileDockerWorkloadHeldResult> {
  return reconcileHeld(options, false, [leaseId]);
}

/**
 * The state-root identity guard every exact cleanup applies before it removes
 * host state, for a caller outside that sequence (the operator `clear`):
 * throws unless the lease's state root is absent or still the exact real
 * directory its bound watchdog policy recorded. A symlink or a replaced
 * directory there would otherwise redirect the removal of the state paths
 * beneath it to whatever it points at.
 */
export function assertDockerWorkloadStateRootIdentity(lease: DockerWorkloadLease, leasePath: string): void {
  if (!pathEntryExistsWithoutFollowing(lease.paths.stateRoot)) return;
  const { policy } = loadLeaseWatchdogPolicy(lease, join(dirname(leasePath), POLICY_FILE));
  assertExactTargetIdentity(lease, policy.targetDevice, policy.targetInode);
}

/**
 * Why a lease record this process cannot read may still belong to a running
 * coordinator, or undefined once it is quiescent. Such a record (a newer
 * schema, a changed mode or form, corruption) carries no trustworthy
 * liveness, so the operator `clear` refuses it while either signal remains:
 * the record was rewritten within the stale bound (a live coordinator rewrites
 * it with every heartbeat, whether or not this version can parse it; the same
 * clock-step rule as heartbeat freshness applies), or the coordinator process
 * the raw record still names is running (by PID and, when the record names
 * one, its start identity; an unreadable process table cannot prove it gone).
 */
export function describeUnreadableDockerWorkloadLeaseActivity(
  leasePath: string,
  coordinator: { readonly pid: number; readonly processIdentity: string | undefined } | undefined,
  options: InspectDockerWorkloadLeasesOptions = {},
): string | undefined {
  const staleHeartbeatMs = options.staleHeartbeatMs ?? DOCKER_WORKLOAD_STALE_HEARTBEAT_MS;
  let modifiedAtMs: number;
  try {
    modifiedAtMs = lstatSync(leasePath).mtimeMs;
  } catch {
    return 'its record changed while it was being judged; retry';
  }
  const ageMs = (options.clock ?? defaultClock)().getTime() - modifiedAtMs;
  if (ageMs > -DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS && ageMs < staleHeartbeatMs) {
    return (
      `its record was rewritten within the last ${Math.round(staleHeartbeatMs / 1000)}s, so a running ` +
      'coordinator may still own it; retry once it has been quiet that long'
    );
  }
  if (coordinator === undefined || !(options.pidAlive ?? defaultPidAlive)(coordinator.pid)) return undefined;
  if (coordinator.processIdentity !== undefined) {
    let identity: string | undefined;
    try {
      identity = (options.processIdentityForPid ?? getProcessStartIdentity)(coordinator.pid);
    } catch {
      identity = coordinator.processIdentity;
    }
    // A different start identity is PID reuse: the recorded coordinator is gone.
    if (identity !== coordinator.processIdentity) return undefined;
  }
  return `the coordinator process its record names (pid ${coordinator.pid}) is still running; end that session first`;
}

interface DockerWorkloadBundleHandleContext {
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: DockerWorkloadRuntimeKind;
  readonly bundleId: string;
  readonly leaseId: string;
  readonly generation: string;
  readonly leasePath: string;
  readonly policyPath: string;
  readonly statusPath: string;
  readonly stopRequestPath: string;
  readonly loadedPolicy: LoadedResourceWatchdogPolicy;
  readonly ownershipLabelKey: string;
  readonly supervisorEntrypointPath: string;
  readonly auditSink: DockerWorkloadAuditSink | undefined;
  readonly clock: () => Date;
  readonly monotonicClock: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly supervisor: WatchdogSupervisorController;
  readonly startHeartbeat: boolean;
  readonly processIdentityForPid: ProcessIdentityResolver | undefined;
}

/** Live handle over one admitted bundle lease. Methods are the narrow calls the product wiring makes. */
export class DockerWorkloadBundleHandle {
  private readonly context: DockerWorkloadBundleHandleContext;
  private rejecting = false;
  private supervisorPid: number | undefined;
  /** When this coordinator saw the bound supervisor's status change, on its own monotonic clock. */
  private supervisorProgress: PeerProgressTracker | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatRefreshPromise: Promise<boolean> | undefined;
  private supervisorMonitorTimer: NodeJS.Timeout | undefined;
  private teardownPromise: Promise<DockerWorkloadTeardownResult> | undefined;
  private readonly localCreateOperations = new Set<symbol>();
  private registryPullProvenance: RegistryPullProvenanceSink | undefined;

  constructor(context: DockerWorkloadBundleHandleContext) {
    this.context = context;
    // Admission can spend minutes hashing/loading a multi-gigabyte archive.
    // Start ownership heartbeats as soon as the handle exists, not only after
    // activation, so the detached supervisor never mistakes valid bootstrap
    // work for a dead coordinator.
    this.startHeartbeatTimer();
  }

  // The lease identity fields live once on `this.context`; these getters expose
  // them read-only without a second copy that could drift.
  get leaseId(): string {
    return this.context.leaseId;
  }
  get generation(): string {
    return this.context.generation;
  }
  get leasePath(): string {
    return this.context.leasePath;
  }
  get loadedPolicy(): LoadedResourceWatchdogPolicy {
    return this.context.loadedPolicy;
  }
  get stagingRoot(): string {
    return loadDockerWorkloadLease(this.leasePath).paths.stagingRoot;
  }
  /** This lease's append-only registry-pull provenance log, in its host-only evidence directory. */
  get registryPullProvenancePath(): string {
    return join(dirname(this.leasePath), EVIDENCE_DIR, REGISTRY_PULL_PROVENANCE_FILE);
  }

  /**
   * Append one completed registry pull to this lease's durable provenance log.
   * The digests are what the registry reported: audit provenance, never an
   * attestation of the pulled bytes. The log outlives teardown, which deletes
   * only the state root.
   */
  recordRegistryPull(record: RegistryPullProvenance): void {
    this.registryPullProvenance ??= createRegistryPullProvenanceSink(this.registryPullProvenancePath, {
      leaseId: this.leaseId,
      generation: this.generation,
      bundleId: this.context.bundleId,
    });
    this.registryPullProvenance.append(record, this.context.clock());
  }

  /** Durably record the caller-selected runtime name BEFORE the caller creates it. */
  precommitOuterResource(request: OuterResourceRequest): OuterResourceRegistration {
    if (this.rejecting) throw new Error('Docker-workload bundle is tearing down; new outer resources are rejected');
    const { kind, role, requestedName } = request;
    if (kind === 'network' && this.context.runtimeKind === 'apple-container') {
      throw new Error('apple-container has no outer network objects to ledger');
    }
    const requestId = `res-${randomUUID()}`;
    requestDockerWorkloadOuterResource(
      this.leasePath,
      this.generation,
      { requestId, kind, role, requestedName, ownershipLabelKey: this.context.ownershipLabelKey },
      this.context.clock(),
    );
    const labels = { [this.context.ownershipLabelKey]: this.generation };
    let observedId: string | undefined;
    return {
      labels,
      observed: (immutableId: string, expanded?: ExpandedOuterCreate): void => {
        observeDockerWorkloadOuterResource(
          this.leasePath,
          this.generation,
          requestId,
          immutableId,
          this.context.clock(),
        );
        observedId = immutableId;
        this.emit({
          kind: 'outer-create',
          requestId,
          resourceKind: kind,
          role,
          requestedName,
          immutableId,
          expanded: expanded ?? {},
        });
      },
      bindStorage: async (): Promise<void> => {
        if (kind !== 'container' || !this.measuresContainerStorage()) return;
        if (observedId === undefined) throw new Error('outer container storage can be bound only after observation');
        const describe = this.context.runtime.describeContainerStorage?.bind(this.context.runtime);
        if (describe === undefined) {
          throw new Error('the selected runtime cannot locate container storage for the observed-disk watchdog');
        }
        const storage = await describe(observedId);
        bindDockerWorkloadOuterResourceStorage(
          this.leasePath,
          this.generation,
          requestId,
          storage,
          this.context.clock(),
        );
      },
    };
  }

  /** Whether the frozen policy charges the bundle for runtime-owned container storage files. */
  private measuresContainerStorage(): boolean {
    const policy = this.loadedPolicy.policy;
    return (
      policy.schemaVersion === RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION &&
      policy.stateClasses.some((stateClass) => stateClass.kind === 'apple-container-rootfs')
    );
  }

  /**
   * Exclude cleanup while freshness, ledger precommit, runtime create, and
   * immutable-ID observation execute as one lifecycle operation.
   */
  async withOuterCreateClaim<T>(operation: () => Promise<T>): Promise<T> {
    if (this.rejecting) throw new Error('Docker-workload bundle is tearing down; outer create is rejected');
    const baselineSampleAt = this.context.supervisor.readStatus(this.context.statusPath)?.lastSample?.sampledAtMs;
    const token = Symbol('outer-create');
    let result: T;
    try {
      result = await withDockerWorkloadLifecycleClaim(
        {
          leasePath: this.leasePath,
          clock: this.context.clock,
          sleep: this.context.sleep,
          wait: true,
          processIdentityForPid: this.context.processIdentityForPid,
        },
        async () => {
          const status = loadDockerWorkloadLease(this.leasePath).status;
          if (this.rejecting || (status !== 'admitting' && status !== 'active')) {
            throw new Error(`Docker-workload bundle is ${status}; outer create is rejected`);
          }
          this.localCreateOperations.add(token);
          heartbeatDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
          const heartbeat = setInterval(() => {
            try {
              heartbeatDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
            } catch {
              // The held lifecycle claim prevents cleanup; a lease-lock collision retries next interval.
            }
          }, DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS);
          heartbeat.unref();
          try {
            return await operation();
          } finally {
            clearInterval(heartbeat);
          }
        },
      );
      await this.reconfirmSupervisorAfterCreate(baselineSampleAt);
      return result;
    } finally {
      this.localCreateOperations.delete(token);
    }
  }

  /** Launch and attest the detached watchdog supervisor; fail admission on anything but 'ready'. */
  async attestWatchdog(): Promise<ResourceWatchdogSupervisorStatus> {
    const launched = await this.context.supervisor.launch({
      leasePath: this.leasePath,
      policyPath: this.context.policyPath,
      statusPath: this.context.statusPath,
      stopRequestPath: this.context.stopRequestPath,
      entrypointPath: this.context.supervisorEntrypointPath,
      startupTimeoutMs: DOCKER_WORKLOAD_WATCHDOG_STARTUP_TIMEOUT_MS,
      // The lease directory owns the supervisor's bounded fatal-error log.
      stderrLogPath: join(dirname(this.leasePath), RESOURCE_WATCHDOG_SUPERVISOR_STDERR_FILE),
    });
    this.supervisorPid = launched.pid;
    const policy = this.loadedPolicy.policy;
    this.supervisorProgress = new PeerProgressTracker({
      staleAfterMs: policy.staleAfterMs,
      lateAfterMs: lateObservationGapMs(policy.staleAfterMs, policy.sampleIntervalMs, policy.sampleTimeoutMs),
      monotonicNow: this.context.monotonicClock,
      wallNow: () => this.context.clock().getTime(),
    });
    // The launch waited for this new process to publish `ready`, so its first
    // observation is the start of the supervisor's first window.
    this.assertSupervisorStatus(launched.status, 'gate');
    const firstSample = launched.status.lastSample;
    if (firstSample === null) throw new Error('watchdog attestation returned no first sample');
    this.emit({
      kind: 'watchdog-attested',
      supervisorPid: launched.pid,
      policy: this.loadedPolicy.policy,
      firstSample,
    });
    this.startSupervisorMonitor();
    return launched.status;
  }

  /**
   * Record the adjudicated nested-daemon configuration (§8.2 step 4/5 evidence).
   *
   * Called only after readiness ACCEPTED the daemon, so the event states which
   * configuration was admitted rather than merely that something answered. The
   * attestation marker is stamped here, not carried by the readiness record:
   * these values reach the host through a bundle-local socket, so the evidence
   * must say so beside the host-observed events it sits next to.
   */
  recordDaemonReady(readiness: PrivateDockerDaemonReadiness): void {
    this.emit({
      kind: 'daemon-ready',
      attestation: DAEMON_READY_ATTESTATION,
      driver: readiness.driver,
      securityOptions: [...readiness.securityOptions],
      serverVersion: readiness.serverVersion,
      readinessMs: readiness.readinessMs,
    });
  }

  /** Record the exact private-Docker inputs and advisory bundle-local observations before activation. */
  recordPrivateDockerBootstrap(observation: PrivateDockerBootstrapObservation): void {
    this.emit({
      kind: 'private-docker-bootstrap',
      attestation: DAEMON_READY_ATTESTATION,
      toolchain: observation.preflight.toolchain,
      image: observation.image,
      network: {
        name: observation.network.name,
        runtimeId: observation.network.id,
      },
    });
  }

  /**
   * Prove the watchdog supervisor is still fresh immediately before daemon/VM
   * create or activation: its status must have changed within the stale window
   * of this coordinator's monotonic clock.
   */
  assertWatchdogFresh(): void {
    this.assertSupervisorStatus(this.readSupervisorStatus(), 'gate');
  }

  /** One deterministic health-monitor iteration; the interval uses the same path. */
  async pollSupervisorHealth(): Promise<void> {
    if (this.rejecting || this.supervisorPid === undefined || this.localCreateOperations.size !== 0) return;
    try {
      this.assertSupervisorStatus(this.readSupervisorStatus(), 'monitor');
    } catch (error) {
      // An audit failure must not skip the teardown this incident demands.
      const auditFailures = this.tryEmitIncident('watchdog-supervisor-unhealthy', error);
      await this.teardown();
      if (auditFailures.length !== 0) throw preserveOriginalFailure(error, auditFailures);
    }
  }

  private readSupervisorStatus(): ResourceWatchdogSupervisorStatus {
    const status = this.context.supervisor.readStatus(this.context.statusPath);
    if (status === undefined) throw new Error('watchdog supervisor status is missing');
    return status;
  }

  private async reconfirmSupervisorAfterCreate(baselineSampleAt: number | undefined): Promise<void> {
    // Preserve the established non-daemon seam: callers that never had a
    // watchdog attestation are not retroactively gated by this handoff.
    if (baselineSampleAt === undefined) return;
    try {
      this.assertWatchdogFresh();
      return;
    } catch {
      // A long valid create intentionally excludes sampling. Demand a newer
      // real sample before returning authority to the caller.
    }
    const deadline = this.context.monotonicClock() + this.loadedPolicy.policy.staleAfterMs;
    for (;;) {
      const status = this.context.supervisor.readStatus(this.context.statusPath);
      // Only the supervisor writes samples, so any different one is newer; a
      // backward wall step must not make that newer sample look older. A
      // sample that landed while this create waited for the lifecycle claim
      // is newer than the baseline yet older than the create, so it must also
      // pass the gate; until a sample does, keep waiting rather than failing
      // a valid create. Binding, readiness, and liveness failures still throw.
      if (
        status !== undefined &&
        status.lastSample !== null &&
        status.lastSample.sampledAtMs !== baselineSampleAt &&
        this.unprovenSupervisorProgressMs(status, 'gate') < this.loadedPolicy.policy.staleAfterMs
      ) {
        return;
      }
      if (this.context.monotonicClock() >= deadline) {
        throw new Error('watchdog supervisor did not publish a fresh sample after outer create');
      }
      await this.context.sleep(POST_CREATE_SAMPLE_POLL_MS);
    }
  }

  /** One single-flight heartbeat iteration; claim collisions retry briefly instead of phase-locking with samples. */
  refreshCoordinatorHeartbeat(): Promise<boolean> {
    if (this.heartbeatRefreshPromise !== undefined) return this.heartbeatRefreshPromise;
    const refresh = this.retryCoordinatorHeartbeat();
    this.heartbeatRefreshPromise = refresh;
    void refresh.then(
      () => {
        if (this.heartbeatRefreshPromise === refresh) this.heartbeatRefreshPromise = undefined;
      },
      () => {
        if (this.heartbeatRefreshPromise === refresh) this.heartbeatRefreshPromise = undefined;
      },
    );
    return refresh;
  }

  /** Activate atomically against cleanup immediately before releasing the agent. */
  async activate(): Promise<void> {
    if (this.rejecting) throw new Error('Docker-workload bundle is tearing down; activation is rejected');
    await withDockerWorkloadLifecycleClaim(
      {
        leasePath: this.leasePath,
        clock: this.context.clock,
        sleep: this.context.sleep,
        wait: true,
        processIdentityForPid: this.context.processIdentityForPid,
      },
      () => {
        const lease = loadDockerWorkloadLease(this.leasePath);
        if (this.rejecting || lease.status !== 'admitting') {
          throw new Error(`Docker-workload bundle is ${lease.status}; activation is rejected`);
        }
        // Image verification/loading can outlast the pre-create check. Bind
        // freshness, coordinator ownership, and the authority transition to
        // one lifecycle owner before the caller attaches and releases the agent.
        this.assertWatchdogFresh();
        heartbeatDockerWorkloadLease(this.leasePath, this.generation, this.context.clock());
        activateDockerWorkloadLease(
          this.leasePath,
          this.generation,
          this.context.clock(),
          measureStorageBaselines(lease, this.measuresContainerStorage()),
        );
        this.emit({ kind: 'lease-transition', from: 'admitting', to: 'active' });
        return Promise.resolve();
      },
    );
  }

  /** §8.3 teardown in the frozen order; idempotent and tolerant of transient lock contention. */
  teardown(): Promise<DockerWorkloadTeardownResult> {
    this.rejecting = true;
    this.clearSupervisorMonitor();
    return (this.teardownPromise ??= this.runTeardown());
  }

  private async runTeardown(): Promise<DockerWorkloadTeardownResult> {
    try {
      const startLease = loadDockerWorkloadLease(this.leasePath);
      if (startLease.status === 'closed') return { alreadyClosed: true, supervisorLost: false };
      const result = await performSerializedDockerWorkloadCleanup({
        runtime: this.context.runtime,
        leasePath: this.leasePath,
        generation: this.generation,
        targetDevice: this.loadedPolicy.policy.targetDevice,
        targetInode: this.loadedPolicy.policy.targetInode,
        gapMs: this.loadedPolicy.policy.cleanupInventoryGapMs,
        clock: this.context.clock,
        sleep: this.context.sleep,
        waitForOwner: true,
        processIdentityForPid: this.context.processIdentityForPid,
        onRevoking: (from) => this.emit({ kind: 'lease-transition', from, to: 'revoking' }),
      });
      if (result.revocation !== undefined) {
        this.emit({
          kind: 'revocation-result',
          removedResourceIds: [...result.revocation.removedResourceIds],
          finalOwnedResourceIds: [...result.revocation.finalOwnedResourceIds],
        });
        this.emit({ kind: 'cleanup-proof', inventories: result.cleanup.inventories });
      }
      const supervisorLost = await this.stopWatchdogAfterCleanup(result.cleanup);
      return {
        alreadyClosed: result.alreadyClosed,
        supervisorLost,
        revocation: result.revocation,
        cleanup: result.cleanup,
      };
    } finally {
      // Preserve ownership throughout cleanup, but never leave an errored
      // coordinator heartbeating forever; the supervisor/reconciler must then
      // be able to take over after the stale bound.
      this.clearHeartbeatTimer();
      this.teardownPromise = undefined;
    }
  }

  private async stopWatchdogAfterCleanup(cleanup: DockerWorkloadCleanupProof): Promise<boolean> {
    const lease = loadDockerWorkloadLease(this.leasePath);
    this.context.supervisor.requestStop(
      this.context.stopRequestPath,
      { leaseId: lease.leaseId, generation: lease.generation, schemaVersion: lease.schemaVersion },
      cleanup,
      this.context.clock(),
    );
    const deadline = this.context.monotonicClock() + SUPERVISOR_STOP_TIMEOUT_MS;
    for (;;) {
      const status = this.context.supervisor.readStatus(this.context.statusPath);
      if (status?.state === 'closed') return false;
      const supervisorGone = this.supervisorPid === undefined || !this.context.supervisor.isAlive(this.supervisorPid);
      if (supervisorGone || this.context.monotonicClock() >= deadline) {
        this.emit({
          kind: 'incident',
          code: 'watchdog-supervisor-lost',
          detail: 'cleanup completed but the watchdog supervisor was unreachable for terminal acknowledgement',
        });
        return true;
      }
      await this.context.sleep(SUPERVISOR_STOP_POLL_MS);
    }
  }

  private startHeartbeatTimer(): void {
    if (!this.context.startHeartbeat) return;
    this.heartbeatTimer = setInterval(() => {
      void this.refreshCoordinatorHeartbeat().catch(() => {
        // Transient lease-lock contention or a terminal lease; the next interval retries.
      });
    }, DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private async retryCoordinatorHeartbeat(): Promise<boolean> {
    const deadline = this.context.monotonicClock() + DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS;
    for (;;) {
      if (this.rejecting) return false;
      try {
        const status = loadDockerWorkloadLease(this.leasePath).status;
        if (status !== 'admitting' && status !== 'active') return false;
        if (
          tryHeartbeatDockerWorkloadLease({
            leasePath: this.leasePath,
            generation: this.generation,
            clock: this.context.clock,
            processIdentityForPid: this.context.processIdentityForPid,
          })
        ) {
          return true;
        }
      } catch {
        // A concurrent short lease mutation gets the same bounded retry.
      }
      if (this.context.monotonicClock() >= deadline) return false;
      await this.context.sleep(HEARTBEAT_CLAIM_RETRY_MS);
    }
  }

  private startSupervisorMonitor(): void {
    if (!this.context.startHeartbeat || this.supervisorMonitorTimer !== undefined) return;
    this.supervisorMonitorTimer = setInterval(() => {
      void this.pollSupervisorHealth().catch((error: unknown) => {
        // Last resort inside a timer: a failed audit here has nowhere to go.
        this.tryEmitIncident('watchdog-monitor-teardown-failed', error);
      });
    }, this.loadedPolicy.policy.sampleIntervalMs);
    this.supervisorMonitorTimer.unref();
  }

  /** Throw unless {@link unprovenSupervisorProgressMs} is within the stale window. */
  private assertSupervisorStatus(status: ResourceWatchdogSupervisorStatus, mode: 'gate' | 'monitor'): void {
    const unprovenForMs = this.unprovenSupervisorProgressMs(status, mode);
    if (unprovenForMs >= this.loadedPolicy.policy.staleAfterMs) {
      throw new Error(
        `watchdog supervisor heartbeat is stale: no status change for ${unprovenForMs}ms of coordinator time`,
      );
    }
  }

  /**
   * Bind the status to this lease, policy, and live supervisor process (any
   * mismatch throws), then return for how long this coordinator has lacked
   * evidence of supervisor progress, judged by when it saw `updatedAt` change
   * on its own monotonic clock. A `'gate'` (pre-create, activation,
   * post-create) counts from the last change it saw; its own lateness is never
   * such evidence. The background `'monitor'` counts only time it actually
   * watched: after its own late iteration (host sleep, a paused VM) the
   * supervisor gets a fresh window instead of the blame.
   */
  private unprovenSupervisorProgressMs(status: ResourceWatchdogSupervisorStatus, mode: 'gate' | 'monitor'): number {
    assertResourceWatchdogSupervisorReady(status, {
      leaseId: this.leaseId,
      generation: this.generation,
      policy: this.loadedPolicy.policy,
    });
    const progress = this.supervisorProgress;
    if (this.supervisorPid === undefined || progress === undefined || status.supervisorPid !== this.supervisorPid) {
      throw new Error('watchdog supervisor process ID binding mismatch');
    }
    if (!this.context.supervisor.isAlive(this.supervisorPid)) {
      throw new Error('watchdog supervisor process is not alive');
    }
    const observation = progress.observe(status.updatedAt);
    return mode === 'gate' ? observation.sinceChangeMs : observation.silentForMs;
  }

  private clearSupervisorMonitor(): void {
    if (this.supervisorMonitorTimer !== undefined) {
      clearInterval(this.supervisorMonitorTimer);
      this.supervisorMonitorTimer = undefined;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private emit(payload: DockerWorkloadAuditEventPayload): void {
    emitAudit(this.context.auditSink, this.leaseId, this.generation, this.context.clock().toISOString(), payload);
  }

  /** Incident audit from a failure path: returns the audit failure instead of throwing it. */
  private tryEmitIncident(code: string, error: unknown): readonly unknown[] {
    return tryEmitIncidentAudit(
      this.context.auditSink,
      this.leaseId,
      this.generation,
      this.context.clock().toISOString(),
      {
        code,
        detail: incidentDetailFromError(error),
      },
    );
  }
}

/**
 * Exact recovery of every nonclosed lease (or only `onlyLeaseIds`). With
 * `waitForRecoveryOwner`, a lease whose lifecycle claim another owner holds is
 * waited for up to the recovery bound and then re-judged (an admission must
 * not fail just because a concurrent one is recovering the same lease);
 * otherwise it is reported fenced at once.
 */
async function reconcileHeld(
  options: ReconcileDockerWorkloadOptions,
  waitForRecoveryOwner: boolean,
  onlyLeaseIds?: readonly string[],
): Promise<ReconcileDockerWorkloadHeldResult> {
  const clock = options.clock ?? defaultClock;
  const monotonicClock = resolveLifecycleMonotonicClock(options);
  const sleep = options.sleep ?? defaultSleep;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const identityForPid = options.processIdentityForPid ?? getProcessStartIdentity;
  const supervisor = options.supervisor ?? defaultSupervisorController;
  const recoveryBoundMs = options.recoveryBoundMs ?? DOCKER_WORKLOAD_RECOVERY_BOUND_MS;
  const staleHeartbeatMs = options.staleHeartbeatMs ?? DOCKER_WORKLOAD_STALE_HEARTBEAT_MS;
  const leasesRoot = getDockerWorkloadLeasesRoot();

  const reconciled: string[] = [];
  const preserved: string[] = [];
  const fences: Array<{ readonly leaseId: string; readonly detail: string }> = [];
  const postCloseAuditFailures: DockerWorkloadPostCloseAuditError[] = [];
  const recordFence = (leaseId: string, detail: string): void => {
    fences.push({ leaseId, detail });
  };
  const leaseIds =
    onlyLeaseIds === undefined
      ? listLeaseIds(leasesRoot)
      : listLeaseIds(leasesRoot).filter((leaseId) => onlyLeaseIds.includes(leaseId));
  for (const leaseId of leaseIds) {
    const leaseDir = join(leasesRoot, leaseId);
    const leasePath = join(leaseDir, LEASE_FILE);
    let lease;
    try {
      lease = loadDockerWorkloadLease(leasePath);
    } catch {
      // Unrelated directories are ignored, but once a lease marker exists its
      // contents are authoritative lifecycle state. Corruption, permissions,
      // symlinks, or an older unsupported schema must fence admission rather
      // than making possibly-running outer resources disappear from recovery.
      if (pathEntryExistsWithoutFollowing(leasePath)) {
        recordFence(leaseId, `${leaseId} (lease record is unreadable; exact recovery cannot be proven)`);
      }
      continue;
    }
    if (lease.status === 'closed') continue;
    const coordinatorProcessAlive = isCoordinatorProcessAlive(lease, pidAlive, identityForPid);
    let heartbeatFresh = isHeartbeatAgeFresh(lease, clock(), staleHeartbeatMs);
    if (
      lease.incident === null &&
      !heartbeatFresh &&
      coordinatorProcessAlive &&
      (lease.status === 'admitting' || lease.status === 'active')
    ) {
      // A live coordinator whose heartbeat only looks stale may just have
      // resumed from host sleep or seen a wall-clock step. That snapshot never
      // destroys it: watch it for one bounded window of this process's own
      // monotonic clock. Progress proves it alive; a whole silent window is
      // the same bounded missed heartbeat that makes any coordinator stale.
      const watched = await watchCoordinatorHeartbeat({
        leasePath,
        baseline: lease,
        windowMs: staleHeartbeatMs,
        monotonicClock,
        sleep,
        isLive: (current) => isLeaseLive(current, leaseDir, supervisor, true, clock()),
      });
      lease = watched.lease;
      if (lease.status === 'closed') continue;
      heartbeatFresh = watched.progressed;
    }
    const recoveringIncident = lease.incident !== null;
    const coordinatorLive = heartbeatFresh && coordinatorProcessAlive;
    if (!recoveringIncident && isLeaseLive(lease, leaseDir, supervisor, coordinatorLive, clock())) {
      preserved.push(leaseId);
      continue;
    }
    // A recent heartbeat fences long enough for a just-launched supervisor to
    // publish status. After the stale bound, cleanup-claim serialization makes
    // it safe for reconciliation to compete with an in-flight supervisor trip.
    if (!recoveringIncident && heartbeatFresh) {
      recordFence(leaseId, `${leaseId} (lifecycle is still owned or recently active)`);
      continue;
    }
    try {
      await recoverStaleLease({
        leaseDir,
        leasePath,
        lease,
        options,
        clock,
        sleep,
        supervisor,
        recoveryBoundMs,
        waitForOwner: waitForRecoveryOwner,
      });
      reconciled.push(leaseId);
    } catch (error) {
      if (error instanceof DockerWorkloadPostCloseAuditError) {
        // Cleanup is already proven. Preserve mandatory audit failure as the
        // pass result, but continue exact recovery so an earlier lease cannot
        // starve later incident cleanup.
        postCloseAuditFailures.push(error);
        continue;
      }
      if (isDockerWorkloadLifecycleClaimBusy(error) || error instanceof DockerWorkloadCleanupPreconditionError) {
        recordFence(leaseId, `${leaseId} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      const auditFailures = fenceLease(leasePath, lease.leaseId, lease.generation, error, clock, options.auditSink);
      recordFence(leaseId, describeFencedLease(leasePath, leaseId, error, auditFailures));
    }
  }
  if (postCloseAuditFailures.length === 1) throw postCloseAuditFailures[0];
  if (postCloseAuditFailures.length > 1) {
    throw new DockerWorkloadPostCloseAuditError(
      `${postCloseAuditFailures.length} Docker-workload leases were durably closed, but mandatory audit publication failed`,
      new AggregateError(postCloseAuditFailures),
    );
  }
  return {
    reconciled,
    preserved,
    fenced: fences.map((fence) => fence.leaseId),
    fences,
  };
}

function isLeaseLive(
  lease: ReturnType<typeof loadDockerWorkloadLease>,
  leaseDir: string,
  supervisor: WatchdogSupervisorController,
  coordinatorFresh: boolean,
  now: Date,
): boolean {
  // A detached supervisor protects cleanup; it never inherits ownership of a
  // bundle. A dead or stale coordinator therefore always makes the lease
  // recoverable even when the supervisor continues sampling successfully.
  if (!coordinatorFresh) return false;
  // Admission before watchdog attestation and coordinator-driven revocation
  // are live while their coordinator is fresh. Once active, both independent
  // owners must be fresh and bound to this exact lease/policy.
  if (lease.status !== 'active') return true;
  try {
    const status = supervisor.readStatus(join(leaseDir, STATUS_FILE));
    if (status === undefined) return false;
    const supervisorStaleAfterMs = loadLeaseWatchdogPolicy(lease, join(leaseDir, POLICY_FILE)).policy.staleAfterMs;
    assertResourceWatchdogSupervisorFresh(
      status,
      { leaseId: lease.leaseId, generation: lease.generation, ...watchdogSupervisorPolicyBinding(lease) },
      supervisorStaleAfterMs,
      now,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the coordinator process recorded in the lease still exists. A v3
 * lease also binds the process-start identity, so a reused PID reads as dead;
 * older leases bind only the PID.
 */
function isCoordinatorProcessAlive(
  lease: DockerWorkloadLease,
  pidAlive: (pid: number) => boolean,
  identityForPid: ProcessIdentityResolver,
): boolean {
  if (!pidAlive(lease.coordinator.pid)) return false;
  if (lease.schemaVersion !== 3) return true;
  let identity: string | undefined;
  try {
    identity = identityForPid(lease.coordinator.pid);
  } catch {
    // An unreadable process table cannot prove the coordinator dead.
    return true;
  }
  return identity === lease.coordinator.processIdentity;
}

/**
 * One-snapshot wall-clock freshness of the coordinator heartbeat. A heartbeat
 * from further in the future than one heartbeat interval means the wall clock
 * stepped back after it was written; its age is unknown, so it is not fresh
 * evidence (it would otherwise fence a dead coordinator's lease for as long as
 * the step). A smaller step reads as just written, which delays a dead
 * coordinator's recovery by at most that interval.
 */
function isHeartbeatAgeFresh(lease: DockerWorkloadLease, now: Date, staleHeartbeatMs: number): boolean {
  const ageMs = now.getTime() - Date.parse(lease.coordinator.heartbeatAt);
  return ageMs > -DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS && ageMs < staleHeartbeatMs;
}

/**
 * Poll one lease for up to `windowMs` of observer-monotonic time. Returns as
 * soon as the heartbeat has changed from `baseline` and the lease is live by
 * `isLive`, or when the lease leaves admission/activity, or when the window
 * ends. `progressed` reports whether the heartbeat changed at all.
 */
async function watchCoordinatorHeartbeat(context: {
  readonly leasePath: string;
  readonly baseline: DockerWorkloadLease;
  readonly windowMs: number;
  readonly monotonicClock: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly isLive: (lease: DockerWorkloadLease) => boolean;
}): Promise<{ readonly lease: DockerWorkloadLease; readonly progressed: boolean }> {
  const deadline = context.monotonicClock() + context.windowMs;
  let lease = context.baseline;
  let progressed = false;
  for (;;) {
    await context.sleep(RECONCILE_LIVENESS_POLL_MS);
    try {
      lease = loadDockerWorkloadLease(context.leasePath);
    } catch {
      // Exact recovery re-reads the record and fences on what it finds.
      return { lease, progressed };
    }
    if (lease.status !== 'admitting' && lease.status !== 'active') return { lease, progressed };
    progressed ||= lease.coordinator.heartbeatAt !== context.baseline.coordinator.heartbeatAt;
    if ((progressed && context.isLive(lease)) || context.monotonicClock() >= deadline) return { lease, progressed };
  }
}

/** Monotonic clock for lifecycle code whose wall clock may be injected (see {@link resolveMonotonicClock}). */
function resolveLifecycleMonotonicClock(options: {
  readonly clock?: () => Date;
  readonly monotonicClock?: () => number;
}): () => number {
  const injectedClock = options.clock;
  return resolveMonotonicClock(
    injectedClock === undefined ? undefined : () => injectedClock().getTime(),
    options.monotonicClock,
  );
}

async function recoverStaleLease(context: {
  readonly leaseDir: string;
  readonly leasePath: string;
  readonly lease: ReturnType<typeof loadDockerWorkloadLease>;
  readonly options: ReconcileDockerWorkloadOptions;
  readonly clock: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly supervisor: WatchdogSupervisorController;
  readonly recoveryBoundMs: number;
  /** Wait (bounded by `recoveryBoundMs`) for a lifecycle owner instead of failing busy at once. */
  readonly waitForOwner: boolean;
}): Promise<void> {
  const { leaseDir, leasePath, lease, options, clock, sleep, supervisor, recoveryBoundMs, waitForOwner } = context;
  const endpoint = lease.schemaVersion === 1 ? undefined : lease.dockerEndpoint;
  const runtime =
    lease.runtimeKind === options.runtimeKind &&
    (endpoint === undefined || endpoint.host === options.runtime.dockerEndpoint?.host)
      ? options.runtime
      : endpoint === undefined
        ? options.runtimeForKind?.(lease.runtimeKind)
        : (options.runtimeForKind ?? createContainerRuntime)(lease.runtimeKind, endpoint);
  if (runtime === undefined) {
    throw new Error(
      `cannot reconcile ${lease.runtimeKind} lease through selected ${options.runtimeKind} runtime; recorded runtime is unavailable`,
    );
  }
  if (endpoint !== undefined && runtime.dockerEndpoint?.host !== endpoint.host) {
    throw new Error('recovery runtime does not match the recorded Docker endpoint');
  }
  const loadedPolicy = loadLeaseWatchdogPolicy(lease, join(leaseDir, POLICY_FILE));
  const result = await performSerializedDockerWorkloadCleanup({
    runtime,
    leasePath,
    generation: lease.generation,
    targetDevice: loadedPolicy.policy.targetDevice,
    targetInode: loadedPolicy.policy.targetInode,
    gapMs: loadedPolicy.policy.cleanupInventoryGapMs,
    clock,
    sleep,
    waitForOwner,
    timeoutMs: recoveryBoundMs,
    processIdentityForPid: options.processIdentityForPid,
    revalidate: (claimedLease) => {
      if (claimedLease.status === 'incident') return;
      if (claimedLease.status === 'revoking') return;
      if (claimedLease.status !== 'admitting' && claimedLease.status !== 'active') {
        throw new DockerWorkloadCleanupPreconditionError(
          `lease state ${claimedLease.status} no longer permits reconciliation cleanup`,
        );
      }
      // Staleness was judged on exactly this heartbeat value. Any change means
      // its coordinator ran again, however the wall clock now compares.
      if (claimedLease.coordinator.heartbeatAt !== lease.coordinator.heartbeatAt) {
        throw new DockerWorkloadCleanupPreconditionError('coordinator heartbeat refreshed before cleanup ownership');
      }
    },
    onRevoking: (from) => {
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'lease-transition',
        from,
        to: 'revoking',
      });
    },
  });
  if (result.revocation !== undefined) {
    try {
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'revocation-result',
        removedResourceIds: [...result.revocation.removedResourceIds],
        finalOwnedResourceIds: [...result.revocation.finalOwnedResourceIds],
      });
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'cleanup-proof',
        inventories: result.cleanup.inventories,
      });
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'lease-transition',
        from: 'revoking',
        to: 'closed',
      });
    } catch (error) {
      throw new DockerWorkloadPostCloseAuditError(
        `Docker-workload lease ${lease.leaseId} is durably closed, but mandatory cleanup audit publication failed`,
        error,
      );
    }
  }

  try {
    supervisor.requestStop(
      join(leaseDir, STOP_REQUEST_FILE),
      { leaseId: lease.leaseId, generation: lease.generation, schemaVersion: lease.schemaVersion },
      result.cleanup,
      clock(),
    );
  } catch (error) {
    // Exact cleanup is already durably closed. A detached supervisor also
    // observes that proof directly, so a failed stop notification is an
    // operational incident, not unresolved workload authority.
    try {
      emitAudit(options.auditSink, lease.leaseId, lease.generation, clock().toISOString(), {
        kind: 'incident',
        code: 'watchdog-supervisor-stop-notification-failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } catch (auditError) {
      throw new DockerWorkloadPostCloseAuditError(
        `Docker-workload lease ${lease.leaseId} is durably closed, but mandatory supervisor-loss audit publication failed`,
        auditError,
      );
    }
  }
}

/**
 * Fence a lease whose recovery failed. Runs on a failure path, so it never
 * throws: recording failures are returned and reported with the fence instead
 * of replacing the recovery failure (the fenced lease still blocks admission).
 */
function fenceLease(
  leasePath: string,
  leaseId: string,
  generation: string,
  error: unknown,
  clock: () => Date,
  auditSink: DockerWorkloadAuditSink | undefined,
): readonly unknown[] {
  const detail = incidentDetailFromError(error);
  try {
    const current = loadDockerWorkloadLease(leasePath);
    if (current.incident !== null && current.status === 'revoking') {
      returnDockerWorkloadLeaseRecoveryToIncident(leasePath, generation, clock());
    } else if (current.status !== 'incident' && current.status !== 'closed') {
      recordDockerWorkloadLeaseIncident(
        leasePath,
        generation,
        { code: 'docker-workload-recovery-fenced', detail },
        clock(),
      );
    }
  } catch {
    // Best effort: the audit incident below is the durable record.
  }
  return tryEmitIncidentAudit(auditSink, leaseId, generation, clock().toISOString(), {
    code: 'docker-workload-recovery-fenced',
    detail,
  });
}

function describeFencedLease(
  leasePath: string,
  leaseId: string,
  error: unknown,
  auditFailures: readonly unknown[] = [],
): string {
  const latest = incidentDetailFromError(error);
  const audit =
    auditFailures.length === 0
      ? ''
      : `; incident audit publication failed: ${auditFailures.map((failure) => incidentDetailFromError(failure, 256)).join('; ')}`;
  try {
    const lease = loadDockerWorkloadLease(leasePath);
    if (lease.incident === null) return `${leaseId} (latest recovery failure: ${latest}${audit})`;
    return `${leaseId} (original incident ${lease.incident.code} at ${lease.incident.recordedAt}: ${lease.incident.detail}; latest recovery failure: ${latest}${audit})`;
  } catch {
    return `${leaseId} (lease record is unreadable; latest recovery failure: ${latest}${audit})`;
  }
}

/**
 * Allocated bytes of every bound storage file right now: the activation
 * baseline above which growth is charged to the released bundle. When the
 * policy measures container storage, every live container must be bound, and
 * a bound file must still be the pinned inode, or the agent is not released.
 */
function measureStorageBaselines(lease: DockerWorkloadLease, requireBinding: boolean): ReadonlyMap<string, number> {
  const baselines = new Map<string, number>();
  if (lease.status !== 'admitting') return baselines;
  for (const resource of lease.resources) {
    const storage = resource.storage;
    if (storage === undefined) {
      if (requireBinding && resource.kind === 'container' && resource.removal === null) {
        throw new Error(`refusing activation: watchdog cannot measure the storage of ${resource.requestedName}`);
      }
      continue;
    }
    const stats = lstatSync(storage.path);
    if (!stats.isFile() || stats.dev !== storage.device || stats.ino !== storage.inode) {
      throw new Error(`bound container storage changed identity before activation: ${storage.path}`);
    }
    baselines.set(resource.requestId, stats.blocks * 512);
  }
  return baselines;
}

/**
 * Admission keeps writing the reserved `exchangeRoot` (see bundle-lease.ts):
 * every lease schema version requires it, and every release parses every lease
 * directory. It records the path only; no `exchange` directory is created.
 */
function leasePathsFor(workspaceRoot: string, stateRoot: string, bundleId: string) {
  return {
    workspaceRoot,
    stateRoot,
    bundleRuntimeRoot: getBundleRuntimeRootForHome(getIronCurtainHome(), bundleId),
    runtimeRoot: join(stateRoot, 'daemon'),
    apiRoot: join(stateRoot, 'api'),
    exchangeRoot: join(stateRoot, 'exchange'),
    stagingRoot: join(stateRoot, 'staging'),
  };
}

function createStateRootSubtree(stateRoot: string): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (const subdir of STATE_SUBDIRS) mkdirSync(join(stateRoot, subdir), { recursive: true, mode: 0o700 });
}

function listLeaseIds(leasesRoot: string): readonly string[] {
  if (!existsSync(leasesRoot)) return [];
  return readdirSync(leasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

interface AdmissionLockContext {
  readonly processIdentityForPid: ProcessIdentityResolver | undefined;
  readonly monotonicClock: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly waitMs: number;
  readonly onWait: (message: string) => void;
}

/** Per lock path, the tail of this process's admission queue. */
const admissionQueues = new Map<string, Promise<void>>();

/**
 * Run `operation` inside the global admission critical section. Admissions
 * in this process queue in order first: the process lock treats its own PID
 * as a live owner, so without the queue a second same-process admission would
 * be refused instead of waiting. The cross-process lock is then polled for up
 * to `waitMs`, naming its holder once per holder.
 */
async function withDockerWorkloadAdmissionLock<T>(
  root: string,
  context: AdmissionLockContext,
  operation: () => Promise<T>,
): Promise<T> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, ADMISSION_LOCK_FILE);
  const previous = admissionQueues.get(lockPath) ?? Promise.resolve();
  let endTurn: () => void = () => {};
  const turn = new Promise<void>((resolveTurn) => {
    endTurn = resolveTurn;
  });
  const tail = previous.then(() => turn);
  admissionQueues.set(lockPath, tail);
  await previous;
  try {
    const lock = await acquireAdmissionLock(lockPath, context);
    try {
      return await operation();
    } finally {
      lock.release();
    }
  } finally {
    endTurn();
    if (admissionQueues.get(lockPath) === tail) admissionQueues.delete(lockPath);
  }
}

async function acquireAdmissionLock(lockPath: string, context: AdmissionLockContext): Promise<ProcessLockHandle> {
  const deadline = context.monotonicClock() + context.waitMs;
  let reportedHolder: string | undefined;
  for (;;) {
    try {
      return acquireProcessLock(lockPath, {
        attempts: ADMISSION_LOCK_ACQUIRE_ATTEMPTS,
        processIdentityForPid: context.processIdentityForPid,
      });
    } catch (error) {
      if (!(error instanceof ProcessLockBusyError)) throw error;
      if (context.monotonicClock() >= deadline) {
        throw new DockerWorkloadAdmissionBusyError(error.ownerPid, context.waitMs, error);
      }
      const holder = error.ownerPid === undefined ? 'another process' : `pid ${error.ownerPid}`;
      if (holder !== reportedHolder) {
        reportedHolder = holder;
        context.onWait(
          `Waiting for nested-Docker admission held by ${holder} (up to ${Math.round(context.waitMs / 1000)}s)`,
        );
      }
      await context.sleep(ADMISSION_LOCK_POLL_MS);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathEntryExistsWithoutFollowing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

/**
 * The one lifecycle audit emitter. Incident details are bounded here, so no
 * error message can exceed the audit schema and turn a recorded incident into
 * a schema failure.
 */
function emitAudit(
  sink: DockerWorkloadAuditSink | undefined,
  leaseId: string,
  generation: string,
  at: string,
  payload: DockerWorkloadAuditEventPayload,
): void {
  if (sink === undefined) return;
  const bounded = payload.kind === 'incident' ? { ...payload, detail: boundIncidentDetail(payload.detail) } : payload;
  sink.emit({ at, leaseId, generation, ...bounded });
}

/** Emit an incident from a failure path; returns the audit failure instead of letting it replace the incident. */
function tryEmitIncidentAudit(
  sink: DockerWorkloadAuditSink | undefined,
  leaseId: string,
  generation: string,
  at: string,
  incident: { readonly code: string; readonly detail: string },
): readonly unknown[] {
  try {
    emitAudit(sink, leaseId, generation, at, { kind: 'incident', ...incident });
    return [];
  } catch (error) {
    return [error];
  }
}

function defaultClock(): Date {
  return new Date();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const defaultSupervisorController: WatchdogSupervisorController = {
  launch: (options) => launchDetachedResourceWatchdogSupervisor(options),
  readStatus: (statusPath) => {
    try {
      return loadResourceWatchdogSupervisorStatus(statusPath);
    } catch {
      return undefined;
    }
  },
  requestStop: (stopRequestPath, lease, cleanup, now) =>
    requestResourceWatchdogSupervisorStop(stopRequestPath, lease, cleanup, now),
  isAlive: (pid) => defaultPidAlive(pid),
};
