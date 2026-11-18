/**
 * Workflow runtime dependencies: a host-provisioned shared base plus a
 * per-run writable layer.
 *
 * A workflow package may ship `scripts/requirements.txt` and/or
 * `scripts/package.json` (+ `package-lock.json`). Their dependencies are
 * installed at run time through the bundle's MITM registry proxy and exposed to
 * the run's containers at `/opt/workflow-venv` and `/opt/workflow-node_modules`.
 *
 * Trust model:
 *
 * - **Shared base, never mounted into an agent container.** One base per content
 *   key (`computeWorkflowDependencyKey`: agent image build hash + exact manifest
 *   bytes) lives at
 *   `<home>/workflow-dependency-bases/<key24>/{python-venv,node_modules}`.
 *   Only a dedicated short-lived provisioning container mounts it (read-write, at
 *   the same container path the run layer later uses). That container is started
 *   from the pristine agent image, carries no workspace, no agent session and no
 *   provider credentials, and is removed before the base is trusted.
 * - **Legacy caches are never touched.** Earlier versions kept one shared cache
 *   per key at `<home>/workflow-deps/<key24>/{python-venv,node_modules}` and
 *   bind-mounted it read-write into every agent container of the workflow. A
 *   process of such a version may still be running (a daemon started before an
 *   upgrade) and mounts whatever directory sits at that path. The bases therefore
 *   live under a different root that no earlier version mounts, and this module
 *   never reads, mounts or deletes the legacy tree: deleting it on the host
 *   would race a still-running agent that can swap its directories for symlinks,
 *   and would break that version's run. The operator removes `workflow-deps/`
 *   once no earlier version is running.
 * - **Host-side provisioned record.** After the provisioning container is gone,
 *   the host walks the base and records a content/mode/symlink manifest in
 *   `<base>.provisioned.json`, a sibling outside every mount. A base without a
 *   valid record (for example one left by a crash mid-provisioning) is
 *   discarded and rebuilt.
 * - **Per-run writable layer.** Each workflow run gets its own copy of the base at
 *   `<home>/workflow-runs/<workflowId>/deps/<key24>/<kind>`, mounted read-write at
 *   the existing container path, so evolve's `provision` state can still install
 *   into `/opt/workflow-venv`. The copy uses copy-on-write clones where the
 *   filesystem supports them and plain copies otherwise. It never uses hard
 *   links, because an in-place write through a hard link would reach the base.
 *   The copy is verified against the record before it is published. A mismatch
 *   means the base changed on disk, so the base is rebuilt and the copy redone.
 *   Agent installs and any tampering stay in the run's own layer. Resume keeps
 *   the layer, and no other run ever sees it.
 * - **Retention.** Every run that seeds from a key records the time in
 *   `<key dir>/last-used.json`. `ironcurtain prune` removes a key directory
 *   unused for `retention.dependencyCaches.maxUnusedDays` under this same
 *   provisioning lock (`src/maintenance/prune.ts`), unless a retained run still
 *   holds a layer of that key. A run waiting for the lock re-creates the key
 *   directory once it holds it, and rebuilds the base. Per-run layers go with
 *   their run directory.
 *
 * The provisioning container itself is created by `docker-infrastructure.ts`
 * (it needs the bundle's network transport); this module owns the layout, the
 * record, verification, seeding and the in-container install scripts.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { cp, lstat, open, opendir, readdir, readlink, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { quote } from 'shell-quote';
import { z } from 'zod';

import { loadImmutableHostJson, writeStableJsonAtomic } from '../hardened-fs.js';
import { sha256HexSchema, stableStringify } from '../hash.js';
import { errorMessage } from '../utils/error-message.js';
import * as logger from '../logger.js';
import { withProvisionLock, type ProvisionLockOptions } from './provision-lock.js';

/** Container path of the run's writable Python venv layer. */
export const WORKFLOW_PYTHON_VENV_DIR = '/opt/workflow-venv';

/** Container path of the run's writable node_modules layer. */
export const WORKFLOW_NODE_MODULES_DIR = '/opt/workflow-node_modules';

/** Read-only manifest mount inside the provisioning container only. */
export const WORKFLOW_DEPENDENCY_MANIFESTS_DIR = '/opt/ironcurtain-workflow-manifests';

/**
 * Host directory (under the IronCurtain home) holding the shared bases. Never
 * the legacy `workflow-deps` directory, which earlier versions mount read-write
 * into agent containers (see the module comment).
 */
