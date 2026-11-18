/** Host-only observed-state watchdog for secure nested Docker bundles. */

import { lstat, readdir, statfs } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { z } from 'zod';
import { loadImmutableHostJson } from '../hardened-fs.js';
import { identifierSchema } from '../zod-helpers.js';
import { resolveMonotonicClock } from './peer-liveness.js';

/**
 * Version 1 measured host directories under the lease state root. Nothing the
 * bundle writes ever lands there, so those classes could never reach a
 * threshold; v1 stays readable only for generations created before version 2.
 */
export const LEGACY_RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION = 1;
/** Version 2 measures the runtime storage the bundle actually grows (see {@link runtimeStorageClassSchema}). */
export const RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION = 2;
export const MAX_RESOURCE_WATCHDOG_POLICY_BYTES = 256 * 1024;

const positiveBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hostStateClassSchema = z
  .object({
    id: identifierSchema,
    relativePath: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) => !value.startsWith('/') && posix.normalize(value) === value && !value.split('/').includes('..'),
        {
          message: 'state class path must be canonical and relative',
        },
      ),
    kind: z.enum(['file', 'directory']),
    required: z.boolean(),
  })
  .strict();

/**
 * Apple: the allocated host blocks (`lstat().blocks`) of each ledgered VM's
 * runtime-owned rootfs image, bound to its container ID at create. Growth is
 * charged from the activation baseline, so the trusted bootstrap image load is
 * not billed to the bundle.
 */
const appleContainerRootfsClassSchema = z
  .object({ id: identifierSchema, kind: z.literal('apple-container-rootfs') })
  .strict();

/**
 * Docker Desktop: the size of each ledgered daemon volume (the nested
 * daemon's VFS data root) as the outer Engine's disk-usage report gives it.
 * That walk is too slow for every sample, so it has its own cadence, timeout,
 * and staleness bound; every sample also reads the Desktop VM disk (see
 * `runtimeReserveBytes`).
 */
const dockerVolumeClassSchema = z
  .object({
    id: identifierSchema,
    kind: z.literal('docker-volume'),
    role: z.literal('daemon-api'),
    sampleIntervalMs: z
      .number()
      .int()
      .min(1_000)
      .max(10 * 60_000),
    sampleTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(10 * 60_000),
    staleAfterMs: z
      .number()
      .int()
      .min(2_000)
      .max(60 * 60_000),
  })
  .strict()
  .superRefine((stateClass, context) => {
    if (
      stateClass.sampleTimeoutMs >= stateClass.staleAfterMs ||
      stateClass.sampleIntervalMs >= stateClass.staleAfterMs
    ) {
      context.addIssue({ code: 'custom', message: 'volume staleness must exceed its timeout and interval' });
    }
  });

/** Measured runtime storage, one kind per backend. */
export const runtimeStorageClassSchema = z.discriminatedUnion('kind', [
  appleContainerRootfsClassSchema,
  dockerVolumeClassSchema,
]);
export type RuntimeStorageClass = z.infer<typeof runtimeStorageClassSchema>;

/** Runtime kinds a version-2 policy measures; matches the lease's `runtimeKind`. */
export const RUNTIME_STORAGE_RUNTIME_KINDS = ['docker', 'apple-container'] as const;
export type RuntimeStorageRuntimeKind = (typeof RUNTIME_STORAGE_RUNTIME_KINDS)[number];

/** The class kind that gives real storage coverage on each runtime. */
export const RUNTIME_STORAGE_CLASS_KIND = {
  docker: 'docker-volume',
  'apple-container': 'apple-container-rootfs',
} as const satisfies Record<RuntimeStorageRuntimeKind, RuntimeStorageClass['kind']>;

