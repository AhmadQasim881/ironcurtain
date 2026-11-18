import { testUserConfig } from '../helpers/user-config.js';
import { USER_CONFIG_DEFAULTS } from '../../src/config/user-config.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { REAL_TMP, testCompiledPolicy, testToolAnnotations } from '../fixtures/test-policy.js';
import { isDockerAvailable, isDockerImageAvailable } from '../helpers/docker-available.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';
import {
  buildWorkflowExecCommand,
  createDockerInfrastructure,
  destroyDockerInfrastructure,
  type DockerInfrastructure,
} from '../../src/docker/docker-infrastructure.js';
import {
  buildDependencyTreeManifest,
  provisionedRecordPath,
  type WorkflowDependencyLayer,
} from '../../src/docker/workflow-dependency-cache.js';
import type { DockerExecResult } from '../../src/docker/types.js';
import type { BundleId } from '../../src/session/types.js';
import type { WorkflowId } from '../../src/workflow/types.js';
import { RUN_SCRIPTS_DIRNAME } from '../../src/workflow/checkpoint.js';

const execFile = promisify(execFileCb);

const IMAGE = 'ironcurtain-claude-code:latest';
const TEST_HOME = `${REAL_TMP}/ironcurtain-workflow-runtime-deps-${process.pid}`;

function findHostCaDir(): string | null {
  const home = process.env.IRONCURTAIN_HOME ?? join(homedir(), '.ironcurtain');
  const ca = join(home, 'ca');
  return existsSync(ca) ? ca : null;
}

const hostCaDir = findHostCaDir();
const dockerReady =
  process.env.INTEGRATION_TEST === '1' && isDockerAvailable() && isDockerImageAvailable(IMAGE) && hostCaDir !== null;

function buildDockerSessionConfig(workspaceDir: string, generatedDir: string): IronCurtainConfig {
  return {
    auditLogPath: join(workspaceDir, 'audit.jsonl'),
    allowedDirectory: workspaceDir,
    mcpServers: {},
    protectedPaths: [],
    generatedDir,
    constitutionPath: join(generatedDir, 'constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: testUserConfig({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-fake-key-no-network',
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 100,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      auditRedaction: { enabled: false },
      packageInstall: { enabled: true, quarantineDays: 2, allowedPackages: ['numpy', 'six'], deniedPackages: [] },
      dockerResources: { ...USER_CONFIG_DEFAULTS.dockerResources, memoryMb: null, cpus: null },
      containerRuntime: 'docker',
    }),
  };
}

async function workflowImageTags(): Promise<Set<string>> {
  const { stdout } = await execFile('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  return new Set(stdout.split('\n').filter((line) => line.startsWith('ironcurtain-wf-')));
}

async function containerConfigImage(containerId: string): Promise<string> {
  const { stdout } = await execFile('docker', ['inspect', '-f', '{{.Config.Image}}', containerId]);
  return stdout.trim();
}

interface InspectedMount {
  readonly Source: string;
  readonly Destination: string;
  readonly RW: boolean;
}

async function containerMounts(containerId: string): Promise<readonly InspectedMount[]> {
  const { stdout } = await execFile('docker', ['inspect', '-f', '{{json .Mounts}}', containerId]);
  return JSON.parse(stdout) as InspectedMount[];
}

async function containerEnv(containerId: string): Promise<readonly string[]> {
  const { stdout } = await execFile('docker', ['inspect', '-f', '{{json .Config.Env}}', containerId]);
  return JSON.parse(stdout) as string[];
}

async function leftoverProvisioners(): Promise<string> {
  const { stdout } = await execFile('docker', [
    'ps',
    '-a',
    '--filter',
    'name=ironcurtain-deps-',
    '--format',
    '{{.ID}}',
  ]);
  return stdout.trim();
}

async function readPackageAudit(bundleDir: string): Promise<readonly Record<string, unknown>[]> {
  const auditPath = resolve(bundleDir, 'package-audit.jsonl');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(auditPath)) {
      const lines = readFileSync(auditPath, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 0) {
        return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      }
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
  }
  return [];
}