const WORKFLOW_DEPENDENCY_BASES_DIR = 'workflow-dependency-bases';

/** The legacy per-key cache directory of earlier versions (never touched here; see the module comment). */
const LEGACY_WORKFLOW_DEPS_DIR = 'workflow-deps';

/** Length of the content-key prefix used as a directory name. */
const CACHE_KEY_DIR_LENGTH = 24;

/** A key directory name: the first {@link CACHE_KEY_DIR_LENGTH} hex digits of a content key. */
const CACHE_KEY_DIR_RE = /^[0-9a-f]{24}$/;

/**
 * Marker inside a key directory recording when a run last used its base
 * (`{ schemaVersion: 1, lastUsedAt }`). Retention (`ironcurtain prune`,
 * `retention.dependencyCaches.maxUnusedDays`) removes bases unused for
 * longer; seeding a run layer only reads the base, so without the marker
 * nothing on disk would say when it was last used.
 */
export const WORKFLOW_DEPENDENCY_LAST_USED_FILE = 'last-used.json';

/** `<home>/workflow-dependency-bases`: the parent of every key directory. */
export function workflowDependencyBasesRoot(ironcurtainHome: string): string {
  return resolve(ironcurtainHome, WORKFLOW_DEPENDENCY_BASES_DIR);
}

/** `<home>/workflow-deps`: the legacy cache tree of earlier versions, never removed automatically. */
export function legacyWorkflowDepsRoot(ironcurtainHome: string): string {
  return resolve(ironcurtainHome, LEGACY_WORKFLOW_DEPS_DIR);
}

/** True when `name` can name a key directory under {@link workflowDependencyBasesRoot}. */
export function isWorkflowDependencyKeyDir(name: string): boolean {
  return CACHE_KEY_DIR_RE.test(name);
}

const lastUsedMarkerSchema = z.object({ schemaVersion: z.literal(1), lastUsedAt: z.string().min(1) });

/**
 * When a run last used the base in `keyDir` (ms since the epoch), from its
 * {@link WORKFLOW_DEPENDENCY_LAST_USED_FILE}; undefined when the marker is
 * missing or unusable (a base provisioned before markers existed).
 */
export function readWorkflowDependencyLastUsed(keyDir: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(keyDir, WORKFLOW_DEPENDENCY_LAST_USED_FILE), 'utf-8')) as unknown;
    const parsed = lastUsedMarkerSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const ms = Date.parse(parsed.data.lastUsedAt);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/** Records that a run used the base in `keyDir` now. Best effort: a failure only makes the base look older. */