const policyFields = {
  policyId: identifierSchema,
  targetRoot: z.string().min(1).max(4096),
  targetDevice: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  targetInode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sampleIntervalMs: z.number().int().min(100).max(60_000),
  sampleTimeoutMs: z.number().int().min(100).max(60_000),
  staleAfterMs: z
    .number()
    .int()
    .min(200)
    .max(5 * 60_000),
  softEvidenceBytes: positiveBytes,
  hardSafetyBytes: positiveBytes,
  hostReserveBytes: positiveBytes,
  maximumOvershootBytes: positiveBytes,
  cleanupInventoryGapMs: z.number().int().min(100).max(60_000),
};

interface CommonPolicyValues {
  readonly targetRoot: string;
  readonly stateClasses: readonly { readonly id: string }[];
  readonly sampleIntervalMs: number;
  readonly sampleTimeoutMs: number;
  readonly staleAfterMs: number;
  readonly softEvidenceBytes: number;
  readonly hardSafetyBytes: number;
}

function refineCommonPolicy(policy: CommonPolicyValues, context: z.RefinementCtx): void {
  if (!isAbsolute(policy.targetRoot) || resolve(policy.targetRoot) !== policy.targetRoot) {
    context.addIssue({ code: 'custom', message: 'watchdog targetRoot must be canonical and absolute' });
  }
  if (policy.softEvidenceBytes >= policy.hardSafetyBytes) {
    context.addIssue({ code: 'custom', message: 'watchdog soft threshold must be below hard threshold' });
  }
  if (policy.sampleTimeoutMs >= policy.staleAfterMs || policy.staleAfterMs < policy.sampleIntervalMs * 2) {
    context.addIssue({ code: 'custom', message: 'watchdog stale threshold must exceed timeout and two intervals' });
  }
  const ids = policy.stateClasses.map((stateClass) => stateClass.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'duplicate watchdog state class ID' });
  }
}

/** Version 1: host directories/files below `targetRoot`. Readable only for existing generations. */
const hostDirectoryPolicySchema = z
  .object({
    schemaVersion: z.literal(LEGACY_RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION),
    ...policyFields,
    stateClasses: z.array(hostStateClassSchema).min(1).max(128),
  })
  .strict()
  .superRefine((policy, context) => {
    refineCommonPolicy(policy, context);
    const paths = policy.stateClasses.map((stateClass) => stateClass.relativePath);
    for (const path of paths) {
      if (
        paths.some(
          (candidate) => candidate !== path && (path.startsWith(`${candidate}/`) || candidate.startsWith(`${path}/`)),
        )
      ) {
        context.addIssue({ code: 'custom', message: 'watchdog state classes must not overlap' });
        break;
      }
    }
  });

/**
 * Version 2: the runtime storage the bundle grows. `targetRoot` remains the
 * host state root, used for exact cleanup identity and the host reserve.
 * Docker policies also carry `runtimeReserveBytes`, the floor for the Desktop
 * VM disk that every container of every session shares.
 */
const runtimeStoragePolicySchema = z
  .object({
    schemaVersion: z.literal(RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION),
    ...policyFields,
    runtimeKind: z.enum(RUNTIME_STORAGE_RUNTIME_KINDS),
    stateClasses: z.array(runtimeStorageClassSchema).min(1).max(8),
    runtimeReserveBytes: positiveBytes.optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    refineCommonPolicy(policy, context);
    const expectedKind = RUNTIME_STORAGE_CLASS_KIND[policy.runtimeKind];
    if (policy.stateClasses.some((stateClass) => stateClass.kind !== expectedKind)) {
      context.addIssue({ code: 'custom', message: `watchdog state classes must measure ${expectedKind} storage` });
    }
    if (new Set(policy.stateClasses.map((stateClass) => stateClass.kind)).size !== policy.stateClasses.length) {
      context.addIssue({ code: 'custom', message: 'watchdog storage kinds must not be measured twice' });
    }
    if ((policy.runtimeKind === 'docker') !== (policy.runtimeReserveBytes !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Docker policies require a runtime disk reserve; Apple policies must not have one',
      });
    }
  });

