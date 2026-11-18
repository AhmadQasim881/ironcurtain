import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  assertWorkflowDependencyProvisioningAvailable,
  buildDependencyTreeManifest,
  buildWorkflowDependencyProvisionScript,
  computeWorkflowDependencyHash,
  computeWorkflowDependencyKey,
  ensureWorkflowDependencyLayers,
  listWorkflowDependencyLayers,
  planWorkflowDependencyLayers,
  provisionedRecordPath,
  readWorkflowDependencyLastUsed,
  readWorkflowDependencyManifests,
  workflowRunDependencyRoot,
  WORKFLOW_DEPENDENCY_LAST_USED_FILE,
  WORKFLOW_DEPENDENCY_MANIFESTS_DIR,
  WORKFLOW_NODE_MODULES_DIR,
  WORKFLOW_PYTHON_VENV_DIR,
  type WorkflowDependencyLayer,
  type WorkflowDependencyLayers,
  type WorkflowDependencyManifests,
  type WorkflowDependencyProvisionRequest,
} from '../../src/docker/workflow-dependency-cache.js';
import { provisionLockPath, tryAcquireProvisionLock } from '../../src/docker/provision-lock.js';
import { sha256Hex, stableStringify } from '../../src/hash.js';

const AGENT_BUILD_HASH = 'a'.repeat(64);
const SITE_PACKAGES = 'lib/python3.12/site-packages';

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workflow-dependency-cache-'));
  home = join(root, 'home');
  mkdirSync(home);
});

afterEach(() => {
  // Read-only directories (0555) inside a tree would otherwise block removal.
  try {
    execFileSync('chmod', ['-R', 'u+rwX', root]);
  } catch {
    // best effort
  }
  rmSync(root, { recursive: true, force: true });
});

function manifests(overrides: WorkflowDependencyManifests = {}): WorkflowDependencyManifests {
  return {
    'requirements.txt': Buffer.from('numpy\npyyaml\n'),
    'package.json': Buffer.from('{ "dependencies": { "ajv": "^8.17.1" } }\n'),
    ...overrides,
  };
}

function runRoot(workflowId: string): string {
  return workflowRunDependencyRoot(join(home, 'workflow-runs', workflowId));
}

function planRun(workflowId: string, deps: WorkflowDependencyManifests = manifests()): WorkflowDependencyLayers {
  return planWorkflowDependencyLayers({
    agentBuildHash: AGENT_BUILD_HASH,
    manifests: deps,
    ironcurtainHome: home,
    runDependencyRoot: runRoot(workflowId),
  });
}

function pythonLayer(layers: WorkflowDependencyLayers): WorkflowDependencyLayer {
  const layer = layers.workflowPythonVenvMount;
  if (layer === undefined) throw new Error('expected a python layer');
  return layer;
}

function nodeLayer(layers: WorkflowDependencyLayers): WorkflowDependencyLayer {
  const layer = layers.workflowNodeModulesMount;
  if (layer === undefined) throw new Error('expected a node layer');
  return layer;
}

