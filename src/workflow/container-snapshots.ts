import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import pLimit from 'p-limit';
import type { ContainerRuntime, DockerImageInfo } from '../docker/types.js';
import { createDockerManager } from '../docker/docker-manager.js';
import { commandExists } from '../trusted-process/container-command.js';
import { IMAGE_BUILD_HASH_LABEL, IMAGE_BUILD_HASH_PATTERN, isImmutableImageId } from '../docker/image-identity.js';
import { sha256Hex } from '../hash.js';
import * as logger from '../logger.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { VERSION } from '../version.js';
import type { CheckpointStore, LoadedCheckpointRecord } from './checkpoint.js';
import { isCheckpointResumable } from './checkpoint.js';
import { isSafeWorkflowId, type ContainerSnapshotRef, type WorkflowCheckpoint, type WorkflowId } from './types.js';
import { isOwnWorkflowRunsDirectory } from './staged-directories.js';
import type { ResolvedUserConfig } from '../config/user-config.js';

export const IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW = 'ironcurtain.snapshot.workflow';
export const IRONCURTAIN_SNAPSHOT_LABEL_SCOPE = 'ironcurtain.snapshot.scope';
export const IRONCURTAIN_SNAPSHOT_LABEL_STOP = 'ironcurtain.snapshot.stop';
/**
 * Which base directory of runs an image belongs to ({@link snapshotOwnerKey}).
 * Docker's image namespace is shared by every IronCurtain home, base
 * directory and user on the engine; garbage collection only ever judges
 * images carrying its own base directory's key.
 */
export const IRONCURTAIN_SNAPSHOT_LABEL_OWNER = 'ironcurtain.snapshot.owner';
/**
 * The agent image build the snapshot's container ran (its
 * `ironcurtain.build-hash`). The flattened snapshot carries that build's
 * entrypoint scripts and agent CLI, so resume uses it only under the same
 * build (`selectResumableSnapshot` in docker-infrastructure.ts).
 */
export const IRONCURTAIN_SNAPSHOT_LABEL_BUILD_HASH = IMAGE_BUILD_HASH_LABEL;
/** The IronCurtain version that committed the snapshot (informational). */
export const IRONCURTAIN_SNAPSHOT_LABEL_VERSION = 'ironcurtain.version';

/** A version string safe to stamp in a `LABEL` change directive and to print. */
const SAFE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;

const SNAPSHOT_TAG_REPOSITORY = 'ironcurtain-snapshot';
const DEFAULT_SNAPSHOT_COMMIT_TIMEOUT_MS = 600_000;
/** Below this much of a caller's deadline a commit is skipped rather than started. */
const MIN_SNAPSHOT_COMMIT_WINDOW_MS = 1_000;
/** Bound on the container size probe (`container inspect --size`). */
const SIZE_PROBE_TIMEOUT_MS = 60_000;
/**
 * Free space a commit must leave on each filesystem it writes (the export tar
 * in the temporary directory, the imported image in the engine's data root),
 * so a snapshot never fills a disk that every other session shares.
 */
export const SNAPSHOT_FREE_SPACE_RESERVE_BYTES = 1024 * 1024 * 1024;

/**
 * A snapshot image is committed (and labeled) BEFORE its checkpoint is saved
 * (see the stop paths in orchestrator.ts). For that brief window the image is
 * labeled but not yet referenced by any checkpoint. The orphan sweep skips
 * images younger than this so a concurrent sweep can't delete a snapshot that
 * another workflow is mid-commit on.
 */
const ORPHAN_SWEEP_GRACE_MS = 5 * 60 * 1000;

function sanitizeTagPart(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'scope';
}

function buildSnapshotTag(workflowId: WorkflowId, scope: string, stopId: string): string {
  return `${SNAPSHOT_TAG_REPOSITORY}:${workflowId}-${sanitizeTagPart(scope)}-${stopId}`;
}

function uniqueSnapshotImages(snapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined): string[] {
  if (!snapshots) return [];
  return [...new Set(Object.values(snapshots).map((snapshot) => snapshot.image))];
}

export function hasContainerSnapshots(checkpoint: WorkflowCheckpoint | undefined): boolean {
  return uniqueSnapshotImages(checkpoint?.containerSnapshots).length > 0;
}

export function getContainerSnapshotImages(checkpoint: WorkflowCheckpoint | undefined): readonly string[] {
  return uniqueSnapshotImages(checkpoint?.containerSnapshots);
}