export const resourceWatchdogPolicySchema = z.discriminatedUnion('schemaVersion', [
  hostDirectoryPolicySchema,
  runtimeStoragePolicySchema,
]);

export type ResourceWatchdogPolicy = z.infer<typeof resourceWatchdogPolicySchema>;
export type HostDirectoryWatchdogPolicy = z.infer<typeof hostDirectoryPolicySchema>;
export type RuntimeStorageWatchdogPolicy = z.infer<typeof runtimeStoragePolicySchema>;

export interface LoadedResourceWatchdogPolicy {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly policy: ResourceWatchdogPolicy;
}

export interface ResourceStateClassSample {
  readonly id: string;
  readonly path: string;
  readonly exists: boolean;
  readonly allocatedBytes: number;
}

export interface ResourceWatchdogSample {
  readonly sampledAtMs: number;
  readonly targetDevice: number;
  readonly targetInode: number;
  /** Free bytes on the host filesystem holding the state root. */
  readonly availableBytes: number;
  /**
   * Free bytes on the container runtime's own disk (the Docker Desktop VM),
   * when the policy has a runtime reserve and a fresh reading exists.
   */
  readonly runtimeAvailableBytes?: number;
  readonly allocatedBytes: number;
  readonly classes: readonly ResourceStateClassSample[];
}

export type ResourceWatchdogTripCode =
  'hard-state-threshold' | 'host-reserve' | 'runtime-reserve' | 'sample-error' | 'sample-stale' | 'target-identity';

/** Every trip code, for the schemas that persist trips. */
export const RESOURCE_WATCHDOG_TRIP_CODES = [
  'hard-state-threshold',
  'host-reserve',
  'runtime-reserve',
  'sample-error',
  'sample-stale',
  'target-identity',
] as const satisfies readonly ResourceWatchdogTripCode[];

export interface ResourceWatchdogTrip {
  readonly code: ResourceWatchdogTripCode;
  readonly atMs: number;
  readonly detail: string;
  readonly sample?: ResourceWatchdogSample;
  readonly overshootBytes: number;
  readonly overshootWithinFrozenMaximum: boolean;
}

export interface ResourceWatchdogCleanupProof {
  readonly exactOuterResourceAbsent: boolean;
  readonly stateRootAbsent: boolean;
  readonly inventories: readonly [
    { readonly capturedAtMs: number; readonly ownedResourceIds: readonly string[] },
    { readonly capturedAtMs: number; readonly ownedResourceIds: readonly string[] },
  ];
}

export interface ResourceWatchdogAttestation {
  readonly policyId: string;
  readonly policy: ResourceWatchdogPolicy;
  readonly firstSample: ResourceWatchdogSample;
}

class ResourceWatchdogRevocationError extends Error {}

/** The watchdog's own sample deadline expired; distinguished so a stalled observer can retry once. */
class ResourceSampleTimeoutError extends Error {}

interface ResourceWatchdogOptions {
  readonly sample?: (signal: AbortSignal) => Promise<ResourceWatchdogSample>;
  readonly onTrip: (trip: ResourceWatchdogTrip) => Promise<void>;
  readonly onSoftEvidence?: (sample: ResourceWatchdogSample) => void;
  /** Wall clock for persisted evidence (`trip.atMs`). */
  readonly now?: () => number;
  /**
   * Observer-local monotonic clock for every in-process staleness and timing
   * decision. Defaults to `performance.now()`, or to `now` when only that is
   * injected.
   */
  readonly monotonicNow?: () => number;
  readonly schedule?: boolean;
}

/**
 * Samples independently of coordinator work. Production starts this in a
 * separate supervisor process; this class contains the fail-closed state
 * machine and is intentionally unaware of an inner Docker daemon.
 *
 * Every staleness decision uses the monotonic clock; wall-clock time is only
 * persisted evidence. A late iteration (the observer itself did not run: host
 * sleep, a paused VM, `SIGSTOP`, starvation) is not evidence about the bundle,
 * so it never trips by itself. The next tick judges a fresh sample on its own
 * merits, and the coordinator independently tears the bundle down when this
 * supervisor stops publishing samples for a full window of its clock.
 */
