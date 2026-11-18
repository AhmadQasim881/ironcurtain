/**
 * Runtime-storage samplers for the observed-disk watchdog (policy version 2).
 *
 * A nested daemon's data never touches the host state root. It grows inside
 * the container runtime, so these samplers read exactly that storage for the
 * detached supervisor:
 *
 * - Apple: one `lstat` per ledgered VM of the runtime-owned rootfs image that
 *   was bound to the container ID at create. Allocated blocks above the
 *   baseline recorded at activation are charged to the bundle.
 * - Docker Desktop: every sample reads the Desktop VM disk with `statfs`
 *   (`stat -f` run as uid 0 in the nested-daemon sidecar's own mount
 *   namespace, which the bundle's rootless processes can neither ptrace nor
 *   remount) for the shared runtime reserve. On a slower cadence, or as soon as
 *   the VM disk has grown by the overshoot bound since the last sizing, the
 *   outer Engine sizes the daemon volume. No `du` walk runs inside the 5 s
 *   sample, and nothing needs a quota or SYS_ADMIN.
 *
 * Both Docker readings run in the background with their own timeouts. A
 * sample uses the latest result and fails closed once a reading has not
 * completed for its staleness bound of observer time, so one slow
 * `docker exec` does not revoke a healthy bundle, and a supervisor that was
 * itself paused grants the readings a fresh window instead of blaming them.
 *
 * Bounds and limits: the volume size is the Engine's apparent size (rounded
 * by the CLI to four significant digits), an accounting bound for ordinary
 * pulls and builds. A bundle that games apparent size (many tiny files,
 * `fallocate --keep-size`, renames racing the walk) still meets the runtime
 * reserve, which reads free blocks of the whole VM disk.
 */

import { lstat } from 'node:fs/promises';
import type { ContainerRuntime } from '../docker/types.js';
import { lateObservationGapMs, PeerProgressTracker } from '../docker/peer-liveness.js';
import {
  sampleWatchdogHostTarget,
  type ResourceStateClassSample,
  type ResourceWatchdogSample,
  type RuntimeStorageClass,
  type RuntimeStorageWatchdogPolicy,
} from '../docker/resource-watchdog.js';
import type { DockerWorkloadLease, DockerWorkloadOuterResource } from './bundle-lease.js';

/**
 * The sidecar's mount point of the daemon volume: the parent of
 * `DOCKER_DESKTOP_SIDECAR_DATA_ROOT` (a test pins the two together; importing
 * the sidecar module here would close an import cycle). Its parents come from
 * the read-only image rootfs, so the bundle cannot replace or remount the path.
 */
export const DOCKER_DESKTOP_RUNTIME_DISK_PATH = '/home/codespace/.local/share';

/**
 * `statfs` of the Desktop VM disk through the daemon image's busybox: block
 * size, total blocks, free blocks, and blocks available to unprivileged users.
 * Run as uid 0, which the rootless daemon user cannot ptrace or signal.
 */
export const DOCKER_DESKTOP_RUNTIME_DISK_ARGV: readonly string[] = Object.freeze([
  '/bin/busybox',
  'stat',
  '-f',
  '-c',
  '%S %b %f %a',
  DOCKER_DESKTOP_RUNTIME_DISK_PATH,
]);
const RUNTIME_DISK_EXEC_USER = '0:0';

export interface RuntimeDiskReading {
  /** Bytes an unprivileged writer can still allocate on the VM disk. */
  readonly availableBytes: number;
  /** Bytes in use on the VM disk (total minus free blocks). */
  readonly usedBytes: number;
}

/** The two Docker Desktop readings; production reads them through the outer runtime. */
export interface DockerDesktopStorageProbe {
  readRuntimeDisk(containerId: string, timeoutMs: number): Promise<RuntimeDiskReading>;
  /** Engine-reported size per volume name; `null` when the Engine could not size it. */
  measureVolumes(timeoutMs: number): Promise<ReadonlyMap<string, number | null>>;
}

