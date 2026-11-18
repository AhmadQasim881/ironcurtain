/**
 * Tests for `ironcurtain doctor`.
 *
 * Two layers:
 *   - Pure unit tests for each check function (no IO unless mocked).
 *   - Integration smoke test that drives `runDoctorCommand([])` against a
 *     tmpdir IRONCURTAIN_HOME and asserts exit-code propagation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import chalk from 'chalk';

// Module mocks for the OAuth-refresh and API-round-trip unit tests below.
// `vi.fn(actual.fn)` keeps default behavior intact so the integration-style
// tests in `describe('runDoctorCommand', ...)` still hit the real impls;
// individual unit tests override with `mockResolvedValueOnce` / `mockReturnValueOnce`.
vi.mock('../src/docker/oauth-credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/docker/oauth-credentials.js')>();
  return {
    ...actual,
    detectAuthMethod: vi.fn(actual.detectAuthMethod),
    refreshOAuthToken: vi.fn(actual.refreshOAuthToken),
    saveOAuthCredentials: vi.fn(actual.saveOAuthCredentials),
    writeToKeychain: vi.fn(actual.writeToKeychain),
  };
});
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(actual.generateText) };
});
vi.mock('../src/config/model-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/model-provider.js')>();
  return { ...actual, createLanguageModel: vi.fn(actual.createLanguageModel) };
});
// The memory-models check runs the bundled memory server. The doctor runs
// below get a runner that reports both models verified; the checkMemoryModels
// unit tests pass their own.
vi.mock('../src/memory/memory-models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/memory/memory-models.js')>();
  return {
    ...actual,
    runMemoryModelsTool: vi.fn(async (): Promise<MemoryModelsResult> => ({
      kind: 'report',
      exitCode: 0,
      report: {
        action: 'verify',
        modelsDir: '/home/u/.ironcurtain/models',
        offline: false,
        models: [
          { role: 'embedding', repo: 'Xenova/bge-base-en-v1.5', dtype: 'q8', status: 'ok' },
          { role: 'reranker', repo: 'Xenova/ms-marco-MiniLM-L-6-v2', dtype: 'q8', status: 'ok' },
        ],
      },
    })),
  };
});

import {
  checkActiveRuntime,
  checkAnnotationDrift,
  checkAppleContainer,
  checkConstitutionDrift,
  checkDocker,
  checkDockerResources,
  checkDockerUserNamespace,
  checkHostIdentityForLinuxDocker,
  checkMcpServerLiveness,
  checkMemoryModels,
  checkNodePty,
  checkNodeVersion,
  checkOsSandbox,
  checkPreferredMode,
  checkRosetta,
  checkServerCredentials,
  collectDeclaredEnvVars,
  type CheckResult,
} from '../src/doctor/checks.js';
import type { AgentId } from '../src/docker/agent-adapter.js';
import { classifyDockerUserNamespace, type DockerAvailability } from '../src/docker/docker-probe.js';
import { ROOT_HOST_IDENTITY_MESSAGE } from '../src/docker/container-identity.js';
import type { ProbeResult, ServerProbe } from '../src/doctor/mcp-liveness.js';
import {
  getOsSandboxAvailability,
  type OsSandboxAvailability,
  type OsSandboxSmokeResult,
} from '../src/trusted-process/sandbox-integration.js';
import { checkContainerAgentCredentials, checkModelCredentials } from '../src/doctor/model-credential-checks.js';
import { resolveProviderProfile } from '../src/config/user-config.js';
import {
  checkAnthropicOAuthToken,
  checkCodexCredentials,
  checkOAuthProviderRefresh,
  checkOAuthProviders,
  checkOAuthProviderTokens,
} from '../src/doctor/oauth-checks.js';
import { VERSION } from '../src/version.js';
import type { IronCurtainConfig, MCPServerConfig } from '../src/config/types.js';
import type { StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import { testUserConfig } from './helpers/user-config.js';
import {
  detectAuthMethod,
  refreshOAuthToken,
  saveOAuthCredentials,
  writeToKeychain,
} from '../src/docker/oauth-credentials.js';
import { generateText } from 'ai';
import { createLanguageModel } from '../src/config/model-provider.js';
import {
  runMemoryModelsTool,
  type MemoryModelsReport,
  type MemoryModelsResult,
  type MemoryModelsRunner,
} from '../src/memory/memory-models.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Captures stdout/stderr writes (and console.error) and suppresses process.exit. */
async function captureOutput(fn: () => Promise<void>): Promise<{ output: string; exitCode: number | undefined }> {
  const writes: string[] = [];
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;
  const origConsoleError = console.error;
  process.stdout.write = (chunk: string) => {
    writes.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string) => {
    writes.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  console.error = ((...args: unknown[]) => {
    writes.push(args.map(String).join(' ') + '\n');
  }) as typeof console.error;

  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = (code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code ?? 0}`);
  };

  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('__exit_')) {
      throw err;
    }
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    console.error = origConsoleError;
    process.exit = origExit;
  }
  return { output: writes.join(''), exitCode };
}

function buildServerConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    command: 'true',
    args: [],
    ...overrides,
  };
}

function buildConfig(overrides: Partial<IronCurtainConfig> = {}): IronCurtainConfig {
  const userConfigStub = testUserConfig({
    autoCompact: { enabled: true, thresholdTokens: 100_000, keepRecentMessages: 10, summaryModelId: 'anthropic:m' },
    autoApprove: { enabled: false, modelId: 'anthropic:m' },
    memory: { enabled: true, autoSave: true, llmBaseUrl: undefined, llmApiKey: undefined, offlineModels: false },
    gooseModel: 'claude',
    packageInstall: { enabled: true, quarantineDays: 2, allowedPackages: [], deniedPackages: [] },
    dockerResources: { memoryMb: 8192, cpus: 4, pidsLimit: 4096 },
  });
  return {
    auditLogPath: '/tmp/audit.jsonl',
    allowedDirectory: '/tmp',
    mcpServers: {},
    protectedPaths: [],
    generatedDir: '/tmp/generated',
    constitutionPath: '/tmp/constitution.md',
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: userConfigStub,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit: checkNodeVersion
// ---------------------------------------------------------------------------

describe('checkNodeVersion', () => {
  it('passes for supported (even-numbered) major versions', () => {
    expect(checkNodeVersion('24.0.0').status).toBe('ok');
    expect(checkNodeVersion('26.0.0').status).toBe('ok');
  });

  it('fails for unsupported odd-numbered major versions', () => {
    expect(checkNodeVersion('25.0.0').status).toBe('fail');
  });

  it('fails for too-old major version', () => {
    const result = checkNodeVersion('20.10.0');
    expect(result.status).toBe('fail');
    expect(result.hint).toMatch(/24 or 26/);
  });

  it('fails for too-new major version', () => {
    const result = checkNodeVersion('27.0.0');
    expect(result.status).toBe('fail');
  });

  it('fails for unparseable input', () => {
    expect(checkNodeVersion('not-a-version').status).toBe('fail');
  });

  it('does not claim prebuilt isolated-vm binaries everywhere: Intel Macs compile it', () => {
    const hint = checkNodeVersion('25.0.0').hint ?? '';
    expect(hint).not.toMatch(/both use prebuilt/);
    expect(hint).toMatch(/Intel Macs/);
  });
});

// ---------------------------------------------------------------------------
// Unit: checkNodePty (BLD-10)
// ---------------------------------------------------------------------------

describe('checkNodePty', () => {
  it('reports a node-pty that loads, with its version', async () => {
    const result = await checkNodePty(async () => ({ status: 'ok', version: '1.1.0' }));
    expect(result).toEqual({ name: 'node-pty', status: 'ok', message: 'loads (1.1.0)' });
  });

  it('warns (node-pty is optional) with build tools and a global-install rebuild when it is installed but cannot load', async () => {
    const result = await checkNodePty(async () => ({
      status: 'unavailable',
      detail: 'Failed to load native module: pty.node,\nchecked: build/Release, build/Debug, prebuilds/linux-x64',
      installed: true,
    }));
    expect(result.status).toBe('warn');
    expect(result.message).toBe(
      'cannot be loaded: Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64',
    );
    expect(result.hint).toContain('ironcurtain mux, the web UI terminal and Apple Container interactive sessions');
    expect(result.hint).toContain('npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false');
    expect(result.hint).not.toContain('npm install node-pty');
  });

  it('tells the user to reinstall when npm deleted node-pty after its build failed', async () => {
    // Nothing is left for `npm rebuild node-pty` to rebuild.
    const result = await checkNodePty(async () => ({
      status: 'unavailable',
      detail: "Cannot find package 'node-pty' imported from /usr/lib/node_modules/@provos/ironcurtain/dist/pty",
      installed: false,
    }));
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/^is not installed: Cannot find package 'node-pty'/);
    expect(result.hint).toContain('npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty');
    expect(result.hint).not.toContain('npm rebuild');
  });

  it('warns about a spawn-helper without the execute bit, which it does not repair', async () => {
    const result = await checkNodePty(async () => ({
      status: 'spawn-helper-not-executable',
      helperPath: '/opt/ic/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    }));
    expect(result.status).toBe('warn');
    expect(result.message).toContain('spawn-helper is not executable');
    expect(result.hint).toContain('chmod +x "/opt/ic/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"');
  });

  it('sanitizes the loader error for the terminal', async () => {
    const result = await checkNodePty(async () => ({
      status: 'unavailable',
      detail: 'bad \u001b[31mred\u001b[0m',
      installed: true,
    }));
    expect(result.message).not.toContain('\u001b');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkDocker
// ---------------------------------------------------------------------------

describe('checkDocker', () => {
  it('returns ok when Docker is available', async () => {
    const result = await checkDocker(async () => ({ available: true }));
    expect(result.status).toBe('ok');
    expect(result.message).toBe('running');
  });

  it('returns warn when Docker is unavailable', async () => {
    const result = await checkDocker(async () => ({
      available: false,
      reason: 'not found',
      detailedMessage: 'docker: command not found',
    }));
    expect(result.status).toBe('warn');
    expect(result.hint).toBe('docker: command not found');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkAppleContainer / checkRosetta / checkActiveRuntime
// ---------------------------------------------------------------------------

describe('checkAppleContainer', () => {
  it('skips on non-applicable platforms without probing', async () => {
    const probe = vi.fn();
    const r = await checkAppleContainer(probe, 'linux', 'arm64');
    expect(r.status).toBe('skip');
    expect(probe).not.toHaveBeenCalled();

    const r2 = await checkAppleContainer(probe, 'darwin', 'x64');
    expect(r2.status).toBe('skip');
  });

  it('returns ok when the runtime is available', async () => {
    const r = await checkAppleContainer(async () => ({ available: true }), 'darwin', 'arm64');
    expect(r.status).toBe('ok');
    expect(r.message).toBe('running');
  });

  it('warns with the remediation hint when the CLI/services are not ready', async () => {
    const r = await checkAppleContainer(
      async () => ({
        available: false,
        reason: 'container services not running',
        detailedMessage: 'Start it with `container system start`.',
      }),
      'darwin',
      'arm64',
    );
    expect(r.status).toBe('warn');
    expect(r.hint).toContain('container system start');
  });
});

describe('checkRosetta', () => {
  it('ok when the x86_64 probe runs', () => {
    expect(checkRosetta(() => true).status).toBe('ok');
  });

  it('warns with the softwareupdate hint when it does not', () => {
    const r = checkRosetta(() => false);
    expect(r.status).toBe('warn');
    expect(r.hint).toContain('softwareupdate --install-rosetta');
  });
});

describe('checkActiveRuntime', () => {
  const dockerAvail: CheckResult = { name: 'Docker', status: 'ok', message: 'running' };
  const appleAvail: CheckResult = { name: 'Apple container', status: 'ok', message: 'running' };

  function configWithRuntime(containerRuntime: 'docker' | 'apple-container' | 'auto') {
    return buildConfig({
      userConfig: { ...buildConfig().userConfig, containerRuntime },
    });
  }

  afterEach(() => {
    delete process.env.IRONCURTAIN_CONTAINER_RUNTIME;
  });

  it('pairs an explicit docker config with the Docker availability result', async () => {
    const r = await checkActiveRuntime(configWithRuntime('docker'), dockerAvail, appleAvail);
    expect(r.kind).toBe('docker');
    expect(r.label).toBe('Docker');
    expect(r.availability).toBe(dockerAvail);
    expect(r.result.status).toBe('ok');
    expect(r.result.message).toContain('docker (config)');
  });

  it('pairs an explicit apple-container config with the Apple availability result', async () => {
    const r = await checkActiveRuntime(configWithRuntime('apple-container'), dockerAvail, appleAvail);
    expect(r.kind).toBe('apple-container');
    expect(r.label).toBe('Apple container');
    expect(r.availability).toBe(appleAvail);
  });

  it('reports the env override as the source', async () => {
    process.env.IRONCURTAIN_CONTAINER_RUNTIME = 'docker';
    const r = await checkActiveRuntime(configWithRuntime('apple-container'), dockerAvail, appleAvail);
    expect(r.kind).toBe('docker');
    expect(r.result.message).toContain('env override');
  });

  it('fails (without throwing) on an invalid env override', async () => {
    process.env.IRONCURTAIN_CONTAINER_RUNTIME = 'podman';
    const r = await checkActiveRuntime(configWithRuntime('auto'), dockerAvail, appleAvail);
    expect(r.result.status).toBe('fail');
    expect(r.result.hint).toContain('IRONCURTAIN_CONTAINER_RUNTIME');
  });
});

// ---------------------------------------------------------------------------
// Unit: Linux Docker host identity and user namespace (DINF-23, DINF-3)
// ---------------------------------------------------------------------------

describe('checkHostIdentityForLinuxDocker', () => {
  it('fails for a root coordinator on Linux Docker, naming the remedy', () => {
    const r = checkHostIdentityForLinuxDocker('docker', 'linux', 0);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/running as root/);
    expect(r.hint).toBe(ROOT_HOST_IDENTITY_MESSAGE);
  });

  it('passes a regular user and skips platforms without the UID remap', () => {
    expect(checkHostIdentityForLinuxDocker('docker', 'linux', 1000).status).toBe('ok');
    expect(checkHostIdentityForLinuxDocker('docker', 'darwin', 0).status).toBe('skip');
    expect(checkHostIdentityForLinuxDocker('apple-container', 'darwin', 0).status).toBe('skip');
  });
});

describe('checkDockerUserNamespace', () => {
  const server = (securityOptions: string[]): DockerAvailability => ({
    available: true,
    server: {
      architecture: 'amd64',
      operatingSystem: 'Ubuntu 24.04',
      osType: 'linux',
      serverVersion: '29.1.3',
      kernelVersion: '6.8.0',
      cgroupVersion: '2',
      securityOptions,
    },
  });

  it('warns when container root is host root', async () => {
    const r = await checkDockerUserNamespace('docker', true, 'linux', async () =>
      server(['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns']),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/container root is host root/);
    expect(r.hint).toMatch(/setuid/);
  });

  it('reports rootless Docker and userns-remap as ok', async () => {
    await expect(
      checkDockerUserNamespace('docker', true, 'linux', async () =>
        server(['name=seccomp,profile=builtin', 'name=rootless']),
      ),
    ).resolves.toMatchObject({ status: 'ok', message: expect.stringMatching(/rootless/) });
    await expect(
      checkDockerUserNamespace('docker', true, 'linux', async () => server(['name=userns'])),
    ).resolves.toMatchObject({ status: 'ok', message: expect.stringMatching(/userns-remap/) });
  });

  it('warns when the daemon facts cannot be read and skips where it does not apply', async () => {
    await expect(
      checkDockerUserNamespace('docker', true, 'linux', async () => ({
        available: false,
        reason: 'Docker not available',
        detailedMessage: 'Cannot connect to the Docker daemon.',
      })),
    ).resolves.toMatchObject({ status: 'warn', hint: 'Cannot connect to the Docker daemon.' });
    const probe = vi.fn(async () => server([]));
    await expect(checkDockerUserNamespace('docker', false, 'linux', probe)).resolves.toMatchObject({ status: 'skip' });
    await expect(checkDockerUserNamespace('docker', true, 'darwin', probe)).resolves.toMatchObject({ status: 'skip' });
    await expect(checkDockerUserNamespace('apple-container', true, 'linux', probe)).resolves.toMatchObject({
      status: 'skip',
    });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('classifyDockerUserNamespace', () => {
  it('reads rootless and userns from docker info SecurityOptions', () => {
    expect(classifyDockerUserNamespace(['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'])).toBe(
      'rootless',
    );
    expect(classifyDockerUserNamespace(['name=apparmor', 'name=userns'])).toBe('userns-remap');
    expect(classifyDockerUserNamespace(['name=apparmor', 'name=seccomp,profile=builtin'])).toBe('host-root');
    expect(classifyDockerUserNamespace([])).toBe('host-root');
    // A profile value that merely mentions the word is not the option itself.
    expect(classifyDockerUserNamespace(['name=seccomp,profile=name=rootless'])).toBe('host-root');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkPreferredMode
// ---------------------------------------------------------------------------

describe('checkPreferredMode', () => {
  const dockerOk: CheckResult = { name: 'Docker', status: 'ok', message: 'running' };
  const dockerWarn: CheckResult = {
    name: 'Docker',
    status: 'warn',
    message: 'unavailable',
    hint: 'docker: command not found',
  };

  function configWithMode(mode: 'container' | 'builtin', anthropicApiKey = '') {
    return buildConfig({
      userConfig: { ...buildConfig().userConfig, preferredMode: mode, anthropicApiKey },
    });
  }

  it('preferredMode=container + Docker ok -> ok', () => {
    const r = checkPreferredMode(configWithMode('container', 'sk-test'), dockerOk);
    expect(r.status).toBe('ok');
    expect(r.message).toBe('container');
  });

  it('preferredMode=container + Docker unavailable -> fail', () => {
    const r = checkPreferredMode(configWithMode('container', 'sk-test'), dockerWarn);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/Docker is unavailable/);
    expect(r.hint).toMatch(/Start Docker/);
  });

  it('preferredMode=builtin + API key present -> ok', () => {
    const r = checkPreferredMode(configWithMode('builtin', 'sk-test'), dockerWarn);
    expect(r.status).toBe('ok');
    expect(r.message).toBe('builtin');
  });

  it('preferredMode=builtin + no API key -> warn (warn alone does not fail doctor)', () => {
    const r = checkPreferredMode(configWithMode('builtin', ''), dockerOk);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/no ANTHROPIC_API_KEY/);
    expect(r.hint).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('preferredMode=builtin status is independent of Docker availability', () => {
    // dockerWarn must not turn a builtin-mode user's status into fail.
    const r = checkPreferredMode(configWithMode('builtin', 'sk-test'), dockerWarn);
    expect(r.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkDockerResources
// ---------------------------------------------------------------------------

describe('checkDockerResources', () => {
  /** Build a config with custom dockerResources values. */
  function configWithResources(resources: { memoryMb: number | null; cpus: number | null }): IronCurtainConfig {
    const base = buildConfig();
    return {
      ...base,
      userConfig: { ...base.userConfig, dockerResources: { ...base.userConfig.dockerResources, ...resources } },
    };
  }

  it('skips probe with ok when image is not present locally', async () => {
    // execFile rejects -> isImagePresent returns false -> no probe.
    const execFile = vi.fn().mockRejectedValue(new Error('no such image'));
    const resolveImage = async () => 'fake-image:latest';
    const result = await checkDockerResources(configWithResources({ memoryMb: 1024, cpus: 1 }), {
      execFile,
      resolveImage,
    });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/not yet pulled/);
    expect(result.message).toMatch(/fake-image:latest/);
  });

  it('runs the probe when image is present and Docker accepts the limits', async () => {
    // First call: image inspect succeeds. Second call: docker run succeeds.
    const execFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const resolveImage = async () => 'fake-image:latest';
    const result = await checkDockerResources(configWithResources({ memoryMb: 512, cpus: 1 }), {
      execFile,
      resolveImage,
    });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/512 MB/);
    expect(result.message).toMatch(/1 cpus/);
  });

  it('reports clamping in the message when configured exceeds host', async () => {
    // 999999 MB / 999 cpus is way beyond any test host -- the clamp will
    // lower both. The probe never runs because we make image-inspect fail.
    const execFile = vi.fn().mockRejectedValue(new Error('no such image'));
    const resolveImage = async () => 'fake-image:latest';
    const result = await checkDockerResources(configWithResources({ memoryMb: 999_999, cpus: 999 }), {
      execFile,
      resolveImage,
    });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/clamped from/);
  });

  it('reports unlimited when configured null', async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const resolveImage = async () => 'fake-image:latest';
    const result = await checkDockerResources(configWithResources({ memoryMb: null, cpus: null }), {
      execFile,
      resolveImage,
    });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/unlimited/);
  });

  it('returns fail with suggested values when Docker rejects the limits', async () => {
    let callIndex = 0;
    const stderr = 'Range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available.';
    const execFile = vi.fn().mockImplementation(async () => {
      // First call (image inspect) succeeds, second call (docker run) fails.
      if (callIndex++ === 0) return { stdout: '[{}]', stderr: '' };
      throw Object.assign(new Error('docker run failed'), { stderr });
    });
    const resolveImage = async () => 'fake-image:latest';
    const result = await checkDockerResources(configWithResources({ memoryMb: 1024, cpus: 1 }), {
      execFile,
      resolveImage,
    });
    expect(result.status).toBe('fail');
    expect(result.hint).toMatch(/ironcurtain config/);
    expect(result.hint).toMatch(/cpus=1/);
  });

  it('returns warn when image resolution throws', async () => {
    const resolveImage: (id: AgentId) => Promise<string> = () =>
      Promise.reject(new Error('agent registry not initialized'));
    const result = await checkDockerResources(configWithResources({ memoryMb: 1024, cpus: 1 }), {
      resolveImage,
    });
    expect(result.status).toBe('warn');
    expect(result.hint).toMatch(/agent registry/);
  });
});

// ---------------------------------------------------------------------------
// Unit: collectDeclaredEnvVars + checkServerCredentials
// ---------------------------------------------------------------------------

describe('collectDeclaredEnvVars', () => {
  it('collects -e flags from args (Docker convention)', () => {
    const cfg = buildServerConfig({
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/x'],
    });
    expect(collectDeclaredEnvVars(cfg)).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
  });

  it('skips -e KEY=value form', () => {
    const cfg = buildServerConfig({ args: ['-e', 'TOKEN=abc'] });
    expect(collectDeclaredEnvVars(cfg)).toEqual([]);
  });

  it('collects credential-like env keys from config.env', () => {
    const cfg = buildServerConfig({
      env: { MY_API_KEY: '', MCP_TRANSPORT_TYPE: 'stdio' },
    });
    // Only MY_API_KEY is credential-shaped.
    expect(collectDeclaredEnvVars(cfg)).toEqual(['MY_API_KEY']);
  });

  it('returns empty when nothing declared', () => {
    expect(collectDeclaredEnvVars(buildServerConfig())).toEqual([]);
  });
});

describe('checkServerCredentials', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('passes when no credentials are needed', () => {
    const cfg = buildConfig({ mcpServers: { foo: buildServerConfig() } });
    const result = checkServerCredentials('foo', cfg.mcpServers.foo, cfg);
    expect(result.status).toBe('ok');
    expect(result.message).toBe('no credentials required');
  });

  it('passes when env var is set in process.env', () => {
    process.env.MY_TOKEN = 'abc';
    const server = buildServerConfig({ args: ['-e', 'MY_TOKEN'] });
    const cfg = buildConfig({ mcpServers: { svc: server } });
    expect(checkServerCredentials('svc', server, cfg).status).toBe('ok');
  });

  it('passes when env var is set in serverCredentials', () => {
    delete process.env.MY_TOKEN;
    const server = buildServerConfig({ args: ['-e', 'MY_TOKEN'] });
    const cfg = buildConfig({
      mcpServers: { svc: server },
      userConfig: {
        ...buildConfig().userConfig,
        serverCredentials: { svc: { MY_TOKEN: 'xyz' } },
      },
    });
    expect(checkServerCredentials('svc', server, cfg).status).toBe('ok');
  });

  it('passes when env var is set inline in serverConfig.env', () => {
    delete process.env.MY_TOKEN;
    const server = buildServerConfig({ args: [], env: { MY_TOKEN: 'inline-value' } });
    const cfg = buildConfig({ mcpServers: { svc: server } });
    expect(checkServerCredentials('svc', server, cfg).status).toBe('ok');
  });

  it('counts a host variable only for a -e passthrough, not for an env slot it never reaches', () => {
    process.env.MY_TOKEN = 'abc';
    const server = buildServerConfig({ args: [], env: { MY_TOKEN: '' } });
    const cfg = buildConfig({ mcpServers: { svc: server } });
    const result = checkServerCredentials('svc', server, cfg);
    expect(result.status).toBe('warn');
    expect(result.message).toBe('missing: MY_TOKEN');

    const stored = buildConfig({
      mcpServers: { svc: server },
      userConfig: { ...buildConfig().userConfig, serverCredentials: { svc: { MY_TOKEN: 'xyz' } } },
    });
    expect(checkServerCredentials('svc', server, stored).status).toBe('ok');
  });

  it('warns when credentials are missing', () => {
    delete process.env.MY_TOKEN;
    const server = buildServerConfig({ args: ['-e', 'MY_TOKEN'] });
    const cfg = buildConfig({ mcpServers: { svc: server } });
    const result = checkServerCredentials('svc', server, cfg);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('MY_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkConstitutionDrift
// ---------------------------------------------------------------------------

describe('checkConstitutionDrift', () => {
  let tmp: string;
  const savedHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-drift-'));
    process.env.IRONCURTAIN_HOME = tmp;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns ok when hashes match', async () => {
    const constitutionPath = resolve(tmp, 'constitution.md');
    writeFileSync(constitutionPath, 'base');
    writeFileSync(resolve(tmp, 'constitution-user.md'), 'rules');
    const { computeConstitutionHash } = await import('../src/config/paths.js');
    const hash = computeConstitutionHash(constitutionPath);
    const cfg = buildConfig({ constitutionPath });
    expect(checkConstitutionDrift(cfg, { constitutionHash: hash }).status).toBe('ok');
  });

  it('returns warn when hashes differ', () => {
    const constitutionPath = resolve(tmp, 'constitution.md');
    writeFileSync(constitutionPath, 'base');
    writeFileSync(resolve(tmp, 'constitution-user.md'), 'rules');
    const cfg = buildConfig({ constitutionPath });
    const result = checkConstitutionDrift(cfg, { constitutionHash: 'stale' });
    expect(result.status).toBe('warn');
    expect(result.hint).toMatch(/compile-policy/);
  });

  it('returns fail when constitution file is missing', () => {
    const cfg = buildConfig({ constitutionPath: resolve(tmp, 'missing.md') });
    expect(checkConstitutionDrift(cfg, { constitutionHash: 'x' }).status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkAnnotationDrift
// ---------------------------------------------------------------------------

describe('checkAnnotationDrift', () => {
  it('returns ok when annotations cover all configured servers', () => {
    const annotations = {
      generatedAt: '',
      servers: { fs: { inputHash: 'h', tools: [] } },
    };
    const mcpServers = { fs: buildServerConfig() };
    expect(checkAnnotationDrift(annotations, mcpServers).status).toBe('ok');
  });

  it('warns when a configured server has no annotations', () => {
    const annotations = { generatedAt: '', servers: {} };
    const mcpServers = { fs: buildServerConfig() };
    const result = checkAnnotationDrift(annotations, mcpServers);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('missing: fs');
    expect(result.hint).toContain('annotate-tools --server fs');
  });

  it('warns when annotations have orphaned entries', () => {
    const annotations = {
      generatedAt: '',
      servers: { gone: { inputHash: 'h', tools: [] } },
    };
    const mcpServers = {};
    const result = checkAnnotationDrift(annotations, mcpServers);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('orphaned: gone');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkMcpServerLiveness
// ---------------------------------------------------------------------------

describe('checkMcpServerLiveness', () => {
  it('returns a single skip entry when no servers are configured', async () => {
    const cfg = buildConfig({ mcpServers: {} });
    const results = await checkMcpServerLiveness(cfg);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('skip');
  });

  it('skips servers with missing credentials without spawning', async () => {
    delete process.env.MY_TOKEN;
    const probe = vi.fn();
    const server = buildServerConfig({ args: ['-e', 'MY_TOKEN'] });
    const cfg = buildConfig({ mcpServers: { svc: server } });
    const results = await checkMcpServerLiveness(cfg, { probe });
    expect(probe).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ name: 'svc', status: 'skip' });
  });

  it('runs probes for servers with credentials', async () => {
    process.env.MY_TOKEN = 'value';
    const probe = vi.fn(async (): Promise<ProbeResult> => ({
      status: 'ok',
      toolCount: 7,
      elapsedMs: 412,
    }));
    const cfg = buildConfig({
      mcpServers: { svc: buildServerConfig({ args: ['-e', 'MY_TOKEN'] }) },
    });
    const results = await checkMcpServerLiveness(cfg, { probe });
    expect(probe).toHaveBeenCalledOnce();
    expect(results[0].status).toBe('ok');
    expect(results[0].message).toContain('7 tools');
    delete process.env.MY_TOKEN;
  });

  it('reports probe failures as fail with reason in hint', async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => ({
      status: 'fail',
      elapsedMs: 1200,
      reason: 'spawn ENOENT',
    }));
    const cfg = buildConfig({ mcpServers: { svc: buildServerConfig() } });
    const results = await checkMcpServerLiveness(cfg, { probe });
    expect(results[0].status).toBe('fail');
    expect(results[0].hint).toBe('spawn ENOENT');
  });

  // WP-27: the probe's live tools are diffed against the effective
  // annotations, argument by argument (the server-level check compares
  // server names only).
  describe('annotation drift', () => {
    const annotations: StoredToolAnnotationsFile = {
      generatedAt: '',
      servers: {
        git: {
          inputHash: 'h',
          serverInfo: { name: '@cyanheads/git-mcp-server', version: '2.8.4' },
          tools: [
            {
              toolName: 'git_clone',
              serverName: 'git',
              comment: 'Clones a repository',
              args: { url: ['git-remote-url'], localPath: ['write-path'] },
              inputSchema: {
                type: 'object',
                properties: { url: { type: 'string' }, localPath: { type: 'string', description: 'Destination' } },
              },
            },
          ],
        },
      },
    };

    function probeListing(properties: Record<string, unknown>) {
      return vi.fn(async (): Promise<ProbeResult> => ({
        status: 'ok',
        toolCount: 1,
        elapsedMs: 40,
        tools: [{ name: 'git_clone', inputSchema: { type: 'object', properties } }],
        serverInfo: { name: '@cyanheads/git-mcp-server', version: '2.15.3' },
      }));
    }

    it('warns with the drifted arguments, the releases and the annotate command', async () => {
      const probe = probeListing({ url: { type: 'string' }, path: { type: 'string', description: 'Destination' } });
      const cfg = buildConfig({ mcpServers: { git: buildServerConfig() } });
      const [result] = await checkMcpServerLiveness(cfg, { probe, toolAnnotations: annotations });
      expect(result.status).toBe('warn');
      expect(result.message).toContain('1 tool, 40ms; annotations drifted');
      expect(result.message).toContain('server reports @cyanheads/git-mcp-server 2.15.3');
      expect(result.message).toContain('annotated for @cyanheads/git-mcp-server 2.8.4');
      expect(result.message).toContain('git_clone (unannotated: path; removed: localPath)');
      expect(result.hint).toBe(
        'Run `ironcurtain annotate-tools --server git`, review the result and recompile the policy.',
      );
    });

    it('stays ok when the live tools match, and notes schema text that changed without a policy effect', async () => {
      const cfg = buildConfig({ mcpServers: { git: buildServerConfig() } });
      const matching = probeListing({
        url: { type: 'string' },
        localPath: { type: 'string', description: 'Destination' },
      });
      const [same] = await checkMcpServerLiveness(cfg, { probe: matching, toolAnnotations: annotations });
      expect(same).toMatchObject({ status: 'ok', message: '1 tool, 40ms' });

      const reworded = probeListing({
        url: { type: 'string' },
        localPath: { type: 'string', description: 'Where to' },
      });
      const [text] = await checkMcpServerLiveness(cfg, { probe: reworded, toolAnnotations: annotations });
      expect(text.status).toBe('ok');
      expect(text.message).toContain('no policy effect');
    });

    it('does not diff servers without an annotations entry', async () => {
      const cfg = buildConfig({ mcpServers: { other: buildServerConfig() } });
      const probe = probeListing({ anything: { type: 'string' } });
      const [result] = await checkMcpServerLiveness(cfg, { probe, toolAnnotations: annotations });
      expect(result).toMatchObject({ status: 'ok', message: '1 tool, 40ms' });
    });
  });
});

// ---------------------------------------------------------------------------
// Unit: checkOsSandbox (bubblewrap / socat / ripgrep + srt smoke run)
// ---------------------------------------------------------------------------

describe('checkOsSandbox', () => {
  const missingAll: OsSandboxAvailability = {
    available: false,
    platformSupported: true,
    problems: ['ripgrep (rg) not found', 'bubblewrap (bwrap) not installed', 'socat not installed'],
    warnings: [],
  };
  const available: OsSandboxAvailability = { available: true, platformSupported: true, problems: [], warnings: [] };
  const smokeOk = async (): Promise<OsSandboxSmokeResult> => ({ ok: true, elapsedMs: 42, detail: 'ok' });
  const servers = {
    filesystem: buildServerConfig({ sandbox: false }),
    git: buildServerConfig({ sandbox: { network: { allowedDomains: ['github.com'] } } }),
    'google-workspace': buildServerConfig(),
  };
  const savedEnv = { iron: process.env.IRONCURTAIN_SANDBOX_POLICY, plain: process.env.SANDBOX_POLICY };

  beforeEach(() => {
    delete process.env.IRONCURTAIN_SANDBOX_POLICY;
    delete process.env.SANDBOX_POLICY;
  });

  afterEach(() => {
    if (savedEnv.iron === undefined) delete process.env.IRONCURTAIN_SANDBOX_POLICY;
    else process.env.IRONCURTAIN_SANDBOX_POLICY = savedEnv.iron;
    if (savedEnv.plain === undefined) delete process.env.SANDBOX_POLICY;
    else process.env.SANDBOX_POLICY = savedEnv.plain;
  });

  it('reports missing bwrap, socat and rg and fails under enforce', async () => {
    const smokeTest = vi.fn(smokeOk);
    const { result, refused } = await checkOsSandbox(buildConfig({ mcpServers: servers, sandboxPolicy: 'enforce' }), {
      availability: () => missingAll,
      smokeTest,
    });

    expect(result.name).toBe('OS sandbox');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('bubblewrap (bwrap) not installed');
    expect(result.message).toContain('socat not installed');
    expect(result.message).toContain('ripgrep (rg) not found');
    expect(result.message).toContain('git, google-workspace will not start');
    expect(result.hint).toContain('sudo apt-get install -y bubblewrap socat ripgrep');
    expect(result.hint).toContain('IRONCURTAIN_SANDBOX_POLICY=warn');
    expect([...refused].sort()).toEqual(['git', 'google-workspace']);
    expect(smokeTest).not.toHaveBeenCalled();
  });

  it('warns (not fails) under warn, naming the unconfined servers', async () => {
    const { result, refused } = await checkOsSandbox(buildConfig({ mcpServers: servers, sandboxPolicy: 'warn' }), {
      availability: () => missingAll,
      smokeTest: smokeOk,
    });

    expect(result.status).toBe('warn');
    expect(result.message).toContain('git, google-workspace will run WITHOUT OS containment');
    expect(refused.size).toBe(0);
  });

  it('does not suggest installing packages on an unsupported platform', async () => {
    const { result } = await checkOsSandbox(buildConfig({ mcpServers: servers, sandboxPolicy: 'enforce' }), {
      availability: () => ({
        available: false,
        platformSupported: false,
        problems: ['platform "win32" is not supported by sandbox-runtime'],
        warnings: [],
      }),
      smokeTest: smokeOk,
    });

    expect(result.status).toBe('fail');
    expect(result.hint).toContain('not supported on this platform');
    expect(result.hint).not.toContain('apt-get');
    expect(result.hint).toContain('IRONCURTAIN_SANDBOX_POLICY=warn');
  });

  it('does not suggest installing packages when the tools are present but unusable', async () => {
    const { result } = await checkOsSandbox(buildConfig({ mcpServers: servers, sandboxPolicy: 'enforce' }), {
      availability: () => ({
        available: false,
        platformSupported: true,
        problems: ["running as uid 0 without CAP_SETFCAP in this process's capability bounding set"],
        warnings: [],
      }),
      smokeTest: smokeOk,
    });

    expect(result.status).toBe('fail');
    expect(result.message).toContain('CAP_SETFCAP');
    expect(result.hint).not.toContain('apt-get');
    expect(result.hint).toContain('resolve the problem above');
    expect(result.hint).toContain('IRONCURTAIN_SANDBOX_POLICY=warn');
  });

  it('names the environment override in the message', async () => {
    process.env.IRONCURTAIN_SANDBOX_POLICY = 'warn';
    const { result } = await checkOsSandbox(buildConfig({ mcpServers: servers, sandboxPolicy: 'warn' }), {
      availability: () => missingAll,
      smokeTest: smokeOk,
    });
    expect(result.message).toContain('from IRONCURTAIN_SANDBOX_POLICY');
  });

  it('runs the srt smoke test when the dependencies are present', async () => {
    const smokeTest = vi.fn(smokeOk);
    const { result } = await checkOsSandbox(buildConfig({ mcpServers: servers, sandboxPolicy: 'enforce' }), {
      availability: () => available,
      smokeTest,
    });

    expect(smokeTest).toHaveBeenCalledOnce();
    expect(result.status).toBe('ok');
    expect(result.message).toContain('srt smoke run 42ms');
    expect(result.message).toContain('git, google-workspace');
  });

  // Sessions treat a host where srt cannot start a sandbox as unavailable
  // (resolveOsSandboxAvailability), so doctor reports what they will do:
  // refuse those servers under "enforce", run them unconfined under "warn".
  it('reports a failed srt smoke run as an unavailable sandbox: refused under enforce', async () => {
    const { result, refused, availability } = await checkOsSandbox(
      buildConfig({ mcpServers: servers, sandboxPolicy: 'enforce' }),
      {
        availability: () => available,
        smokeTest: async () => ({ ok: false, elapsedMs: 120, detail: 'apply-seccomp: Permission denied' }),
      },
    );

    expect(result.status).toBe('fail');
    expect(result.message).toContain('srt cannot start a sandbox on this host: apply-seccomp: Permission denied');
    expect(result.message).toContain('git, google-workspace will not start');
    expect(result.hint).not.toContain('apt-get');
    expect(result.hint).toContain('IRONCURTAIN_SANDBOX_POLICY=warn');
    expect([...refused].sort()).toEqual(['git', 'google-workspace']);
    // The liveness probes plan from the same verdict as sessions.
    expect(availability.available).toBe(false);
  });

  it('reports a failed srt smoke run as an unavailable sandbox: unconfined under warn', async () => {
    const { result, refused } = await checkOsSandbox(buildConfig({ mcpServers: servers, sandboxPolicy: 'warn' }), {
      availability: () => available,
      smokeTest: async () => ({ ok: false, elapsedMs: 120, detail: 'apply-seccomp: Permission denied' }),
    });

    expect(result.status).toBe('warn');
    expect(result.message).toContain('srt cannot start a sandbox on this host: apply-seccomp: Permission denied');
    expect(result.message).toContain('git, google-workspace will run WITHOUT OS containment');
    expect(refused.size).toBe(0);
  });

  it('is ok, without a smoke run, when no configured server asks for an OS sandbox', async () => {
    const smokeTest = vi.fn(smokeOk);
    const optedOut = { filesystem: buildServerConfig({ sandbox: false }) };

    const unavailable = await checkOsSandbox(buildConfig({ mcpServers: optedOut, sandboxPolicy: 'enforce' }), {
      availability: () => missingAll,
      smokeTest,
    });
    expect(unavailable.result.status).toBe('ok');
    expect(unavailable.result.message).toContain('not needed');

    const present = await checkOsSandbox(buildConfig({ mcpServers: optedOut, sandboxPolicy: 'enforce' }), {
      availability: () => available,
      smokeTest,
    });
    expect(present.result.status).toBe('ok');
    expect(smokeTest).not.toHaveBeenCalled();
  });

  it('does not probe servers sessions will refuse', async () => {
    const probe = vi.fn(async (): Promise<ProbeResult> => ({ status: 'ok', toolCount: 1, elapsedMs: 1 }));
    const cfg = buildConfig({ mcpServers: servers });

    const results = await checkMcpServerLiveness(cfg, { probe, refusedServers: new Set(['git', 'google-workspace']) });

    expect(probe).toHaveBeenCalledOnce();
    expect(results.find((r) => r.name === 'git')?.status).toBe('skip');
    expect(results.find((r) => r.name === 'git')?.message).toContain('OS sandbox unavailable');
    expect(results.find((r) => r.name === 'filesystem')?.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkMemoryModels
// ---------------------------------------------------------------------------

describe('checkMemoryModels', () => {
  const EMBEDDING = { role: 'embedding', repo: 'Xenova/bge-base-en-v1.5', dtype: 'q8' } as const;
  const RERANKER = { role: 'reranker', repo: 'Xenova/ms-marco-MiniLM-L-6-v2', dtype: 'q8' } as const;

  function reportOf(models: MemoryModelsReport['models']): MemoryModelsResult {
    return {
      kind: 'report',
      exitCode: models.every((m) => m.status === 'ok') ? 0 : 1,
      report: { action: 'verify', modelsDir: '/home/u/.ironcurtain/models', offline: false, models },
    };
  }

  function withMemory(memory: Partial<IronCurtainConfig['userConfig']['memory']>): IronCurtainConfig {
    const config = buildConfig();
    return { ...config, userConfig: { ...config.userConfig, memory: { ...config.userConfig.memory, ...memory } } };
  }

  it('skips without running anything when memory is disabled', async () => {
    const run = vi.fn<MemoryModelsRunner>();
    const result = await checkMemoryModels(withMemory({ enabled: false }), run);
    expect(result.status).toBe('skip');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports the pinned models verified, checking without downloading', async () => {
    const run = vi.fn<MemoryModelsRunner>(async () =>
      reportOf([
        { ...EMBEDDING, status: 'ok' },
        { ...RERANKER, status: 'ok' },
      ]),
    );
    const result = await checkMemoryModels(buildConfig(), run);
    expect(run).toHaveBeenCalledWith('verify');
    expect(result).toEqual({
      name: 'Memory models',
      status: 'ok',
      message: '2 pinned models verified in /home/u/.ironcurtain/models',
    });
  });

  it('fails on a model file that failed verification, and says how to replace it', async () => {
    const run: MemoryModelsRunner = async () =>
      reportOf([
        {
          ...EMBEDDING,
          status: 'invalid',
          detail: 'onnx/model_quantized.onnx in /m has SHA-256 aaaa, the pin says bbbb',
        },
        { ...RERANKER, status: 'ok' },
      ]);
    const result = await checkMemoryModels(buildConfig(), run);
    expect(result.status).toBe('fail');
    expect(result.message).toBe(
      'Xenova/bge-base-en-v1.5 (q8) failed verification: onnx/model_quantized.onnx in /m has SHA-256 aaaa, the pin says bbbb',
    );
    expect(result.hint).toContain('ironcurtain memory prefetch');
  });

  it('fails when this build has no pin for a model', async () => {
    const run: MemoryModelsRunner = async () =>
      reportOf([
        { ...EMBEDDING, status: 'unpinned', detail: 'has not been pinned yet' },
        { ...RERANKER, status: 'unpinned', detail: 'has not been pinned yet' },
      ]);
    const result = await checkMemoryModels(buildConfig(), run);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Xenova/bge-base-en-v1.5 (q8), Xenova/ms-marco-MiniLM-L-6-v2 (q8) not pinned');
    expect(result.hint).toContain('PINNED_MODELS');
  });

  it('warns that missing models are downloaded on first use', async () => {
    const run: MemoryModelsRunner = async () => reportOf([{ ...EMBEDDING, status: 'missing' }]);
    const result = await checkMemoryModels(buildConfig(), run);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('not downloaded yet; the first memory session downloads and verifies them');
    expect(result.hint).toContain('ironcurtain memory prefetch');
  });

  it('fails on missing models when memory.offlineModels forbids downloading them', async () => {
    const run: MemoryModelsRunner = async () => reportOf([{ ...EMBEDDING, status: 'missing' }]);
    const result = await checkMemoryModels(withMemory({ offlineModels: true }), run);
    expect(result.status).toBe('fail');
    expect(result.message).toBe(
      'Xenova/bge-base-en-v1.5 (q8) not in /home/u/.ironcurtain/models, and memory.offlineModels forbids downloading them',
    );
    expect(result.hint).toContain('on a machine with network access');
  });

  it('warns when the check itself could not run', async () => {
    const run: MemoryModelsRunner = async () => ({ kind: 'failed', reason: 'could not run the memory server: EACCES' });
    await expect(checkMemoryModels(buildConfig(), run)).resolves.toMatchObject({
      status: 'warn',
      message: 'could not check: could not run the memory server: EACCES',
    });
  });

  it('never prints terminal escapes from the report', async () => {
    const run: MemoryModelsRunner = async () =>
      reportOf([{ ...EMBEDDING, status: 'invalid', detail: 'config.json \u001b]0;pwned\u0007 is a symbolic link' }]);
    const result = await checkMemoryModels(buildConfig(), run);
    expect(result.message).not.toContain('\u001b');
    expect(result.message).not.toContain('\u0007');
  });
});

// ---------------------------------------------------------------------------
// Integration: runDoctorCommand exit-code propagation
// ---------------------------------------------------------------------------

describe('runDoctorCommand', () => {
  let tmp: string;
  const savedHome = process.env.IRONCURTAIN_HOME;
  const savedColor = process.env.FORCE_COLOR;
  const savedAllowed = process.env.ALLOWED_DIRECTORY;
  const savedChalkLevel = chalk.level;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-int-'));
    process.env.IRONCURTAIN_HOME = tmp;
    process.env.FORCE_COLOR = '0';
    chalk.level = 0;
    // Avoid any incidental ANTHROPIC_API_KEY from the runner environment
    // affecting credential checks (we want deterministic 'no creds').
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ALLOWED_DIRECTORY = tmp;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    if (savedColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedColor;
    if (savedAllowed === undefined) delete process.env.ALLOWED_DIRECTORY;
    else process.env.ALLOWED_DIRECTORY = savedAllowed;
    chalk.level = savedChalkLevel;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('prints help and returns when --help is passed', async () => {
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const { output, exitCode } = await captureOutput(() => runDoctorCommand(['--help']));
    expect(output).toContain('ironcurtain doctor');
    expect(output).toContain('--check-api');
    expect(exitCode).toBeUndefined();
  });

  it('prints all sections and a summary footer', async () => {
    // loadConfig() reads from src/config/mcp-servers.json which exists
    // in the repo. We pass a probe stub through DoctorDeps to avoid
    // actually spawning the configured MCP server processes.
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn<ServerProbe>(async (): Promise<ProbeResult> => ({
      status: 'ok',
      toolCount: 1,
      elapsedMs: 10,
    }));
    const { output } = await captureOutput(() => runDoctorCommand([], { probeMcpServer: probeStub }));
    expect(output).toContain('Environment');
    expect(output).toContain('Configuration');
    expect(output).toContain('Credentials');
    expect(output).toContain('MCP servers');
    expect(output).toMatch(/Summary: \d+ ok, \d+ warn, \d+ fail/);
  });

  it('rejects unknown flags by printing an error', async () => {
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const { output, exitCode } = await captureOutput(() => runDoctorCommand(['--bogus']));
    expect(output).toMatch(/--bogus/i);
    expect(exitCode).toBe(1);
  });

  it('lists servers whose user tool annotations override the shipped ones', async () => {
    // A user overlay (IRONCURTAIN_HOME/generated) pinning its own git annotations.
    const gitTools = [
      { toolName: 'git_status', serverName: 'git', comment: 'status', args: { path: ['none'] }, inputSchema: {} },
    ];
    mkdirSync(resolve(tmp, 'generated'), { recursive: true });
    writeFileSync(
      resolve(tmp, 'generated', 'tool-annotations.json'),
      JSON.stringify({
        generatedAt: 'x',
        servers: { git: { inputHash: 'mine', source: 'user', pinned: true, tools: gitTools } },
      }),
    );
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn<ServerProbe>(async (): Promise<ProbeResult> => ({
      status: 'ok',
      toolCount: 1,
      elapsedMs: 10,
    }));
    const { output } = await captureOutput(() => runDoctorCommand([], { probeMcpServer: probeStub }));
    expect(output).toMatch(/Annotation overlay\s+overrides shipped annotations for: git \(pinned\)/);
    expect(output).toContain('annotate-tools --reset --server git');
  });

  it('flags a user policy compiled by an older policy compiler as stale, and says where it comes from', async () => {
    // The user compiled their own policy (IRONCURTAIN_HOME/generated) with a
    // compiler from an earlier epoch; its constitution hash cannot tell.
    const { POLICY_COMPILER_EPOCH, buildPolicyProvenance } = await import('../src/policy-artifacts/provenance.js');
    const { readToolAnnotationsFile } = await import('../src/config/tool-annotations-overlay.js');
    const { getPackageGeneratedDir } = await import('../src/config/index.js');
    const shipped = readToolAnnotationsFile(resolve(getPackageGeneratedDir(), 'tool-annotations.json'));
    if (!shipped) throw new Error('shipped annotations missing');
    const rules = [
      {
        name: 'allow-list-dirs',
        description: 'd',
        principle: 'p',
        if: { server: ['filesystem'], tool: ['list_allowed_directories'] },
        then: 'allow' as const,
        reason: 'r',
      },
    ];
    const provenance = {
      ...buildPolicyProvenance({ policy: { rules }, annotations: shipped }),
      policyCompilerEpoch: POLICY_COMPILER_EPOCH - 1,
    };
    mkdirSync(resolve(tmp, 'generated'), { recursive: true });
    writeFileSync(
      resolve(tmp, 'generated', 'compiled-policy.json'),
      JSON.stringify({ generatedAt: 'x', constitutionHash: 'x', inputHash: 'x', provenance, rules }),
    );

    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn(async (): Promise<ProbeResult> => ({ status: 'ok', toolCount: 1, elapsedMs: 10 }));
    const { output } = await captureOutput(() => runDoctorCommand([], { probeMcpServer: probeStub }));
    expect(output).toMatch(/Policy source\s+your compiled policy \(.*generated\/compiled-policy\.json\)/);
    expect(output).toMatch(/Policy provenance\s+stale: it was compiled by an older policy compiler/);
    expect(output).toContain('Run `ironcurtain compile-policy` to rebuild it.');
    expect(output).toMatch(/Policy invariants\s+2 universal invariant\(s\) hold/);
  });

  it('reports a user policy whose rules are malformed instead of crashing', async () => {
    // Valid JSON, wrong shape: such a file must not end the run. The
    // schema-validated loader refuses it in the "Policy artifacts" check, so
    // the policy checks that read the rules (provenance, scenario replay,
    // invariants) never receive it; they guard themselves too (see
    // test/policy-provenance.test.ts).
    mkdirSync(resolve(tmp, 'generated'), { recursive: true });
    writeFileSync(
      resolve(tmp, 'generated', 'compiled-policy.json'),
      JSON.stringify({ generatedAt: 'x', constitutionHash: 'x', inputHash: 'x', rules: { not: 'an array' } }),
    );

    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn(async (): Promise<ProbeResult> => ({ status: 'ok', toolCount: 1, elapsedMs: 10 }));
    const { output, exitCode } = await captureOutput(() => runDoctorCommand([], { probeMcpServer: probeStub }));
    expect(output).toMatch(/Policy artifacts\s+.*generated\/compiled-policy\.json is not a valid compiled policy/);
    expect(output).toContain('rules: expected an array, got an object');
    expect(output).not.toMatch(/Policy provenance\s/);
    expect(output).not.toMatch(/Policy invariants\s/);
    // The run went on to the remaining sections.
    expect(output).toMatch(/Summary: /);
    expect(exitCode).toBe(1);
  });

  it('reports the OS sandbox in the MCP servers section and skips refused servers', async () => {
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn<ServerProbe>(async (): Promise<ProbeResult> => ({
      status: 'ok',
      toolCount: 1,
      elapsedMs: 10,
    }));
    const savedPolicy = process.env.IRONCURTAIN_SANDBOX_POLICY;
    process.env.IRONCURTAIN_SANDBOX_POLICY = 'enforce';
    try {
      const { output, exitCode } = await captureOutput(() =>
        runDoctorCommand([], {
          probeMcpServer: probeStub,
          osSandbox: {
            availability: () => ({
              available: false,
              platformSupported: true,
              problems: ['ripgrep (rg) not found', 'bubblewrap (bwrap) not installed', 'socat not installed'],
              warnings: [],
            }),
          },
        }),
      );
      expect(output).toMatch(
        /✗ OS sandbox\s+unavailable \(ripgrep \(rg\) not found; bubblewrap \(bwrap\) not installed; socat not installed\)/,
      );
      expect(output).toContain('git, google-workspace will not start');
      expect(output).toMatch(/git\s.*skipped — sessions will not start it/);
      expect(probeStub.mock.calls.map((c) => c[0])).not.toContain('git');
      // A fail result always makes doctor exit non-zero.
      expect(exitCode).toBe(1);
    } finally {
      if (savedPolicy === undefined) delete process.env.IRONCURTAIN_SANDBOX_POLICY;
      else process.env.IRONCURTAIN_SANDBOX_POLICY = savedPolicy;
    }
  });

  it('reports the memory models in a Memory section', async () => {
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn<ServerProbe>(async (): Promise<ProbeResult> => ({
      status: 'ok',
      toolCount: 1,
      elapsedMs: 10,
    }));
    vi.mocked(runMemoryModelsTool).mockClear();
    const { output } = await captureOutput(() => runDoctorCommand([], { probeMcpServer: probeStub }));
    expect(output).toMatch(/\nMemory\n/);
    expect(output).toMatch(/Memory models\s+2 pinned models verified in \/home\/u\/\.ironcurtain\/models/);
    // Doctor is read-only: one verify of the store, never a prefetch (download).
    expect(vi.mocked(runMemoryModelsTool).mock.calls.map(([action]) => action)).toEqual(['verify']);
  });

  // FU-05: a memory server from before the review quarantine makes cron jobs and
  // workflows with memory refuse to start; the Memory section says so, with the fix.
  it('reports in the Memory section whether the memory server has the review quarantine', async () => {
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn<ServerProbe>(async (): Promise<ProbeResult> => ({
      status: 'ok',
      toolCount: 1,
      elapsedMs: 10,
    }));
    const memorySection = (output: string): string => output.slice(output.indexOf('\nMemory\n'));

    const outdated = await captureOutput(() =>
      runDoctorCommand([], { probeMcpServer: probeStub, memoryReviewQuarantine: () => false }),
    );
    expect(memorySection(outdated.output)).toMatch(
      /✗ Memory review quarantine\s+@provos\/memory-mcp-server\/admin does not resolve.*refuse to start\n\s+└─ .*npm run build -w packages\/memory-mcp-server/,
    );

    const current = await captureOutput(() =>
      runDoctorCommand([], { probeMcpServer: probeStub, memoryReviewQuarantine: () => true }),
    );
    expect(memorySection(current.output)).toMatch(
      /✓ Memory review quarantine\s+memories that cron jobs and workflows write wait for review/,
    );
  });

  it('reports node-pty in the Environment section, with the reinstall command when it is missing', async () => {
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn<ServerProbe>(async (): Promise<ProbeResult> => ({
      status: 'ok',
      toolCount: 1,
      elapsedMs: 10,
    }));
    const { output } = await captureOutput(() =>
      runDoctorCommand([], {
        probeMcpServer: probeStub,
        nodePty: async () => ({ status: 'unavailable', detail: 'Cannot find module node-pty', installed: false }),
      }),
    );
    const environment = output.slice(output.indexOf('Environment'), output.indexOf('Configuration'));
    expect(environment).toMatch(/⚠ node-pty\s+is not installed: Cannot find module node-pty/);
    expect(environment).toContain('npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty');
  });

  it('prints a Preferred mode line in the Configuration section', async () => {
    // Docker availability varies by env; only assert the line is labeled.
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn<ServerProbe>(async (): Promise<ProbeResult> => ({
      status: 'ok',
      toolCount: 1,
      elapsedMs: 10,
    }));
    const { output } = await captureOutput(() => runDoctorCommand([], { probeMcpServer: probeStub }));
    expect(output).toContain('Preferred mode');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkOAuthRefresh
// ---------------------------------------------------------------------------

describe('checkOAuthRefresh', () => {
  const baseConfig = buildConfig();
  const oauthAuth = {
    kind: 'oauth' as const,
    source: 'file' as const,
    filePath: '/home/user/.claude/.credentials.json',
    credentials: { accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() + 60_000 },
  };
  const freshCreds = { accessToken: 'new', refreshToken: 'rt-new', expiresAt: Date.now() + 3_600_000 };

  it('skips when no OAuth credentials are present', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce({ kind: 'none' });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('skip');
    expect(r.message).toMatch(/no OAuth credentials/);
  });

  it('returns ok and persists rotated credentials on successful refresh', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'ok', credentials: freshCreds });
    vi.mocked(saveOAuthCredentials).mockReturnValueOnce(freshCreds);
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/valid \(.*, file\)/);
    expect(saveOAuthCredentials).toHaveBeenCalledWith(freshCreds, oauthAuth.filePath, { refreshedFrom: 'rt-old' });
  });

  it('reports HTTP rejection with the status code and a re-login hint', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'http-error', status: 401 });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/HTTP 401/);
    expect(r.hint).toMatch(/Refresh token has been invalidated/);
  });

  it('reports network errors with the underlying message', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'network-error', message: 'ECONNRESET' });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/network error/);
    expect(r.hint).toBe('ECONNRESET');
  });

  it('reports parse errors with the detail', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'parse-error', detail: 'missing access_token' });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/unparseable/);
    expect(r.hint).toBe('missing access_token');
  });

  it('reports persistence failure separately so the user knows credentials are now invalid', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'ok', credentials: freshCreds });
    vi.mocked(saveOAuthCredentials).mockImplementationOnce(() => {
      throw new Error('EACCES: write denied');
    });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/refresh succeeded but persistence failed/);
    expect(r.message).toMatch(/EACCES/);
    expect(r.hint).toMatch(/Run `claude login`/);
  });
});

// ---------------------------------------------------------------------------
// Unit: checkAgentApiRoundtrip
// ---------------------------------------------------------------------------

describe('checkAgentApiRoundtrip', () => {
  const baseConfig = buildConfig();
  const fakeModel = {} as never;

  function configWithApiKey(provider: 'anthropic' | 'openai' | 'google', key: string) {
    return buildConfig({
      agentModelId: `${provider}:test-model`,
      userConfig: { ...baseConfig.userConfig, [`${provider}ApiKey`]: key },
    });
  }

  function configWithZaiKey(apiKey: string) {
    return buildConfig({
      userConfig: {
        ...baseConfig.userConfig,
        hostModelProfiles: { agent: 'glm' },
        modelProviders: {
          default: 'native',
          profiles: {
            glm: {
              type: 'zai',
              apiKey,
              plan: 'api',
              model: 'glm-5.3',
              modelMap: [],
              usesDefaultMap: false,
              perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
            },
          },
        },
      },
    });
  }

  it('identifies a named Z.AI agent route in a successful diagnostic', async () => {
    vi.mocked(createLanguageModel).mockResolvedValueOnce(fakeModel);
    vi.mocked(generateText).mockResolvedValueOnce({} as never);
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(configWithZaiKey('zai-key'));
    expect(r).toMatchObject({ name: 'Z.AI API round-trip', status: 'ok' });
  });

  it('does not treat missing named-profile credentials as an unrelated OAuth setup', async () => {
    const priorAuthCalls = vi.mocked(detectAuthMethod).mock.calls.length;
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(configWithZaiKey(''));
    expect(r).toMatchObject({ name: 'Z.AI API round-trip', status: 'skip' });
    expect(r.message).toContain('host agent profile "glm"');
    expect(r.hint).toContain('ZAI_API_KEY');
    expect(detectAuthMethod).toHaveBeenCalledTimes(priorAuthCalls);
  });

  it('skips with provider-aware message when no API key is set and provider is non-Anthropic', async () => {
    // For non-Anthropic providers the OAuth fallback branch is short-circuited,
    // so detectAuthMethod is never called — no need to mock it here.
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(buildConfig({ agentModelId: 'openai:gpt-4' }));
    expect(r.name).toBe('OpenAI API round-trip');
    expect(r.status).toBe('skip');
    expect(r.message).toMatch(/no OpenAI API key/);
  });

  it('skips with OAuth-aware message when Anthropic provider has OAuth but no API key', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce({
      kind: 'oauth',
      source: 'file',
      credentials: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 },
    });
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(baseConfig);
    expect(r.name).toBe('Anthropic API round-trip');
    expect(r.status).toBe('skip');
    expect(r.message).toMatch(/OAuth-only setup/);
  });

  it('reports ok with elapsed time on a successful round-trip', async () => {
    vi.mocked(createLanguageModel).mockResolvedValueOnce(fakeModel);
    vi.mocked(generateText).mockResolvedValueOnce({} as never);
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(configWithApiKey('anthropic', 'sk-test'));
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/responded in/);
  });

  it('extracts url, status, cause, and code from AI SDK errors via describeApiError', async () => {
    vi.mocked(createLanguageModel).mockResolvedValueOnce(fakeModel);
    const sdkError = Object.assign(new Error('Cannot connect to API'), {
      url: 'https://api.anthropic.com/v1/messages',
      statusCode: 500,
      cause: Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }),
    });
    vi.mocked(generateText).mockRejectedValueOnce(sdkError);
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(configWithApiKey('anthropic', 'sk-test'));
    expect(r.status).toBe('fail');
    expect(r.message).toContain('Cannot connect to API');
    expect(r.message).toContain('url=https://api.anthropic.com/v1/messages');
    expect(r.message).toContain('status=500');
    expect(r.message).toContain('cause=fetch failed');
    expect(r.message).toContain('code=ECONNREFUSED');
  });

  it('passes a timeout abortSignal to generateText so a hung provider cannot block doctor', async () => {
    vi.mocked(createLanguageModel).mockResolvedValueOnce(fakeModel);
    vi.mocked(generateText).mockResolvedValueOnce({} as never);
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    await checkAgentApiRoundtrip(configWithApiKey('anthropic', 'sk-test'));
    const callArgs = vi.mocked(generateText).mock.calls[0][0] as {
      abortSignal?: AbortSignal;
      maxRetries?: number;
    };
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArgs.maxRetries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: checkHostModelApiRoundtrips / checkHostModelRouting
// ---------------------------------------------------------------------------

describe('checkHostModelApiRoundtrips', () => {
  const baseConfig = buildConfig();
  const fakeModel = {} as never;

  function withUserConfig(userConfig: Partial<IronCurtainConfig['userConfig']>, agentModelId?: string) {
    return buildConfig({
      ...(agentModelId ? { agentModelId } : {}),
      userConfig: { ...baseConfig.userConfig, anthropicApiKey: 'sk-test', openaiApiKey: 'sk-openai', ...userConfig },
    });
  }

  it('round-trips every enabled role with its own model, summary first, sharing one call per model', async () => {
    vi.mocked(createLanguageModel).mockClear();
    vi.mocked(createLanguageModel).mockResolvedValue(fakeModel);
    vi.mocked(generateText).mockResolvedValue({} as never);
    const { checkHostModelApiRoundtrips } = await import('../src/doctor/checks.js');
    const results = await checkHostModelApiRoundtrips(
      withUserConfig({
        policyModelId: 'openai:gpt-test',
        prefilterModelId: 'anthropic:claude-haiku-4-5',
        autoCompact: { ...baseConfig.userConfig.autoCompact, summaryModelId: 'anthropic:claude-haiku-4-5' },
        autoApprove: { enabled: false, modelId: 'anthropic:never-checked' },
      }),
    );

    expect(results.map((r) => [r.name, r.status, r.message.split(':')[0]])).toEqual([
      ['Anthropic API round-trip', 'ok', 'summary, prefilter (anthropic'],
      ['Anthropic API round-trip', 'ok', 'agent (anthropic'],
      ['OpenAI API round-trip', 'ok', 'policy (openai'],
    ]);
    expect(results[0].message).toContain('(anthropic:claude-haiku-4-5): responded in');
    const requested = vi.mocked(createLanguageModel).mock.calls.map((call) => [call[0], call[2]]);
    expect(requested).toEqual([
      ['anthropic:claude-haiku-4-5', 'summary'],
      ['anthropic:claude-sonnet-4-6', 'agent'],
      ['openai:gpt-test', 'policy'],
    ]);
    vi.mocked(createLanguageModel).mockReset();
    vi.mocked(generateText).mockReset();
  });

  it('checks the auto-approver only when it is enabled, and names the role on failure', async () => {
    vi.mocked(createLanguageModel).mockResolvedValue(fakeModel);
    vi.mocked(generateText).mockRejectedValue(new Error('model not found'));
    const { checkHostModelApiRoundtrips } = await import('../src/doctor/checks.js');
    const results = await checkHostModelApiRoundtrips(
      withUserConfig({
        autoCompact: { ...baseConfig.userConfig.autoCompact, enabled: false },
        autoApprove: { enabled: true, modelId: 'anthropic:claude-typo' },
      }),
    );

    const approver = results.find((r) => r.message.startsWith('autoApprove'));
    expect(approver).toMatchObject({ status: 'fail' });
    expect(approver?.message).toContain('autoApprove (anthropic:claude-typo): model not found');
    expect(approver?.hint).toContain('autoApprove.modelId');
    expect(results.some((r) => r.message.startsWith('summary'))).toBe(false);
    vi.mocked(createLanguageModel).mockReset();
    vi.mocked(generateText).mockReset();
  });

  // The outbound content check (contentAssessment) is a host role too: its
  // model is round-tripped through its own profile once its LLM check is on.
  it('checks the outbound content check model only when its LLM check is on', async () => {
    vi.mocked(createLanguageModel).mockClear();
    vi.mocked(createLanguageModel).mockResolvedValue(fakeModel);
    vi.mocked(generateText).mockRejectedValue(new Error('model not found'));
    const { checkHostModelApiRoundtrips } = await import('../src/doctor/checks.js');
    const run = (llmCheck: boolean) =>
      checkHostModelApiRoundtrips(
        withUserConfig({
          autoCompact: { ...baseConfig.userConfig.autoCompact, enabled: false },
          contentAssessment: { enabled: true, llmCheck, llmModelId: 'openai:gpt-assess' },
        }),
      );

    expect((await run(false)).some((r) => r.message.startsWith('contentAssessment'))).toBe(false);

    const assessment = (await run(true)).find((r) => r.message.startsWith('contentAssessment'));
    expect(assessment).toMatchObject({ name: 'OpenAI API round-trip', status: 'fail' });
    expect(assessment?.message).toContain('contentAssessment (openai:gpt-assess): model not found');
    expect(assessment?.hint).toContain('contentAssessment.llmModelId');
    expect(vi.mocked(createLanguageModel).mock.calls.map((call) => [call[0], call[2]])).toContainEqual([
      'openai:gpt-assess',
      'contentAssessment',
    ]);
    vi.mocked(createLanguageModel).mockReset();
    vi.mocked(generateText).mockReset();
  });
});

describe('checkConfigLoad', () => {
  let home: string;
  const savedHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-config-'));
    process.env.IRONCURTAIN_HOME = home;
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('warns about unknown nested fields instead of reporting a clean parse', async () => {
    writeFileSync(resolve(home, 'config.json'), JSON.stringify({ resourceBudget: { maxStep: 5 } }), { mode: 0o600 });
    const { checkConfigLoad } = await import('../src/doctor/checks.js');

    const { result, config } = checkConfigLoad();

    expect(config).toBeDefined();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('resourceBudget.maxStep (did you mean resourceBudget.maxSteps?)');
  });

  it('reports a clean parse when every field is known', async () => {
    writeFileSync(resolve(home, 'config.json'), JSON.stringify({ resourceBudget: { maxSteps: 5 } }), { mode: 0o600 });
    const { checkConfigLoad } = await import('../src/doctor/checks.js');

    expect(checkConfigLoad().result).toMatchObject({ status: 'ok', message: 'parsed cleanly' });
  });
});

describe('checkHostModelRouting', () => {
  const baseConfig = buildConfig();
  const router = {
    type: 'openrouter' as const,
    apiKey: 'sk-or-v1-x',
    modelMap: [],
    usesDefaultMap: false,
    perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
    providerPreference: undefined,
    sessionAffinity: true,
  };

  it('warns about a gateway-bound role whose model ID the gateway cannot route', async () => {
    const { checkHostModelRouting } = await import('../src/doctor/checks.js');
    const r = checkHostModelRouting(
      buildConfig({
        userConfig: {
          ...baseConfig.userConfig,
          hostModelProfiles: { policy: 'router' },
          modelProviders: { default: 'native', profiles: { native: { type: 'native' }, router } },
        },
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('Host role "policy" (profile "router")');
    expect(r.message).toContain('"claude-sonnet-4-6"');
  });

  it('skips when no role is bound to a gateway', async () => {
    const { checkHostModelRouting } = await import('../src/doctor/checks.js');
    expect(checkHostModelRouting(baseConfig).status).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// Smoke: CheckResult shape stays stable
// ---------------------------------------------------------------------------

describe('CheckResult shape', () => {
  it('all unit checks return a name, status, and message', () => {
    const samples: CheckResult[] = [
      checkNodeVersion('24.0.0'),
      checkAnnotationDrift({ generatedAt: '', servers: {} }, {}),
    ];
    for (const r of samples) {
      expect(typeof r.name).toBe('string');
      expect(['ok', 'warn', 'fail', 'skip']).toContain(r.status);
      expect(typeof r.message).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// WP-106: read-only doctor, sandbox-aware probes, no-refresh --check-api,
// per-role credentials, version state
// ---------------------------------------------------------------------------

describe('runDoctorCommand stays read-only', () => {
  let root: string;
  let home: string;
  const saved = {
    home: process.env.IRONCURTAIN_HOME,
    allowed: process.env.ALLOWED_DIRECTORY,
    color: process.env.FORCE_COLOR,
    policy: process.env.IRONCURTAIN_SANDBOX_POLICY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };
  const savedChalkLevel = chalk.level;
  const sandboxAvailable: OsSandboxAvailability = {
    available: true,
    platformSupported: true,
    problems: [],
    warnings: [],
  };
  const smokeOk = async (): Promise<OsSandboxSmokeResult> => ({ ok: true, elapsedMs: 5, detail: 'ok' });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-ro-'));
    // Not created: a fresh install.
    home = join(root, 'home');
    process.env.IRONCURTAIN_HOME = home;
    delete process.env.ALLOWED_DIRECTORY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.IRONCURTAIN_SANDBOX_POLICY = 'warn';
    process.env.FORCE_COLOR = '0';
    chalk.level = 0;
  });

  afterEach(() => {
    restore('IRONCURTAIN_HOME', saved.home);
    restore('ALLOWED_DIRECTORY', saved.allowed);
    restore('FORCE_COLOR', saved.color);
    restore('IRONCURTAIN_SANDBOX_POLICY', saved.policy);
    restore('ANTHROPIC_API_KEY', saved.anthropic);
    chalk.level = savedChalkLevel;
    rmSync(root, { recursive: true, force: true });
  });

  it('creates no config.json, and nothing else in the home, on a fresh install', async () => {
    const allowedDirectories: string[] = [];
    const probe: ServerProbe = async (_name, _config, context) => {
      allowedDirectories.push(context.environment().allowedDirectory);
      return { status: 'ok', toolCount: 1, elapsedMs: 1 };
    };
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const { output } = await captureOutput(() =>
      runDoctorCommand([], {
        probeMcpServer: probe,
        osSandbox: { availability: () => sandboxAvailable, smokeTest: smokeOk },
      }),
    );
    expect(output).toMatch(/User config\s+not created yet; the defaults apply/);
    expect(output).toMatch(/IronCurtain version\s+\S+ \(new home\)/);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
    // Not even the home: no V8 cache marker, no sandbox directory, no state.json.
    expect(existsSync(home)).toBe(false);
    // The probes ran against a temporary stand-in for the missing sandbox.
    expect(allowedDirectories.length).toBeGreaterThan(0);
    expect(allowedDirectories.every((dir) => !dir.startsWith(home))).toBe(true);
    // ...which is removed again.
    expect(allowedDirectories.some((dir) => existsSync(dir))).toBe(false);
  }, 60_000);

  it('reports a missing bwrap and names the servers that would run unconfined', async () => {
    const missingBwrap = getOsSandboxAvailability(
      () => ({ platformSupported: true, errors: ['bubblewrap (bwrap) not installed'], warnings: [] }),
      'linux',
    );
    const probe = vi.fn<ServerProbe>(async () => ({ status: 'ok', toolCount: 1, elapsedMs: 1 }));
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const { output } = await captureOutput(() =>
      runDoctorCommand([], { probeMcpServer: probe, osSandbox: { availability: () => missingBwrap } }),
    );
    expect(output).toMatch(
      /⚠ OS sandbox\s+unavailable \(bubblewrap \(bwrap\) not installed\); .*git.* will run WITHOUT OS containment/,
    );
    expect(output).toContain('sudo apt-get install -y bubblewrap socat ripgrep');
  }, 60_000);

  it('--check-api validates the OAuth access token without a refresh grant or any credential write', async () => {
    vi.mocked(refreshOAuthToken).mockClear();
    vi.mocked(saveOAuthCredentials).mockClear();
    vi.mocked(writeToKeychain).mockClear();
    vi.mocked(detectAuthMethod).mockImplementation(async () => ({
      kind: 'oauth',
      source: 'file',
      filePath: join(root, 'credentials.json'),
      credentials: { accessToken: 'at-current', refreshToken: 'rt-current', expiresAt: Date.now() + 3_600_000 },
    }));
    const fetchStub = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    try {
      const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
      const { output } = await captureOutput(() =>
        runDoctorCommand(['--check-api'], {
          probeMcpServer: async () => ({ status: 'ok', toolCount: 1, elapsedMs: 1 }),
          osSandbox: { availability: () => sandboxAvailable, smokeTest: smokeOk },
          oauth: { fetch: fetchStub },
        }),
      );
      expect(refreshOAuthToken).not.toHaveBeenCalled();
      expect(saveOAuthCredentials).not.toHaveBeenCalled();
      expect(writeToKeychain).not.toHaveBeenCalled();
      expect(fetchStub).toHaveBeenCalledOnce();
      const [url, init] = fetchStub.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer at-current');
      expect(output).toMatch(/Anthropic OAuth\s+access token accepted by api\.anthropic\.com .*expires in/);
      expect(output).not.toMatch(/OAuth refresh/);
    } finally {
      vi.mocked(detectAuthMethod).mockReset();
    }
  }, 60_000);

  it('--check-api round-trips every host model role; only --check-refresh runs the refresh grant', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(refreshOAuthToken).mockClear();
    vi.mocked(saveOAuthCredentials).mockClear();
    vi.mocked(createLanguageModel).mockResolvedValue({} as never);
    vi.mocked(generateText).mockResolvedValue({} as never);
    vi.mocked(detectAuthMethod).mockImplementation(async () => ({
      kind: 'oauth',
      source: 'file',
      filePath: join(root, 'credentials.json'),
      credentials: { accessToken: 'at-current', refreshToken: 'rt-current', expiresAt: Date.now() - 60_000 },
    }));
    vi.mocked(refreshOAuthToken).mockResolvedValue({ kind: 'http-error', status: 400 });
    const deps = {
      probeMcpServer: async () => ({ status: 'ok' as const, toolCount: 1, elapsedMs: 1 }),
      osSandbox: { availability: () => sandboxAvailable, smokeTest: smokeOk },
      oauth: { fetch: vi.fn<typeof fetch>() },
    };
    try {
      const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
      const api = await captureOutput(() => runDoctorCommand(['--check-api'], deps));
      // One round-trip per host role, each with its own model (roles sharing a model share a line).
      for (const role of ['summary', 'agent', 'policy', 'prefilter']) {
        expect(api.output).toMatch(new RegExp(`API round-trip\\s+[^\\n]*\\b${role}\\b[^\\n]*responded in`));
      }
      expect(refreshOAuthToken).not.toHaveBeenCalled();
      expect(api.output).not.toMatch(/OAuth refresh/);

      const refresh = await captureOutput(() => runDoctorCommand(['--check-refresh'], deps));
      expect(refreshOAuthToken).toHaveBeenCalledOnce();
      expect(refresh.output).toMatch(/OAuth refresh/);
      // The refresh grant alone: no model round-trip.
      expect(refresh.output).not.toMatch(/responded in/);
    } finally {
      vi.mocked(detectAuthMethod).mockReset();
      vi.mocked(refreshOAuthToken).mockReset();
      vi.mocked(createLanguageModel).mockReset();
      vi.mocked(generateText).mockReset();
    }
  }, 60_000);

  it('flags a lastRunVersion mismatch and points at doctor --upgrade, without recording the version', async () => {
    mkdirSync(home, { mode: 0o700 });
    const state = JSON.stringify({ layoutVersion: 1, lastRunVersion: '0.0.1' });
    writeFileSync(join(home, 'state.json'), state, { mode: 0o600 });
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const { output } = await captureOutput(() =>
      runDoctorCommand([], {
        probeMcpServer: async () => ({ status: 'ok', toolCount: 1, elapsedMs: 1 }),
        osSandbox: { availability: () => sandboxAvailable, smokeTest: smokeOk },
      }),
    );
    expect(output).toContain(`IronCurtain version     ${VERSION}; this home was last used by 0.0.1`);
    expect(output).toContain('ironcurtain doctor --upgrade');
    expect(readFileSync(join(home, 'state.json'), 'utf-8')).toBe(state);
  }, 60_000);

  it('fails a home whose layout is newer than this version supports', async () => {
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'state.json'), JSON.stringify({ layoutVersion: 99, lastRunVersion: '9.0.0' }));
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const { output, exitCode } = await captureOutput(() =>
      runDoctorCommand([], {
        probeMcpServer: async () => ({ status: 'ok', toolCount: 1, elapsedMs: 1 }),
        osSandbox: { availability: () => sandboxAvailable, smokeTest: smokeOk },
      }),
    );
    expect(output).toMatch(/✗ IronCurtain version\s+The IronCurtain home .* has layout version 99/);
    expect(exitCode).toBe(1);
  }, 60_000);
});

describe('checkPreferredMode derives the builtin credential from the agent model', () => {
  const base = buildConfig().userConfig;

  it('accepts an OpenAI agent model with only an OpenAI key', () => {
    const config = buildConfig({
      userConfig: { ...base, preferredMode: 'builtin', agentModelId: 'openai:gpt-5', openaiApiKey: 'sk-openai' },
    });
    expect(checkPreferredMode(config, { name: 'Docker', status: 'warn', message: 'x' })).toMatchObject({
      status: 'ok',
      message: 'builtin',
    });
  });

  it("names the agent model's provider key when it is missing", () => {
    const config = buildConfig({
      userConfig: { ...base, preferredMode: 'builtin', agentModelId: 'openai:gpt-5', anthropicApiKey: 'sk-ant' },
    });
    const result = checkPreferredMode(config, { name: 'Docker', status: 'ok', message: 'running' });
    expect(result.status).toBe('warn');
    expect(result.message).toContain('no OPENAI_API_KEY configured for openai:gpt-5');
  });
});

describe('checkModelCredentials', () => {
  const base = buildConfig().userConfig;

  it('checks every role in use against the key it resolves at run time', () => {
    const results = checkModelCredentials({
      ...base,
      preferredMode: 'builtin',
      agentModelId: 'openai:gpt-5',
      openaiApiKey: 'sk-openai',
      autoApprove: { enabled: true, modelId: 'google:gemini-2.5-flash' },
    });
    expect(results.find((r) => r.name === 'Agent model')).toMatchObject({ status: 'ok' });
    const autoApprove = results.find((r) => r.name === 'Auto-approve model');
    expect(autoApprove).toMatchObject({ status: 'warn' });
    expect(autoApprove?.message).toContain('no GOOGLE_GENERATIVE_AI_API_KEY; the auto-approver will fail');
    expect(autoApprove?.hint).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('checks a profile-routed role against its profile key and leaves disabled roles out', () => {
    const savedHome = process.env.IRONCURTAIN_HOME;
    const home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-roles-'));
    process.env.IRONCURTAIN_HOME = home;
    const userConfig = {
      ...base,
      anthropicApiKey: 'sk-ant',
      autoCompact: { ...base.autoCompact, enabled: false },
      hostModelProfiles: { policy: 'glm' },
      modelProviders: {
        default: 'native',
        profiles: {
          native: { type: 'native' },
          glm: {
            type: 'zai',
            apiKey: '',
            plan: 'api',
            model: 'glm-5.3',
            modelMap: [],
            usesDefaultMap: false,
            perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
          },
        },
      },
    } as never;
    try {
      // No persona, job or compiled policy of the user's own: compiling is not in use yet.
      const idle = checkModelCredentials(userConfig).find((r) => r.name === 'Policy model');
      expect(idle).toMatchObject({ status: 'skip' });
      expect(idle?.message).toContain('no API key for provider profile "glm"');

      // With a persona, its policy must be compiled (on creation, edits and upgrades).
      mkdirSync(join(home, 'personas', 'helper'), { recursive: true });
      const results = checkModelCredentials(userConfig);
      const policy = results.find((r) => r.name === 'Policy model');
      expect(policy).toMatchObject({ status: 'warn' });
      expect(policy?.message).toContain('policy compilation');
      expect(policy?.hint).toContain('ZAI_API_KEY');
      expect(results.find((r) => r.name === 'Prefilter model')).toMatchObject({ status: 'ok' });
      expect(results.some((r) => r.name === 'Summary model')).toBe(false);
    } finally {
      if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("checks the outbound content check's model only while that LLM check is on", () => {
    const off = checkModelCredentials({
      ...base,
      contentAssessment: { enabled: true, llmCheck: false, llmModelId: 'openai:gpt-5-mini' },
    });
    expect(off.some((r) => r.name === 'Content assessment model')).toBe(false);

    const on = checkModelCredentials({
      ...base,
      contentAssessment: { enabled: true, llmCheck: true, llmModelId: 'openai:gpt-5-mini' },
    });
    const assessment = on.find((r) => r.name === 'Content assessment model');
    expect(assessment).toMatchObject({ status: 'warn' });
    expect(assessment?.message).toBe(
      'openai:gpt-5-mini: no OPENAI_API_KEY; the outbound content intelligibility check will fail',
    );
    expect(assessment?.hint).toContain('OPENAI_API_KEY');

    const keyed = checkModelCredentials({
      ...base,
      openaiApiKey: 'sk-openai',
      contentAssessment: { enabled: true, llmCheck: true, llmModelId: 'openai:gpt-5-mini' },
    });
    expect(keyed.find((r) => r.name === 'Content assessment model')).toMatchObject({ status: 'ok' });
  });
});

describe('checkContainerAgentCredentials', () => {
  const base = buildConfig().userConfig;

  it('checks the default gateway key even when native credentials are available', () => {
    for (const apiKey of ['', 'private-fixture-key']) {
      const result = checkContainerAgentCredentials(
        {
          ...base,
          preferredDockerAgent: 'codex',
          anthropicApiKey: 'unrelated-fixture',
          modelProviders: {
            default: 'team',
            profiles: { team: resolveProviderProfile({ type: 'openrouter', apiKey }) },
          },
        },
        { name: 'Codex (ChatGPT)', status: 'ok', message: 'OAuth' },
      );
      expect(result?.status).toBe(apiKey ? 'ok' : 'fail');
      expect(result?.message).toContain('team');
      if (!apiKey) expect(result?.hint).toContain('OPENROUTER_API_KEY');
      expect(JSON.stringify(result)).not.toContain('private-fixture-key');
    }
  });

  it('checks the native Goose provider key independently of the host model', () => {
    const userConfig = {
      ...base,
      preferredDockerAgent: 'goose',
      gooseProvider: 'google',
      anthropicApiKey: 'fixture',
    } as const;
    expect(checkContainerAgentCredentials(userConfig, undefined)).toMatchObject({
      status: 'fail',
      hint: expect.stringContaining('GOOGLE_GENERATIVE_AI_API_KEY'),
    });
    expect(checkContainerAgentCredentials({ ...userConfig, googleApiKey: 'fixture' }, undefined)?.status).toBe('ok');
  });

  it('reports an absent native Codex login only when that agent is selected', () => {
    const codex = { ...base, preferredDockerAgent: 'codex' } as const;
    expect(checkContainerAgentCredentials(codex, undefined)).toMatchObject({
      status: 'fail',
      hint: expect.stringContaining('codex login'),
    });
    expect(checkContainerAgentCredentials({ ...codex, preferredMode: 'builtin' }, undefined)).toBeUndefined();
    expect(checkContainerAgentCredentials(base, undefined)).toBeUndefined();
  });
});

describe('OAuth checks without refresh grants', () => {
  const config = buildConfig();
  const oauthFile = {
    kind: 'oauth' as const,
    source: 'file' as const,
    filePath: '/x/.credentials.json',
    credentials: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 },
  };

  it('fails a rejected Anthropic access token with the login hint', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthFile);
    const fetchStub = vi.fn<typeof fetch>(async () => new Response('', { status: 401 }));
    const result = await checkAnthropicOAuthToken(config, { fetch: fetchStub });
    expect(result).toMatchObject({ status: 'fail' });
    expect(result.hint).toContain('claude login');
  });

  it('does not send or refresh an expired access token', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce({
      ...oauthFile,
      credentials: { ...oauthFile.credentials, expiresAt: Date.now() - 60_000 },
    });
    vi.mocked(refreshOAuthToken).mockClear();
    const fetchStub = vi.fn<typeof fetch>();
    const result = await checkAnthropicOAuthToken(config, { fetch: fetchStub });
    expect(result.status).toBe('skip');
    expect(result.hint).toContain('--check-refresh');
    expect(fetchStub).not.toHaveBeenCalled();
    expect(refreshOAuthToken).not.toHaveBeenCalled();
  });

  it('never refreshes Keychain-stored credentials under --check-refresh', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce({
      kind: 'oauth',
      source: 'keychain',
      keychainServiceName: 'Claude Code-credentials',
      credentials: oauthFile.credentials,
    });
    vi.mocked(refreshOAuthToken).mockClear();
    vi.mocked(writeToKeychain).mockClear();
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const result = await checkOAuthRefresh(config);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('never writes the Keychain');
    expect(refreshOAuthToken).not.toHaveBeenCalled();
    expect(writeToKeychain).not.toHaveBeenCalled();
  });

  describe('IronCurtain OAuth providers', () => {
    let home: string;
    const savedHome = process.env.IRONCURTAIN_HOME;
    const withGoogle = buildConfig({ mcpServers: { 'google-workspace': buildServerConfig() } });

    beforeEach(() => {
      home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-oauth-'));
      process.env.IRONCURTAIN_HOME = home;
      mkdirSync(join(home, 'oauth'), { mode: 0o700 });
      writeFileSync(
        join(home, 'oauth', 'google-credentials.json'),
        JSON.stringify({ installed: { client_id: 'cid', client_secret: 'csecret' } }),
        { mode: 0o600 },
      );
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    });

    function writeToken(expiresAt: number): void {
      writeFileSync(
        join(home, 'oauth', 'google.json'),
        JSON.stringify({ accessToken: 'ya29.token', refreshToken: 'rt', expiresAt, scopes: ['a', 'b'] }),
        { mode: 0o600 },
      );
    }

    it('warns when the client credentials are imported but nothing is authorized', () => {
      const [result] = checkOAuthProviders(withGoogle);
      expect(result).toMatchObject({ name: 'Google Workspace', status: 'warn' });
      expect(result.message).toContain('not authorized; sessions skip google-workspace');
    });

    it('reports the access token expiry, and a likely dead Testing-mode refresh token', () => {
      writeToken(Date.now() + 30 * 60_000);
      expect(checkOAuthProviders(withGoogle)[0]).toMatchObject({ status: 'ok' });

      writeToken(Date.now() - 60_000);
      const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(join(home, 'oauth', 'google.json'), tenDaysAgo, tenDaysAgo);
      const [stale] = checkOAuthProviders(withGoogle);
      expect(stale.status).toBe('warn');
      expect(stale.hint).toContain('"Testing" status');
    });

    it('validates the access token by a form POST, never in the URL', async () => {
      writeToken(Date.now() + 30 * 60_000);
      const fetchStub = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ expires_in: '1700' }), { status: 200 }),
      );
      const [result] = await checkOAuthProviderTokens(withGoogle, { fetch: fetchStub });
      expect(result).toMatchObject({ name: 'Google Workspace token', status: 'ok' });
      expect(result.message).toContain('expires in 28m');
      const [url, init] = fetchStub.mock.calls[0];
      expect(url).toBe('https://oauth2.googleapis.com/tokeninfo');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('access_token=ya29.token');
    });

    describe('--check-refresh', () => {
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it('tests the refresh token as a relay does and saves the new access token', async () => {
        writeToken(Date.now() - 60_000);
        const fetchStub = vi.fn<typeof fetch>(
          async () => new Response(JSON.stringify({ access_token: 'ya29.fresh', expires_in: 3599 }), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchStub);
        const [result] = await checkOAuthProviderRefresh(withGoogle);
        expect(result).toMatchObject({ name: 'Google Workspace refresh', status: 'ok' });
        const [url, init] = fetchStub.mock.calls[0];
        expect(url).toBe('https://oauth2.googleapis.com/token');
        const body = typeof init?.body === 'string' ? init.body : '';
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=rt');
        const stored = JSON.parse(readFileSync(join(home, 'oauth', 'google.json'), 'utf-8')) as Record<string, unknown>;
        // Google keeps the refresh token: only the access token changes.
        expect(stored).toMatchObject({ accessToken: 'ya29.fresh', refreshToken: 'rt' });
      });

      it('fails a rejected refresh token and names the re-authorization', async () => {
        writeToken(Date.now() - 60_000);
        vi.stubGlobal(
          'fetch',
          vi.fn<typeof fetch>(async () => new Response('{"error":"invalid_grant"}', { status: 400 })),
        );
        const [result] = await checkOAuthProviderRefresh(withGoogle);
        expect(result).toMatchObject({ name: 'Google Workspace refresh', status: 'fail' });
        expect(result.message).toContain('invalid_grant');
        expect(result.hint).toContain('`ironcurtain auth google`');
        // The stored token is left as it was.
        expect(JSON.parse(readFileSync(join(home, 'oauth', 'google.json'), 'utf-8'))).toMatchObject({
          accessToken: 'ya29.token',
        });
      });

      it('reports a refresh that could not reach the provider without blaming the refresh token', async () => {
        writeToken(Date.now() - 60_000);
        vi.stubGlobal(
          'fetch',
          vi.fn<typeof fetch>(async () => {
            throw new TypeError('fetch failed');
          }),
        );
        const [result] = await checkOAuthProviderRefresh(withGoogle);
        expect(result).toMatchObject({ status: 'fail', message: 'the refresh could not be completed: fetch failed' });
        expect(result.hint).toBeUndefined();
      });

      it('sends nothing for a provider that is not authorized', async () => {
        const fetchStub = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchStub);
        expect(await checkOAuthProviderRefresh(withGoogle)).toEqual([]);
        expect(fetchStub).not.toHaveBeenCalled();
      });
    });
  });

  it('reports a Codex ChatGPT login when there is one', () => {
    const savedCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-codex-'));
    process.env.CODEX_HOME = codexHome;
    try {
      expect(checkCodexCredentials()).toBeUndefined();
      const exp = Math.floor(Date.now() / 1000) + 7200;
      const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
      writeFileSync(
        join(codexHome, 'auth.json'),
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt, refresh_token: 'rt' } }),
      );
      expect(checkCodexCredentials()).toMatchObject({ name: 'Codex (ChatGPT)', status: 'ok' });
    } finally {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