export class ResourceWatchdog {
  private readonly policy: ResourceWatchdogPolicy;
  private readonly expectedStateClassIdsJson: string;
  private readonly sampleState: (signal: AbortSignal) => Promise<ResourceWatchdogSample>;
  private readonly onTrip: (trip: ResourceWatchdogTrip) => Promise<void>;
  private readonly onSoftEvidence: ((sample: ResourceWatchdogSample) => void) | undefined;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly shouldSchedule: boolean;
  private timer: NodeJS.Timeout | undefined;
  /** Monotonic start of the sample attempt in flight. */
  private samplingStartedAtMs: number | undefined;
  /** Monotonic completion time of the last accepted sample (or deferral). */
  private lastCompletedAtMs: number | undefined;
  private tripRecord: ResourceWatchdogTrip | undefined;
  private revocationFailure: string | undefined;
  private stopped = false;

  constructor(policy: ResourceWatchdogPolicy, options: ResourceWatchdogOptions) {
    const validated = resourceWatchdogPolicySchema.parse(policy);
    this.policy = validated;
    this.expectedStateClassIdsJson = JSON.stringify(this.policy.stateClasses.map((stateClass) => stateClass.id).sort());
    if (options.sample !== undefined) {
      this.sampleState = options.sample;
    } else if (validated.schemaVersion === LEGACY_RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION) {
      this.sampleState = (signal) => sampleValidatedResourceStateAsync(validated, Date.now, signal);
    } else {
      // Runtime storage lives outside this process's view; only the
      // Docker-workload supervisor knows how to read it.
      throw new Error('a runtime-storage watchdog policy requires an injected storage sampler');
    }
    this.onTrip = options.onTrip;
    this.onSoftEvidence = options.onSoftEvidence;
    this.now = options.now ?? Date.now;
    this.monotonicNow = resolveMonotonicClock(options.now, options.monotonicNow);
    this.shouldSchedule = options.schedule ?? true;
  }

  async start(): Promise<ResourceWatchdogAttestation> {
    if (this.stopped || this.lastCompletedAtMs !== undefined || this.timer !== undefined) {
      throw new Error('resource watchdog cannot be started twice');
    }
    const firstSample = await this.tick();
    if (firstSample === undefined || this.tripRecord !== undefined) {
      throw new Error(`resource watchdog failed startup attestation: ${this.tripRecord?.detail ?? 'no sample'}`);
    }
    if (this.shouldSchedule) {
      this.timer = setInterval(() => void this.tick(), this.policy.sampleIntervalMs);
    }
    return { policyId: this.policy.policyId, policy: resourceWatchdogPolicySchema.parse(this.policy), firstSample };
  }