function markWorkflowDependencyUsed(keyDir: string): void {
  try {
    writeStableJsonAtomic(join(keyDir, WORKFLOW_DEPENDENCY_LAST_USED_FILE), {
      schemaVersion: 1,
      lastUsedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn(`Could not record the use of workflow dependency base ${keyDir}: ${errorMessage(error)}`);
  }
}

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const RECORD_SCHEMA_VERSION = 1;
const RECORD_SUFFIX = '.provisioned.json';

/**
 * How long a run waits for another run that is provisioning the same key. One
 * lock covers both kinds (each install is bounded at 20 minutes) and a possible
 * rebuild, so this exceeds the provisioning lock's 25-minute default.
 */
const DEPENDENCY_LOCK_MAX_WAIT_MS = 60 * 60_000;

const MANIFEST_NAMES = ['requirements.txt', 'package.json', 'package-lock.json'] as const;

export type WorkflowDependencyManifestName = (typeof MANIFEST_NAMES)[number];

/** Exact manifest bytes, read once: the key hashes them and the provisioner installs them. */
export type WorkflowDependencyManifests = Readonly<Partial<Record<WorkflowDependencyManifestName, Buffer>>>;

export type WorkflowDependencyKind = 'python-venv' | 'node_modules';

/** One dependency layer: a shared host-only base and this run's writable copy of it. */
export interface WorkflowDependencyLayer {
  readonly kind: WorkflowDependencyKind;
  /** Container path where the run layer is mounted read-write (and where the base was built). */
  readonly target: string;
  /** This run's writable layer on the host: `<run deps root>/<key24>/<kind>`. */
  readonly hostDir: string;
  /** Full content key (sha256 hex) shared by the base and every run layered on it. */
  readonly cacheKey: string;
  /** Host-only key directory: `<home>/workflow-dependency-bases/<key24>`. */
  readonly cacheRoot: string;
  /** Shared base: `<cacheRoot>/<kind>`. Mounted only into the provisioning container. */
  readonly baseDir: string;
  /** The manifest bytes this layer's installer reads. */
  readonly manifests: WorkflowDependencyManifests;
}

export interface WorkflowPythonVenvLayer extends WorkflowDependencyLayer {
  readonly kind: 'python-venv';
}

export interface WorkflowNodeModulesLayer extends WorkflowDependencyLayer {
  readonly kind: 'node_modules';
  readonly hasPackageLock: boolean;
}

/** The layers a workflow bundle carries (field names match `PreContainerInfrastructure`). */
export interface WorkflowDependencyLayers {
  readonly workflowPythonVenvMount?: WorkflowPythonVenvLayer;
  readonly workflowNodeModulesMount?: WorkflowNodeModulesLayer;
}

/** What a provisioner receives when one or more bases must be (re)built. */
export interface WorkflowDependencyProvisionRequest {
  /** Layers whose base must be populated. Each `baseDir` is a fresh empty directory. */
  readonly layers: readonly WorkflowDependencyLayer[];
  /** Private host scratch directory for this attempt; removed afterwards. */
  readonly scratchDir: string;
  /**
   * Host directory with the exact hashed manifest bytes, to be mounted read-only
   * at {@link WORKFLOW_DEPENDENCY_MANIFESTS_DIR}.
   */
  readonly manifestsDir: string;
}

/**
 * Populates each `layer.baseDir`, mounted at `layer.target`, by running
 * {@link buildWorkflowDependencyProvisionScript}. When the promise settles no
 * process may still be able to write any base directory: the provisioning
 * container must be gone, not merely stopped from the caller's point of view.
 */
export type WorkflowDependencyProvisioner = (request: WorkflowDependencyProvisionRequest) => Promise<void>;

// ---------------------------------------------------------------------------
// Manifests and content key
// ---------------------------------------------------------------------------

function readManifestFiles(scriptsDir: string): WorkflowDependencyManifests {
  const files: Partial<Record<WorkflowDependencyManifestName, Buffer>> = {};
  for (const name of MANIFEST_NAMES) {
    const path = resolve(scriptsDir, name);
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
    if (!stats.isFile()) throw new Error(`Workflow dependency manifest is not a regular file: ${path}`);
    const bytes = readFileSync(path);
    if (bytes.length > MAX_MANIFEST_BYTES) {
      throw new Error(`Workflow dependency manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${path}`);
    }
    files[name] = bytes;
  }
  return files;
}

/**
 * Reads the dependency manifests a staged workflow scripts directory declares.
 * Returns `undefined` when it declares no runtime dependencies (neither a
 * `requirements.txt` nor a `package.json`).
 */
export function readWorkflowDependencyManifests(
  scriptsDir: string | undefined,
): WorkflowDependencyManifests | undefined {
  if (scriptsDir === undefined) return undefined;
  const files = readManifestFiles(scriptsDir);
  if (files['requirements.txt'] === undefined && files['package.json'] === undefined) return undefined;
  return files;
}

/**
 * Content key of a dependency base: the agent image build hash plus each present
 * manifest, keyed by name before its bytes so adding or removing a manifest
 * changes the key.
 */
export function computeWorkflowDependencyKey(agentBuildHash: string, manifests: WorkflowDependencyManifests): string {
  const hash = createHash('sha256');
  hash.update(`agent:${agentBuildHash}\n`);
  for (const name of MANIFEST_NAMES) {
    const bytes = manifests[name];
    if (bytes === undefined) continue;
    hash.update(`file:${name}\n`);
    hash.update(bytes);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** {@link computeWorkflowDependencyKey} over the manifests currently in `scriptsDir`. */
export function computeWorkflowDependencyHash(agentBuildHash: string, scriptsDir: string): string {
  return computeWorkflowDependencyKey(agentBuildHash, readManifestFiles(scriptsDir));
}

/**
 * Fails fast, before any proxy, lease or container work, when a workflow that
 * declares runtime dependencies cannot have them provisioned.
 */
export function assertWorkflowDependencyProvisioningAvailable(options: {
  readonly packageInstallEnabled: boolean;
  readonly nestedDockerAdmitted: boolean;
}): void {
  // Runtime provisioning installs through the MITM registry proxy, which is only
  // wired when packageInstall is enabled. Without it the install would die with
  // an opaque network error under `--network=none`.
  if (!options.packageInstallEnabled) {
    throw new Error(
      'This workflow requires installing dependencies at runtime ' +
        '(a requirements.txt and/or package.json is present in its scripts), ' +
        'but packageInstall is disabled. Enable packageInstall in your IronCurtain ' +
        'config to run workflows that declare runtime dependencies.',
    );
  }
  // The shared base is built in a dedicated provisioning container. An admitted
  // nested-Docker bundle must ledger every outer resource it creates, and that
  // ledger has no provisioning role, so refuse instead of creating an
  // unledgered container.
  if (options.nestedDockerAdmitted) {
    throw new Error(
      'This workflow requires installing dependencies at runtime ' +
        '(a requirements.txt and/or package.json is present in its scripts), ' +
        'which is not supported while nested Docker (dockerWorkload) is enabled. ' +
        'Disable dockerWorkload in your IronCurtain config to run this workflow.',
    );
  }
}

/** Host directory holding the run layers of one workflow run. */
export function workflowRunDependencyRoot(workflowRunDir: string): string {
  return resolve(workflowRunDir, 'deps');
}

/**
 * Plans the shared bases and this run's layers for the given manifests. Pure:
 * nothing is created on disk until {@link ensureWorkflowDependencyLayers}.
 */
export function planWorkflowDependencyLayers(options: {
  readonly agentBuildHash: string;
  readonly manifests: WorkflowDependencyManifests;
  readonly ironcurtainHome: string;
  /** Directory holding this run's layers, e.g. `<home>/workflow-runs/<id>/deps`. */
  readonly runDependencyRoot: string;
}): WorkflowDependencyLayers {
  const { manifests } = options;
  const cacheKey = computeWorkflowDependencyKey(options.agentBuildHash, manifests);
  const keyDir = cacheKey.slice(0, CACHE_KEY_DIR_LENGTH);
  const cacheRoot = resolve(options.ironcurtainHome, WORKFLOW_DEPENDENCY_BASES_DIR, keyDir);
  const runRoot = resolve(options.runDependencyRoot, keyDir);

  const requirements = manifests['requirements.txt'];
  const packageJson = manifests['package.json'];
  const packageLock = manifests['package-lock.json'];

  const python: WorkflowPythonVenvLayer | undefined =
    requirements === undefined
      ? undefined
      : {
          kind: 'python-venv',
          target: WORKFLOW_PYTHON_VENV_DIR,
          hostDir: resolve(runRoot, 'python-venv'),
          cacheKey,
          cacheRoot,
          baseDir: resolve(cacheRoot, 'python-venv'),
          manifests: { 'requirements.txt': requirements },
        };
  const node: WorkflowNodeModulesLayer | undefined =
    packageJson === undefined
      ? undefined
      : {
          kind: 'node_modules',
          target: WORKFLOW_NODE_MODULES_DIR,
          hostDir: resolve(runRoot, 'node_modules'),
          cacheKey,
          cacheRoot,
          baseDir: resolve(cacheRoot, 'node_modules'),
          manifests: {
            'package.json': packageJson,
            ...(packageLock === undefined ? {} : { 'package-lock.json': packageLock }),
          },
          hasPackageLock: packageLock !== undefined,
        };
  return {
    ...(python ? { workflowPythonVenvMount: python } : {}),
    ...(node ? { workflowNodeModulesMount: node } : {}),
  };
}

/** The layers present on a bundle, in a stable order. */
export function listWorkflowDependencyLayers(layers: WorkflowDependencyLayers): WorkflowDependencyLayer[] {
  const listed: WorkflowDependencyLayer[] = [];
  if (layers.workflowPythonVenvMount) listed.push(layers.workflowPythonVenvMount);
  if (layers.workflowNodeModulesMount) listed.push(layers.workflowNodeModulesMount);
  return listed;
}

/**
 * The install script the provisioning container runs (as `codespace`, through
 * `/bin/sh -lc`) to populate `layer.target`. The only interpolated values are
 * hardcoded container paths. The manifests come from the read-only
 * {@link WORKFLOW_DEPENDENCY_MANIFESTS_DIR} mount, so they are exactly the bytes
 * the content key covers.
 */
export function buildWorkflowDependencyProvisionScript(layer: WorkflowDependencyLayer): string {
  const target = quote([layer.target]);
  if (layer.kind === 'python-venv') {
    return [
      'set -eu',
      // Copy, never hard-link, from uv's cache into the base.
      'export UV_NATIVE_TLS=1 UV_LINK_MODE=copy',
      `uv venv ${target}`,
      `VIRTUAL_ENV=${target} uv pip install -r ${quote([`${WORKFLOW_DEPENDENCY_MANIFESTS_DIR}/requirements.txt`])}`,
    ].join('\n');
  }
  const hasPackageLock = layer.manifests['package-lock.json'] !== undefined;
  return [
    'set -eu',
    'tmp="$(mktemp -d)"',
    'cleanup() { rm -rf "$tmp"; }',
    'trap cleanup EXIT',
    `cp ${quote([`${WORKFLOW_DEPENDENCY_MANIFESTS_DIR}/package.json`])} "$tmp/package.json"`,
    hasPackageLock
      ? `cp ${quote([`${WORKFLOW_DEPENDENCY_MANIFESTS_DIR}/package-lock.json`])} "$tmp/package-lock.json"`
      : '',
    'cd "$tmp"',
    hasPackageLock ? 'npm ci --omit=dev' : 'npm install --omit=dev',
    'mkdir -p node_modules',
    `cp -a node_modules/. ${target}/`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Content/mode/symlink manifest of a dependency tree
// ---------------------------------------------------------------------------

const dirEntrySchema = z.strictObject({
  path: z.string().min(1),
  type: z.literal('dir'),
  mode: z.number().int().min(0).max(0o7777),
});
const fileEntrySchema = z.strictObject({
  path: z.string().min(1),
  type: z.literal('file'),
  mode: z.number().int().min(0).max(0o7777),
  size: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
});
const symlinkEntrySchema = z.strictObject({
  path: z.string().min(1),
  type: z.literal('symlink'),
  target: z.string(),
});
const treeEntrySchema = z.discriminatedUnion('type', [dirEntrySchema, fileEntrySchema, symlinkEntrySchema]);

export type DependencyTreeEntry = z.infer<typeof treeEntrySchema>;

export interface DependencyTreeManifest {
  /** sha256 of the canonical serialization of `entries`. */
  readonly digest: string;
  readonly entryCount: number;
  readonly totalBytes: number;
  /** Sorted by path. `.` is the root directory itself. */
  readonly entries: readonly DependencyTreeEntry[];
}

function digestEntries(entries: readonly DependencyTreeEntry[]): string {
  const hash = createHash('sha256').update('[');
  entries.forEach((entry, index) => {
    if (index > 0) hash.update(',');
    hash.update(stableStringify(entry) ?? '');
  });
  return hash.update(']').digest('hex');
}

function comparePaths(left: DependencyTreeEntry, right: DependencyTreeEntry): number {
  if (left.path < right.path) return -1;
  return left.path > right.path ? 1 : 0;
}

/** Hash a regular file through one no-follow descriptor bound to the walked inode. */
async function hashRegularFile(path: string, expected: Stats, buffer: Buffer, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
      throw new Error(`workflow dependency tree entry changed during verification: ${JSON.stringify(path)}`);
    }
    const hash = createHash('sha256');
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expected.size + 1 - total, maxBytes + 1 - total),
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.size || total > maxBytes) {
        throw new Error('workflow dependency tree file changed or exceeded byte limit during verification');
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== expected.size) {
      throw new Error(`workflow dependency tree entry changed during verification: ${JSON.stringify(path)}`);
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Walks a dependency tree without following any symlink and records every
 * directory (mode), regular file (mode, size, sha256) and symlink (target).
 * Any other file type, or an entry that changes during the walk, fails closed.
 */
export interface DependencyTreeLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
  readonly maxMetadataBytes: number;
}

const DEFAULT_TREE_LIMITS: DependencyTreeLimits = {
  maxEntries: 100_000,
  maxDepth: 64,
  maxBytes: 16 * 1024 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024 * 1024,
};

export async function buildDependencyTreeManifest(
  root: string,
  options: Partial<DependencyTreeLimits> = {},
): Promise<DependencyTreeManifest> {
  const limits = { ...DEFAULT_TREE_LIMITS, ...options };
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('workflow dependency tree limits must be non-negative safe integers');
  }
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`workflow dependency tree root is not a directory: ${root}`);
  }
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const entries: DependencyTreeEntry[] = [];
  let totalBytes = 0;
  let metadataBytes = 2;
  const retain = (entry: DependencyTreeEntry): void => {
    metadataBytes += Buffer.byteLength(stableStringify(entry) ?? '') + (entries.length > 0 ? 1 : 0);
    if (metadataBytes > limits.maxMetadataBytes)
      throw new Error('workflow dependency tree metadata byte limit exceeded');
    entries.push(entry);
  };
  const visit = async (absolute: string, relativePath: string, depth: number): Promise<void> => {
    if (entries.length >= limits.maxEntries) throw new Error('workflow dependency tree entry limit exceeded');
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      retain({ path: relativePath, type: 'symlink', target: await readlink(absolute) });
    } else if (stats.isDirectory()) {
      if (depth > limits.maxDepth) throw new Error('workflow dependency tree depth limit exceeded');
      retain({ path: relativePath, type: 'dir', mode: stats.mode & 0o7777 });
      const directory = await opendir(absolute);
      for await (const entry of directory) {
        await visit(
          join(absolute, entry.name),
          relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`,
          depth + 1,
        );
      }
    } else if (stats.isFile()) {
      if (stats.size > limits.maxBytes - totalBytes)
        throw new Error('workflow dependency tree content byte limit exceeded');
      const sha256 = await hashRegularFile(absolute, stats, buffer, limits.maxBytes - totalBytes);
      retain({ path: relativePath, type: 'file', mode: stats.mode & 0o7777, size: stats.size, sha256 });
      totalBytes += stats.size;
    } else {
      throw new Error(`unsupported file type in workflow dependency tree: ${JSON.stringify(relativePath)}`);
    }
  };
  await visit(root, '.', 0);
  entries.sort(comparePaths);
  return { digest: digestEntries(entries), entryCount: entries.length, totalBytes, entries };
}

/** First differing path between two sorted manifests, for diagnostics. */
function describeTreeMismatch(
  expected: readonly DependencyTreeEntry[],
  actual: readonly DependencyTreeEntry[],
): string {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    const left = expected.at(index);
    const right = actual.at(index);
    if (stableStringify(left) !== stableStringify(right)) {
      return `content differs at ${JSON.stringify(left?.path ?? right?.path ?? '?')}`;
    }
  }
  return 'content digest differs';
}

// ---------------------------------------------------------------------------
// Provisioned record (host-only, outside every mount)
// ---------------------------------------------------------------------------

const provisionedRecordSchema = z.strictObject({
  schemaVersion: z.literal(RECORD_SCHEMA_VERSION),
  kind: z.enum(['python-venv', 'node_modules']),
  cacheKey: sha256HexSchema,
  target: z.string().min(1),
  provisionedAt: z.string().min(1),
  digest: sha256HexSchema,
  entryCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  entries: z.array(treeEntrySchema),
});

export type WorkflowDependencyProvisionedRecord = z.infer<typeof provisionedRecordSchema>;

/** Where the provisioned record of a layer's base lives: a sibling of the base, never inside it. */
export function provisionedRecordPath(layer: Pick<WorkflowDependencyLayer, 'baseDir'>): string {
  return `${layer.baseDir}${RECORD_SUFFIX}`;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Loads the provisioned record of a layer's base. Returns `undefined`, so the
 * base is rebuilt, when the record is missing, unreadable, internally
 * inconsistent, describes a different key, kind or target, or the base itself
 * is gone.
 */
function loadProvisionedRecord(layer: WorkflowDependencyLayer): WorkflowDependencyProvisionedRecord | undefined {
  const path = provisionedRecordPath(layer);
  if (!pathExists(path)) return undefined;
  let record: WorkflowDependencyProvisionedRecord;
  try {
    record = loadImmutableHostJson(path, {
      label: 'workflow dependency provisioned record',
      schema: provisionedRecordSchema,
      maxBytes: MAX_RECORD_BYTES,
    }).value;
  } catch (error) {
    logger.warn(`Ignoring unusable workflow dependency record ${path}: ${errorMessage(error)}`);
    return undefined;
  }
  const consistent =
    record.kind === layer.kind &&
    record.cacheKey === layer.cacheKey &&
    record.target === layer.target &&
    record.entryCount === record.entries.length &&
    digestEntries(record.entries) === record.digest;
  if (!consistent) {
    logger.warn(`Ignoring workflow dependency record ${path}: it does not describe this base`);
    return undefined;
  }
  return isRealDirectory(layer.baseDir) ? record : undefined;
}

// ---------------------------------------------------------------------------
// Host filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Creates (or validates) a private host directory. A pre-existing symlink is
 * rejected before `mkdir`, which would otherwise follow it.
 */
function ensurePrivateDirectory(path: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Refusing workflow dependency path that is not a real directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

/** Make every real directory under `root` writable by its owner, without following symlinks. */
async function makeDirectoriesWritable(root: string): Promise<void> {
  const pending = [root];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let handle;
    try {
      handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      continue; // a symlink, a non-directory, or not ours
    }
    try {
      await handle.chmod(0o700);
    } catch {
      // Owned by someone else (e.g. root via an agent's sudo); rm reports it.
    } finally {
      await handle.close();
    }
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) pending.push(join(directory, name));
  }
}

/** Remove a host tree; read-only directories are made writable first. Failures are logged. */
async function removeTreeBestEffort(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch {
    // Retry after making read-only directories writable.
  }
  try {
    await makeDirectoriesWritable(path);
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    logger.warn(`Could not remove ${path}: ${errorMessage(error)}. Remove it manually.`);
  }
}

/**
 * Atomically free `path` by renaming it to a sibling tombstone, then remove the
 * tombstone. The rename works whatever the tree contains, so the canonical path
 * is clean even when an old agent-written tree cannot be fully deleted.
 */
async function discardTree(path: string): Promise<void> {
  if (!pathExists(path)) return;
  const tombstone = join(dirname(path), `.discard-${basename(path)}-${randomUUID()}`);
  renameSync(path, tombstone);
  await removeTreeBestEffort(tombstone);
}

/** True when this run's layer already exists (it is then reused as-is, e.g. on resume). */
function isSeededLayer(layer: WorkflowDependencyLayer): boolean {
  let stats: Stats;
  try {
    stats = lstatSync(layer.hostDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Workflow dependency layer path is not a real directory: ${layer.hostDir}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rebuild and seed
// ---------------------------------------------------------------------------

/**
 * Discards the bases of `layers`, has `provision` populate fresh ones, and
 * records each base's manifest once the provisioner can no longer write it.
 */
async function rebuildBases(
  layers: readonly WorkflowDependencyLayer[],
  provision: WorkflowDependencyProvisioner,
): Promise<Map<WorkflowDependencyKind, WorkflowDependencyProvisionedRecord>> {
  const first = layers.at(0);
  if (first === undefined) return new Map();
  for (const layer of layers) {
    // Forget the record first, so a crash mid-rebuild leaves the base unprovisioned.
    rmSync(provisionedRecordPath(layer), { force: true });
    await discardTree(layer.baseDir);
    mkdirSync(layer.baseDir, { mode: 0o700 });
  }

  const scratchDir = mkdtempSync(join(first.cacheRoot, '.provision-'));
  try {
    const manifestsDir = join(scratchDir, 'manifests');
    mkdirSync(manifestsDir, { mode: 0o700 });
    const files = new Map<string, Buffer>();
    for (const layer of layers) {
      for (const [name, bytes] of Object.entries(layer.manifests)) files.set(name, bytes);
    }
    for (const [name, bytes] of files) {
      const path = join(manifestsDir, name);
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      chmodSync(path, 0o444);
    }
    chmodSync(manifestsDir, 0o755);
    logger.info(
      `Provisioning workflow dependency base(s) ${layers.map((layer) => layer.kind).join(', ')} ` +
        `for key ${first.cacheKey.slice(0, CACHE_KEY_DIR_LENGTH)} in a dedicated container`,
    );
    await provision({ layers, scratchDir, manifestsDir });
  } finally {
    await removeTreeBestEffort(scratchDir);
  }

  const records = new Map<WorkflowDependencyKind, WorkflowDependencyProvisionedRecord>();
  for (const layer of layers) {
    const tree = await buildDependencyTreeManifest(layer.baseDir);
    const record: WorkflowDependencyProvisionedRecord = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      kind: layer.kind,
      cacheKey: layer.cacheKey,
      target: layer.target,
      provisionedAt: new Date().toISOString(),
      digest: tree.digest,
      entryCount: tree.entryCount,
      totalBytes: tree.totalBytes,
      entries: [...tree.entries],
    };
    writeStableJsonAtomic(provisionedRecordPath(layer), record);
    records.set(layer.kind, record);
  }
  return records;
}

type SeedResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Copies the base into a private staging directory next to the run layer,
 * verifies the copy against the record, and only then renames it into place.
 * Returns `ok: false` when the copy cannot be made or does not match, which
 * means the base on disk is not the provisioned one.
 */
async function seedLayer(
  layer: WorkflowDependencyLayer,
  record: WorkflowDependencyProvisionedRecord,
): Promise<SeedResult> {
  const staging = join(dirname(layer.hostDir), `.${basename(layer.hostDir)}.staging-${randomUUID()}`);
  try {
    let result: SeedResult;
    try {
      if (!isRealDirectory(layer.baseDir)) {
        result = { ok: false, reason: 'the base directory is missing' };
      } else {
        // COPYFILE_FICLONE: a copy-on-write clone where supported, else a plain
        // copy. Never a hard link. verbatimSymlinks keeps relative targets
        // relative instead of resolving them into the host base path.
        await cp(layer.baseDir, staging, {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        });
        const copy = await buildDependencyTreeManifest(staging);
        result =
          copy.digest === record.digest
            ? { ok: true }
            : { ok: false, reason: describeTreeMismatch(record.entries, copy.entries) };
      }
    } catch (error) {
      // A full disk is not evidence about the base; rebuilding would not help.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EDQUOT') throw error;
      result = { ok: false, reason: errorMessage(error) };
    }
    if (result.ok) renameSync(staging, layer.hostDir);
    return result;
  } finally {
    await removeTreeBestEffort(staging);
  }
}

/**
 * Makes sure every layer exists for this run: reuses a layer that already
 * exists (resume), otherwise verifies or rebuilds the shared base and seeds a
 * fresh copy of it. All layers must share one content key. Serialized per key
 * across processes by the host provisioning lock.
 */
export async function ensureWorkflowDependencyLayers(
  layers: readonly WorkflowDependencyLayer[],
  provision: WorkflowDependencyProvisioner,
  options: { readonly lock?: ProvisionLockOptions } = {},
): Promise<void> {
  const pending = layers.filter((layer) => !isSeededLayer(layer));
  const first = pending.at(0);
  if (first === undefined) return;
  if (pending.some((layer) => layer.cacheKey !== first.cacheKey || layer.cacheRoot !== first.cacheRoot)) {
    throw new Error('Workflow dependency layers of one bundle must share a content key');
  }

  // `workflow-dependency-bases/` itself may be a user-made symlink to another
  // disk (the IronCurtain home is the trust boundary); the key directory below
  // it may not.
  mkdirSync(dirname(first.cacheRoot), { recursive: true, mode: 0o700 });
  ensurePrivateDirectory(first.cacheRoot);
  await withProvisionLock(
    first.cacheRoot,
    async () => {
      // Another bundle of this run may have seeded while we waited.
      const unseeded = pending.filter((layer) => !isSeededLayer(layer));
      if (unseeded.length === 0) return;
      // Retention removes an unused key directory under this same lock (the
      // lock file is its sibling), possibly while this run waited for it.
      ensurePrivateDirectory(first.cacheRoot);
      markWorkflowDependencyUsed(first.cacheRoot);

      const records = new Map<WorkflowDependencyKind, WorkflowDependencyProvisionedRecord>();
      const unprovisioned: WorkflowDependencyLayer[] = [];
      for (const layer of unseeded) {
        const record = loadProvisionedRecord(layer);
        if (record === undefined) unprovisioned.push(layer);
        else records.set(layer.kind, record);
      }
      if (unprovisioned.length > 0) {
        for (const [kind, record] of await rebuildBases(unprovisioned, provision)) records.set(kind, record);
      }

      for (const layer of unseeded) {
        mkdirSync(dirname(dirname(layer.hostDir)), { recursive: true, mode: 0o700 });
        ensurePrivateDirectory(dirname(layer.hostDir));
        const record = records.get(layer.kind);
        if (record === undefined) throw new Error(`Workflow dependency base ${layer.baseDir} has no record`);
        const seeded = await seedLayer(layer, record);
        if (seeded.ok) continue;

        logger.warn(
          `Workflow dependency base ${layer.baseDir} does not match its provisioned record ` +
            `(${seeded.reason}); rebuilding it`,
        );
        const rebuilt = (await rebuildBases([layer], provision)).get(layer.kind);
        if (rebuilt === undefined) throw new Error(`Workflow dependency base ${layer.baseDir} has no record`);
        const reseeded = await seedLayer(layer, rebuilt);
        if (!reseeded.ok) {
          throw new Error(
            `Workflow dependency layer ${layer.hostDir} could not be seeded from a freshly provisioned base: ` +
              reseeded.reason,
          );
        }
      }
    },
    { maxWaitMs: DEPENDENCY_LOCK_MAX_WAIT_MS, ...options.lock },
  );
}