export function createDockerDesktopStorageProbe(runtime: ContainerRuntime): DockerDesktopStorageProbe {
  return {
    async readRuntimeDisk(containerId, timeoutMs) {
      const result = await runtime.exec(
        containerId,
        DOCKER_DESKTOP_RUNTIME_DISK_ARGV,
        timeoutMs,
        RUNTIME_DISK_EXEC_USER,
      );
      if (result.exitCode !== 0 || result.timedOut === true) {
        throw new Error(`Docker Desktop VM disk probe exited with code ${result.exitCode}`);
      }
      return parseRuntimeDiskStat(result.stdout);
    },
    async measureVolumes(timeoutMs) {
      if (runtime.measureVolumeUsage === undefined) {
        throw new Error('the outer runtime cannot size Docker volumes');
      }
      return runtime.measureVolumeUsage(timeoutMs);
    },
  };
}

const STAT_FIELD = /^\d{1,19}$/u;

/** Parse the four `statfs` fields printed by {@link DOCKER_DESKTOP_RUNTIME_DISK_ARGV}. */
export function parseRuntimeDiskStat(stdout: string): RuntimeDiskReading {
  const fields = stdout.trim().split(/\s+/u);
  if (fields.length !== 4 || !fields.every((field) => STAT_FIELD.test(field))) {
    throw new Error('Docker Desktop VM disk probe returned an unexpected statfs line');
  }
  const [blockSize, blocks, free, available] = fields.map(Number);
  const availableBytes = available * blockSize;
  const usedBytes = (blocks - free) * blockSize;
  if (
    blockSize <= 0 ||
    free > blocks ||
    available > blocks ||
    !Number.isSafeInteger(availableBytes) ||
    !Number.isSafeInteger(usedBytes)
  ) {
    throw new Error('Docker Desktop VM disk probe returned inconsistent statfs counts');
  }
  return { availableBytes, usedBytes };
}

export interface ObservedStorageSamplerOptions {
  readonly policy: RuntimeStorageWatchdogPolicy;
  /** The supervisor's latest lease snapshot, read under its lifecycle claim. */
  readonly readLease: () => DockerWorkloadLease;
  readonly runtime: ContainerRuntime;
  /** Wall clock for `sampledAtMs` evidence. */
  readonly now: () => number;
  /** Observer-monotonic clock for every staleness and cadence decision. */
  readonly monotonicNow: () => number;
  /** Test seam; production reads through {@link createDockerDesktopStorageProbe}. */
  readonly dockerDesktopProbe?: DockerDesktopStorageProbe;
}

export type ObservedStorageSampler = (signal: AbortSignal) => Promise<ResourceWatchdogSample>;

/** Build the sampler that matches the policy's runtime. */
export function createObservedStorageSampler(options: ObservedStorageSamplerOptions): ObservedStorageSampler {
  return options.policy.runtimeKind === 'apple-container'
    ? createAppleRootfsSampler(options)
    : createDockerDesktopSampler(
        options,
        options.dockerDesktopProbe ?? createDockerDesktopStorageProbe(options.runtime),
      );
}

/** Containers that still hold storage: observed and not yet proven removed. */
function liveContainers(lease: DockerWorkloadLease): readonly DockerWorkloadOuterResource[] {
  return lease.resources.filter(
    (resource) => resource.kind === 'container' && resource.observedId !== null && resource.removal === null,
  );
}