function pythonLayerOf(bundle: DockerInfrastructure): WorkflowDependencyLayer {
  const layer = bundle.workflowPythonVenvMount;
  if (layer === undefined) throw new Error('bundle has no Python dependency layer');
  return layer;
}

/** The base's site-packages directory on the host (python3.X varies by image). */
function hostSitePackages(venvDir: string): string {
  const lib = join(venvDir, 'lib');
  const python = readdirSync(lib).find((name) => name.startsWith('python3'));
  if (python === undefined) throw new Error(`no python3.X directory under ${lib}`);
  return join(lib, python, 'site-packages');
}

describe.skipIf(!dockerReady)('workflow runtime dependency provisioning with real Docker', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAuth: string | undefined;
  let originalApiKey: string | undefined;
  const liveBundles = new Set<DockerInfrastructure>();

  beforeAll(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    originalAuth = process.env.IRONCURTAIN_DOCKER_AUTH;
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.IRONCURTAIN_HOME = TEST_HOME;
    process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';
    process.env.ANTHROPIC_API_KEY = 'test-fake-key-no-network';
    mkdirSync(TEST_HOME, { recursive: true });
    cpSync(hostCaDir as string, join(TEST_HOME, 'ca'), { recursive: true });
  });

  async function drainBundles(): Promise<void> {
    const bundles = [...liveBundles];
    const results = await Promise.allSettled(
      bundles.map(async (bundle) => {
        await destroyDockerInfrastructure(bundle);
        liveBundles.delete(bundle);
      }),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Bundle cleanup failed',
      );
  }

  afterAll(async () => {
    await drainBundles();

    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    if (originalAuth === undefined) delete process.env.IRONCURTAIN_DOCKER_AUTH;
    else process.env.IRONCURTAIN_DOCKER_AUTH = originalAuth;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;

    rmSync(TEST_HOME, { recursive: true, force: true });
  }, 120_000);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-runtime-deps-'));
  });

  // Drain containers before removing their bind-mounted workspace. Stop/remove
  // phases have their own bounds; allow cleanup overhead across retained bundles.
  afterEach(async () => {
    await drainBundles();
    rmSync(tmpDir, { recursive: true, force: true });
  }, 120_000);

  /** Stands up one workflow bundle whose staged scripts carry `requirements`. */
  async function makeBundle(label: string, workflowId: string, requirements: string): Promise<DockerInfrastructure> {
    const workspaceDir = resolve(tmpDir, `workspace-${label}`);
    const generatedDir = resolve(TEST_HOME, 'generated');
    const bundleDir = resolve(TEST_HOME, 'bundles', label);
    const escalationDir = resolve(bundleDir, 'escalations');
    const workflowRunDir = resolve(TEST_HOME, 'workflow-runs', workflowId);
    const scriptsDir = resolve(workflowRunDir, RUN_SCRIPTS_DIRNAME);
    for (const dir of [workspaceDir, generatedDir, bundleDir, escalationDir, scriptsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
    writeFileSync(resolve(scriptsDir, 'requirements.txt'), requirements);

    const bundle = await createDockerInfrastructure(
      buildDockerSessionConfig(workspaceDir, generatedDir),
      { kind: 'docker', agent: 'claude-code' as AgentId },
      bundleDir,
      workspaceDir,
      escalationDir,
      `${label}-bundle` as BundleId,
      workflowId as WorkflowId,
      'primary',
      [],
      undefined,
      scriptsDir,
      { workflowRunDir },
    );
    liveBundles.add(bundle);
    return bundle;
  }

  async function destroyBundle(bundle: DockerInfrastructure): Promise<void> {
    await destroyDockerInfrastructure(bundle);
    liveBundles.delete(bundle);
  }

  function execIn(bundle: DockerInfrastructure, command: readonly string[]): Promise<DockerExecResult> {
    return bundle.docker.exec(bundle.containerId, command, 300_000, 'codespace', '/workspace');
  }

  async function purelib(bundle: DockerInfrastructure): Promise<string> {
    const result = await execIn(bundle, [
      '/opt/workflow-venv/bin/python',
      '-c',
      'import sysconfig; print(sysconfig.get_paths()["purelib"])',
    ]);
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  }

  it('installs requirements in a dedicated provisioner and mounts only the run layer into the agent', async () => {
    const beforeImages = await workflowImageTags();
    const bundle = await makeBundle('runtime-deps', 'wf-runtime-deps', 'numpy\n');
    const layer = pythonLayerOf(bundle);

    // Containers are created from the exact build tag; IMAGE is its moving alias.
    expect(bundle.image).toMatch(/^ironcurtain-claude-code:build-[0-9a-f]{16}$/u);
    expect(await containerConfigImage(bundle.containerId)).toBe(bundle.image);

    const importResult = await execIn(bundle, [
      '/opt/workflow-venv/bin/python',
      '-c',
      'import numpy; print(numpy.__version__)',
    ]);
    expect(importResult.exitCode).toBe(0);
    expect(importResult.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const afterImages = await workflowImageTags();
    expect([...afterImages].filter((tag) => !beforeImages.has(tag))).toEqual([]);

    const audit = await readPackageAudit(bundle.bundleDir);
    expect(
      audit.some(
        (entry) =>
          entry.registry === 'pypi' &&
          entry.packageName === 'numpy' &&
          entry.decision === 'allow' &&
          (entry.source === 'metadata-filter' || entry.source === 'tarball-backstop'),
      ),
    ).toBe(true);

    // The agent container mounts this run's layer read-write and never the
    // shared base; the short-lived provisioner is gone.
    const mounts = await containerMounts(bundle.containerId);
    expect(mounts.find((mount) => mount.Destination === '/opt/workflow-venv')).toMatchObject({
      Source: layer.hostDir,
      RW: true,
    });
    expect(
      mounts.some(
        (mount) =>
          mount.Source.startsWith(resolve(TEST_HOME, 'workflow-dependency-bases')) ||
          mount.Source.startsWith(resolve(TEST_HOME, 'workflow-deps')),
      ),
    ).toBe(false);
    expect(await leftoverProvisioners()).toBe('');
    // NODE_PATH is never set container-wide.
    expect((await containerEnv(bundle.containerId)).some((entry) => entry.startsWith('NODE_PATH='))).toBe(false);
    // The host-side record describes the base exactly.
    const record = JSON.parse(readFileSync(provisionedRecordPath(layer), 'utf8')) as { digest: string };
    expect((await buildDependencyTreeManifest(layer.baseDir)).digest).toBe(record.digest);

    // A bare `node` invocation must resolve from the container's real PATH
    // (the venv bin is prepended at exec time, the image PATH is preserved).
    const nodeVersion = await execIn(bundle, buildWorkflowExecCommand(bundle, ['node', '--version']));
    expect(nodeVersion.exitCode).toBe(0);
    expect(nodeVersion.stdout.trim()).toMatch(/^v\d+/);
  }, 600_000);

  it("isolates runs of one workflow: run B sees the pristine base, not run A's tampering", async () => {
    const runA = await makeBundle('iso-a', 'wf-iso-a', 'numpy\nsix\n');
    const layerA = pythonLayerOf(runA);
    const siteA = await purelib(runA);

    // A compromised agent in run A patches a package and plants a .pth file
    // (payloads passed as argv, so no shell quoting is involved).
    const tamper = await execIn(runA, [
      '/opt/workflow-venv/bin/python',
      '-c',
      [
        'import pathlib, sys',
        'site = pathlib.Path(sys.argv[1])',
        'open(site / "six.py", "a").write(sys.argv[2])',
        '(site / "zz-evil.pth").write_text(sys.argv[3])',
      ].join('\n'),
      siteA,
      '\nPWNED_MARKER = 1\n',
      'import sys; sys.stderr.write("PWNED" + chr(10))\n',
    ]);
    expect(tamper.exitCode).toBe(0);
    const poisoned = await execIn(runA, ['/opt/workflow-venv/bin/python', '-c', 'import six; print(six.PWNED_MARKER)']);
    expect(poisoned.stdout.trim()).toBe('1');
    expect(poisoned.stderr).toContain('PWNED');

    // Run B of the same workflow: same content key, its own fresh layer.
    const runB = await makeBundle('iso-b', 'wf-iso-b', 'numpy\nsix\n');
    const layerB = pythonLayerOf(runB);
    expect(layerB.cacheKey).toBe(layerA.cacheKey);
    expect(layerB.baseDir).toBe(layerA.baseDir);
    expect(layerB.hostDir).not.toBe(layerA.hostDir);

    const clean = await execIn(runB, [
      '/opt/workflow-venv/bin/python',
      '-c',
      'import six; print(hasattr(six, "PWNED_MARKER"))',
    ]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout.trim()).toBe('False');
    expect(clean.stderr).not.toContain('PWNED');
    expect(existsSync(join(hostSitePackages(layerB.hostDir), 'zz-evil.pth'))).toBe(false);
    // The shared base still matches its record.
    const record = JSON.parse(readFileSync(provisionedRecordPath(layerA), 'utf8')) as { digest: string };
    expect((await buildDependencyTreeManifest(layerA.baseDir)).digest).toBe(record.digest);
  }, 600_000);

  it('detects tampering with the base on disk and rebuilds it before the next run uses it', async () => {
    const first = await makeBundle('tamper-a', 'wf-tamper-a', 'numpy\n');
    const layer = pythonLayerOf(first);
    const before = JSON.parse(readFileSync(provisionedRecordPath(layer), 'utf8')) as {
      digest: string;
      provisionedAt: string;
    };

    writeFileSync(join(hostSitePackages(layer.baseDir), 'zz-evil.pth'), 'import sys; sys.stderr.write("PWNED\\n")\n');

    const next = await makeBundle('tamper-b', 'wf-tamper-b', 'numpy\n');
    const after = JSON.parse(readFileSync(provisionedRecordPath(layer), 'utf8')) as { provisionedAt: string };
    expect(after.provisionedAt).not.toBe(before.provisionedAt);
    expect(existsSync(join(hostSitePackages(layer.baseDir), 'zz-evil.pth'))).toBe(false);
    expect(existsSync(join(hostSitePackages(pythonLayerOf(next).hostDir), 'zz-evil.pth'))).toBe(false);

    const result = await execIn(next, ['/opt/workflow-venv/bin/python', '-c', 'import numpy; print("ok")']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('PWNED');
  }, 900_000);

  it("keeps the run's own installs into /opt/workflow-venv across resume (evolve provision state)", async () => {
    const original = await makeBundle('resume-a', 'wf-resume', 'numpy\n');
    const layer = pythonLayerOf(original);

    // What evolve's provision agent does: install an experiment dependency.
    const install = await execIn(original, [
      '/bin/sh',
      '-lc',
      'UV_NATIVE_TLS=1 VIRTUAL_ENV=/opt/workflow-venv uv pip install six',
    ]);
    expect(install.exitCode, install.stderr).toBe(0);
    await destroyBundle(original);

    // Resume mints a fresh bundle for the same workflow id.
    const resumed = await makeBundle('resume-b', 'wf-resume', 'numpy\n');
    expect(pythonLayerOf(resumed).hostDir).toBe(layer.hostDir);
    const result = await execIn(resumed, ['/opt/workflow-venv/bin/python', '-c', 'import numpy, six; print("ok")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');

    // Another run of the workflow does not see that install.
    const other = await makeBundle('resume-other', 'wf-resume-other', 'numpy\n');
    const isolated = await execIn(other, ['/opt/workflow-venv/bin/python', '-c', 'import six']);
    expect(isolated.exitCode).not.toBe(0);
  }, 900_000);
});