/**
 * The owner key stamped on snapshots committed for runs of `baseDir`: a hash
 * of its canonical path, so every spelling of one directory maps to one key
 * and nothing about the path itself is published in image labels.
 */
export function snapshotOwnerKey(baseDir: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(baseDir);
  } catch {
    canonical = resolve(baseDir);
  }
  return sha256Hex(`ironcurtain-workflow-runs:${canonical}`);
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/** Why a commit was skipped instead of attempted. */
export type ContainerSnapshotSkipReason = 'deadline' | 'too_large' | 'insufficient_space';

/**
 * A snapshot was deliberately not taken: the caller's deadline ran out while
 * other commits went first, the container exceeds `snapshot.maxBytes`, or a
 * filesystem lacks room for it. The run still stops resumably; resume starts
 * the scope from a fresh container. `code` is the discriminant for callers in
 * other modules.
 */
export class ContainerSnapshotSkippedError extends Error {
  readonly code = 'CONTAINER_SNAPSHOT_SKIPPED' as const;

  constructor(
    readonly reason: ContainerSnapshotSkipReason,
    message: string,
  ) {
    super(message);
    this.name = 'ContainerSnapshotSkippedError';
  }
}

export function isContainerSnapshotSkippedError(err: unknown): err is ContainerSnapshotSkippedError {
  return err instanceof Error && 'code' in err && err.code === 'CONTAINER_SNAPSHOT_SKIPPED';
}

/** Free space and filesystem identity, injectable for tests. */
export interface SnapshotDiskProbe {
  /** Bytes available to this user at `path`, or undefined when unknown. */
  freeBytes(path: string): number | undefined;
  /** Device number of the filesystem holding `path`, or undefined when unknown. */
  deviceOf(path: string): number | undefined;
}

const systemDiskProbe: SnapshotDiskProbe = {
  freeBytes(path) {
    try {
      const stats = statfsSync(path);
      return stats.bavail * stats.bsize;
    } catch {
      return undefined;
    }
  },
  deviceOf(path) {
    try {
      return statSync(path).dev;
    } catch {
      return undefined;
    }
  },
};

/**
 * Serializes snapshot commits across every workflow in this process. A
 * flattened commit writes the container's whole filesystem as a tar under
 * the temporary directory and then imports it into the engine, and a daemon
 * shutdown or a burst of aborts would otherwise run one such multi-GB commit
 * per workflow at once.
 */
const commitQueue = pLimit(1);

export interface CommitContainerSnapshotInput {
  readonly docker: ContainerRuntime;
  readonly workflowId: WorkflowId;
  readonly scope: string;
  readonly containerId: string;
  /** Base directory of the run; its {@link snapshotOwnerKey} labels the image for GC. */
  readonly baseDir: string;
  /**
   * Build hash of the agent image the container was created from (the
   * bundle's `imageResolution.buildHash`), stamped on the image and recorded
   * in the returned ref so resume can refuse a snapshot of another build.
   */
  readonly agentBuildHash: string;
  /**
   * Whether the container's agent had passwordless sudo (the bundle's
   * `agentSudo` plan), recorded in the returned ref so a resume under
   * `agentSudo: false` can refuse a snapshot an agent with root may have
   * changed. Absent when the bundle does not report it; resume then counts
   * the snapshot as taken with sudo.
   */
  readonly agentSudo?: boolean;
  /** Largest container (bytes) to snapshot; null or absent means no cap. */
  readonly maxBytes?: number | null;
  /**
   * A deadline for the whole operation, waiting for earlier commits included,
   * for a caller that must be done by then (a shutdown's snapshot budget).
   * Absent: each commit gets the default 10-minute bound once it starts.
   */
  readonly timeoutMs?: number;
  /** Test seam; the real filesystem by default. */
  readonly disk?: SnapshotDiskProbe;
}

function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

/**
 * Refuses a commit that would exceed the size cap or leave a filesystem with
 * less than {@link SNAPSHOT_FREE_SPACE_RESERVE_BYTES} free. The flattened
 * snapshot is about the container's whole filesystem: it is written once to
 * the temporary directory (the export tar) and once to the engine's data root
 * (the import), twice on one filesystem when both share it. A size or a
 * filesystem that cannot be measured is not held against the commit.
 */