function createAppleRootfsSampler(options: ObservedStorageSamplerOptions): ObservedStorageSampler {
  const { policy } = options;
  return async (signal) => {
    const host = await sampleWatchdogHostTarget(policy, signal);
    let chargedBytes = 0;
    const paths: string[] = [];
    for (const resource of liveContainers(options.readLease())) {
      throwIfAborted(signal);
      const storage = resource.storage;
      if (storage === undefined) {
        throw new Error(`Apple container ${resource.requestedName} has no bound rootfs image to measure`);
      }
      paths.push(storage.path);
      let stats;
      try {
        stats = await lstat(storage.path);
      } catch (error) {
        // The runtime already deleted this VM: it holds no storage. Exact
        // revocation still proves its absence before the lease closes.
        if (isMissingError(error)) continue;
        throw error;
      }
      if (!stats.isFile() || stats.dev !== storage.device || stats.ino !== storage.inode) {
        throw new Error(`Apple container rootfs image identity changed: ${storage.path}`);
      }
      // Until activation records the baseline, the VM runs only the trusted
      // bootstrap; the host reserve still bounds it.
      if (storage.baselineAllocatedBytes !== null) {
        chargedBytes += Math.max(0, stats.blocks * 512 - storage.baselineAllocatedBytes);
      }
    }
    throwIfAborted(signal);
    const classes = policy.stateClasses.map((stateClass) =>
      classSample(stateClass, paths.join(',') || stateClass.kind, paths.length > 0, chargedBytes),
    );
    return {
      sampledAtMs: options.now(),
      targetDevice: host.targetDevice,
      targetInode: host.targetInode,
      availableBytes: host.availableBytes,
      allocatedBytes: classes.reduce((sum, stateClass) => sum + stateClass.allocatedBytes, 0),
      classes,
    };
  };
}

function createDockerDesktopSampler(
  options: ObservedStorageSamplerOptions,
  probe: DockerDesktopStorageProbe,
): ObservedStorageSampler {
  const { policy } = options;
  const volumeClasses = policy.stateClasses.filter(
    (stateClass): stateClass is Extract<RuntimeStorageClass, { kind: 'docker-volume' }> =>
      stateClass.kind === 'docker-volume',
  );
  if (volumeClasses.length !== 1 || policy.runtimeReserveBytes === undefined) {
    throw new Error('a Docker Desktop storage policy measures exactly one daemon volume and the VM disk');
  }
  const volumeClass = volumeClasses[0];
  const lateAfterMs = lateObservationGapMs(policy.staleAfterMs, policy.sampleIntervalMs, policy.sampleTimeoutMs);
  const runtimeDisk = new BackgroundReading<RuntimeDiskReading>({
    label: 'Docker Desktop VM disk reading',
    staleAfterMs: policy.staleAfterMs,
    lateAfterMs,
    monotonicNow: options.monotonicNow,
    wallNow: options.now,
  });
  const volumes = new BackgroundReading<ReadonlyMap<string, number | null>>({
    label: 'Docker Desktop daemon volume size',
    staleAfterMs: volumeClass.staleAfterMs,
    lateAfterMs,
    monotonicNow: options.monotonicNow,
    wallNow: options.now,
  });
  let usedBytesAtVolumeStart: number | undefined;

  return async (signal) => {
    const host = await sampleWatchdogHostTarget(policy, signal);
    const lease = options.readLease();
    const daemons = liveContainers(lease).filter((resource) => resource.role === 'nested-daemon');
    if (daemons.length > 1) throw new Error('Docker Desktop lease has more than one nested-daemon container');
    const daemonId = daemons.at(0)?.observedId ?? undefined;

    let runtimeAvailableBytes: number | undefined;
    let runtimeUsedBytes: number | undefined;
    if (daemonId === undefined) {
      runtimeDisk.idle();
    } else {
      runtimeDisk.start(() => probe.readRuntimeDisk(daemonId, policy.sampleTimeoutMs));
      const reading = runtimeDisk.fresh();
      runtimeAvailableBytes = reading?.availableBytes;
      runtimeUsedBytes = reading?.usedBytes;
    }

    const volumeResources = lease.resources.filter(
      (resource) =>
        resource.kind === 'volume' &&
        resource.role === volumeClass.role &&
        resource.observedId !== null &&
        resource.removal === null,
    );
    let volumeBytes = 0;
    if (volumeResources.length === 0) {
      volumes.idle();
    } else {
      // A sizing that began before the first VM disk reading takes that first
      // reading as its growth baseline.
      usedBytesAtVolumeStart ??= runtimeUsedBytes;
      const grown =
        runtimeUsedBytes !== undefined &&
        usedBytesAtVolumeStart !== undefined &&
        runtimeUsedBytes - usedBytesAtVolumeStart >= policy.maximumOvershootBytes;
      const started = volumes.startIfDue(
        () => probe.measureVolumes(volumeClass.sampleTimeoutMs),
        volumeClass.sampleIntervalMs,
        grown,
      );
      if (started) usedBytesAtVolumeStart = runtimeUsedBytes;
      const sizes = volumes.fresh();
      for (const resource of volumeResources) {
        const name = resource.observedId ?? resource.requestedName;
        const size = sizes?.get(name);
        if (size === null) throw new Error(`the Docker Engine could not size daemon volume ${name}`);
        // Absent from a completed report: the volume no longer exists.
        volumeBytes += size ?? 0;
      }
    }
    throwIfAborted(signal);
    const classes = policy.stateClasses.map((stateClass) =>
      classSample(
        stateClass,
        volumeResources.map((resource) => resource.observedId ?? resource.requestedName).join(',') || stateClass.kind,
        volumeResources.length > 0,
        stateClass.kind === 'docker-volume' ? volumeBytes : 0,
      ),
    );
    return {
      sampledAtMs: options.now(),
      targetDevice: host.targetDevice,
      targetInode: host.targetInode,
      availableBytes: host.availableBytes,
      ...(runtimeAvailableBytes === undefined ? {} : { runtimeAvailableBytes }),
      allocatedBytes: classes.reduce((sum, stateClass) => sum + stateClass.allocatedBytes, 0),
      classes,
    };
  };
}

