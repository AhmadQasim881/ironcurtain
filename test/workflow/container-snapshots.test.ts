import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitContainerSnapshot,
  IRONCURTAIN_SNAPSHOT_LABEL_BUILD_HASH,
  IRONCURTAIN_SNAPSHOT_LABEL_OWNER,
  IRONCURTAIN_SNAPSHOT_LABEL_VERSION,
  IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW,
  isContainerSnapshotSkippedError,
  removeContainerSnapshotImages,
  snapshotOwnerKey,
  SNAPSHOT_FREE_SPACE_RESERVE_BYTES,
  sweepContainerSnapshots,
  type SnapshotDiskProbe,
} from '../../src/workflow/container-snapshots.js';
import { commandExists } from '../../src/trusted-process/container-command.js';
import { createDockerManager } from '../../src/docker/docker-manager.js';
import { FileCheckpointStore, type CheckpointStore } from '../../src/workflow/checkpoint.js';
import type { ContainerSnapshotRef, WorkflowCheckpoint, WorkflowId } from '../../src/workflow/types.js';
import type { DockerImageInfo, ContainerRuntime } from '../../src/docker/types.js';
import type { ResolvedUserConfig } from '../../src/config/user-config.js';
import { VERSION } from '../../src/version.js';

// The default (no-`docker`-arg) sweep path resolves the Docker CLI lazily; mock
// the probe + factory so we can assert it short-circuits on a Docker-less host.
vi.mock('../../src/trusted-process/container-command.js', () => ({ commandExists: vi.fn(() => true) }));
vi.mock('../../src/docker/docker-manager.js', () => ({ createDockerManager: vi.fn() }));