  async tick(): Promise<ResourceWatchdogSample | undefined> {
    if (this.stopped || this.tripRecord !== undefined) return undefined;
    const now = this.monotonicNow();
    if (this.samplingStartedAtMs !== undefined) {
      if (now - this.samplingStartedAtMs >= this.policy.staleAfterMs) {
        await this.trigger('sample-stale', `sample has not completed for ${now - this.samplingStartedAtMs}ms`);
      }
      return undefined;
    }
    // However long ago the last sample completed, this tick takes a fresh one:
    // a late iteration says this observer did not run, not that the bundle
    // misbehaved. The fresh sample below trips on its own measurement.
    try {
      const sample = await this.takeSample();
      this.assertSampleIdentity(sample);
      this.lastCompletedAtMs = this.monotonicNow();
      const runtimeReserveBytes =
        this.policy.schemaVersion === RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION
          ? this.policy.runtimeReserveBytes
          : undefined;
      if (sample.availableBytes < this.policy.hostReserveBytes) {
        await this.trigger(
          'host-reserve',
          `host available bytes ${sample.availableBytes} are below reserve ${this.policy.hostReserveBytes}`,
          sample,
        );
      } else if (
        runtimeReserveBytes !== undefined &&
        sample.runtimeAvailableBytes !== undefined &&
        sample.runtimeAvailableBytes < runtimeReserveBytes
      ) {
        await this.trigger(
          'runtime-reserve',
          `container runtime disk available bytes ${sample.runtimeAvailableBytes} are below reserve ${runtimeReserveBytes}`,
          sample,
        );
      } else if (sample.allocatedBytes > this.policy.hardSafetyBytes) {
        await this.trigger(
          'hard-state-threshold',
          `owned state ${sample.allocatedBytes} exceeds hard threshold ${this.policy.hardSafetyBytes}`,
          sample,
        );
      } else if (sample.allocatedBytes >= this.policy.softEvidenceBytes) {
        this.onSoftEvidence?.(sample);
      }
      return sample;
    } catch (error) {
      if (error instanceof ResourceWatchdogRevocationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code: ResourceWatchdogTripCode = /identity/u.test(message) ? 'target-identity' : 'sample-error';
      await this.trigger(code, message);
      return undefined;
    } finally {
      this.samplingStartedAtMs = undefined;
    }
  }

  get trip(): ResourceWatchdogTrip | undefined {
    return this.tripRecord;
  }

  /**
   * Trip on a fail-closed condition no sample can report, for example a
   * supervisor that cannot take its lifecycle claim because host storage is
   * exhausted. Same revocation path as a sampled trip; a no-op once stopped
   * or tripped.
   */
  async failClosed(code: ResourceWatchdogTripCode, detail: string): Promise<void> {
    if (this.stopped || this.tripRecord !== undefined) return;
    await this.trigger(code, detail);
  }

  get revocationError(): string | undefined {
    return this.revocationFailure;
  }

  assertFresh(): void {
    if (this.stopped) throw new Error('resource watchdog is stopped');
    if (this.tripRecord !== undefined) throw new Error(`resource watchdog tripped: ${this.tripRecord.detail}`);
    if (
      this.lastCompletedAtMs === undefined ||
      this.monotonicNow() - this.lastCompletedAtMs >= this.policy.staleAfterMs
    ) {
      throw new Error('resource watchdog sample is stale or absent');
    }
  }

  /**
   * Restart the freshness window (what `assertFresh` judges) while a trusted,
   * process-bound lifecycle operation owns the resource boundary. The caller
   * must demand a real tick as soon as that ownership becomes available again.
   */
  deferSamplingForTrustedLifecycleOperation(): void {
    if (this.stopped || this.tripRecord !== undefined) {
      throw new Error('resource watchdog cannot defer sampling after it stops or trips');
    }
    if (this.lastCompletedAtMs === undefined || this.samplingStartedAtMs !== undefined) {
      throw new Error('resource watchdog can defer only after an attested sample and outside an active sample');
    }
    this.lastCompletedAtMs = this.monotonicNow();
  }

  stopAfterCleanup(proof: ResourceWatchdogCleanupProof): void {
    if (!proof.exactOuterResourceAbsent || !proof.stateRootAbsent) {
      throw new Error('resource watchdog cannot stop before exact outer/state removal');
    }
    const [first, second] = proof.inventories;
    if (first.ownedResourceIds.length !== 0 || second.ownedResourceIds.length !== 0) {
      throw new Error('resource watchdog cannot stop before two empty owned inventories');
    }
    if (second.capturedAtMs - first.capturedAtMs < this.policy.cleanupInventoryGapMs) {
      throw new Error('resource watchdog cleanup inventories are not sufficiently separated');
    }
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.stopped = true;
  }

  /**
   * One bounded sample. When its deadline fires at least a full sample
   * interval late on either clock, this observer was not running for part of
   * the attempt (host sleep, or a VM whose monotonic clock counts the pause),
   * so the timeout judges the observer rather than the bundle. Exactly one
   * fresh attempt then decides; a second timeout trips as before.
   */
  private async takeSample(): Promise<ResourceWatchdogSample> {
    for (let attempt = 1; ; attempt += 1) {
      const startedAtMs = this.monotonicNow();
      const startedAtWallMs = this.now();
      this.samplingStartedAtMs = startedAtMs;
      const abortController = new AbortController();
      try {
        return await withTimeout(
          this.sampleState(abortController.signal),
          this.policy.sampleTimeoutMs,
          'resource sample timed out',
          () => abortController.abort(new Error('resource sample timed out')),
        );
      } catch (error) {
        const stalledAfterMs = this.policy.sampleTimeoutMs + this.policy.sampleIntervalMs;
        const observerStalled =
          this.monotonicNow() - startedAtMs >= stalledAfterMs || this.now() - startedAtWallMs >= stalledAfterMs;
        if (attempt > 1 || !(error instanceof ResourceSampleTimeoutError) || !observerStalled) throw error;
      }
    }
  }

  private assertSampleIdentity(sample: ResourceWatchdogSample): void {
    if (sample.targetDevice !== this.policy.targetDevice || sample.targetInode !== this.policy.targetInode) {
      throw new Error(
        `watchdog target identity changed: expected ${this.policy.targetDevice}:${this.policy.targetInode}, ` +
          `got ${sample.targetDevice}:${sample.targetInode}`,
      );
    }
    const actualIds = sample.classes.map((stateClass) => stateClass.id).sort();
    if (JSON.stringify(actualIds) !== this.expectedStateClassIdsJson) {
      throw new Error('watchdog target identity/scope changed: state class set mismatch');
    }
    const total = sample.classes.reduce((sum, stateClass) => sum + stateClass.allocatedBytes, 0);
    if (total !== sample.allocatedBytes) throw new Error('watchdog sample allocated-byte total is inconsistent');
    for (const value of [sample.availableBytes, sample.allocatedBytes, sample.runtimeAvailableBytes]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error('watchdog sample byte counts must be non-negative safe integers');
      }
    }
  }