function classSample(
  stateClass: RuntimeStorageClass,
  path: string,
  exists: boolean,
  allocatedBytes: number,
): ResourceStateClassSample {
  return { id: stateClass.id, path, exists, allocatedBytes };
}

interface BackgroundReadingOptions {
  readonly label: string;
  readonly staleAfterMs: number;
  readonly lateAfterMs: number;
  readonly monotonicNow: () => number;
  readonly wallNow: () => number;
}

/**
 * One single-flight background measurement with a staleness bound judged on
 * the observer's monotonic clock from when the reading was first needed.
 * Completions are the progress marker, so an observer that was itself late
 * grants a fresh window (see {@link PeerProgressTracker}).
 */
class BackgroundReading<T> {
  private readonly options: BackgroundReadingOptions;
  private tracker: PeerProgressTracker | undefined;
  private inFlight = false;
  private completions = 0;
  private value: T | undefined;
  private lastStartedAtMs: number | undefined;
  private lastError: string | undefined;

  constructor(options: BackgroundReadingOptions) {
    this.options = options;
  }

  /** The target is gone: forget the window so a later target starts afresh. */
  idle(): void {
    this.tracker = undefined;
    this.value = undefined;
    this.lastStartedAtMs = undefined;
  }

  start(read: () => Promise<T>): boolean {
    return this.startIfDue(read, 0, true);
  }

  /** Start a reading unless one is in flight and none is due yet. Returns whether one started. */
  startIfDue(read: () => Promise<T>, intervalMs: number, force: boolean): boolean {
    if (this.inFlight) return false;
    const nowMs = this.options.monotonicNow();
    if (!force && this.lastStartedAtMs !== undefined && nowMs - this.lastStartedAtMs < intervalMs) return false;
    this.inFlight = true;
    this.lastStartedAtMs = nowMs;
    void read().then(
      (value) => {
        this.value = value;
        this.completions += 1;
        this.lastError = undefined;
        this.inFlight = false;
      },
      (error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.inFlight = false;
      },
    );
    return true;
  }

  /** The latest reading (undefined while the first is pending); throws once it is stale. */
  fresh(): T | undefined {
    this.tracker ??= new PeerProgressTracker({
      staleAfterMs: this.options.staleAfterMs,
      lateAfterMs: this.options.lateAfterMs,
      monotonicNow: this.options.monotonicNow,
      wallNow: this.options.wallNow,
    });
    const observation = this.tracker.observe(String(this.completions));
    if (observation.stale) {
      const cause = this.lastError === undefined ? '' : `: ${this.lastError}`;
      throw new Error(`${this.options.label} has not completed for ${observation.silentForMs}ms${cause}`);
    }
    return this.value;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('resource sample aborted');
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