async function assertSnapshotCapacity(input: CommitContainerSnapshotInput, probeTimeoutMs: number): Promise<void> {
  const disk = input.disk ?? systemDiskProbe;
  const size = await input.docker.containerSize?.(input.containerId, probeTimeoutMs);
  const maxBytes = input.maxBytes ?? null;
  if (size !== undefined && maxBytes !== null && size > maxBytes) {
    throw new ContainerSnapshotSkippedError(
      'too_large',
      `the container's filesystem is ${formatBytes(size)}, above snapshot.maxBytes (${formatBytes(maxBytes)})`,
    );
  }
  const needed = size ?? 0;
  const tempDir = tmpdir();
  const dataRoot = await input.docker.localDataRoot?.(probeTimeoutMs);
  const tempDevice = disk.deviceOf(tempDir);
  const shared = dataRoot !== undefined && tempDevice !== undefined && tempDevice === disk.deviceOf(dataRoot);
  const checks: ReadonlyArray<readonly [string, number]> = shared
    ? [[tempDir, 2 * needed]]
    : [[tempDir, needed], ...(dataRoot !== undefined ? [[dataRoot, needed] as const] : [])];
  for (const [path, bytes] of checks) {
    const free = disk.freeBytes(path);
    if (free === undefined || free >= bytes + SNAPSHOT_FREE_SPACE_RESERVE_BYTES) continue;
    throw new ContainerSnapshotSkippedError(
      'insufficient_space',
      `${path} has ${formatBytes(free)} free, but the snapshot needs about ${formatBytes(bytes)} there ` +
        `plus a ${formatBytes(SNAPSHOT_FREE_SPACE_RESERVE_BYTES)} reserve`,
    );
  }
}

/**
 * Commits one scope's container as a flattened, labeled snapshot image and
 * returns its immutable id with the agent image build, the agent's privilege
 * mode and the IronCurtain version it was taken under. Commits run one at a
 * time per process, after a size and free-space pre-check; a commit that
 * cannot be done safely throws {@link ContainerSnapshotSkippedError} without
 * touching the engine.
 */
export async function commitContainerSnapshot(input: CommitContainerSnapshotInput): Promise<ContainerSnapshotRef> {
  // Stamped into a `LABEL` change directive: refuse anything but a hash.
  if (!IMAGE_BUILD_HASH_PATTERN.test(input.agentBuildHash)) {
    throw new Error('the agent image build hash of the container is not a valid build hash');
  }
  const ironcurtainVersion = SAFE_VERSION_PATTERN.test(VERSION) ? VERSION : undefined;
  const deadline = input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs;
  const timeLeft = (): number => (deadline === undefined ? DEFAULT_SNAPSHOT_COMMIT_TIMEOUT_MS : deadline - Date.now());
  const assertTimeLeft = (): void => {
    if (deadline !== undefined && timeLeft() < MIN_SNAPSHOT_COMMIT_WINDOW_MS) {
      throw new ContainerSnapshotSkippedError(
        'deadline',
        'the time allowed for it ran out while other snapshot commits went first',
      );
    }
  };
  return commitQueue(async () => {
    assertTimeLeft();
    await assertSnapshotCapacity(input, Math.max(1, Math.min(SIZE_PROBE_TIMEOUT_MS, Math.floor(timeLeft() / 4))));
    assertTimeLeft();
    const stopId = randomUUID();
    const tag = buildSnapshotTag(input.workflowId, input.scope, stopId);
    const image = await input.docker.commit(input.containerId, {
      tag,
      pause: false,
      flatten: true,
      timeoutMs: timeLeft(),
      // No need to clear inherited ironcurtain.bundle/scope labels: the flatten
      // (export/import) path produces an image with no labels at all, so we only
      // stamp the dedicated snapshot labels used by GC, and the build identity
      // resume checks.
      changes: [
        `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW}=${input.workflowId}`,
        `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_SCOPE}=${input.scope}`,
        `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_STOP}=${stopId}`,
        `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_OWNER}=${snapshotOwnerKey(input.baseDir)}`,
        `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_BUILD_HASH}=${input.agentBuildHash}`,
        ...(ironcurtainVersion === undefined
          ? []
          : [`LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_VERSION}=${ironcurtainVersion}`]),
      ],
    });
    return {
      image,
      tag,
      agentBuildHash: input.agentBuildHash,
      ...(input.agentSudo === undefined ? {} : { agentSudo: input.agentSudo }),
      ...(ironcurtainVersion === undefined ? {} : { ironcurtainVersion }),
    };
  });
}

/** The run whose checkpoint names the snapshot images being removed. */
export interface SnapshotImageOwner {
  readonly workflowId: WorkflowId;
  /** Base directory of the run; images carrying another {@link snapshotOwnerKey} are not its own. */
  readonly baseDir: string;
}