/** Writes a small but realistic tree into `dir`, the way the in-container installer would. */
function writeFakeTree(layer: WorkflowDependencyLayer, dir: string, manifestsDir: string): void {
  if (layer.kind === 'python-venv') {
    const requirements = readFileSync(join(manifestsDir, 'requirements.txt'), 'utf8');
    writeFileSync(join(dir, 'pyvenv.cfg'), `home = /usr/bin\n# ${requirements.trim().replaceAll('\n', ',')}\n`);
    mkdirSync(join(dir, 'bin'));
    symlinkSync('/usr/bin/python3', join(dir, 'bin', 'python'));
    symlinkSync('python', join(dir, 'bin', 'python3'));
    writeFileSync(join(dir, 'bin', 'f2py'), `#!${WORKFLOW_PYTHON_VENV_DIR}/bin/python\n`, { mode: 0o755 });
    chmodSync(join(dir, 'bin', 'f2py'), 0o755);
    mkdirSync(join(dir, SITE_PACKAGES, 'numpy'), { recursive: true });
    writeFileSync(join(dir, SITE_PACKAGES, 'numpy', '__init__.py'), '__version__ = "2.1.0"\n');
    writeFileSync(join(dir, SITE_PACKAGES, 'numpy', 'LICENSE.txt'), 'BSD\n');
    chmodSync(join(dir, SITE_PACKAGES, 'numpy', 'LICENSE.txt'), 0o444);
    mkdirSync(join(dir, SITE_PACKAGES, 'yaml'));
    writeFileSync(join(dir, SITE_PACKAGES, 'yaml', '__init__.py'), '__version__ = "6.0"\n');
    return;
  }
  const packageJson = readFileSync(join(manifestsDir, 'package.json'), 'utf8');
  mkdirSync(join(dir, 'ajv', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'ajv', 'package.json'), packageJson);
  writeFileSync(join(dir, 'ajv', 'bin', 'ajv.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  chmodSync(join(dir, 'ajv', 'bin', 'ajv.js'), 0o755);
  mkdirSync(join(dir, '.bin'));
  symlinkSync('../ajv/bin/ajv.js', join(dir, '.bin', 'ajv'));
}

interface FakeProvisioner {
  readonly provision: (request: WorkflowDependencyProvisionRequest) => Promise<void>;
  readonly calls: { kinds: string[]; manifestNames: string[]; manifestBytes: Record<string, string> }[];
}

function fakeProvisioner(customize?: (layer: WorkflowDependencyLayer, dir: string) => void): FakeProvisioner {
  const calls: FakeProvisioner['calls'] = [];
  return {
    calls,
    async provision(request) {
      const manifestNames = readdirSync(request.manifestsDir).sort();
      const manifestBytes = Object.fromEntries(
        manifestNames.map((name) => [name, readFileSync(join(request.manifestsDir, name), 'utf8')]),
      );
      calls.push({ kinds: request.layers.map((layer) => layer.kind), manifestNames, manifestBytes });
      for (const layer of request.layers) {
        // The provisioner receives a fresh, empty base directory every time.
        expect(readdirSync(layer.baseDir)).toEqual([]);
        writeFakeTree(layer, layer.baseDir, request.manifestsDir);
        customize?.(layer, layer.baseDir);
      }
      await Promise.resolve();
    },
  };
}

async function ensureRun(layers: WorkflowDependencyLayers, provisioner: FakeProvisioner): Promise<void> {
  await ensureWorkflowDependencyLayers(listWorkflowDependencyLayers(layers), provisioner.provision);
}

async function digestOf(dir: string): Promise<string> {
  return (await buildDependencyTreeManifest(dir)).digest;
}

function readRecord(layer: WorkflowDependencyLayer): { digest: string; provisionedAt: string; cacheKey: string } {
  return JSON.parse(readFileSync(provisionedRecordPath(layer), 'utf8')) as {
    digest: string;
    provisionedAt: string;
    cacheKey: string;
  };
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

describe('workflow dependency manifests and plan', () => {
  it('refuses a tiny tree beyond an explicit entry budget', async () => {
    const tree = join(root, 'bounded-tree');
    mkdirSync(tree);
    writeFileSync(join(tree, 'one.txt'), 'one');
    writeFileSync(join(tree, 'two.txt'), 'two');
    await expect(buildDependencyTreeManifest(tree, { maxEntries: 2 })).rejects.toThrow(/entry limit/);
  });

  it('accepts exact tiny budgets and preserves the existing canonical digest', async () => {
    const tree = join(root, 'exact-tree');
    mkdirSync(tree);
    writeFileSync(join(tree, 'one.txt'), 'one');
    const manifest = await buildDependencyTreeManifest(tree, { maxEntries: 2, maxDepth: 0, maxBytes: 3 });
    expect(manifest.entryCount).toBe(2);
    expect(manifest.totalBytes).toBe(3);
    expect(manifest.digest).toBe(sha256Hex(stableStringify(manifest.entries) ?? ''));
    const metadata = Buffer.byteLength(stableStringify(manifest.entries) ?? '');
    await expect(buildDependencyTreeManifest(tree, { maxMetadataBytes: metadata })).resolves.toMatchObject({
      digest: manifest.digest,
    });
    await expect(buildDependencyTreeManifest(tree, { maxMetadataBytes: metadata - 1 })).rejects.toThrow(
      /metadata byte limit/,
    );
    await expect(buildDependencyTreeManifest(tree, { maxBytes: 2 })).rejects.toThrow(/content byte limit/);
  });

  it('refuses excess directory depth and invalid limits with ordinary small fixtures', async () => {
    const tree = join(root, 'depth-tree');
    mkdirSync(join(tree, 'first', 'second'), { recursive: true });
    await expect(buildDependencyTreeManifest(tree, { maxDepth: 1 })).rejects.toThrow(/depth limit/);
    await expect(buildDependencyTreeManifest(tree, { maxDepth: 2 })).resolves.toMatchObject({ entryCount: 3 });
    await expect(buildDependencyTreeManifest(tree, { maxEntries: -1 })).rejects.toThrow(/non-negative safe integers/);
    await expect(buildDependencyTreeManifest(tree, { maxBytes: Number.POSITIVE_INFINITY })).rejects.toThrow(
      /non-negative safe integers/,
    );
  });
  it('reads only declared manifests and treats a lone package-lock as no runtime dependencies', () => {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    expect(readWorkflowDependencyManifests(undefined)).toBeUndefined();
    expect(readWorkflowDependencyManifests(join(root, 'missing'))).toBeUndefined();
    writeFileSync(join(scriptsDir, 'package-lock.json'), '{}\n');
    expect(readWorkflowDependencyManifests(scriptsDir)).toBeUndefined();

    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy\n');
    const read = readWorkflowDependencyManifests(scriptsDir);
    expect(read?.['requirements.txt']?.toString()).toBe('numpy\n');
    expect(read?.['package-lock.json']?.toString()).toBe('{}\n');
    expect(read?.['package.json']).toBeUndefined();
  });

  it('rejects a manifest that is not a regular file', () => {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(join(scriptsDir, 'requirements.txt'), { recursive: true });
    expect(() => readWorkflowDependencyManifests(scriptsDir)).toThrow(/not a regular file/);
  });

  it('keys the base on the agent build and the exact manifest bytes, not on the run', () => {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir);
    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy\n');
    const read = readWorkflowDependencyManifests(scriptsDir);
    if (read === undefined) throw new Error('expected manifests');
    expect(computeWorkflowDependencyHash(AGENT_BUILD_HASH, scriptsDir)).toBe(
      computeWorkflowDependencyKey(AGENT_BUILD_HASH, read),
    );

    const a = planRun('run-a');
    const b = planRun('run-b');
    expect(pythonLayer(a).cacheKey).toBe(pythonLayer(b).cacheKey);
    expect(pythonLayer(a).baseDir).toBe(pythonLayer(b).baseDir);
    // Each run gets its own writable layer.
    expect(pythonLayer(a).hostDir).not.toBe(pythonLayer(b).hostDir);
    expect(nodeLayer(a).hostDir).not.toBe(nodeLayer(b).hostDir);

    const changed = planRun('run-a', manifests({ 'requirements.txt': Buffer.from('numpy\nscipy\n') }));
    expect(pythonLayer(changed).cacheKey).not.toBe(pythonLayer(a).cacheKey);
  });

  it('lays out the shared base under workflow-dependency-bases and each run layer under its workflow run', () => {
    const layers = planRun('run-a', manifests({ 'package-lock.json': Buffer.from('{"lockfileVersion":3}\n') }));
    const python = pythonLayer(layers);
    const node = nodeLayer(layers);
    const keyDir = python.cacheKey.slice(0, 24);

    expect(python.target).toBe(WORKFLOW_PYTHON_VENV_DIR);
    expect(node.target).toBe(WORKFLOW_NODE_MODULES_DIR);
    expect(python.cacheRoot).toBe(join(home, 'workflow-dependency-bases', keyDir));
    expect(python.baseDir).toBe(join(home, 'workflow-dependency-bases', keyDir, 'python-venv'));
    expect(python.hostDir).toBe(join(home, 'workflow-runs', 'run-a', 'deps', keyDir, 'python-venv'));
    expect(node.hostDir).toBe(join(home, 'workflow-runs', 'run-a', 'deps', keyDir, 'node_modules'));
    expect(layers.workflowNodeModulesMount?.hasPackageLock).toBe(true);
    // The provisioned record is a sibling of the base: outside every mount source.
    expect(provisionedRecordPath(python)).toBe(`${python.baseDir}.provisioned.json`);
    // Never the legacy shared-cache path that earlier versions mount read-write
    // into agent containers.
    for (const layer of listWorkflowDependencyLayers(layers)) {
      expect(isInside(layer.baseDir, join(home, 'workflow-deps'))).toBe(false);
      expect(isInside(layer.hostDir, join(home, 'workflow-deps'))).toBe(false);
    }
    // Planning is pure.
    expect(existsSync(join(home, 'workflow-dependency-bases'))).toBe(false);
  });

  it('refuses runtime dependencies that cannot be provisioned', () => {
    expect(() =>
      assertWorkflowDependencyProvisioningAvailable({ packageInstallEnabled: false, nestedDockerAdmitted: false }),
    ).toThrow(/packageInstall is disabled/);
    expect(() =>
      assertWorkflowDependencyProvisioningAvailable({ packageInstallEnabled: true, nestedDockerAdmitted: true }),
    ).toThrow(/not supported while nested Docker/);
    expect(() =>
      assertWorkflowDependencyProvisioningAvailable({ packageInstallEnabled: true, nestedDockerAdmitted: false }),
    ).not.toThrow();
  });

  it('builds install scripts that read only the hashed manifest mount and never hard-link into the base', () => {
    const python = buildWorkflowDependencyProvisionScript(pythonLayer(planRun('run-a')));
    expect(python).toContain(`uv venv ${WORKFLOW_PYTHON_VENV_DIR}`);
    expect(python).toContain(`uv pip install -r ${WORKFLOW_DEPENDENCY_MANIFESTS_DIR}/requirements.txt`);
    expect(python).toContain('UV_LINK_MODE=copy');

    const nodeWithoutLock = buildWorkflowDependencyProvisionScript(nodeLayer(planRun('run-a')));
    expect(nodeWithoutLock).toContain('npm install --omit=dev');
    expect(nodeWithoutLock).toContain(`cp -a node_modules/. ${WORKFLOW_NODE_MODULES_DIR}/`);
    const nodeWithLock = buildWorkflowDependencyProvisionScript(
      nodeLayer(planRun('run-a', manifests({ 'package-lock.json': Buffer.from('{}') }))),
    );
    expect(nodeWithLock).toContain('npm ci --omit=dev');
    expect(nodeWithLock).toContain(`${WORKFLOW_DEPENDENCY_MANIFESTS_DIR}/package-lock.json`);

    for (const script of [python, nodeWithoutLock, nodeWithLock]) {
      expect(script).not.toContain('/workspace');
      expect(script).not.toContain('/workflow-scripts');
    }
  });
});

describe('ensureWorkflowDependencyLayers', () => {
  it('provisions the base once and seeds an identical, independent run layer', async () => {
    const provisioner = fakeProvisioner();
    const layers = planRun('run-a', manifests({ 'package-lock.json': Buffer.from('{"lockfileVersion":3}\n') }));
    await ensureRun(layers, provisioner);

    // One provisioning pass for both kinds, fed the exact hashed manifest bytes.
    expect(provisioner.calls).toHaveLength(1);
    expect(provisioner.calls[0].kinds).toEqual(['python-venv', 'node_modules']);
    expect(provisioner.calls[0].manifestNames).toEqual(['package-lock.json', 'package.json', 'requirements.txt']);
    expect(provisioner.calls[0].manifestBytes['requirements.txt']).toBe('numpy\npyyaml\n');

    for (const layer of listWorkflowDependencyLayers(layers)) {
      const record = readRecord(layer);
      expect(record.cacheKey).toBe(layer.cacheKey);
      // The record describes the base exactly and lives outside every mount source.
      expect(record.digest).toBe(await digestOf(layer.baseDir));
      expect(isInside(provisionedRecordPath(layer), layer.baseDir)).toBe(false);
      expect(isInside(provisionedRecordPath(layer), layer.hostDir)).toBe(false);
      // The run layer is a faithful copy: content, modes and symlink targets.
      expect(await digestOf(layer.hostDir)).toBe(record.digest);
    }

    const python = pythonLayer(layers);
    // Symlinks are copied verbatim, not resolved to host paths.
    expect(readlinkSync(join(python.hostDir, 'bin', 'python'))).toBe('/usr/bin/python3');
    expect(readlinkSync(join(python.hostDir, 'bin', 'python3'))).toBe('python');
    expect(readlinkSync(join(nodeLayer(layers).hostDir, '.bin', 'ajv'))).toBe('../ajv/bin/ajv.js');
    expect(statSync(join(python.hostDir, 'bin', 'f2py')).mode & 0o777).toBe(0o755);
    expect(statSync(join(python.hostDir, SITE_PACKAGES, 'numpy', 'LICENSE.txt')).mode & 0o777).toBe(0o444);
    // Never hard links: writing the run layer in place must not reach the base.
    const baseFile = statSync(join(python.baseDir, SITE_PACKAGES, 'numpy', '__init__.py'));
    const layerFile = statSync(join(python.hostDir, SITE_PACKAGES, 'numpy', '__init__.py'));
    expect(layerFile.ino).not.toBe(baseFile.ino);
    expect(layerFile.nlink).toBe(1);
    // No staging or tombstone directories are left behind, and the lock is released.
    expect(readdirSync(dirname(python.hostDir)).sort()).toEqual(['node_modules', 'python-venv']);
    expect(existsSync(provisionLockPath(python.cacheRoot))).toBe(false);
  });

  it("isolates runs: run B sees the pristine base, not run A's modified package or planted .pth file", async () => {
    const provisioner = fakeProvisioner();
    const runA = planRun('run-a');
    await ensureRun(runA, provisioner);
    const pythonA = pythonLayer(runA);
    const recordBefore = readRecord(pythonA);

    // A compromised agent in run A tampers with its own writable layer.
    writeFileSync(join(pythonA.hostDir, SITE_PACKAGES, 'numpy', '__init__.py'), 'import os  # attacker\n');
    writeFileSync(join(pythonA.hostDir, SITE_PACKAGES, 'zz-evil.pth'), 'import os; os.system("id")\n');
    writeFileSync(join(nodeLayer(runA).hostDir, 'ajv', 'bin', 'ajv.js'), 'process.exit(0) // attacker\n');

    const runB = planRun('run-b');
    await ensureRun(runB, provisioner);
    const pythonB = pythonLayer(runB);

    // Same content key, no reprovisioning, and B's layer is the pristine base.
    expect(pythonB.cacheKey).toBe(pythonA.cacheKey);
    expect(provisioner.calls).toHaveLength(1);
    expect(existsSync(join(pythonB.hostDir, SITE_PACKAGES, 'zz-evil.pth'))).toBe(false);
    expect(readFileSync(join(pythonB.hostDir, SITE_PACKAGES, 'numpy', '__init__.py'), 'utf8')).toBe(
      '__version__ = "2.1.0"\n',
    );
    expect(readFileSync(join(nodeLayer(runB).hostDir, 'ajv', 'bin', 'ajv.js'), 'utf8')).toBe('#!/usr/bin/env node\n');
    expect(await digestOf(pythonB.hostDir)).toBe(recordBefore.digest);
    // The shared base itself was never touched by run A.
    expect(await digestOf(pythonA.baseDir)).toBe(recordBefore.digest);
    // Run A keeps its own (tampered) layer; isolation is per run.
    expect(existsSync(join(pythonA.hostDir, SITE_PACKAGES, 'zz-evil.pth'))).toBe(true);
  });

  it('keeps a run layer across resume, including packages installed into it', async () => {
    const provisioner = fakeProvisioner();
    const runA = planRun('run-a');
    await ensureRun(runA, provisioner);
    const pythonA = pythonLayer(runA);

    // evolve's provision state: `uv pip install scipy` into /opt/workflow-venv.
    mkdirSync(join(pythonA.hostDir, SITE_PACKAGES, 'scipy'));
    writeFileSync(join(pythonA.hostDir, SITE_PACKAGES, 'scipy', '__init__.py'), '__version__ = "1.14"\n');

    // Resume: a new bundle for the same workflow id plans the same layer.
    const resumed = planRun('run-a');
    expect(pythonLayer(resumed).hostDir).toBe(pythonA.hostDir);
    await ensureRun(resumed, provisioner);

    expect(provisioner.calls).toHaveLength(1);
    expect(readFileSync(join(pythonA.hostDir, SITE_PACKAGES, 'scipy', '__init__.py'), 'utf8')).toBe(
      '__version__ = "1.14"\n',
    );
  });

  it.each([
    [
      'a planted .pth file',
      (base: string) => writeFileSync(join(base, SITE_PACKAGES, 'zz-evil.pth'), 'import os; os.system("id")\n'),
    ],
    [
      'a modified package file',
      (base: string) => writeFileSync(join(base, SITE_PACKAGES, 'numpy', '__init__.py'), 'import os  # attacker\n'),
    ],
    ['a changed mode', (base: string) => chmodSync(join(base, SITE_PACKAGES, 'numpy', 'LICENSE.txt'), 0o666)],
    [
      'a replaced interpreter symlink',
      (base: string) => {
        rmSync(join(base, 'bin', 'python'));
        symlinkSync('/tmp/evil-python', join(base, 'bin', 'python'));
      },
    ],
    [
      'a deleted file',
      (base: string) => {
        rmSync(join(base, SITE_PACKAGES, 'yaml', '__init__.py'));
      },
    ],
  ])('detects %s in the base on disk and rebuilds it before seeding', async (_label, tamper) => {
    const provisioner = fakeProvisioner();
    await ensureRun(planRun('run-a'), provisioner);
    const runB = planRun('run-b');
    const pythonB = pythonLayer(runB);
    const pristine = readRecord(pythonB).digest;

    tamper(pythonB.baseDir);
    await ensureRun(runB, provisioner);

    // The tampering was detected, the python base rebuilt (node was intact), and
    // run B received the pristine content.
    expect(provisioner.calls).toHaveLength(2);
    expect(provisioner.calls[1].kinds).toEqual(['python-venv']);
    expect(await digestOf(pythonB.hostDir)).toBe(pristine);
    expect(await digestOf(pythonB.baseDir)).toBe(pristine);
    expect(existsSync(join(pythonB.baseDir, SITE_PACKAGES, 'zz-evil.pth'))).toBe(false);
    expect(readRecord(pythonB).digest).toBe(pristine);
  });

  it('never reads, mounts or deletes a legacy shared cache that an earlier version may still mount', async () => {
    const layers = planRun('run-a');
    const python = pythonLayer(layers);
    // Pre-record layout at the same key: earlier versions mounted this cache
    // read-write into every agent container of the workflow, and a daemon of
    // such a version may still be running and mounting it. Its in-tree
    // sentinel proves nothing, and an agent there can plant symlinks.
    const legacy = join(home, 'workflow-deps', python.cacheKey.slice(0, 24), 'python-venv');
    mkdirSync(join(legacy, SITE_PACKAGES), { recursive: true });
    writeFileSync(join(legacy, `.ironcurtain-provisioned-${python.cacheKey}`), '');
    writeFileSync(join(legacy, SITE_PACKAGES, 'zz-evil.pth'), 'import os\n');
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'precious'), 'keep\n');
    symlinkSync(join(root, 'outside'), join(legacy, 'escape'));
    const legacyBefore = await digestOf(legacy);

    const provisioner = fakeProvisioner();
    await ensureRun(layers, provisioner);

    // A fresh base was provisioned elsewhere and seeded into the run.
    expect(provisioner.calls).toHaveLength(1);
    expect(isInside(python.baseDir, join(home, 'workflow-deps'))).toBe(false);
    expect(existsSync(join(python.baseDir, SITE_PACKAGES, 'zz-evil.pth'))).toBe(false);
    expect(existsSync(join(python.hostDir, SITE_PACKAGES, 'zz-evil.pth'))).toBe(false);
    expect(existsSync(join(python.hostDir, `.ironcurtain-provisioned-${python.cacheKey}`))).toBe(false);
    expect(await digestOf(python.hostDir)).toBe(readRecord(python).digest);
    // The legacy tree is left exactly as it was (deleting it on the host would
    // race an agent that can still write it), and nothing it links to is touched.
    expect(await digestOf(legacy)).toBe(legacyBefore);
    expect(readFileSync(join(root, 'outside', 'precious'), 'utf8')).toBe('keep\n');
    expect(readdirSync(dirname(legacy))).toEqual(['python-venv']);
  });

  it('discards and rebuilds a base left without a record, read-only directories included', async () => {
    const layers = planRun('run-a');
    const python = pythonLayer(layers);
    // A crash mid-provisioning leaves a partial base and no record.
    mkdirSync(join(python.baseDir, SITE_PACKAGES), { recursive: true });
    writeFileSync(join(python.baseDir, SITE_PACKAGES, 'partial.py'), 'x = 1\n');
    mkdirSync(join(python.baseDir, 'readonly', 'inner'), { recursive: true });
    writeFileSync(join(python.baseDir, 'readonly', 'inner', 'file'), 'ro\n');
    chmodSync(join(python.baseDir, 'readonly', 'inner'), 0o555);
    chmodSync(join(python.baseDir, 'readonly'), 0o555);

    const provisioner = fakeProvisioner();
    await ensureRun(layers, provisioner);

    expect(provisioner.calls).toHaveLength(1);
    expect(existsSync(join(python.baseDir, SITE_PACKAGES, 'partial.py'))).toBe(false);
    expect(existsSync(join(python.baseDir, 'readonly'))).toBe(false);
    expect(await digestOf(python.hostDir)).toBe(readRecord(python).digest);
    // The partial tree was removed, not just moved aside.
    expect(readdirSync(python.cacheRoot).filter((name) => name.startsWith('.discard-'))).toEqual([]);
  });

  it('rebuilds when the record is corrupt or describes a different key', async () => {
    const provisioner = fakeProvisioner();
    const layers = planRun('run-a');
    await ensureRun(layers, provisioner);
    const python = pythonLayer(layers);

    writeFileSync(provisionedRecordPath(python), '{"schemaVersion":1}', { mode: 0o600 });
    const runB = planRun('run-b');
    await ensureRun(runB, provisioner);
    expect(provisioner.calls).toHaveLength(2);
    expect(provisioner.calls[1].kinds).toEqual(['python-venv']);
    expect(await digestOf(pythonLayer(runB).hostDir)).toBe(readRecord(python).digest);
  });

  it('serializes concurrent runs of one key so the base is provisioned exactly once', async () => {
    const provisioner = fakeProvisioner();
    const runs = ['run-a', 'run-b', 'run-c'].map((id) => planRun(id));
    await Promise.all(runs.map((layers) => ensureRun(layers, provisioner)));

    expect(provisioner.calls).toHaveLength(1);
    const digest = readRecord(pythonLayer(runs[0])).digest;
    for (const layers of runs) {
      expect(await digestOf(pythonLayer(layers).hostDir)).toBe(digest);
    }
  });

  it('records nothing and seeds nothing when provisioning fails, then retries on the next run', async () => {
    const layers = planRun('run-a');
    const failing = async (): Promise<void> => {
      await Promise.resolve();
      throw new Error('uv pip install failed: 403 from registry proxy');
    };
    await expect(ensureWorkflowDependencyLayers(listWorkflowDependencyLayers(layers), failing)).rejects.toThrow(
      /403 from registry proxy/,
    );
    for (const layer of listWorkflowDependencyLayers(layers)) {
      expect(existsSync(provisionedRecordPath(layer))).toBe(false);
      expect(existsSync(layer.hostDir)).toBe(false);
    }
    expect(existsSync(provisionLockPath(pythonLayer(layers).cacheRoot))).toBe(false);

    const provisioner = fakeProvisioner();
    await ensureRun(layers, provisioner);
    expect(provisioner.calls).toHaveLength(1);
    expect(existsSync(pythonLayer(layers).hostDir)).toBe(true);
  });

  it('fails closed when the provisioned base contains a file type it cannot verify', async () => {
    const layers = planRun('run-a');
    const provisioner = fakeProvisioner((layer, dir) => {
      if (layer.kind === 'python-venv') execFileSync('mkfifo', [join(dir, 'pipe')]);
    });
    await expect(ensureRun(layers, provisioner)).rejects.toThrow(/unsupported file type/);
    expect(existsSync(provisionedRecordPath(pythonLayer(layers)))).toBe(false);
    expect(existsSync(pythonLayer(layers).hostDir)).toBe(false);
  });

  it('refuses a run layer path that is a symlink', async () => {
    const layers = planRun('run-a');
    const python = pythonLayer(layers);
    mkdirSync(dirname(python.hostDir), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), python.hostDir);
    await expect(ensureRun(layers, fakeProvisioner())).rejects.toThrow(/not a real directory/);
  });

  it('accepts a relocated bases root but refuses a symlinked key directory', async () => {
    // The operator may move workflow-dependency-bases to another disk with a symlink.
    mkdirSync(join(root, 'bigdisk'));
    symlinkSync(join(root, 'bigdisk'), join(home, 'workflow-dependency-bases'));
    const layers = planRun('run-a');
    await ensureRun(layers, fakeProvisioner());
    expect(readdirSync(join(root, 'bigdisk'))).toContain(pythonLayer(layers).cacheKey.slice(0, 24));

    // A symlink at the key directory itself could redirect the base anywhere.
    const other = planRun('run-b', manifests({ 'requirements.txt': Buffer.from('scipy\n') }));
    mkdirSync(join(root, 'redirect'));
    symlinkSync(join(root, 'redirect'), pythonLayer(other).cacheRoot);
    await expect(ensureRun(other, fakeProvisioner())).rejects.toThrow(/not a real directory/);
    expect(readdirSync(join(root, 'redirect'))).toEqual([]);
  });

  it('keeps the base directory itself out of every run layer path', () => {
    const layers = planRun('run-a');
    for (const layer of listWorkflowDependencyLayers(layers)) {
      expect(isInside(layer.hostDir, layer.cacheRoot)).toBe(false);
      expect(isInside(layer.baseDir, dirname(layer.hostDir))).toBe(false);
    }
  });

  it('records when a run last used the base, for retention', async () => {
    const before = Date.now();
    const layers = planRun('run-a');
    await ensureRun(layers, fakeProvisioner());
    const keyDir = pythonLayer(layers).cacheRoot;
    const marker = JSON.parse(readFileSync(join(keyDir, WORKFLOW_DEPENDENCY_LAST_USED_FILE), 'utf8')) as {
      schemaVersion: number;
      lastUsedAt: string;
    };
    expect(marker.schemaVersion).toBe(1);
    const lastUsed = readWorkflowDependencyLastUsed(keyDir);
    expect(lastUsed).toBeGreaterThanOrEqual(before - 1000);
    expect(lastUsed).toBeLessThanOrEqual(Date.now() + 1000);

    // A later run seeding from the same base records its use again.
    writeFileSync(
      join(keyDir, WORKFLOW_DEPENDENCY_LAST_USED_FILE),
      JSON.stringify({ schemaVersion: 1, lastUsedAt: '2020-01-01T00:00:00.000Z' }),
    );
    await ensureRun(planRun('run-b'), fakeProvisioner());
    expect(readWorkflowDependencyLastUsed(keyDir)).toBeGreaterThanOrEqual(before - 1000);
    // A missing or malformed marker reads as unknown.
    writeFileSync(join(keyDir, WORKFLOW_DEPENDENCY_LAST_USED_FILE), '{"schemaVersion":2}');
    expect(readWorkflowDependencyLastUsed(keyDir)).toBeUndefined();
  });

  it('re-creates a key directory that retention removed while the run waited for the lock', async () => {
    const layers = planRun('run-a');
    const keyDir = pythonLayer(layers).cacheRoot;
    mkdirSync(dirname(keyDir), { recursive: true });
    const held = tryAcquireProvisionLock(keyDir);
    if (held === undefined) throw new Error('expected to hold the provisioning lock');
    const provisioner = fakeProvisioner();
    const ensured = ensureRun(layers, provisioner);
    // The run created the key directory and now waits; a prune removes it under the lock.
    expect(existsSync(keyDir)).toBe(true);
    rmSync(keyDir, { recursive: true, force: true });
    held.release();
    await ensured;
    expect(provisioner.calls).toHaveLength(1);
    expect(existsSync(provisionedRecordPath(pythonLayer(layers)))).toBe(true);
    expect(await digestOf(pythonLayer(layers).hostDir)).toBe(readRecord(pythonLayer(layers)).digest);
  });
});