  private async trigger(
    code: ResourceWatchdogTripCode,
    detail: string,
    sample?: ResourceWatchdogSample,
  ): Promise<void> {
    if (this.tripRecord !== undefined) return;
    const overshootBytes = Math.max(0, (sample?.allocatedBytes ?? 0) - this.policy.hardSafetyBytes);
    const trip: ResourceWatchdogTrip = {
      code,
      atMs: this.now(),
      detail,
      ...(sample === undefined ? {} : { sample }),
      overshootBytes,
      overshootWithinFrozenMaximum: overshootBytes <= this.policy.maximumOvershootBytes,
    };
    this.tripRecord = trip;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.onTrip(trip);
    } catch (error) {
      this.revocationFailure = error instanceof Error ? error.message : String(error);
      throw new ResourceWatchdogRevocationError(`resource watchdog revocation failed: ${this.revocationFailure}`, {
        cause: error,
      });
    }
  }
}

export function loadResourceWatchdogPolicy(path: string): LoadedResourceWatchdogPolicy {
  const loaded = loadImmutableHostJson(path, {
    label: 'resource watchdog policy',
    schema: resourceWatchdogPolicySchema,
    maxBytes: MAX_RESOURCE_WATCHDOG_POLICY_BYTES,
  });
  return { path: loaded.path, sha256: loaded.sha256, sizeBytes: loaded.sizeBytes, policy: loaded.value };
}

/**
 * Measure allocated host blocks for non-overlapping exact state classes of a
 * version-1 policy. The signal is the caller's cancellation seam; an unaborted
 * default keeps one-shot measurements outside the watchdog's timeout
 * machinery simple.
 */
export function sampleResourceState(
  policy: ResourceWatchdogPolicy,
  now = Date.now,
  signal: AbortSignal = new AbortController().signal,
): Promise<ResourceWatchdogSample> {
  const validated = resourceWatchdogPolicySchema.parse(policy);
  if (validated.schemaVersion !== LEGACY_RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION) {
    return Promise.reject(new Error('runtime-storage policies are sampled by the Docker-workload supervisor'));
  }
  return sampleValidatedResourceStateAsync(validated, now, signal);
}