const NOW = new Date('2026-06-18T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();
const digest = (c: string) => `sha256:${c.repeat(64)}`;

function resumableCheckpoint(image: string): WorkflowCheckpoint {
  const snapshots: Record<string, ContainerSnapshotRef> = { primary: { image } };
  return {
    finalStatus: { phase: 'aborted', reason: 'test' },
    timestamp: NOW.toISOString(),
    containerSnapshots: snapshots,
  } as unknown as WorkflowCheckpoint;
}

function makeCheckpointStore(entries: Record<string, WorkflowCheckpoint>): CheckpointStore {
  return {
    listAll: () => Object.keys(entries) as WorkflowId[],
    load: (id: WorkflowId) => entries[id],
  } as unknown as CheckpointStore;
}

interface FakeImage {
  readonly created: string;
  readonly labels: Record<string, string>;
}

/** ContainerRuntime stub exposing only the image methods the sweep uses. */
function makeDocker(images: Record<string, FakeImage>) {
  const removeImage = vi.fn(async (ref: string) => {
    delete images[ref];
    return true;
  });
  const listImages = vi.fn(async (): Promise<readonly DockerImageInfo[]> => {
    return Object.entries(images).map(([id, image]) => ({ id, repoTags: [], ...image }));
  });
  const docker = {
    listImages,
    async inspectImage(ref: string): Promise<DockerImageInfo | undefined> {
      const image = images[ref] as FakeImage | undefined;
      return image ? { id: ref, repoTags: [], ...image } : undefined;
    },
    removeImage,
  } as unknown as ContainerRuntime;
  return { docker, removeImage, listImages };
}

function userConfig(snapshot: { enabled: boolean; maxAgeDays: number | null }): ResolvedUserConfig {
  return { snapshot: { ...snapshot, sweepIntervalHours: 24, maxBytes: null } } as unknown as ResolvedUserConfig;
}

describe('sweepContainerSnapshots', () => {
  let root: string;
  let baseDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'snapshot-gc-'));
    baseDir = join(root, 'home-a', 'workflow-runs');
    mkdirSync(baseDir, { recursive: true });
    vi.stubEnv('IRONCURTAIN_HOME', join(root, 'home-a'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  /** Labels of an image committed for `workflowId` by runs of `ownerBaseDir` (none: a pre-owner image). */
  function labels(workflowId: string, ownerBaseDir?: string): Record<string, string> {
    return {
      [IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW]: workflowId,
      ...(ownerBaseDir !== undefined ? { [IRONCURTAIN_SNAPSHOT_LABEL_OWNER]: snapshotOwnerKey(ownerBaseDir) } : {}),
    };
  }

  function makeRunDirs(...ids: string[]): void {
    for (const id of ids) mkdirSync(join(baseDir, id), { recursive: true });
  }

  it('skips cleanly without spawning docker when the Docker CLI is absent (apple-container host)', async () => {
    vi.mocked(commandExists).mockReturnValue(false);
    const checkpointStore = makeCheckpointStore({ wf: resumableCheckpoint(digest('a')) });

    // No `docker` arg → the default path; commandExists('docker') === false must
    // short-circuit before createDockerManager() (which would spawn a missing CLI).
    const result = await sweepContainerSnapshots({
      baseDir,
      checkpointStore,
      userConfig: userConfig({ enabled: true, maxAgeDays: 7 }),
      now: NOW,
    });

    expect(result).toEqual({ removedImages: [], agedImages: [], orphanImages: [] });
    expect(commandExists).toHaveBeenCalledWith('docker');
    expect(createDockerManager).not.toHaveBeenCalled();
    vi.mocked(commandExists).mockReturnValue(true);
  });

  it('removes an aged referenced image but keeps a fresh one (image-only, checkpoint untouched)', async () => {
    const aged = digest('a');
    const fresh = digest('f');
    makeRunDirs('wfAged', 'wfFresh');
    const { docker, removeImage } = makeDocker({
      [aged]: { created: daysAgo(30), labels: labels('wfAged', baseDir) },
      [fresh]: { created: daysAgo(1), labels: labels('wfFresh', baseDir) },
    });
    const checkpointStore = makeCheckpointStore({
      wfAged: resumableCheckpoint(aged),
      wfFresh: resumableCheckpoint(fresh),
    });

    const result = await sweepContainerSnapshots({
      baseDir,
      checkpointStore,
      userConfig: userConfig({ enabled: true, maxAgeDays: 7 }),
      docker,
      now: NOW,
    });

    expect(result.agedImages).toEqual([aged]);
    expect(result.orphanImages).toEqual([]);
    expect(removeImage).toHaveBeenCalledWith(aged);
    expect(removeImage).not.toHaveBeenCalledWith(fresh);
    // The sweep never mutates checkpoints: the (still-resumable) checkpoint for
    // the aged image is left in place for a graceful, image-less resume.
    expect(checkpointStore.load('wfAged' as WorkflowId)).toBeDefined();
  });

  it('removes an unreferenced owned orphan but spares one inside the commit grace window', async () => {
    const orphanOld = digest('1');
    const orphanYoung = digest('2');
    makeRunDirs('wf');
    // orphanYoung was committed a minute ago and is not yet referenced by any
    // saved checkpoint -- the grace window must protect it from a racing sweep.
    const { docker, removeImage } = makeDocker({
      [orphanOld]: { created: minutesAgo(60), labels: labels('wf', baseDir) },
      [orphanYoung]: { created: minutesAgo(1), labels: labels('wf', baseDir) },
    });

    const result = await sweepContainerSnapshots({
      baseDir,
      checkpointStore: makeCheckpointStore({}), // the run has no checkpoint referencing either image
      userConfig: userConfig({ enabled: true, maxAgeDays: null }), // isolate orphan logic
      docker,
      now: NOW,
    });

    expect(result.orphanImages).toEqual([orphanOld]);
    expect(removeImage).toHaveBeenCalledWith(orphanOld);
    expect(removeImage).not.toHaveBeenCalledWith(orphanYoung);
  });

  it("removes an owned image whose run directory is gone, and a completed run's image", async () => {
    const deletedRun = digest('3');
    const completedRun = digest('4');
    makeRunDirs('wf-completed');
    const completed = {
      ...resumableCheckpoint(completedRun),
      finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
    } as unknown as WorkflowCheckpoint;
    const { docker } = makeDocker({
      [deletedRun]: { created: minutesAgo(60), labels: labels('wf-deleted', baseDir) },
      [completedRun]: { created: minutesAgo(60), labels: labels('wf-completed', baseDir) },
    });

    const result = await sweepContainerSnapshots({
      baseDir,
      checkpointStore: makeCheckpointStore({ 'wf-completed': completed }),
      userConfig: userConfig({ enabled: true, maxAgeDays: null }),
      docker,
      now: NOW,
    });

    expect([...result.orphanImages].sort()).toEqual([deletedRun, completedRun].sort());
  });

  it('leaves the snapshots of another base directory alone when sweeping this one', async () => {
    // Base A holds a resumable run with a snapshot. A sweep of base B (another
    // IRONCURTAIN_HOME, or `resume-standalone /some/other/runs`) must not
    // treat A's image as an orphan, however old it is.
    const homeA = baseDir;
    const homeB = join(root, 'home-b', 'workflow-runs');
    mkdirSync(homeB, { recursive: true });
    const storeA = new FileCheckpointStore(homeA);
    const id = 'wf-in-a' as WorkflowId;
    const imageA = digest('a');
    storeA.save(id, {
      ...resumableCheckpoint(imageA),
      machineState: 'review',
      context: { taskDescription: 't', artifacts: {} },
      transitionHistory: [],
      definitionPath: '/tmp/def.json',
    } as unknown as WorkflowCheckpoint);
    const legacyOfA = digest('b'); // committed before owner labels existed
    const { docker, removeImage } = makeDocker({
      [imageA]: { created: daysAgo(30), labels: labels(id, homeA) },
      [legacyOfA]: { created: daysAgo(30), labels: labels('wf-other-in-a') },
    });

    const fromB = await sweepContainerSnapshots({
      baseDir: homeB,
      checkpointStore: new FileCheckpointStore(homeB),
      userConfig: userConfig({ enabled: true, maxAgeDays: 7 }),
      docker,
      now: NOW,
    });
    expect(fromB.removedImages).toEqual([]);
    expect(removeImage).not.toHaveBeenCalled();

    // A sweep of A itself still ages its own image out.
    const fromA = await sweepContainerSnapshots({
      baseDir: homeA,
      checkpointStore: storeA,
      userConfig: userConfig({ enabled: true, maxAgeDays: 7 }),
      docker,
      now: NOW,
    });
    expect(fromA.agedImages).toEqual([imageA]);
    expect(removeImage).not.toHaveBeenCalledWith(legacyOfA);
  });

  it('never removes the images of a run whose checkpoint fails to load', async () => {
    const image = digest('c');
    makeRunDirs('wf-corrupt');
    const { docker, removeImage } = makeDocker({
      [image]: { created: daysAgo(30), labels: labels('wf-corrupt', baseDir) },
    });
    const throwing = {
      listAll: () => ['wf-corrupt'],
      load: () => {
        throw new Error('checkpoint.json is not valid JSON');
      },
    } as unknown as CheckpointStore;

    const result = await sweepContainerSnapshots({
      baseDir,
      checkpointStore: throwing,
      userConfig: userConfig({ enabled: true, maxAgeDays: 7 }),
      docker,
      now: NOW,
    });
    expect(result.removedImages).toEqual([]);
    expect(removeImage).not.toHaveBeenCalled();
  });

  it('never removes the images of a run recovered from its previous checkpoint', async () => {
    // checkpoint.json was damaged; the previous copy predates the newest
    // snapshot, so that snapshot looks unreferenced but must survive.
    const id = 'wf-recovered' as WorkflowId;
    const store = new FileCheckpointStore(baseDir, { warn: () => {} });
    const base = {
      machineState: 'review',
      context: { taskDescription: 't', artifacts: {} },
      transitionHistory: [],
      definitionPath: '/tmp/def.json',
      timestamp: NOW.toISOString(),
    };
    store.save(id, base as unknown as WorkflowCheckpoint);
    store.save(id, {
      ...base,
      containerSnapshots: { primary: { image: digest('d') } },
    } as unknown as WorkflowCheckpoint);
    writeFileSync(join(baseDir, id, 'checkpoint.json'), '{"damaged":');

    const { docker, removeImage } = makeDocker({
      [digest('d')]: { created: minutesAgo(60), labels: labels(id, baseDir) },
    });
    const result = await sweepContainerSnapshots({
      baseDir,
      checkpointStore: store,
      userConfig: userConfig({ enabled: true, maxAgeDays: null }),
      docker,
      now: NOW,
    });
    expect(result.removedImages).toEqual([]);
    expect(removeImage).not.toHaveBeenCalled();
  });

  it('judges a pre-owner image only when its run directory exists in this base directory', async () => {
    const legacyHere = digest('5');
    const legacyReferenced = digest('6');
    const legacyElsewhere = digest('7');
    makeRunDirs('wf-here', 'wf-kept');
    const { docker } = makeDocker({
      [legacyHere]: { created: minutesAgo(60), labels: labels('wf-here') },
      [legacyReferenced]: { created: minutesAgo(60), labels: labels('wf-kept') },
      [legacyElsewhere]: { created: minutesAgo(60), labels: labels('wf-not-here') },
    });

    const result = await sweepContainerSnapshots({
      baseDir,
      checkpointStore: makeCheckpointStore({ 'wf-kept': resumableCheckpoint(legacyReferenced) }),
      userConfig: userConfig({ enabled: true, maxAgeDays: null }),
      docker,
      now: NOW,
    });
    expect(result.orphanImages).toEqual([legacyHere]);
  });

  it('keeps ownerless legacy images when an external base merely contains the matching run name', async () => {
    const foreignBase = join(root, 'external-runs');
    mkdirSync(join(foreignBase, 'wf-legacy'), { recursive: true });
    const legacy = digest('9');
    const { docker, removeImage } = makeDocker({ [legacy]: { created: daysAgo(30), labels: labels('wf-legacy') } });
    const result = await sweepContainerSnapshots({
      baseDir: foreignBase,
      checkpointStore: makeCheckpointStore({}),
      docker,
      userConfig: userConfig({ enabled: true, maxAgeDays: 7 }),
      now: NOW,
    });
    expect(result.removedImages).toEqual([]);
    expect(removeImage).not.toHaveBeenCalled();
  });

  it('ignores images whose workflow label is not a safe run id', async () => {
    const odd = digest('8');
    const { docker, removeImage } = makeDocker({
      [odd]: { created: minutesAgo(60), labels: labels('../../etc', baseDir) },
    });
    const result = await sweepContainerSnapshots({
      baseDir,
      checkpointStore: makeCheckpointStore({}),
      userConfig: userConfig({ enabled: true, maxAgeDays: null }),
      docker,
      now: NOW,
    });
    expect(result.removedImages).toEqual([]);
    expect(removeImage).not.toHaveBeenCalled();
  });

  it('is a no-op when the snapshot kill switch is off', async () => {
    const { docker, removeImage, listImages } = makeDocker({
      [digest('a')]: { created: daysAgo(30), labels: labels('wf', baseDir) },
    });

    const result = await sweepContainerSnapshots({
      baseDir,
      checkpointStore: makeCheckpointStore({}),
      userConfig: userConfig({ enabled: false, maxAgeDays: 7 }),
      docker,
      now: NOW,
    });

    expect(result).toEqual({ removedImages: [], agedImages: [], orphanImages: [] });
    expect(listImages).not.toHaveBeenCalled();
    expect(removeImage).not.toHaveBeenCalled();
  });
});

describe('removeContainerSnapshotImages', () => {
  // A checkpoint's snapshot references are only strings: one copied in from
  // elsewhere, restored from a backup or left by an agent can name any image
  // on the engine. Removal is `docker image rm --force`, so each reference is
  // inspected first and only this run's own snapshot images are removed.
  let root: string;
  let baseDir: string;
  const workflowId = 'wf-run' as WorkflowId;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'snapshot-remove-'));
    baseDir = join(root, 'home-a', 'workflow-runs');
    mkdirSync(baseDir, { recursive: true });
    vi.stubEnv('IRONCURTAIN_HOME', join(root, 'home-a'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function snapshotLabels(id: string, ownerBaseDir?: string): Record<string, string> {
    return {
      [IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW]: id,
      ...(ownerBaseDir !== undefined ? { [IRONCURTAIN_SNAPSHOT_LABEL_OWNER]: snapshotOwnerKey(ownerBaseDir) } : {}),
    };
  }

  it('requires an owner label before retiring snapshots referenced by an external run', async () => {
    const external = join(root, 'external-runs');
    mkdirSync(external);
    const legacy = digest('8');
    const owned = digest('9');
    const { docker, removeImage } = makeDocker({
      [legacy]: { created: daysAgo(1), labels: snapshotLabels(workflowId) },
      [owned]: { created: daysAgo(1), labels: snapshotLabels(workflowId, external) },
    });
    await removeContainerSnapshotImages(
      docker,
      { legacy: { image: legacy }, owned: { image: owned } },
      { workflowId, baseDir: external },
    );
    expect(removeImage.mock.calls.map(([image]) => image)).toEqual([owned]);
  });

  it('never removes an image a checkpoint names that is not a snapshot of this run', async () => {
    const foreignById = digest('e');
    const otherRun = digest('1');
    const otherBaseDir = digest('2');
    const { docker, removeImage } = makeDocker({
      'postgres:16': { created: daysAgo(1), labels: {} },
      [foreignById]: { created: daysAgo(1), labels: { 'org.opencontainers.image.title': 'postgres' } },
      [otherRun]: { created: daysAgo(1), labels: snapshotLabels('wf-other', baseDir) },
      [otherBaseDir]: { created: daysAgo(1), labels: snapshotLabels(workflowId, '/srv/home-b/workflow-runs') },
    });

    await removeContainerSnapshotImages(
      docker,
      {
        tagged: { image: 'postgres:16' },
        foreign: { image: foreignById },
        otherRun: { image: otherRun },
        otherBaseDir: { image: otherBaseDir },
      },
      { workflowId, baseDir },
    );

    expect(removeImage).not.toHaveBeenCalled();
  });

  it("removes this run's snapshot images, with or without an owner label, and skips ones already gone", async () => {
    const owned = digest('3');
    const preOwner = digest('4');
    const { docker, removeImage } = makeDocker({
      [owned]: { created: daysAgo(1), labels: snapshotLabels(workflowId, baseDir) },
      [preOwner]: { created: daysAgo(1), labels: snapshotLabels(workflowId) },
    });

    await removeContainerSnapshotImages(
      docker,
      {
        primary: { image: owned },
        review: { image: preOwner },
        gone: { image: digest('5') },
        sameImage: { image: owned },
      },
      { workflowId, baseDir },
    );

    expect(removeImage.mock.calls.map(([ref]) => ref).sort()).toEqual([owned, preOwner].sort());
  });

  it('keeps going when one image cannot be inspected', async () => {
    const owned = digest('6');
    const { docker, removeImage } = makeDocker({
      [owned]: { created: daysAgo(1), labels: snapshotLabels(workflowId, baseDir) },
    });
    const inspect = docker.inspectImage.bind(docker);
    docker.inspectImage = async (ref) => {
      if (ref === digest('7')) throw new Error('engine timeout');
      return inspect(ref);
    };

    await removeContainerSnapshotImages(
      docker,
      { broken: { image: digest('7') }, primary: { image: owned } },
      { workflowId, baseDir },
    );

    expect(removeImage.mock.calls.map(([ref]) => ref)).toEqual([owned]);
  });
});

describe('snapshotOwnerKey', () => {
  it('maps every spelling of one directory to one key and different directories to different keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'snapshot-owner-'));
    try {
      const a = join(root, 'a');
      const b = join(root, 'b');
      mkdirSync(a);
      mkdirSync(b);
      expect(snapshotOwnerKey(a)).toBe(snapshotOwnerKey(join(root, 'b', '..', 'a')));
      expect(snapshotOwnerKey(a)).not.toBe(snapshotOwnerKey(b));
      expect(snapshotOwnerKey(a)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('commitContainerSnapshot', () => {
  const GiB = 1024 * 1024 * 1024;
  const plentyOfSpace: SnapshotDiskProbe = { freeBytes: () => 1000 * GiB, deviceOf: () => 1 };
  /** Build hash of the agent image the snapshotted container ran. */
  const AGENT_BUILD = 'b'.repeat(64);

  function makeCommitDocker(options: { size?: number; dataRoot?: string } = {}) {
    const commit = vi.fn<ContainerRuntime['commit']>(async () => digest('9'));
    const containerSize = vi.fn<NonNullable<ContainerRuntime['containerSize']>>(async () => options.size);
    const localDataRoot = vi.fn<NonNullable<ContainerRuntime['localDataRoot']>>(async () => options.dataRoot);
    const docker = { commit, containerSize, localDataRoot } as unknown as ContainerRuntime;
    return { docker, commit, containerSize, localDataRoot };
  }

  it('labels the image with its workflow and the owner key of its base directory', async () => {
    const { docker, commit } = makeCommitDocker({ size: GiB });
    const ref = await commitContainerSnapshot({
      docker,
      workflowId: 'wf-owner' as WorkflowId,
      scope: 'primary',
      containerId: 'c1',
      baseDir: '/srv/home-a/workflow-runs',
      agentBuildHash: AGENT_BUILD,
      disk: plentyOfSpace,
    });

    expect(ref.image).toBe(digest('9'));
    const options = commit.mock.calls[0][1];
    expect(options?.flatten).toBe(true);
    expect(options?.changes).toEqual(
      expect.arrayContaining([
        `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW}=wf-owner`,
        `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_OWNER}=${snapshotOwnerKey('/srv/home-a/workflow-runs')}`,
      ]),
    );
  });

  it('runs one commit at a time across workflows', async () => {
    let releaseFirst: (() => void) | undefined;
    let active = 0;
    let maxActive = 0;
    const commit = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (releaseFirst === undefined) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      active -= 1;
      return digest('9');
    });
    const docker = { commit } as unknown as ContainerRuntime;
    const input = {
      docker,
      scope: 'primary',
      containerId: 'c',
      baseDir: '/srv/runs',
      agentBuildHash: AGENT_BUILD,
      disk: plentyOfSpace,
    };

    const first = commitContainerSnapshot({ ...input, workflowId: 'wf-1' as WorkflowId });
    const second = commitContainerSnapshot({ ...input, workflowId: 'wf-2' as WorkflowId });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    // The second commit waits for the first instead of exporting in parallel.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(commit).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("bounds both capacity probes by what is left of the caller's deadline", async () => {
    // A shutdown's snapshot budget covers the probes too: a slow `docker info`
    // must not run past it.
    const { docker, containerSize, localDataRoot } = makeCommitDocker({ size: GiB, dataRoot: '/var/lib/docker' });
    await commitContainerSnapshot({
      docker,
      workflowId: 'wf-budget' as WorkflowId,
      scope: 'primary',
      containerId: 'c',
      baseDir: '/srv/runs',
      agentBuildHash: AGENT_BUILD,
      timeoutMs: 8_000,
      disk: plentyOfSpace,
    });
    const sizeTimeout = containerSize.mock.calls[0]?.[1];
    const dataRootTimeout = localDataRoot.mock.calls[0]?.[0];
    expect(sizeTimeout).toBeLessThanOrEqual(2_000);
    expect(dataRootTimeout).toBeLessThanOrEqual(2_000);
    expect(dataRootTimeout).toBeGreaterThan(0);
  });

  it('skips a container larger than snapshot.maxBytes without committing', async () => {
    const { docker, commit } = makeCommitDocker({ size: 10 * GiB });
    const err = await commitContainerSnapshot({
      docker,
      workflowId: 'wf-big' as WorkflowId,
      scope: 'primary',
      containerId: 'c',
      baseDir: '/srv/runs',
      agentBuildHash: AGENT_BUILD,
      maxBytes: GiB,
      disk: plentyOfSpace,
    }).catch((e: unknown) => e);

    expect(isContainerSnapshotSkippedError(err)).toBe(true);
    expect(err).toMatchObject({ reason: 'too_large' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('skips when the temporary directory lacks room for the export', async () => {
    const { docker, commit } = makeCommitDocker({ size: 4 * GiB });
    const err = await commitContainerSnapshot({
      docker,
      workflowId: 'wf-full' as WorkflowId,
      scope: 'primary',
      containerId: 'c',
      baseDir: '/srv/runs',
      agentBuildHash: AGENT_BUILD,
      disk: { freeBytes: () => 4 * GiB, deviceOf: () => 1 },
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'CONTAINER_SNAPSHOT_SKIPPED', reason: 'insufficient_space' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('needs room for both copies when the engine data root shares the temporary filesystem', async () => {
    const size = 4 * GiB;
    const enoughForOne = size + SNAPSHOT_FREE_SPACE_RESERVE_BYTES + GiB;
    const shared = makeCommitDocker({ size, dataRoot: '/var/lib/docker' });
    const err = await commitContainerSnapshot({
      docker: shared.docker,
      workflowId: 'wf-shared' as WorkflowId,
      scope: 'primary',
      containerId: 'c',
      baseDir: '/srv/runs',
      agentBuildHash: AGENT_BUILD,
      disk: { freeBytes: () => enoughForOne, deviceOf: () => 7 },
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'insufficient_space' });
    expect(shared.commit).not.toHaveBeenCalled();

    // On separate filesystems the same free space suffices for each.
    const separate = makeCommitDocker({ size, dataRoot: '/var/lib/docker' });
    await commitContainerSnapshot({
      docker: separate.docker,
      workflowId: 'wf-separate' as WorkflowId,
      scope: 'primary',
      containerId: 'c',
      baseDir: '/srv/runs',
      agentBuildHash: AGENT_BUILD,
      disk: {
        freeBytes: () => enoughForOne,
        deviceOf: (path) => (path === '/var/lib/docker' ? 8 : 7),
      },
    });
    expect(separate.commit).toHaveBeenCalledTimes(1);
  });

  it('skips a commit whose deadline ran out while it waited for the one before', async () => {
    let releaseFirst: (() => void) | undefined;
    const commit = vi.fn(async () => {
      if (releaseFirst === undefined) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return digest('9');
    });
    const docker = { commit } as unknown as ContainerRuntime;
    const input = {
      docker,
      scope: 'primary',
      containerId: 'c',
      baseDir: '/srv/runs',
      agentBuildHash: AGENT_BUILD,
      disk: plentyOfSpace,
    };

    const first = commitContainerSnapshot({ ...input, workflowId: 'wf-1' as WorkflowId });
    const second = commitContainerSnapshot({ ...input, workflowId: 'wf-2' as WorkflowId, timeoutMs: 1_100 });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseFirst?.();
    await first;

    await expect(second).rejects.toMatchObject({ code: 'CONTAINER_SNAPSHOT_SKIPPED', reason: 'deadline' });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('stamps the agent image build and IronCurtain version, and records both in the ref', async () => {
    const { docker, commit } = makeCommitDocker({ size: GiB });
    const ref = await commitContainerSnapshot({
      docker,
      workflowId: 'wf-build' as WorkflowId,
      scope: 'primary',
      containerId: 'c1',
      baseDir: '/srv/runs',
      agentBuildHash: AGENT_BUILD,
      disk: plentyOfSpace,
    });

    expect(ref).toMatchObject({ image: digest('9'), agentBuildHash: AGENT_BUILD, ironcurtainVersion: VERSION });
    expect(commit.mock.calls[0][1]?.changes).toEqual(
      expect.arrayContaining([
        `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_BUILD_HASH}=${AGENT_BUILD}`,
        `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_VERSION}=${VERSION}`,
      ]),
    );
    // The same label the agent images carry: a snapshot names the build it came from.
    expect(IRONCURTAIN_SNAPSHOT_LABEL_BUILD_HASH).toBe('ironcurtain.build-hash');
    expect(IRONCURTAIN_SNAPSHOT_LABEL_VERSION).toBe('ironcurtain.version');
  });

  it('records whether the snapshotted agent had sudo, and nothing when that is unknown', async () => {
    const { docker } = makeCommitDocker({ size: GiB });
    const input = {
      docker,
      workflowId: 'wf-sudo' as WorkflowId,
      scope: 'primary',
      containerId: 'c1',
      baseDir: '/srv/runs',
      agentBuildHash: AGENT_BUILD,
      disk: plentyOfSpace,
    };

    expect(await commitContainerSnapshot({ ...input, agentSudo: false })).toMatchObject({ agentSudo: false });
    expect(await commitContainerSnapshot({ ...input, agentSudo: true })).toMatchObject({ agentSudo: true });
    // Resume counts a snapshot without the field as taken with sudo.
    expect(await commitContainerSnapshot(input)).not.toHaveProperty('agentSudo');
  });

  it('refuses a build hash that is not a hash without touching the engine', async () => {
    const { docker, commit, containerSize } = makeCommitDocker({ size: GiB });
    // A newline would smuggle another directive into `docker import --change`.
    for (const agentBuildHash of ['', 'b'.repeat(63), `${'b'.repeat(64)}\nLABEL x=y`, 'B'.repeat(64)]) {
      await expect(
        commitContainerSnapshot({
          docker,
          workflowId: 'wf-bad-build' as WorkflowId,
          scope: 'primary',
          containerId: 'c1',
          baseDir: '/srv/runs',
          agentBuildHash,
          disk: plentyOfSpace,
        }),
      ).rejects.toThrow(/not a valid build hash/);
    }
    expect(commit).not.toHaveBeenCalled();
    expect(containerSize).not.toHaveBeenCalled();
  });
});