/**
 * Removes the snapshot images a checkpoint of `owner.workflowId` references
 * (superseded at a stop, or all of them once the run completed), but only
 * those that are this run's own IronCurtain snapshots. A checkpoint's
 * references are just strings: one copied in from elsewhere, restored from a
 * backup or left by an agent can name any image on the engine, and removal is
 * `docker image rm --force`. So each reference must be an immutable image ID
 * (what a commit records) whose image is labeled with the run's workflow id
 * and, when it carries an owner label (images from before owner labels do
 * not), the owner key of the run's base directory. Anything else is kept and
 * logged; an image that is already gone is skipped. Failures are per image
 * and never reject.
 */
export async function removeContainerSnapshotImages(
  docker: ContainerRuntime,
  snapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
  owner: SnapshotImageOwner,
): Promise<void> {
  const ownerKey = snapshotOwnerKey(owner.baseDir);
  const removeIfOwn = async (ref: string): Promise<void> => {
    const keep = (why: string): void => {
      logger.warn(
        `[workflow] Not removing image ${toDisplayText(ref, { maxLength: 100 })} that the checkpoint of ` +
          `${owner.workflowId} references: ${why}`,
      );
    };
    if (!isImmutableImageId(ref)) {
      keep('it is not named by an immutable image ID');
      return;
    }
    const image = await docker.inspectImage(ref);
    if (image === undefined) return;
    if (labelOf(image, IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW) !== owner.workflowId) {
      keep('it is not a snapshot image of this run');
      return;
    }
    const imageOwner = labelOf(image, IRONCURTAIN_SNAPSHOT_LABEL_OWNER);
    if (imageOwner === undefined && !isOwnWorkflowRunsDirectory(owner.baseDir)) {
      keep('legacy image ownership cannot be established outside this home');
      return;
    }
    if (imageOwner !== undefined && imageOwner !== ownerKey) {
      keep("it is a snapshot image of another base directory's run");
      return;
    }
    await docker.removeImage(ref);
  };
  await Promise.allSettled(uniqueSnapshotImages(snapshots).map(removeIfOwn));
}

// ---------------------------------------------------------------------------
// Garbage collection
// ---------------------------------------------------------------------------

export interface ContainerSnapshotGcResult {
  readonly removedImages: readonly string[];
  readonly agedImages: readonly string[];
  readonly orphanImages: readonly string[];
}

/** What this base directory knows about the run an image is labeled with. */
type RunSnapshotState =
  /** No run directory of that id here. */
  | { readonly kind: 'absent' }
  /** The checkpoint exists but could not be read reliably: its images are never touched. */
  | { readonly kind: 'unreadable' }
  /** The run directory exists; `checkpoint` is undefined when it has none. */
  | { readonly kind: 'present'; readonly checkpoint: WorkflowCheckpoint | undefined };

function loadRunState(input: SweepInput, workflowId: WorkflowId): RunSnapshotState {
  if (!existsSync(resolve(input.baseDir, workflowId))) return { kind: 'absent' };
  let record: LoadedCheckpointRecord | undefined;
  try {
    if (input.checkpointStore.loadRecord) {
      record = input.checkpointStore.loadRecord(workflowId);
    } else {
      const checkpoint = input.checkpointStore.load(workflowId);
      record = checkpoint === undefined ? undefined : { checkpoint, recoveredFromPrevious: false };
    }
  } catch (err) {
    logger.debug(`snapshot GC: keeping the images of ${workflowId}, its checkpoint failed to load: ${String(err)}`);
    return { kind: 'unreadable' };
  }
  // A recovered previous copy may not list the snapshot the damaged newer
  // checkpoint referenced.
  if (record?.recoveredFromPrevious === true) return { kind: 'unreadable' };
  return { kind: 'present', checkpoint: record?.checkpoint };
}

/** A label of a listed image, or undefined when the image does not carry it. */
function labelOf(image: DockerImageInfo, key: string): string | undefined {
  return Object.hasOwn(image.labels, key) ? image.labels[key] : undefined;
}

interface SweepInput {
  readonly baseDir: string;
  readonly checkpointStore: CheckpointStore;
  readonly userConfig: ResolvedUserConfig;
  readonly docker?: ContainerRuntime;
  readonly now?: Date;
}