export interface WatchdogHostTargetSample {
  readonly targetDevice: number;
  readonly targetInode: number;
  /** `statfs` free bytes available to an unprivileged writer on the state root's filesystem. */
  readonly availableBytes: number;
}

/**
 * Prove the state root is still the exact real directory rendered into the
 * policy, then read the free space of the filesystem that holds it. Every
 * sampler starts here: the identity guards cleanup, the free space is the
 * host reserve.
 */
export async function sampleWatchdogHostTarget(
  policy: Pick<ResourceWatchdogPolicy, 'targetRoot' | 'targetDevice' | 'targetInode'>,
  signal: AbortSignal,
): Promise<WatchdogHostTargetSample> {
  throwIfAborted(signal);
  const root = await lstat(policy.targetRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('watchdog target identity is not a real directory');
  if (root.dev !== policy.targetDevice || root.ino !== policy.targetInode) {
    throw new Error('watchdog target identity changed before measurement');
  }
  const filesystem = await statfs(policy.targetRoot);
  return { targetDevice: root.dev, targetInode: root.ino, availableBytes: filesystem.bavail * filesystem.bsize };
}

/**
 * Sample using an already-validated policy; the ResourceWatchdog hot path skips
 * the per-tick re-parse. Async so timeout and supervisor signals remain
 * observable during large walks.
 */
async function sampleValidatedResourceStateAsync(
  validated: HostDirectoryWatchdogPolicy,
  now: () => number,
  signal: AbortSignal,
): Promise<ResourceWatchdogSample> {
  const host = await sampleWatchdogHostTarget(validated, signal);
  const classes: ResourceStateClassSample[] = [];
  for (const stateClass of validated.stateClasses) {
    throwIfAborted(signal);
    const path = join(validated.targetRoot, stateClass.relativePath);
    const escaped = relative(validated.targetRoot, path);
    if (escaped.startsWith('..') || isAbsolute(escaped)) {
      throw new Error(`watchdog state class escapes root: ${stateClass.id}`);
    }
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (isMissingError(error) && !stateClass.required) {
        classes.push({ id: stateClass.id, path, exists: false, allocatedBytes: 0 });
        continue;
      }
      throw error;
    }
    if (stateClass.kind === 'file' && !stats.isFile()) {
      throw new Error(`watchdog state class is not a file: ${stateClass.id}`);
    }
    if (stateClass.kind === 'directory' && !stats.isDirectory()) {
      throw new Error(`watchdog state class is not a directory: ${stateClass.id}`);
    }
    classes.push({
      id: stateClass.id,
      path,
      exists: true,
      allocatedBytes: await allocatedTreeBytesAsync(path, signal),
    });
  }
  throwIfAborted(signal);
  return {
    sampledAtMs: now(),
    targetDevice: host.targetDevice,
    targetInode: host.targetInode,
    availableBytes: host.availableBytes,
    allocatedBytes: classes.reduce((sum, stateClass) => sum + stateClass.allocatedBytes, 0),
    classes,
  };
}

async function allocatedTreeBytesAsync(path: string, signal: AbortSignal): Promise<number> {
  const seen = new Set<string>();
  const pending = [path];
  let bytes = 0;
  while (pending.length > 0) {
    throwIfAborted(signal);
    const entryPath = pending.pop();
    if (entryPath === undefined) break;
    const stats = await lstat(entryPath);
    const identity = `${stats.dev}:${stats.ino}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    bytes += stats.blocks * 512;
    // Never follow symlinks. Their inode blocks count, their target does not.
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      for (const entry of await readdir(entryPath)) pending.push(join(entryPath, entry));
    }
  }
  return bytes;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('resource sample aborted');
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      onTimeout();
      rejectPromise(new ResourceSampleTimeoutError(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