/**
 * Reclaims snapshot images of this base directory's runs.
 *
 * Only images this base directory owns are judged: those labeled with its
 * {@link snapshotOwnerKey}, plus (only in this home's own workflow-runs)
 * unowned legacy images whose workflow label names a run directory here. An
 * image of another base directory, another IronCurtain home or another user
 * on the same engine is never touched.
 *
 * - Orphan: the image's run has no directory here (owned images only), no
 *   checkpoint, a completed checkpoint, or a checkpoint that does not
 *   reference it, and the image is past the commit grace window.
 * - Aged: referenced by a resumable checkpoint but older than
 *   `snapshot.maxAgeDays`; the checkpoint stays resumable and resume starts
 *   the scope fresh.
 * - A run whose checkpoint fails to load (or was recovered from its previous
 *   copy) keeps all its images.
 */
export async function sweepContainerSnapshots(input: SweepInput): Promise<ContainerSnapshotGcResult> {
  if (!input.userConfig.snapshot.enabled) {
    return { removedImages: [], agedImages: [], orphanImages: [] };
  }

  // Container snapshots are a Docker-only feature. On a host without the Docker
  // CLI (e.g. an Apple `container`-only machine) there are no snapshot images to
  // collect — skip cleanly rather than spawning a missing `docker` binary and
  // surfacing a caught ENOENT to every caller on each sweep.
  let docker = input.docker;
  if (!docker) {
    if (!commandExists('docker')) {
      return { removedImages: [], agedImages: [], orphanImages: [] };
    }
    docker = createDockerManager();
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const maxAgeMs =
    input.userConfig.snapshot.maxAgeDays === null ? null : input.userConfig.snapshot.maxAgeDays * 24 * 60 * 60 * 1000;
  const owner = snapshotOwnerKey(input.baseDir);
  const allowLegacyImages = isOwnWorkflowRunsDirectory(input.baseDir);

  const removedImages: string[] = [];
  const orphanImages: string[] = [];
  const agedImages: string[] = [];

  let labeledImages: readonly DockerImageInfo[];
  try {
    labeledImages = await docker.listImages({ labelFilter: IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW });
  } catch (err) {
    // Expected when Docker is unavailable (e.g. a builtin, non-Docker workflow
    // triggered the CLI sweep), so degrade quietly -- debug-only so a persistent
    // failure is still discoverable without spamming non-Docker users.
    logger.debug(`snapshot GC: listImages failed, skipping sweep: ${err instanceof Error ? err.message : String(err)}`);
    return { removedImages, agedImages, orphanImages };
  }

  const runStates = new Map<WorkflowId, RunSnapshotState>();
  for (const image of labeledImages) {
    const imageOwner = labelOf(image, IRONCURTAIN_SNAPSHOT_LABEL_OWNER);
    if (imageOwner === undefined && !allowLegacyImages) continue;
    if (imageOwner !== undefined && imageOwner !== owner) continue;
    const workflowId = labelOf(image, IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW);
    if (!isSafeWorkflowId(workflowId)) continue;
    let state = runStates.get(workflowId);
    if (state === undefined) {
      state = loadRunState(input, workflowId);
      runStates.set(workflowId, state);
    }
    if (state.kind === 'unreadable') continue;
    // An unowned image of a run that has no directory here may belong to any
    // base directory on this engine: never ours to judge.
    if (state.kind === 'absent' && imageOwner === undefined) continue;

    const checkpoint = state.kind === 'present' ? state.checkpoint : undefined;
    const referenced =
      checkpoint !== undefined &&
      isCheckpointResumable(checkpoint) &&
      uniqueSnapshotImages(checkpoint.containerSnapshots).includes(image.id);
    const createdMs = Date.parse(image.created);

    if (!referenced) {
      if (Number.isFinite(createdMs) && nowMs - createdMs < ORPHAN_SWEEP_GRACE_MS) continue;
      if (await docker.removeImage(image.id)) {
        removedImages.push(image.id);
        orphanImages.push(image.id);
      }
      continue;
    }

    if (maxAgeMs === null) continue;
    const checkpointMs = Date.parse(checkpoint.timestamp);
    const validTimes = [createdMs, checkpointMs].filter((value) => Number.isFinite(value));
    if (validTimes.length === 0) continue;
    const bornAtMs = Math.min(...validTimes);
    if (nowMs - bornAtMs <= maxAgeMs) continue;
    if (await docker.removeImage(image.id)) {
      removedImages.push(image.id);
      agedImages.push(image.id);
    }
  }

  return { removedImages, agedImages, orphanImages };
}
