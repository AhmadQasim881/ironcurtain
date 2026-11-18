import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentImageResolution,
  DockerInfrastructure,
  PreContainerInfrastructure,
} from '../src/docker/docker-infrastructure.js';
import {
  AGENT_OPEN_FILES_LIMIT,
  HOST_ROOT_EXPOSURE_WARNING,
  TRANSPORT_SIDECAR_LIMITS,
  assertLinuxDockerHostIdentity,
  buildAgentUidRemap,
  buildDockerAgentTrustedCreateOptions,
  buildDockerDesktopTransportCreateLimits,
  prepareConversationStateDir,
  createSessionContainers,
  destroyDockerInfrastructure,
  prepareDockerInfrastructure,
  resolveRealKey,
  canRefreshOAuth,
  computeDockerBuildHash,
  computeWorkflowDependencyHash,
  buildWorkflowExecCommand,
  checkDockerContainerWritableStorage,
  resolveAgentImage,
  selectResumableSnapshot,
  warnWhenContainerRootIsHostRoot,
} from '../src/docker/docker-infrastructure.js';
import { buildCreateArgs } from '../src/docker/docker-manager.js';
import { ROOT_HOST_IDENTITY_MESSAGE } from '../src/docker/container-identity.js';
import type { DockerServerFacts } from '../src/docker/docker-probe.js';
import * as logger from '../src/logger.js';
import * as hostMountScan from '../src/docker/host-mount-privilege-scan.js';
import type { AgentAdapter, AgentId, ConversationStateConfig } from '../src/docker/agent-adapter.js';
import type { DockerProxy } from '../src/docker/code-mode-proxy.js';
import type { MitmProxy } from '../src/docker/mitm-proxy.js';
import type { ContainerRuntime } from '../src/docker/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ResolvedProviderProfile, ResolvedUserConfig } from '../src/config/user-config.js';
import { resolveActiveProfile, USER_CONFIG_DEFAULTS } from '../src/config/user-config.js';
import { generateFakeKey } from '../src/docker/fake-keys.js';
import { makeOpenRouterProvider, makeOpenRouterRewriter } from '../src/docker/openrouter.js';
import { getInternalNetworkName } from '../src/docker/platform.js';
import {
  dockerAllocationPoolForSubnet,
  ironCurtainInternalSubnetHostAddress,
  IRONCURTAIN_MANAGED_LABEL,
  IRONCURTAIN_OWNER_TOKEN_LABEL,
} from '../src/docker/docker-resource-lifecycle.js';
import { getBundleShortId, type BundleId } from '../src/session/types.js';
import type { WorkflowId } from '../src/workflow/types.js';
import {
  planWorkflowDependencyLayers,
  provisionedRecordPath,
  WORKFLOW_DEPENDENCY_MANIFESTS_DIR,
  type WorkflowDependencyLayer,
  type WorkflowDependencyLayers,
} from '../src/docker/workflow-dependency-cache.js';

// Container target the mock adapter advertises via `skills.containerPath`.
// Hardcoded here (rather than imported from a constant) because the
// adapter contract makes this per-adapter — the test asserts the wired
// target matches what the adapter declared. Matches the post-refactor
// Claude Code path (a sibling of the conversation-state mount, NOT
// nested under it).
const TEST_SKILLS_CONTAINER_PATH = '/home/codespace/skills/.claude/skills';

const TEST_BUNDLE_ID = 'test-session-id' as BundleId;
const TEST_SHORT_ID = getBundleShortId(TEST_BUNDLE_ID);
import {
  createDockerCallTracker,
  createMockAdapter,
  createMockCA,
  createMockDocker,
  createMockMitmProxy,
  createMockProxy,
  testTcpTransportCredentials,
  MOCK_TRANSPORT_SIDECAR_IMAGE_ID,
  type CreateMockDockerOptions,
  type DockerCallTracker,
} from './helpers/docker-mocks.js';
import {
  computeTransportSidecarBuildHash,
  TRANSPORT_SIDECAR_IMAGE,
  transportSidecarContextDir,
} from '../src/docker/transport-sidecar-image.js';

/**
 * Type-level tests for the DockerInfrastructure interface.
 *
 * prepareDockerInfrastructure() requires real Docker, MCP servers,
 * and proxy infrastructure to run, so we verify the interface shape
 * rather than calling the function directly. The actual integration
 * is tested via the Docker session tests and PTY session tests.
 */

describe('DockerInfrastructure interface', () => {
  it('has all required fields', () => {
    // Compile-time type assertion: this object satisfies DockerInfrastructure.
    // If a field is missing or has the wrong type, TypeScript will error.
    const infra: DockerInfrastructure = {
      bundleId: 'test-session-id' as import('../src/session/types.js').BundleId,
      bundleDir: '/tmp/test/sessions/test-session-id',
      workspaceDir: '/tmp/test/sessions/test-session-id/sandbox',
      escalationDir: '/tmp/test/sessions/test-session-id/escalations',
      auditLogPath: '/tmp/test/sessions/test-session-id/audit.jsonl',
      proxy: createMockProxy('/tmp/proxy.sock'),
      mitmProxy: createMockMitmProxy(),
      docker: createMockDocker(),
      adapter: createMockAdapter(),
      ca: {
        generation: 'gen-00000000-0000-4000-8000-000000000000',
        certPem: 'mock-cert',
        keyPem: 'mock-key',
        certPath: '/tmp/ca-cert.pem',
        keyPath: '/tmp/ca-key.pem',
      },
      fakeKeys: new Map(),
      orientationDir: '/tmp/test/sessions/test-session-id/orientation',
      systemPrompt: 'Test system prompt',
      image: 'test-image:latest',
      runtimeKind: 'docker',
      topology: 'uds',
      useTcp: false,
      socketsDir: '/tmp/test/sessions/test-session-id/sockets',
      mitmAddr: { socketPath: '/tmp/mitm.sock' },
      metricsProxyUrl: 'http://127.0.0.1:18080',
      authKind: 'apikey',
      providerProfileId: 'native',
      containerId: 'container-id',
      containerName: 'ironcurtain-test-session',
      setTokenSessionId: () => {},
      restageSkills: () => {},
      beginCaptureSession: () => {},
      endCaptureSession: async () => {},
    };

    // Verify key fields are accessible at runtime
    expect(infra.bundleId).toBe('test-session-id');
    expect(infra.useTcp).toBe(false);
    expect(infra.fakeKeys).toBeInstanceOf(Map);
    expect(infra.mitmAddr.socketPath).toBe('/tmp/mitm.sock');
    expect(infra.systemPrompt).toBe('Test system prompt');
    expect(infra.image).toBe('test-image:latest');
    expect(infra.socketsDir).toContain('sockets');
    expect(infra.containerId).toBe('container-id');
    expect(infra.containerName).toBe('ironcurtain-test-session');
  });

  it('supports TCP mode with port-based mitmAddr', () => {
    const tcpAddr: DockerInfrastructure['mitmAddr'] = { port: 8443 };
    expect(tcpAddr.port).toBe(8443);
    expect(tcpAddr.socketPath).toBeUndefined();
  });

  it('supports UDS mode with socketPath-based mitmAddr', () => {
    const udsAddr: DockerInfrastructure['mitmAddr'] = { socketPath: '/tmp/mitm.sock' };
    expect(udsAddr.socketPath).toBe('/tmp/mitm.sock');
    expect(udsAddr.port).toBeUndefined();
  });
});

describe('buildAgentUidRemap (issue #232)', () => {
  it('returns empty mapping when skipRemap is true (macOS Docker Desktop, apple-container)', () => {
    // VirtioFS handles UID translation transparently; passing
    // `--user 0:0` would break that. macOS path must be a pure no-op.
    // apple-container likewise skips the Linux renumber-and-drop.
    const remap = buildAgentUidRemap(true);
    expect(remap.user).toBeUndefined();
    expect(remap.env).toEqual({});
  });

  it('returns 0:0 + host UID/GID env on Linux Docker (skipRemap=false)', () => {
    const remap = buildAgentUidRemap(false);
    expect(remap.user).toBe('0:0');
    // The entrypoint reads these to renumber codespace before
    // dropping privileges via runuser.
    expect(remap.env.IRONCURTAIN_AGENT_UID).toBe(String(process.getuid?.() ?? 1000));
    expect(remap.env.IRONCURTAIN_AGENT_GID).toBe(String(process.getgid?.() ?? 1000));
  });
});

describe('Linux Docker host identity guard (DINF-23)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a root coordinator exactly where the agent UID remap applies', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    vi.spyOn(process, 'getgid').mockReturnValue(0);

    expect(() => assertLinuxDockerHostIdentity('docker', false)).toThrow(ROOT_HOST_IDENTITY_MESSAGE);
    // macOS Docker Desktop (TCP transport) and apple-container skip the remap.
    expect(() => assertLinuxDockerHostIdentity('docker', true)).not.toThrow();
    expect(() => assertLinuxDockerHostIdentity('apple-container', false)).not.toThrow();
  });

  it('admits a regular user, including one whose primary group is root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    vi.spyOn(process, 'getgid').mockReturnValue(0);
    expect(() => assertLinuxDockerHostIdentity('docker', false)).not.toThrow();
  });
});

describe('container root vs host root disclosure (DINF-3)', () => {
  const facts = (securityOptions: string[]): DockerServerFacts => ({
    architecture: 'amd64',
    operatingSystem: 'Ubuntu 24.04',
    osType: 'linux',
    serverVersion: '29.1.3',
    kernelVersion: '6.8.0',
    cgroupVersion: '2',
    securityOptions,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when the daemon has neither rootless mode nor userns-remap', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const probe = vi.fn(async () => facts(['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns']));

    await expect(warnWhenContainerRootIsHostRoot(undefined, probe)).resolves.toBe('host-root');
    expect(probe).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(HOST_ROOT_EXPOSURE_WARNING);
  });

  it('stays quiet for rootless Docker and userns-remap, using recorded facts without probing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const probe = vi.fn(async () => undefined);

    await expect(
      warnWhenContainerRootIsHostRoot(facts(['name=seccomp,profile=builtin', 'name=rootless']), probe),
    ).resolves.toBe('rootless');
    await expect(warnWhenContainerRootIsHostRoot(facts(['name=userns', 'name=apparmor']), probe)).resolves.toBe(
      'userns-remap',
    );
    expect(probe).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('only notes host root when agent sudo is disabled, since nothing in the container can become root', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

    await expect(warnWhenContainerRootIsHostRoot(facts(['name=apparmor']), async () => undefined, false)).resolves.toBe(
      'host-root',
    );
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('agent sudo is disabled (agentSudo: false)'));
    expect(HOST_ROOT_EXPOSURE_WARNING).toContain('"agentSudo": false');
    expect(HOST_ROOT_EXPOSURE_WARNING).toContain('strips setuid/setgid bits');
  });

  it('never throws when the daemon cannot be read', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(warnWhenContainerRootIsHostRoot(undefined, async () => undefined)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not read Docker security options'));
  });
});

describe('container resource bounds (DINF-11)', () => {
  it('always bounds the macOS socat sidecar, partitioned or not', () => {
    expect(buildDockerDesktopTransportCreateLimits(undefined)).toEqual({
      resources: { memoryMb: 64, cpus: 0.25 },
      trustedCreateOptions: { pidsLimit: 64, ulimits: [{ name: 'nofile', soft: 256, hard: 256 }] },
    });
    const partitioned = buildDockerDesktopTransportCreateLimits({
      sidecar: { memoryMb: 512, cpus: 0.25, pidsLimit: 100 },
      transport: { memoryMb: 64, cpus: 0.25, pidsLimit: 32 },
      agent: { memoryMb: 1024, cpus: 1, pidsLimit: 128 },
    });
    expect(partitioned.resources).toEqual({ memoryMb: 64, cpus: 0.25 });
    expect(partitioned.trustedCreateOptions.pidsLimit).toBe(32);
    expect(partitioned.trustedCreateOptions.ulimits).toEqual([{ name: 'nofile', soft: 128, hard: 128 }]);
  });

  it('gives Docker agents the configured pids ceiling unless a nested partition sets its own', () => {
    expect(buildDockerAgentTrustedCreateOptions('docker', [], undefined, { pidsLimit: 2048 })).toMatchObject({
      pidsLimit: 2048,
      ulimits: [{ name: 'nofile', soft: AGENT_OPEN_FILES_LIMIT, hard: AGENT_OPEN_FILES_LIMIT }],
    });
    expect(
      buildDockerAgentTrustedCreateOptions(
        'docker',
        [],
        {
          sidecar: { memoryMb: 512, cpus: 0.25, pidsLimit: 100 },
          transport: { memoryMb: 0, cpus: 0, pidsLimit: 0 },
          agent: { memoryMb: 1024, cpus: 1, pidsLimit: 128 },
        },
        { pidsLimit: 4096 },
      )?.pidsLimit,
    ).toBe(128);
  });

  it('passes no Docker-only options to apple-container, whose VM is the bound', () => {
    expect(buildDockerAgentTrustedCreateOptions('apple-container', [], undefined, { pidsLimit: 4096 })).toBeUndefined();
  });
});

describe('canRefreshOAuth', () => {
  it('is false for an empty refresh token (externally-managed Codex tokens)', () => {
    expect(canRefreshOAuth('')).toBe(false);
  });

  it('is true for a non-empty refresh token', () => {
    expect(canRefreshOAuth('codex-refresh-token')).toBe(true);
  });
});

describe('resolveRealKey', () => {
  // Minimal config: only the userConfig key fields resolveRealKey reads.
  function configWithKeys(keys: Partial<IronCurtainConfig['userConfig']>): IronCurtainConfig {
    return { userConfig: { ...keys } } as unknown as IronCurtainConfig;
  }

  it('returns the OAuth access token for Codex ChatGPT hosts when a token is provided', () => {
    const config = configWithKeys({});
    expect(resolveRealKey('chatgpt.com', config, 'oauth-access-token')).toBe('oauth-access-token');
    expect(resolveRealKey('auth.openai.com', config, 'oauth-access-token')).toBe('oauth-access-token');
  });

  it('returns the OAuth access token for Anthropic hosts when a token is provided', () => {
    const config = configWithKeys({ anthropicApiKey: 'sk-ant-api03-configured' });
    expect(resolveRealKey('api.anthropic.com', config, 'oauth-access-token')).toBe('oauth-access-token');
    expect(resolveRealKey('platform.claude.com', config, 'oauth-access-token')).toBe('oauth-access-token');
  });

  it('returns empty string for Codex ChatGPT hosts when no OAuth token is provided', () => {
    // Without OAuth, Codex hosts have no API-key fallback — the MITM proxy
    // would have nothing to swap in, which is the intended "OAuth required"
    // posture for Codex.
    const config = configWithKeys({});
    expect(resolveRealKey('chatgpt.com', config, undefined)).toBe('');
    expect(resolveRealKey('auth.openai.com', config, undefined)).toBe('');
  });

  it('falls back to the configured API key for Anthropic hosts when no OAuth token', () => {
    const config = configWithKeys({ anthropicApiKey: 'sk-ant-api03-configured' });
    expect(resolveRealKey('api.anthropic.com', config, undefined)).toBe('sk-ant-api03-configured');
  });

  // --- OpenRouter (G4 / §7.5) ---

  /** Config stamped with an openrouter-type active profile carrying `apiKey`. */
  function configWithOpenrouterProfile(apiKey: string): IronCurtainConfig {
    return {
      userConfig: {},
      activeProviderProfile: {
        type: 'openrouter',
        apiKey,
        modelMap: [],
        usesDefaultMap: false,
        perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
        providerPreference: undefined,
        sessionAffinity: true,
      },
    } as unknown as IronCurtainConfig;
  }

  it('returns the stamped active profile apiKey for openrouter.ai', () => {
    const config = configWithOpenrouterProfile('sk-or-v1-realkey');
    expect(resolveRealKey('openrouter.ai', config, undefined)).toBe('sk-or-v1-realkey');
  });

  it('never returns an OAuth token for openrouter.ai (static bearer key only)', () => {
    // openrouter.ai is in neither ANTHROPIC_HOSTS nor CODEX_CHATGPT_HOSTS, so
    // even a provided OAuth token is ignored — the profile key wins. This is
    // the observable proof that no OAuth token manager is attached (§7.5).
    const config = configWithOpenrouterProfile('sk-or-v1-realkey');
    expect(resolveRealKey('openrouter.ai', config, 'oauth-access-token')).toBe('sk-or-v1-realkey');
  });

  it('returns empty string for openrouter.ai when the active profile is native', () => {
    const config = { userConfig: {}, activeProviderProfile: { type: 'native' } } as unknown as IronCurtainConfig;
    expect(resolveRealKey('openrouter.ai', config, undefined)).toBe('');
  });

  it('returns empty string for openrouter.ai when no active profile is stamped', () => {
    const config = configWithKeys({});
    expect(resolveRealKey('openrouter.ai', config, undefined)).toBe('');
  });
});

describe('OpenRouter ProviderKeyMapping assembly (G4 / §7.5, §9.5)', () => {
  /** Directories the tests made under os.tmpdir(), removed after each test. */
  const tempDirs: string[] = [];
  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Minimal openrouter-type resolved profile with the given key. */
  function openrouterProfile(apiKey: string): ResolvedProviderProfile {
    return {
      type: 'openrouter',
      apiKey,
      modelMap: [],
      usesDefaultMap: false,
      perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
      providerPreference: undefined,
      sessionAffinity: true,
    };
  }

  /** Config carrying only the fields the assembly logic reads. */
  function stampedConfig(profile: ResolvedProviderProfile): IronCurtainConfig {
    return { userConfig: {}, activeProviderProfile: profile } as unknown as IronCurtainConfig;
  }

  it('assembles a fake/real ProviderKeyMapping for openrouter.ai with distinct keys', () => {
    // Mirrors the per-provider loop in prepareDockerInfrastructure: the
    // openrouterProvider's fakeKeyPrefix seeds a structurally-valid fake key,
    // and resolveRealKey supplies the real key off the stamped profile.
    const rewriter = makeOpenRouterRewriter({
      modelMap: [],
      perAgentDefault: undefined,
      providerPreference: undefined,
      sessionAffinity: true,
    });
    const provider = makeOpenRouterProvider('messages', rewriter);
    expect(provider.host).toBe('openrouter.ai');
    expect(provider.fakeKeyPrefix).toBe('sk-or-v1-ironcurtain-');

    const fakeKey = generateFakeKey(provider.fakeKeyPrefix);
    expect(fakeKey.startsWith('sk-or-v1-ironcurtain-')).toBe(true);

    const config = stampedConfig(openrouterProfile('sk-or-v1-realkey'));
    const realKey = resolveRealKey(provider.host, config, undefined);
    expect(realKey).toBe('sk-or-v1-realkey');
    expect(fakeKey).not.toBe(realKey);
  });

  it('leaves openrouter.ai unmanaged by OAuth (no token manager) — real key ignores an OAuth token', () => {
    // isManagedOAuthHost is ANTHROPIC_HOSTS ∪ (codex ∧ CODEX_CHATGPT_HOSTS);
    // openrouter.ai matches neither, so no token manager is ever attached and
    // resolveRealKey never substitutes an OAuth token for the profile key.
    const config = stampedConfig(openrouterProfile('sk-or-v1-realkey'));
    expect(resolveRealKey('openrouter.ai', config, 'oauth-access-token')).toBe('sk-or-v1-realkey');
  });

  it('resolves the active profile from a providerProfileName (G1 resolver, used by infra prep)', () => {
    const modelProviders = {
      default: 'native',
      profiles: {
        native: { type: 'native' as const },
        glm: openrouterProfile('sk-or-v1-realkey'),
        kimi: openrouterProfile(''),
      },
    };
    expect(resolveActiveProfile(modelProviders, 'glm')).toEqual(openrouterProfile('sk-or-v1-realkey'));
    expect(resolveActiveProfile(modelProviders, undefined)).toEqual({ type: 'native' });
  });

  it('throws listing available profiles for an unknown providerProfileName (before container launch)', () => {
    const modelProviders = {
      default: 'native',
      profiles: {
        native: { type: 'native' as const },
        glm: openrouterProfile('sk-or-v1-realkey'),
        kimi: openrouterProfile(''),
      },
    };
    expect(() => resolveActiveProfile(modelProviders, 'does-not-exist')).toThrow(
      'Unknown provider profile "does-not-exist". Available: native, glm, kimi.',
    );
  });

  it.each(['openrouter', 'zai'] as const)(
    'fails fast before container launch when a %s profile has an empty resolved apiKey',
    async (type) => {
      // The bundle-level belt-and-suspenders guard in prepareDockerInfrastructure
      // resolves + stamps the active profile FIRST, then throws when the active
      // profile has an empty apiKey — before any container is
      // launched. Reaching the guard in-process requires only that the container-
      // runtime probe is short-circuited (env override) and the requested agent
      // registers; the guard runs before any Docker/CA/proxy work.
      const bundleDir = makeTempDir('or-bundle-');
      const prev = process.env.IRONCURTAIN_CONTAINER_RUNTIME;
      process.env.IRONCURTAIN_CONTAINER_RUNTIME = 'docker';
      try {
        const config = {
          // Minimal userConfig: only the fields the pre-guard path reads. The
          // adapter factories read agentModelId/gooseProvider/gooseModel (all
          // optional); resolveRuntimeKind is short-circuited by the env override.
          userConfig: {
            modelProviders: {
              default: 'glm',
              profiles: {
                native: { type: 'native' },
                glm:
                  type === 'openrouter'
                    ? openrouterProfile('')
                    : {
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
          },
          auditLogPath: join(bundleDir, 'audit.jsonl'),
        } as unknown as IronCurtainConfig;

        await expect(
          prepareDockerInfrastructure(
            config,
            { kind: 'docker', agent: 'claude-code' as AgentId },
            bundleDir,
            makeTempDir('or-ws-'),
            makeTempDir('or-esc-'),
            'or-fail-fast' as BundleId,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { providerProfileName: 'glm' },
          ),
        ).rejects.toThrow(
          `Provider profile "glm" is ${type === 'zai' ? 'Z.AI' : 'OpenRouter'} but no API key is configured. ` +
            `Set ${type === 'zai' ? 'ZAI_API_KEY' : 'OPENROUTER_API_KEY'} or the profile's apiKey in ~/.ironcurtain/config.json.`,
        );
      } finally {
        if (prev === undefined) delete process.env.IRONCURTAIN_CONTAINER_RUNTIME;
        else process.env.IRONCURTAIN_CONTAINER_RUNTIME = prev;
      }
    },
  );
});

describe('prepareDockerInfrastructure workflow dependency preconditions', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'deps-precondition-'));
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = join(home, 'ironcurtain');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects runtime dependencies with packageInstall disabled before any infrastructure work', async () => {
    const scriptsDir = join(home, 'workflow-scripts');
    mkdirSync(scriptsDir);
    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy\n');
    const config = {
      userConfig: {
        modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
        packageInstall: { enabled: false, quarantineDays: 2, allowedPackages: [], deniedPackages: [] },
      },
      auditLogPath: join(home, 'audit.jsonl'),
    } as unknown as IronCurtainConfig;

    await expect(
      prepareDockerInfrastructure(
        config,
        { kind: 'docker', agent: 'claude-code' as AgentId },
        join(home, 'bundle'),
        join(home, 'workspace'),
        join(home, 'escalations'),
        'deps-precondition' as BundleId,
        'wf-deps-precondition' as WorkflowId,
        'primary',
        [],
        undefined,
        scriptsDir,
        { workflowRunDir: home },
      ),
    ).rejects.toThrow(/packageInstall is disabled/);

    // Rejected before the provider-profile stamp, so before any proxy, image,
    // container, or dependency-cache work.
    expect(config.activeProviderProfile).toBeUndefined();
    expect(existsSync(join(home, 'ironcurtain'))).toBe(false);
  });

  it('refuses an unscoped script directory before reading dependency manifests', async () => {
    const scriptsDir = join(home, 'ordinary-scripts');
    mkdirSync(scriptsDir);
    writeFileSync(join(scriptsDir, 'package.json'), 'not a manifest');
    await expect(
      prepareDockerInfrastructure(
        {} as IronCurtainConfig,
        { kind: 'docker', agent: 'claude-code' as AgentId },
        join(home, 'bundle'),
        join(home, 'workspace'),
        join(home, 'escalations'),
        'scripts-precondition' as BundleId,
        undefined,
        undefined,
        undefined,
        undefined,
        scriptsDir,
      ),
    ).rejects.toThrow('Workflow scripts must name the run-owned workflow-scripts directory');
    expect(existsSync(join(home, 'bundle'))).toBe(false);
  });
});

describe('prepareDockerInfrastructure agentSudo: false preconditions (DINF-3)', () => {
  let home: string;
  let originalHome: string | undefined;
  let originalRuntime: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agent-sudo-precondition-'));
    originalHome = process.env.IRONCURTAIN_HOME;
    originalRuntime = process.env.IRONCURTAIN_CONTAINER_RUNTIME;
    process.env.IRONCURTAIN_HOME = join(home, 'ironcurtain');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    if (originalRuntime === undefined) delete process.env.IRONCURTAIN_CONTAINER_RUNTIME;
    else process.env.IRONCURTAIN_CONTAINER_RUNTIME = originalRuntime;
    rmSync(home, { recursive: true, force: true });
  });

  async function prepareWithSudoOff(): Promise<IronCurtainConfig> {
    const config = {
      userConfig: {
        modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
        agentSudo: false,
      },
      auditLogPath: join(home, 'audit.jsonl'),
    } as unknown as IronCurtainConfig;
    await expect(
      prepareDockerInfrastructure(
        config,
        { kind: 'docker', agent: 'claude-code' as AgentId },
        join(home, 'bundle'),
        join(home, 'workspace'),
        join(home, 'escalations'),
        'agent-sudo-precondition' as BundleId,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_SUDO_UNSUPPORTED' });
    return config;
  }

  it.skipIf(process.platform !== 'linux')(
    'refuses a host UID the sudo-off Linux agent cannot run as, before credentials or bundle state',
    async () => {
      process.env.IRONCURTAIN_CONTAINER_RUNTIME = 'docker';
      vi.spyOn(process, 'getuid').mockReturnValue(1500);
      vi.spyOn(process, 'getgid').mockReturnValue(1500);

      const config = await prepareWithSudoOff();

      expect(config.dockerAuth).toBeUndefined();
      expect(existsSync(join(home, 'ironcurtain', 'run'))).toBe(false);
    },
  );

  it('refuses agentSudo: false on the Apple runtime, which cannot set no-new-privileges', async () => {
    process.env.IRONCURTAIN_CONTAINER_RUNTIME = 'apple-container';
    const config = await prepareWithSudoOff();
    expect(config.dockerAuth).toBeUndefined();
  });
});

describe('prepareConversationStateDir', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'conv-state-test-'));
  });

  afterEach(() => {
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('creates state dir and seeds files on first run', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [
        { path: 'data/', content: '' },
        { path: 'config.json', content: '{"key": "value"}' },
      ],
      resumeFlags: ['--resume'],
      transcriptLayout: 'claude-projects',
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);

    expect(stateDir).toBe(join(sessionDir, 'test-state'));
    expect(existsSync(join(stateDir, 'data'))).toBe(true);
    expect(readFileSync(join(stateDir, 'config.json'), 'utf-8')).toBe('{"key": "value"}');
  });

  it('calls seed content function and skips undefined results', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [
        { path: 'present.json', content: () => '{"present": true}' },
        { path: 'absent.json', content: () => undefined },
      ],
      resumeFlags: [],
      transcriptLayout: 'claude-projects',
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);

    expect(readFileSync(join(stateDir, 'present.json'), 'utf-8')).toBe('{"present": true}');
    expect(existsSync(join(stateDir, 'absent.json'))).toBe(false);
  });

  it('does not re-seed on subsequent runs', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [{ path: 'config.json', content: '{"original": true}' }],
      resumeFlags: [],
      transcriptLayout: 'claude-projects',
    };

    // First run creates the file
    prepareConversationStateDir(sessionDir, config);

    // Modify the file to simulate agent writes
    const configPath = join(sessionDir, 'test-state', 'config.json');
    writeFileSync(configPath, '{"modified": true}');

    // Second run should not overwrite
    prepareConversationStateDir(sessionDir, config);
    expect(readFileSync(configPath, 'utf-8')).toBe('{"modified": true}');
  });

  it('deletes .credentials.json on every run (defense-in-depth)', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [],
      resumeFlags: [],
      transcriptLayout: 'claude-projects',
    };

    // First run creates the dir
    const stateDir = prepareConversationStateDir(sessionDir, config);

    // Simulate agent creating credentials
    writeFileSync(join(stateDir, '.credentials.json'), '{"token": "secret"}');
    expect(existsSync(join(stateDir, '.credentials.json'))).toBe(true);

    // Second run should delete it
    prepareConversationStateDir(sessionDir, config);
    expect(existsSync(join(stateDir, '.credentials.json'))).toBe(false);
  });

  it('deletes auth.json on every run (Codex defense-in-depth)', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'codex-state',
      containerMountPath: '/home/codespace/.codex/',
      seed: [],
      resumeFlags: [],
      transcriptLayout: 'codex-rollouts',
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);

    // Simulate a stale fake-token auth.json left by a prior container start.
    writeFileSync(join(stateDir, 'auth.json'), '{"auth_mode":"chatgptAuthTokens","tokens":{}}');
    expect(existsSync(join(stateDir, 'auth.json'))).toBe(true);

    // Second run should scrub it so no stale credential lingers across resumes.
    prepareConversationStateDir(sessionDir, config);
    expect(existsSync(join(stateDir, 'auth.json'))).toBe(false);
  });

  it('handles missing .credentials.json gracefully', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [],
      resumeFlags: [],
      transcriptLayout: 'claude-projects',
    };

    // Should not throw even when .credentials.json doesn't exist
    expect(() => prepareConversationStateDir(sessionDir, config)).not.toThrow();
  });

  it('creates nested directories for seed file paths', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [{ path: 'deep/nested/file.txt', content: 'hello' }],
      resumeFlags: [],
      transcriptLayout: 'claude-projects',
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);
    expect(readFileSync(join(stateDir, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('hello');
  });
});

// --- createSessionContainers tests ---
//
// These tests exercise the container-creation helper used by
// createDockerInfrastructure(). They drive a scripted PreContainerInfrastructure
// with a mock ContainerRuntime to verify:
//   - the main container's mount configuration (security: only sockets subdir
//     in UDS mode, never the full session dir with escalation/audit files)
//   - rollback semantics when a downstream step (connectivity check) fails
//     after the main container has already been created and started

/** Overrides accepted by the test-local makeMockDocker wrapper. */
type MockDockerOverrides = Pick<CreateMockDockerOptions, 'exec' | 'create'>;

/**
 * Thin wrapper around the shared createMockDocker that bundles a
 * DockerCallTracker for test assertions. The shared helper returns just
 * the ContainerRuntime; this wrapper flattens the tracker into the same
 * return shape the tests already use.
 */
function makeMockDocker(overrides: MockDockerOverrides = {}): { docker: ContainerRuntime } & DockerCallTracker {
  const tracker = createDockerCallTracker();
  const docker = createMockDocker({ tracker, ...overrides });
  return { docker, ...tracker };
}

/** Local alias kept so existing call sites read the same. */
const makeMockProxy = (socketPath: string, port?: number): DockerProxy => ({
  ...createMockProxy(socketPath, port),
  getHelpData() {
    return { serverDescriptions: {}, toolsByServer: {} };
  },
});

const makeMockMitmProxy = (): MitmProxy => createMockMitmProxy();

/**
 * Minimal config accepted by createSessionContainers. Deliberately partial
 * (hence the cast): `dockerResources` predates `pidsLimit`, as in a config an
 * embedder builds by hand, unless a test overrides it.
 */
function makeMockConfig(userConfig: Partial<ResolvedUserConfig> = {}): IronCurtainConfig {
  return {
    mcpServers: {},
    userConfig: {
      anthropicApiKey: 'sk-test',
      resourceBudget: {
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
      },
      escalationTimeoutSeconds: 120,
      auditRedaction: { enabled: true },
      // null/null = "no flag emitted" — avoids the clamp helper having to
      // probe real host resources in unit tests.
      dockerResources: { memoryMb: null, cpus: null },
      ...userConfig,
    },
  } as unknown as IronCurtainConfig;
}

/** Options for configuring the mock PreContainerInfrastructure. */
interface MockCoreOptions {
  readonly tempDir: string;
  readonly useTcp: boolean;
  readonly docker: ContainerRuntime;
  readonly adapter?: AgentAdapter;
  /** Defaults to 'tcp-sidecar' when useTcp, else 'uds'. */
  readonly topology?: PreContainerInfrastructure['topology'];
  readonly hostOnlyNetwork?: PreContainerInfrastructure['hostOnlyNetwork'];
  /** Defaults to 'apple-container' for tcp-hostonly, 'docker' otherwise. */
  readonly runtimeKind?: PreContainerInfrastructure['runtimeKind'];
}

/**
 * Builds a PreContainerInfrastructure rooted at `tempDir`, with on-disk
 * session/sandbox/sockets/orientation directories so the real
 * `writeFileSync(orientationDir, ...)` call inside createSessionContainers
 * actually works.
 */
function makeMockCore(opts: MockCoreOptions): PreContainerInfrastructure {
  const bundleId = TEST_BUNDLE_ID;
  const bundleDir = join(opts.tempDir, 'session');
  const workspaceDir = join(opts.tempDir, 'sandbox');
  const escalationDir = join(opts.tempDir, 'escalations');
  const orientationDir = join(bundleDir, 'orientation');
  const socketsDir = join(bundleDir, 'sockets');
  const auditLogPath = join(opts.tempDir, 'audit.jsonl');

  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(escalationDir, { recursive: true });
  mkdirSync(orientationDir, { recursive: true });
  mkdirSync(socketsDir, { recursive: true });

  const proxyPort = opts.useTcp ? 9123 : undefined;
  const mitmAddr: PreContainerInfrastructure['mitmAddr'] = opts.useTcp
    ? { port: 8443 }
    : { socketPath: '/tmp/test-mitm-proxy.sock' };

  return {
    bundleId,
    bundleDir,
    workspaceDir,
    escalationDir,
    auditLogPath,
    proxy: makeMockProxy(join(socketsDir, 'proxy.sock'), proxyPort),
    mitmProxy: makeMockMitmProxy(),
    docker: opts.docker,
    adapter: opts.adapter ?? createMockAdapter(),
    ca: createMockCA(opts.tempDir),
    fakeKeys: new Map([['api.test.com', 'sk-test-fake-key']]),
    orientationDir,
    systemPrompt: 'You are a test agent.',
    image: 'ironcurtain-claude-code:latest',
    runtimeKind: opts.runtimeKind ?? (opts.topology === 'tcp-hostonly' ? 'apple-container' : 'docker'),
    topology: opts.topology ?? (opts.useTcp ? 'tcp-sidecar' : 'uds'),
    ...(opts.useTcp && opts.topology !== 'tcp-hostonly' ? { tcpTransport: testTcpTransportCredentials() } : {}),
    useTcp: opts.useTcp,
    hostOnlyNetwork: opts.hostOnlyNetwork,
    socketsDir,
    mitmAddr,
    metricsProxyUrl: 'http://127.0.0.1:18080',
    authKind: 'apikey',
    providerProfileId: 'native',
    setTokenSessionId: () => {},
    restageSkills: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  };
}

function makeAppleArtifactResolution(logicalName: string, immutableImageId: string): AgentImageResolution {
  const buildHash = 'a'.repeat(64);
  return {
    mode: 'selected-agent-artifact',
    logicalName,
    imageRef: logicalName,
    immutableImageId,
    buildHash,
    artifact: {
      logicalName,
      buildHash,
      architecture: 'arm64',
      appleImageId: immutableImageId,
      dockerImageId: `sha256:${'b'.repeat(64)}`,
      manifestDigest: `sha256:${'c'.repeat(64)}`,
      archivePath: '/artifacts/selected-agent.oci.tar',
      archiveSizeBytes: 1024,
    },
  };
}

describe('createSessionContainers', () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'create-session-containers-'));
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = join(tempDir, 'home');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --- Test A (security-relevant) ---
  it('merges adapter batch-only environment into one-shot containers', async () => {
    const { docker, createCalls } = makeMockDocker();
    const adapter: AgentAdapter = {
      ...createMockAdapter(),
      buildBatchEnv: () => ({ BATCH_ONLY: '1' }),
    };
    const core = makeMockCore({ tempDir, useTcp: false, docker, adapter });

    await createSessionContainers(core, makeMockConfig());

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].env.TEST_KEY).toBe('test-value');
    expect(createCalls[0].env.BATCH_ONLY).toBe('1');
  });

  describe('resuming from a workflow snapshot only under its agent image build', () => {
    const AGENT_IMAGE = 'ironcurtain-claude-code:latest';
    const CURRENT_BUILD = 'a'.repeat(64);
    const OTHER_BUILD = 'b'.repeat(64);
    const SNAPSHOT = `sha256:${'7'.repeat(64)}`;

    function snapshotCore(docker: ContainerRuntime): PreContainerInfrastructure {
      return {
        ...makeMockCore({ tempDir, useTcp: false, docker }),
        imageResolution: {
          mode: 'build-if-stale',
          logicalName: AGENT_IMAGE,
          imageRef: AGENT_IMAGE,
          buildHash: CURRENT_BUILD,
        },
      };
    }

    /** A runtime holding the snapshot image with `labels` (absent: the image is gone). */
    function dockerWithSnapshot(labels: Record<string, string> | undefined) {
      const mock = makeMockDocker();
      mock.docker.inspectImage = async (ref) =>
        ref === SNAPSHOT && labels !== undefined ? { id: SNAPSHOT, repoTags: [], labels, created: '' } : undefined;
      return mock;
    }

    beforeEach(() => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('creates the agent container from a snapshot of the build this bundle runs', async () => {
      const { docker, createCalls } = dockerWithSnapshot({ 'ironcurtain.build-hash': CURRENT_BUILD });

      const resources = await createSessionContainers(snapshotCore(docker), makeMockConfig(), {
        baseImageOverride: SNAPSHOT,
        baseImageAgentBuildHash: CURRENT_BUILD,
      });

      expect(createCalls.map((call) => call.image)).toEqual([SNAPSHOT]);
      expect(resources.snapshotRefusal).toBeUndefined();
    });

    it('never creates the agent container from a snapshot of another build', async () => {
      // Even an image whose label matches the recorded (other) build.
      const { docker, createCalls } = dockerWithSnapshot({ 'ironcurtain.build-hash': OTHER_BUILD });

      const resources = await createSessionContainers(snapshotCore(docker), makeMockConfig(), {
        baseImageOverride: SNAPSHOT,
        baseImageAgentBuildHash: OTHER_BUILD,
      });

      expect(createCalls.map((call) => call.image)).toEqual([AGENT_IMAGE]);
      expect(resources.snapshotRefusal).toBe(
        'the snapshot was taken from agent image build bbbbbbbbbbbbbbbb, and this IronCurtain runs build aaaaaaaaaaaaaaaa',
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Not resuming from workflow snapshot'));
    });

    it('never uses a snapshot that records no agent image build', async () => {
      const { docker, createCalls } = dockerWithSnapshot({ 'ironcurtain.build-hash': CURRENT_BUILD });

      const resources = await createSessionContainers(snapshotCore(docker), makeMockConfig(), {
        baseImageOverride: SNAPSHOT,
      });

      expect(createCalls.map((call) => call.image)).toEqual([AGENT_IMAGE]);
      expect(resources.snapshotRefusal).toMatch(/does not record the agent image build/u);
    });

    it('never uses a snapshot image whose label disagrees with the recorded build', async () => {
      const unlabeled = dockerWithSnapshot({});
      const relabeled = dockerWithSnapshot({ 'ironcurtain.build-hash': OTHER_BUILD });

      for (const { docker, createCalls } of [unlabeled, relabeled]) {
        const resources = await createSessionContainers(snapshotCore(docker), makeMockConfig(), {
          baseImageOverride: SNAPSHOT,
          baseImageAgentBuildHash: CURRENT_BUILD,
        });
        expect(createCalls.map((call) => call.image)).toEqual([AGENT_IMAGE]);
        expect(resources.snapshotRefusal).toMatch(/not labeled with the agent image build/u);
      }
    });

    it('starts fresh when the snapshot image is gone or the bundle build is unknown', async () => {
      const gone = dockerWithSnapshot(undefined);
      const goneResources = await createSessionContainers(snapshotCore(gone.docker), makeMockConfig(), {
        baseImageOverride: SNAPSHOT,
        baseImageAgentBuildHash: CURRENT_BUILD,
      });
      expect(gone.createCalls.map((call) => call.image)).toEqual([AGENT_IMAGE]);
      expect(goneResources.snapshotRefusal).toBe('the snapshot image no longer exists');

      const unknown = dockerWithSnapshot({ 'ironcurtain.build-hash': CURRENT_BUILD });
      const unknownResources = await createSessionContainers(
        makeMockCore({ tempDir, useTcp: false, docker: unknown.docker }),
        makeMockConfig(),
        { baseImageOverride: SNAPSHOT, baseImageAgentBuildHash: CURRENT_BUILD },
      );
      expect(unknown.createCalls.map((call) => call.image)).toEqual([AGENT_IMAGE]);
      expect(unknownResources.snapshotRefusal).toMatch(/build of this bundle is unknown/u);
    });

    it('never uses a snapshot named by a tag, which could be re-pointed before the create', async () => {
      const mock = makeMockDocker();
      mock.docker.inspectImage = async () => ({
        id: SNAPSHOT,
        repoTags: ['ironcurtain-snapshot:wf-primary-1'],
        labels: { 'ironcurtain.build-hash': CURRENT_BUILD },
        created: '',
      });

      const resources = await createSessionContainers(snapshotCore(mock.docker), makeMockConfig(), {
        baseImageOverride: 'ironcurtain-snapshot:wf-primary-1',
        baseImageAgentBuildHash: CURRENT_BUILD,
      });

      expect(mock.createCalls.map((call) => call.image)).toEqual([AGENT_IMAGE]);
      expect(resources.snapshotRefusal).toBe('the snapshot is not named by an immutable image ID');
    });

    it('decides the same way through selectResumableSnapshot', async () => {
      const { docker } = dockerWithSnapshot({ 'ironcurtain.build-hash': CURRENT_BUILD });
      const core = snapshotCore(docker);
      const sudoOn = { agentSudo: true };
      await expect(selectResumableSnapshot(core, undefined, sudoOn)).resolves.toEqual({});
      await expect(
        selectResumableSnapshot(core, { baseImageOverride: SNAPSHOT, baseImageAgentBuildHash: CURRENT_BUILD }, sudoOn),
      ).resolves.toEqual({ image: SNAPSHOT });
      // A recorded value that is not even a hash (a damaged checkpoint) is refused and never echoed.
      const damaged = await selectResumableSnapshot(
        core,
        { baseImageOverride: SNAPSHOT, baseImageAgentBuildHash: '\u001b[2Jx' },
        sudoOn,
      );
      expect(damaged.image).toBeUndefined();
      expect(damaged.refusal).toMatch(/taken from agent image build unknown/u);
    });

    // A sudo-off container runs as UID 1000 only, so its groups come from the
    // image's /etc/passwd and /etc/group. A snapshot of a container whose agent
    // had root (sudo on) may have added that account to any group.
    describe('under agentSudo: false', () => {
      const offer = { baseImageOverride: SNAPSHOT, baseImageAgentBuildHash: CURRENT_BUILD };

      it('uses only a snapshot recorded as taken without agent sudo', async () => {
        const { docker } = dockerWithSnapshot({ 'ironcurtain.build-hash': CURRENT_BUILD });
        const core = snapshotCore(docker);
        const sudoOff = { agentSudo: false };

        await expect(selectResumableSnapshot(core, { ...offer, baseImageAgentSudo: false }, sudoOff)).resolves.toEqual({
          image: SNAPSHOT,
        });
        const recordedSudo = await selectResumableSnapshot(core, { ...offer, baseImageAgentSudo: true }, sudoOff);
        expect(recordedSudo.image).toBeUndefined();
        expect(recordedSudo.refusal).toBe(
          'the snapshot was taken while the agent had sudo, and agentSudo is now false',
        );
        // Not recorded (a snapshot from before the field existed) counts as sudo on,
        // and so does anything but an exact false from a damaged checkpoint.
        for (const recorded of [{}, { baseImageAgentSudo: 'false' as unknown as boolean }]) {
          const unknown = await selectResumableSnapshot(core, { ...offer, ...recorded }, sudoOff);
          expect(unknown.image).toBeUndefined();
          expect(unknown.refusal).toBe(
            'the snapshot does not record that the agent ran without sudo, and agentSudo is now false',
          );
        }
      });

      it('leaves agent-sudo bundles resuming snapshots whatever mode they record', async () => {
        const { docker } = dockerWithSnapshot({ 'ironcurtain.build-hash': CURRENT_BUILD });
        const core = snapshotCore(docker);
        for (const recorded of [{}, { baseImageAgentSudo: true }, { baseImageAgentSudo: false }]) {
          await expect(selectResumableSnapshot(core, { ...offer, ...recorded }, { agentSudo: true })).resolves.toEqual({
            image: SNAPSHOT,
          });
        }
      });

      it('creates the sudo-off agent container fresh from a snapshot taken with agent sudo', async () => {
        vi.spyOn(process, 'getuid').mockReturnValue(1000);
        vi.spyOn(process, 'getgid').mockReturnValue(1000);
        const { docker, createCalls } = dockerWithSnapshot({ 'ironcurtain.build-hash': CURRENT_BUILD });

        const resources = await createSessionContainers(snapshotCore(docker), makeMockConfig({ agentSudo: false }), {
          ...offer,
          baseImageAgentSudo: true,
        });

        expect(createCalls.map((call) => call.image)).toEqual([AGENT_IMAGE]);
        expect(createCalls[0].user).toBe('1000');
        expect(resources.snapshotRefusal).toMatch(/agent had sudo, and agentSudo is now false/u);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Not resuming from workflow snapshot'));

        const sudoOffSnapshot = dockerWithSnapshot({ 'ironcurtain.build-hash': CURRENT_BUILD });
        const used = await createSessionContainers(
          snapshotCore(sudoOffSnapshot.docker),
          makeMockConfig({ agentSudo: false }),
          { ...offer, baseImageAgentSudo: false },
        );
        expect(sudoOffSnapshot.createCalls.map((call) => call.image)).toEqual([SNAPSHOT]);
        expect(used.snapshotRefusal).toBeUndefined();
      });
    });
  });

  it('shadows the image-declared Docker state volume when nested Docker is explicitly disabled', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, runtimeKind: 'docker', docker });
    const config = makeMockConfig({ dockerWorkload: { enabled: false } });

    await createSessionContainers(core, config);

    expect(createCalls).toHaveLength(1);
    // Every Docker agent container also carries the default process and
    // descriptor bounds (DINF-11), even when the config predates pidsLimit.
    expect(createCalls[0].trustedCreateOptions).toEqual({
      tmpfs: ['/var/lib/docker:ro,nosuid,nodev,noexec,size=1m'],
      pidsLimit: USER_CONFIG_DEFAULTS.dockerResources.pidsLimit,
      ulimits: [{ name: 'nofile', soft: AGENT_OPEN_FILES_LIMIT, hard: AGENT_OPEN_FILES_LIMIT }],
    });
  });

  it('creates Docker agent containers with the configured pids ceiling, swap pinned to memory', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, runtimeKind: 'docker', docker });
    const config = makeMockConfig({
      dockerWorkload: { enabled: false },
      dockerResources: { memoryMb: 2048, cpus: null, pidsLimit: 1024 },
    });

    await createSessionContainers(core, config);

    const args = buildCreateArgs(createCalls[0]);
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('1024');
    expect(args[args.indexOf('--memory') + 1]).toBe(args[args.indexOf('--memory-swap') + 1]);
    expect(args[args.indexOf('--ulimit') + 1]).toBe(`nofile=${AGENT_OPEN_FILES_LIMIT}:${AGENT_OPEN_FILES_LIMIT}`);
  });

  it('omits only the pids ceiling when the operator disabled it', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, runtimeKind: 'docker', docker });
    const config = makeMockConfig({
      dockerWorkload: { enabled: false },
      dockerResources: { memoryMb: null, cpus: null, pidsLimit: null },
    });

    await createSessionContainers(core, config);

    expect(createCalls[0].trustedCreateOptions?.pidsLimit).toBeUndefined();
    expect(createCalls[0].trustedCreateOptions?.ulimits).toEqual([
      { name: 'nofile', soft: AGENT_OPEN_FILES_LIMIT, hard: AGENT_OPEN_FILES_LIMIT },
    ]);
  });

  it('creates a sudo-off agent without root: --user 1000, no capabilities, no-new-privileges (DINF-3)', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    vi.spyOn(process, 'getgid').mockReturnValue(100);
    try {
      const { docker, createCalls } = makeMockDocker();
      const exec = vi.spyOn(docker, 'exec');
      const core = makeMockCore({ tempDir, useTcp: false, runtimeKind: 'docker', docker });
      const config = makeMockConfig({ agentSudo: false });

      await createSessionContainers(core, config);

      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].user).toBe('1000');
      expect(createCalls[0].capAdd).toEqual([]);
      expect(createCalls[0].trustedCreateOptions?.securityOptions).toEqual(['no-new-privileges:true']);
      expect(createCalls[0].env.IRONCURTAIN_AGENT_SUDO).toBe('disabled');
      expect(createCalls[0].env.IRONCURTAIN_AGENT_UID).toBeUndefined();
      // The startup handoff is probed as the agent's own UID: no root exists.
      const probe = exec.mock.calls.find(([, command]) => command.includes('ironcurtain-agent-startup'));
      expect(probe?.[3]).toBe('1000');
      expect(exec.mock.calls.some(([, , , user]) => user === '0:0' || user === 'root')).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('mounts /workspace read-only for a read-only workspace config, and read-write otherwise (WP-131)', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, runtimeKind: 'docker', docker });
    const readOnly = { ...makeMockConfig(), readOnlyWorkspace: { writablePaths: ['.workflow/reviews'] } };

    const result = await createSessionContainers({ ...core, containerRootIsHostRoot: true }, readOnly);
    const workspaceMount = createCalls[0].mounts.find((mount) => mount.target === '/workspace');
    expect(workspaceMount).toEqual({ source: core.workspaceDir, target: '/workspace', readonly: true });
    expect(buildCreateArgs(createCalls[0]).join(' ')).toContain(`${core.workspaceDir}:/workspace:ro`);
    // Nothing can be planted in a read-only mount: it is not swept.
    expect(result.privilegedFileScanner?.roots.some((root) => root.containerPath === '/workspace')).toBe(false);

    // The bundle's own record of its read-only workspace has the same effect.
    await createSessionContainers({ ...core, readOnlyWorkspace: { writablePaths: [] } }, makeMockConfig());
    expect(createCalls[1].mounts.find((mount) => mount.target === '/workspace')?.readonly).toBe(true);

    await createSessionContainers(core, makeMockConfig());
    expect(createCalls[2].mounts.find((mount) => mount.target === '/workspace')?.readonly).toBe(false);
  });

  it('delivers a mocked failed-start host-file finding without replacing the startup error', async () => {
    const failure = new Error('Example startup failure');
    const { docker } = makeMockDocker();
    vi.spyOn(docker, 'start').mockRejectedValueOnce(failure);
    const finding = { path: '/workspace/example', uid: 0, mode: 0o644, kind: 'file' as const };
    const scan = vi.fn(async (when: string): Promise<hostMountScan.HostMountPrivilegeScanReport> => ({
      when,
      scannedEntries: 1,
      complete: true,
      stripped: [],
      unstripped: [],
      rootOwned: [finding],
      unreadable: [],
      omitted: 0,
      newFindings: { unstripped: [], rootOwned: [finding] },
    }));
    vi.spyOn(hostMountScan, 'createBundlePrivilegedFileScanner').mockReturnValue({ roots: [], scan });
    const onHostPrivilegedFiles = vi.fn();
    const core = { ...makeMockCore({ tempDir, useTcp: false, docker }), onHostPrivilegedFiles };

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toBe(failure);

    expect(scan).toHaveBeenCalledWith('failed session start');
    expect(onHostPrivilegedFiles).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'host_privileged_files', rootOwned: 1 }),
    );
    expect(failure.message).toContain('root-owned');
    expect(failure.message).toContain('/workspace/example');
  });

  it('attaches a host-mount privilege scanner over the read-write mounts only where container root is host root', async () => {
    const { docker } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, runtimeKind: 'docker', docker });

    const hostRoot = await createSessionContainers({ ...core, containerRootIsHostRoot: true }, makeMockConfig());
    const roots = hostRoot.privilegedFileScanner?.roots ?? [];
    expect(roots).toContainEqual({ hostPath: core.workspaceDir, containerPath: '/workspace' });
    expect(roots).toContainEqual({ hostPath: core.socketsDir, containerPath: '/run/ironcurtain' });
    // Read-only mounts (orientation) and single-file mounts are not scanned.
    expect(roots.some((root) => root.hostPath === core.orientationDir)).toBe(false);
    expect(roots.every((root) => root.containerPath !== '/etc/apt/apt.conf.d/90-ironcurtain-proxy')).toBe(true);

    const isolated = await createSessionContainers(core, makeMockConfig());
    expect(isolated.privilegedFileScanner).toBeUndefined();
  });

  it.skipIf(process.platform !== 'linux')(
    'sweeps the host mounts once a container whose start failed is removed (DINF-3)',
    async () => {
      // The entrypoint runs (as root in the default mode, possibly from a
      // resumed snapshot image) before the startup checks; a start that then
      // fails must not leave what it planted unswept.
      const { docker } = makeMockDocker({
        async exec(_container, command) {
          if (command[2]?.includes('ironcurtain-write-probe')) {
            return { exitCode: 1, stdout: '', stderr: 'No space left on device' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      const core: PreContainerInfrastructure = {
        ...makeMockCore({ tempDir, useTcp: false, runtimeKind: 'docker', docker }),
        containerRootIsHostRoot: true,
      };
      const planted = join(core.workspaceDir, 'planted');
      writeFileSync(planted, '#!/bin/sh\n');
      chmodSync(planted, 0o4755);
      const modesAtRemoval: number[] = [];
      const remove = docker.remove.bind(docker);
      docker.remove = async (id) => {
        modesAtRemoval.push(statSync(planted).mode & 0o7777);
        await remove(id);
      };
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(/writable storage check failed/);

        expect(modesAtRemoval).toEqual([0o4755]);
        expect(statSync(planted).mode & 0o7777).toBe(0o755);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('mounts only sockets subdirectory in UDS mode, not the full session dir', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, docker });

    const result = await createSessionContainers(core, makeMockConfig());

    expect(result.containerId).toBeDefined();
    expect(result.sidecarContainerId).toBeUndefined();
    expect(result.internalNetwork).toBeUndefined();

    // Only one docker.create call in UDS mode: the main container.
    expect(createCalls).toHaveLength(1);

    // Issue #232: Linux UDS mode runs the container as 0:0 and passes
    // the host UID/GID via env so the entrypoint can renumber codespace.
    expect(createCalls[0].user).toBe('0:0');
    expect(createCalls[0].env.IRONCURTAIN_AGENT_UID).toBe(String(process.getuid?.() ?? 1000));
    expect(createCalls[0].env.IRONCURTAIN_AGENT_GID).toBe(String(process.getgid?.() ?? 1000));

    const mounts = createCalls[0].mounts;

    // Defense-in-depth: /run/ironcurtain must map to sockets/ only, so the
    // container cannot reach escalation files, audit log, or other session data.
    const runMount = mounts.find((m) => m.target === '/run/ironcurtain');
    expect(runMount).toBeDefined();
    expect(runMount!.source).toBe(core.socketsDir);
    expect(runMount!.source).not.toBe(core.bundleDir);

    // Symmetric sanity check: the bundle dir itself is never mounted anywhere.
    expect(mounts.some((m) => m.source === core.bundleDir)).toBe(false);
    // And neither is the escalation dir or audit log.
    expect(mounts.some((m) => m.source === core.escalationDir)).toBe(false);
    expect(mounts.some((m) => m.source === core.auditLogPath)).toBe(false);
  });

  it('uds/apple-container: mounts each proxy socket file, --network none, no UID remap', async () => {
    // apple-container's virtiofs directory shares do not carry sockets;
    // each socket is mounted per-file so the runtime creates a vsock relay.
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, runtimeKind: 'apple-container', docker });

    const result = await createSessionContainers(core, makeMockConfig());

    expect(result.sidecarContainerId).toBeUndefined();
    expect(result.internalNetwork).toBeUndefined();
    expect(createCalls).toHaveLength(1);

    const main = createCalls[0];
    expect(main.network).toBe('none');
    expect(main.env.HTTPS_PROXY).toBe('http://127.0.0.1:18080');
    expect(main.env.NODE_EXTRA_CA_CERTS).toBe('/etc/ironcurtain/ca-cert.pem');
    expect(main.env.SSL_CERT_FILE).toBe('/etc/ironcurtain/ca-bundle.pem');
    // The registry proxy is read-only, so npm must not try its audit POSTs.
    expect(main.env.NPM_CONFIG_AUDIT).toBe('false');
    expect(main.env.NPM_CONFIG_FUND).toBe('false');
    // No Linux UID remap on apple-container.
    expect(main.user).toBeUndefined();
    expect(main.env.IRONCURTAIN_AGENT_UID).toBeUndefined();
    expect(main.trustedCreateOptions).toBeUndefined();

    // Per-file socket mounts (NOT the sockets directory).
    const mounts = main.mounts;
    expect(mounts.some((m) => m.source === core.socketsDir)).toBe(false);
    const proxyMount = mounts.find((m) => m.target === '/run/ironcurtain/proxy.sock');
    const mitmMount = mounts.find((m) => m.target === '/run/ironcurtain/mitm-proxy.sock');
    expect(proxyMount?.source).toBe(join(core.socketsDir, 'proxy.sock'));
    expect(mitmMount?.source).toBe(join(core.socketsDir, 'mitm-proxy.sock'));

    // apt config is written via exec (nested-source virtiofs quirk), not
    // bind-mounted.
    expect(mounts.some((m) => m.target === '/etc/apt/apt.conf.d/90-ironcurtain-proxy')).toBe(false);
    // Security invariant carries over: bundle/escalation/audit never mounted.
    expect(mounts.some((m) => m.source === core.bundleDir)).toBe(false);
    expect(mounts.some((m) => m.source === core.escalationDir)).toBe(false);
  });

  it('labels Apple Container VMs with an owner lease and reconciles Apple VMs at startup', async () => {
    // Crash recovery used to be Docker-only: an interrupted Apple session left
    // its VM (memory and CPUs) running until removed by hand.
    const { docker, createCalls } = makeMockDocker();
    const listContainers = vi.fn(async () => []);
    docker.listContainers = listContainers;
    const core = makeMockCore({ tempDir, useTcp: false, runtimeKind: 'apple-container', docker });

    await createSessionContainers(core, makeMockConfig());

    expect(listContainers).toHaveBeenCalledWith({ labelFilter: `${IRONCURTAIN_MANAGED_LABEL}=true` });
    const labels = createCalls[0].labels ?? {};
    expect(labels[IRONCURTAIN_MANAGED_LABEL]).toBe('true');
    const token = labels[IRONCURTAIN_OWNER_TOKEN_LABEL];
    const lease = JSON.parse(
      readFileSync(join(tempDir, 'home', 'run', 'docker-owners', `${token}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(lease).toMatchObject({ state: 'active', runtime: 'apple-container', bundleId: core.bundleId });
  });

  it('creates no container when setup was interrupted before container creation', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, docker });
    const controller = new AbortController();
    controller.abort(new Error('interrupted'));

    await expect(createSessionContainers(core, makeMockConfig(), { signal: controller.signal })).rejects.toThrow(
      /interrupted/,
    );
    expect(createCalls).toHaveLength(0);
  });

  it('stops waiting for agent readiness when interrupted and removes the started container', async () => {
    const controller = new AbortController();
    const tracker = createDockerCallTracker();
    const docker = createMockDocker({
      tracker,
      exec: async (_container, command) => {
        if (command.includes('ironcurtain-agent-startup')) {
          // The entrypoint is still remapping UIDs when Ctrl-C arrives.
          controller.abort(new Error('interrupted'));
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: false, docker });

    const started = Date.now();
    await expect(createSessionContainers(core, makeMockConfig(), { signal: controller.signal })).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(tracker.startCalls).toEqual(['container-1']);
    expect(tracker.removedContainers).toContain('container-1');
  });

  it('ends setup after the connectivity check when interrupted during it', async () => {
    // Nothing after the checks may run (the Apple nested-Docker activation
    // can take minutes): the session never comes up and its resources go.
    const controller = new AbortController();
    const tracker = createDockerCallTracker();
    const docker = createMockDocker({
      tracker,
      exec: async (_container, command) => {
        if (command.includes('/usr/local/bin/ironcurtain-mcp-bridge.mjs')) controller.abort(new Error('interrupted'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, docker });

    await expect(createSessionContainers(core, makeMockConfig(), { signal: controller.signal })).rejects.toThrow(
      /interrupted/,
    );
    // Sidecar (container-1) and agent (container-2), then their network.
    expect(tracker.removedContainers).toEqual(expect.arrayContaining(['container-1', 'container-2']));
    expect(tracker.removedNetworks).toContain(getInternalNetworkName(TEST_SHORT_ID));
  });

  it('creates Apple by the prepared logical tag and verifies the stopped descriptor before start', async () => {
    const tracker = createDockerCallTracker();
    const events: string[] = [];
    const immutableImageId = `sha256:${'a'.repeat(64)}`;
    const docker = createMockDocker({
      tracker,
      create: async () => {
        events.push('create');
        return 'apple-vm-id';
      },
    });
    docker.getImageId = async (id) => {
      expect(id).toBe('apple-vm-id');
      events.push('inspect-stopped');
      return immutableImageId;
    };
    docker.start = async (id) => {
      expect(id).toBe('apple-vm-id');
      events.push('start');
    };
    const logicalName = 'ironcurtain-claude-code:latest';
    const core = {
      ...makeMockCore({ tempDir, useTcp: false, runtimeKind: 'apple-container', docker }),
      image: logicalName,
      imageResolution: makeAppleArtifactResolution(logicalName, immutableImageId),
    };

    await createSessionContainers(core, makeMockConfig());

    expect(tracker.createCalls[0].image).toBe(logicalName);
    expect(events).toEqual(['create', 'inspect-stopped', 'start']);
  });

  it('removes a mismatched stopped Apple create and does not start it', async () => {
    const tracker = createDockerCallTracker();
    const immutableImageId = `sha256:${'a'.repeat(64)}`;
    const docker = createMockDocker({ tracker, create: async () => 'apple-vm-id' });
    docker.getImageId = async () => `sha256:${'f'.repeat(64)}`;
    const logicalName = 'ironcurtain-claude-code:latest';
    const core = {
      ...makeMockCore({ tempDir, useTcp: false, runtimeKind: 'apple-container', docker }),
      image: logicalName,
      imageResolution: makeAppleArtifactResolution(logicalName, immutableImageId),
    };

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(
      /Apple stopped-create image mismatch/u,
    );

    expect(tracker.createCalls[0].image).toBe(logicalName);
    expect(tracker.startCalls).toEqual([]);
    expect(tracker.removedContainers).toEqual(['apple-vm-id']);
  });

  // --- Skills mount tests ---
  async function runSkillsMountScenario(opts: {
    skillsMount?: { hostDir: string; target: string };
  }): Promise<readonly { source: string; target: string; readonly: boolean }[]> {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, docker });
    const coreWithSkills: PreContainerInfrastructure = opts.skillsMount
      ? { ...core, skillsMount: opts.skillsMount }
      : core;
    await createSessionContainers(coreWithSkills, makeMockConfig());
    expect(createCalls).toHaveLength(1);
    return createCalls[0].mounts;
  }

  it('mounts the staged skills directory read-only when skillsMount is set', async () => {
    // The architectural invariant: a separate read-only bind mount from
    // the bundle's staging dir to the adapter-declared container path.
    const skillsDir = join(tempDir, 'session', 'skills');
    mkdirSync(skillsDir, { recursive: true });

    const mounts = await runSkillsMountScenario({
      skillsMount: { hostDir: skillsDir, target: TEST_SKILLS_CONTAINER_PATH },
    });

    const skillsMount = mounts.find((m) => m.target === TEST_SKILLS_CONTAINER_PATH);
    expect(skillsMount).toBeDefined();
    expect(skillsMount!.source).toBe(skillsDir);
    expect(skillsMount!.readonly).toBe(true);
  });

  it('omits the skills mount entirely when core.skillsMount is undefined', async () => {
    const mounts = await runSkillsMountScenario({});
    expect(mounts.some((m) => m.target === TEST_SKILLS_CONTAINER_PATH)).toBe(false);
  });

  it('mounts workflow scripts read-only when scriptsMount is set', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, docker });
    const scriptsDir = join(tempDir, 'workflow-scripts');
    mkdirSync(scriptsDir, { recursive: true });

    await createSessionContainers(
      { ...core, workflowRunDir: tempDir, scriptsMount: { hostDir: scriptsDir, target: '/workflow-scripts' } },
      makeMockConfig(),
    );

    expect(createCalls).toHaveLength(1);
    const scriptsMount = createCalls[0].mounts.find((m) => m.target === '/workflow-scripts');
    expect(scriptsMount).toEqual({ source: scriptsDir, target: '/workflow-scripts', readonly: true });
  });

  it('refuses a changed scripts staging root before creating the container', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, docker });
    const scriptsDir = join(tempDir, 'workflow-scripts');
    mkdirSync(scriptsDir);
    renameSync(scriptsDir, join(tempDir, 'old-stage'));
    symlinkSync(join(tempDir, 'old-stage'), scriptsDir);
    await expect(
      createSessionContainers(
        { ...core, workflowRunDir: tempDir, scriptsMount: { hostDir: scriptsDir, target: '/workflow-scripts' } },
        makeMockConfig(),
      ),
    ).rejects.toThrow('Workflow scripts must name the run-owned workflow-scripts directory');
    expect(createCalls).toHaveLength(0);
  });

  // --- Workflow dependency layers: shared base + per-run writable layer ---
  const SITE_PACKAGES = 'lib/python3.12/site-packages';

  function makeDependencyLayers(workflowId = 'wf-run-a'): WorkflowDependencyLayers {
    return planWorkflowDependencyLayers({
      agentBuildHash: 'b'.repeat(64),
      manifests: {
        'requirements.txt': Buffer.from('numpy\n'),
        'package.json': Buffer.from('{ "dependencies": { "ajv": "^8" } }\n'),
      },
      ironcurtainHome: join(tempDir, 'home'),
      runDependencyRoot: join(tempDir, 'home', 'workflow-runs', workflowId, 'deps'),
    });
  }

  function requireLayers(layers: WorkflowDependencyLayers): {
    python: WorkflowDependencyLayer;
    node: WorkflowDependencyLayer;
  } {
    const python = layers.workflowPythonVenvMount;
    const node = layers.workflowNodeModulesMount;
    if (python === undefined || node === undefined) throw new Error('expected both dependency layers');
    return { python, node };
  }

  interface RecordedExec {
    readonly container: string;
    readonly command: readonly string[];
    readonly user: string | null | undefined;
    readonly workdir: string | undefined;
    readonly environment: Readonly<Record<string, string>> | undefined;
  }

  /**
   * A runtime whose provisioning-container installs populate the shared base
   * the way `uv pip install` / `npm install` would, and that records the
   * create/remove order and every exec.
   */
  function makeProvisioningDocker(
    layers: WorkflowDependencyLayers,
    installResult: { exitCode: number; stdout: string; stderr: string } = { exitCode: 0, stdout: '', stderr: '' },
  ): ReturnType<typeof makeMockDocker> & { events: string[]; execs: RecordedExec[] } {
    const { python, node } = requireLayers(layers);
    const events: string[] = [];
    const execs: RecordedExec[] = [];
    const mock = makeMockDocker({
      async create(config) {
        events.push(`create:${config.name}`);
        if (config.name.includes('-deps-')) return 'deps-container';
        if (config.name.includes('sidecar')) return 'sidecar-container';
        return 'agent-container';
      },
    });
    mock.docker.exec = async (container, command, _timeout, user, workdir, environment) => {
      execs.push({ container, command, user, workdir, environment });
      const script = command[2] ?? '';
      if (container === 'deps-container' && script.includes('uv pip install')) {
        if (installResult.exitCode !== 0) return installResult;
        mkdirSync(join(python.baseDir, SITE_PACKAGES, 'numpy'), { recursive: true });
        writeFileSync(join(python.baseDir, SITE_PACKAGES, 'numpy', '__init__.py'), '__version__ = "2.1.0"\n');
      } else if (container === 'deps-container' && script.includes('npm ')) {
        mkdirSync(join(node.baseDir, 'ajv'), { recursive: true });
        writeFileSync(join(node.baseDir, 'ajv', 'index.js'), 'module.exports = {};\n');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const remove = mock.docker.remove.bind(mock.docker);
    mock.docker.remove = async (id) => {
      events.push(`remove:${id}`);
      await remove(id);
    };
    return { ...mock, events, execs };
  }

  it('delivers a mocked dependency-provisioning host-file finding before starting the agent', async () => {
    const layers = makeDependencyLayers();
    const { docker, events } = makeProvisioningDocker(layers);
    const finding = { path: '/example-dependency-base/example', uid: 0, mode: 0o644, kind: 'file' as const };
    vi.spyOn(hostMountScan, 'createBundlePrivilegedFileScanner').mockReturnValue({
      roots: [],
      scan: vi.fn(async (when: string): Promise<hostMountScan.HostMountPrivilegeScanReport> => ({
        when,
        scannedEntries: 1,
        complete: true,
        stripped: [],
        unstripped: [],
        rootOwned: [finding],
        unreadable: [],
        omitted: 0,
        newFindings: { unstripped: [], rootOwned: [finding] },
      })),
    });
    const onHostPrivilegedFiles = vi.fn(() => {
      expect(events.some((event) => event.startsWith('create:') && !event.includes('-deps-'))).toBe(false);
    });
    const core = { ...makeMockCore({ tempDir, useTcp: false, docker }), ...layers, onHostPrivilegedFiles };

    await createSessionContainers(core, makeMockConfig());

    expect(onHostPrivilegedFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'host_privileged_files',
        when: 'workflow dependency provisioning',
        rootOwned: 1,
      }),
    );
  });

  it("provisions the shared base in a dedicated container and mounts only the run's writable layer", async () => {
    const layers = makeDependencyLayers();
    const { python, node } = requireLayers(layers);
    const { docker, createCalls, events, execs } = makeProvisioningDocker(layers);
    const core: PreContainerInfrastructure = { ...makeMockCore({ tempDir, useTcp: false, docker }), ...layers };

    await createSessionContainers(core, makeMockConfig());

    expect(createCalls).toHaveLength(2);
    const [provisioner, agent] = createCalls;

    // The provisioning container: pristine agent image, the base read-write at
    // the run-layer target, the exact manifests and the public CA read-only,
    // and only the MITM socket. Nothing agent-facing.
    expect(provisioner.name).toBe(`ironcurtain-deps-${TEST_SHORT_ID}`);
    expect(provisioner.image).toBe('ironcurtain-claude-code:latest');
    expect(provisioner.network).toBe('none');
    expect(provisioner.mounts).toEqual(
      expect.arrayContaining([
        { source: python.baseDir, target: '/opt/workflow-venv', readonly: false },
        { source: node.baseDir, target: '/opt/workflow-node_modules', readonly: false },
        { source: expect.any(String), target: WORKFLOW_DEPENDENCY_MANIFESTS_DIR, readonly: true },
        { source: expect.any(String), target: '/etc/ironcurtain', readonly: true },
        {
          source: join(core.socketsDir, 'mitm-proxy.sock'),
          target: '/run/ironcurtain/mitm-proxy.sock',
          readonly: false,
        },
      ]),
    );
    expect(provisioner.mounts).toHaveLength(5);
    expect(provisioner.mounts.find((mount) => mount.target === '/etc/ironcurtain')?.source).not.toBe(
      core.orientationDir,
    );
    expect(provisioner.mounts.map((mount) => mount.target)).not.toContain('/workspace');
    expect(provisioner.env.TEST_KEY).toBeUndefined();
    expect(provisioner.env.HTTPS_PROXY).toBe('http://127.0.0.1:18080');
    expect(provisioner.env.NODE_PATH).toBeUndefined();
    // `npm install` here goes through the read-only registry proxy too.
    expect(provisioner.env.NPM_CONFIG_AUDIT).toBe('false');
    expect(provisioner.env.NPM_CONFIG_FUND).toBe('false');

    // Installs run as codespace, outside /workspace, in the provisioner only.
    const installs = execs.filter((entry) => entry.command[1] === '-lc');
    expect(installs.map((entry) => entry.container)).toEqual(['deps-container', 'deps-container']);
    expect(installs[0].command[2]).toContain('uv pip install');
    expect(installs[1].command[2]).toContain('npm install --omit=dev');
    for (const install of installs) {
      expect(install.user).toBe('codespace');
      expect(install.workdir).toBe('/tmp');
    }

    // The provisioner is gone before the agent container exists.
    expect(events).toEqual([
      `create:ironcurtain-deps-${TEST_SHORT_ID}`,
      'remove:deps-container',
      `create:ironcurtain-${TEST_SHORT_ID}`,
    ]);

    // The agent container uses the stock agent image (no per-workflow image),
    // mounts only this run's layers (read-write), never the shared base, and
    // NODE_PATH is not set container-wide.
    expect(agent.image).toBe('ironcurtain-claude-code:latest');
    expect(agent.mounts).toEqual(
      expect.arrayContaining([
        { source: python.hostDir, target: '/opt/workflow-venv', readonly: false },
        { source: node.hostDir, target: '/opt/workflow-node_modules', readonly: false },
      ]),
    );
    expect(agent.mounts.some((mount) => mount.source.startsWith(python.cacheRoot))).toBe(false);
    expect(agent.env.NODE_PATH).toBeUndefined();
    // PATH must NOT be overridden: Docker `-e PATH=...` REPLACES (not appends)
    // the image PATH. The workflow venv bin is prepended at exec time instead.
    expect(agent.env.PATH).toBeUndefined();

    // The run layer was seeded from the provisioned base, whose record lives on the host.
    expect(readFileSync(join(python.hostDir, SITE_PACKAGES, 'numpy', '__init__.py'), 'utf8')).toBe(
      '__version__ = "2.1.0"\n',
    );
    expect(existsSync(provisionedRecordPath(python))).toBe(true);
    expect(existsSync(provisionedRecordPath(node))).toBe(true);
  });

  it('runs the installs of a sudo-off bundle as the numeric agent UID, never by account name (DINF-3)', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    vi.spyOn(process, 'getgid').mockReturnValue(1000);
    try {
      const layers = makeDependencyLayers();
      const { docker, createCalls, execs } = makeProvisioningDocker(layers);
      const config = makeMockConfig({ agentSudo: false });

      await createSessionContainers({ ...makeMockCore({ tempDir, useTcp: false, docker }), ...layers }, config);

      const provisioner = createCalls.find((call) => call.name.includes('-deps-'));
      expect(provisioner?.user).toBe('1000');
      expect(provisioner?.capAdd).toEqual([]);
      expect(provisioner?.trustedCreateOptions?.securityOptions).toEqual(['no-new-privileges:true']);
      const deps = execs.filter((entry) => entry.container === 'deps-container');
      expect(deps.length).toBeGreaterThan(0);
      for (const entry of deps) expect(entry.user).toBe('1000');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'strips setuid bits the installs left in the shared base before recording it, on a host-root daemon (DINF-3)',
    async () => {
      const layers = makeDependencyLayers();
      const { python } = requireLayers(layers);
      const { docker } = makeProvisioningDocker(layers);
      const install = docker.exec.bind(docker);
      docker.exec = async (container, command, timeout, user, workdir) => {
        const result = await install(container, command, timeout, user, workdir);
        if (container === 'deps-container' && (command[2] ?? '').includes('uv pip install')) {
          const helper = join(python.baseDir, 'bin', 'helper');
          mkdirSync(join(python.baseDir, 'bin'), { recursive: true });
          writeFileSync(helper, '#!/bin/sh\n');
          chmodSync(helper, 0o4755);
        }
        return result;
      };
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await createSessionContainers(
          { ...makeMockCore({ tempDir, useTcp: false, docker }), ...layers, containerRootIsHostRoot: true },
          makeMockConfig(),
        );

        expect(statSync(join(python.baseDir, 'bin', 'helper')).mode & 0o7777).toBe(0o755);
        expect(statSync(join(python.hostDir, 'bin', 'helper')).mode & 0o7777).toBe(0o755);
        const record = JSON.parse(readFileSync(provisionedRecordPath(python), 'utf8')) as {
          entries: { path: string; mode?: number }[];
        };
        expect(record.entries.find((entry) => entry.path === 'bin/helper')?.mode).toBe(0o755);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('re-mounts an existing run layer on resume without starting a provisioning container', async () => {
    const layers = makeDependencyLayers();
    const { python, node } = requireLayers(layers);
    // An earlier bundle of this run seeded the layers and the agent installed scipy.
    mkdirSync(join(python.hostDir, SITE_PACKAGES, 'scipy'), { recursive: true });
    writeFileSync(join(python.hostDir, SITE_PACKAGES, 'scipy', '__init__.py'), '__version__ = "1.14"\n');
    mkdirSync(node.hostDir, { recursive: true });
    const { docker, createCalls } = makeProvisioningDocker(layers);

    await createSessionContainers({ ...makeMockCore({ tempDir, useTcp: false, docker }), ...layers }, makeMockConfig());

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].mounts).toEqual(
      expect.arrayContaining([
        { source: python.hostDir, target: '/opt/workflow-venv', readonly: false },
        { source: node.hostDir, target: '/opt/workflow-node_modules', readonly: false },
      ]),
    );
    expect(readFileSync(join(python.hostDir, SITE_PACKAGES, 'scipy', '__init__.py'), 'utf8')).toBe(
      '__version__ = "1.14"\n',
    );
  });

  it('mounts the run layer read-only in a read-only bundle, which shares it with read-write scopes (WP-131)', async () => {
    // Every bundle of the run mounts the same run layer, and the read-write
    // scopes execute what is installed there: a read-only reviewer that could
    // change it would run code in a container that can write the workspace.
    const layers = makeDependencyLayers();
    const { python, node } = requireLayers(layers);
    mkdirSync(join(python.hostDir, SITE_PACKAGES), { recursive: true });
    mkdirSync(node.hostDir, { recursive: true });
    const { docker, createCalls } = makeProvisioningDocker(layers);
    const readOnly = { ...makeMockConfig(), readOnlyWorkspace: { writablePaths: ['.workflow/reviews'] } };

    await createSessionContainers({ ...makeMockCore({ tempDir, useTcp: false, docker }), ...layers }, readOnly);

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].mounts).toEqual(
      expect.arrayContaining([
        { source: python.hostDir, target: '/opt/workflow-venv', readonly: true },
        { source: node.hostDir, target: '/opt/workflow-node_modules', readonly: true },
      ]),
    );
  });

  it('provisions from the pristine agent image even when the agent resumes from a snapshot', async () => {
    const layers = makeDependencyLayers();
    const { docker, createCalls } = makeProvisioningDocker(layers);
    const agentBuildHash = 'b'.repeat(64);
    const snapshot = `sha256:${'c'.repeat(64)}`;
    docker.inspectImage = async (ref) =>
      ref === snapshot
        ? { id: snapshot, repoTags: [], labels: { 'ironcurtain.build-hash': agentBuildHash }, created: '' }
        : undefined;

    const resources = await createSessionContainers(
      {
        ...makeMockCore({ tempDir, useTcp: false, docker }),
        ...layers,
        imageResolution: {
          mode: 'build-if-stale',
          logicalName: 'ironcurtain-claude-code:latest',
          imageRef: 'ironcurtain-claude-code:latest',
          buildHash: agentBuildHash,
        },
      },
      makeMockConfig(),
      { baseImageOverride: snapshot, baseImageAgentBuildHash: agentBuildHash },
    );

    expect(createCalls.map((call) => call.image)).toEqual(['ironcurtain-claude-code:latest', snapshot]);
    expect(resources.snapshotRefusal).toBeUndefined();
  });

  it('runs the provisioner on the internal network behind the sidecar in TCP mode', async () => {
    const layers = makeDependencyLayers();
    const { python } = requireLayers(layers);
    const { docker, createCalls, execs } = makeProvisioningDocker(layers);

    await createSessionContainers({ ...makeMockCore({ tempDir, useTcp: true, docker }), ...layers }, makeMockConfig());

    const provisioner = createCalls.find((call) => call.name.includes('-deps-'));
    expect(provisioner).toBeDefined();
    expect(provisioner?.network).toBe(getInternalNetworkName(TEST_SHORT_ID));
    expect(provisioner?.extraHosts).toEqual([`host.docker.internal:${createCalls[0].ipv4Address}`]);
    expect(provisioner?.env).not.toHaveProperty('HTTPS_PROXY');
    expect(provisioner?.env).not.toHaveProperty('HTTP_PROXY');
    expect(provisioner?.privateEnv).toMatchObject({
      HTTPS_PROXY: `http://ironcurtain:${'2'.repeat(43)}@host.docker.internal:8443`,
      HTTP_PROXY: `http://ironcurtain:${'2'.repeat(43)}@host.docker.internal:8443`,
    });
    expect(provisioner?.privateEnv).not.toHaveProperty('IRONCURTAIN_MCP_TCP_TOKEN');
    expect(provisioner?.user).toBeUndefined();
    expect(provisioner?.mounts.some((mount) => mount.target.startsWith('/run/ironcurtain'))).toBe(false);
    expect(provisioner?.mounts).toContainEqual({
      source: python.baseDir,
      target: '/opt/workflow-venv',
      readonly: false,
    });
    // The installer has only its registry transport capability, never MCP.
    const provisioningExecs = execs.filter((entry) => entry.container === 'deps-container');
    for (const entry of provisioningExecs) {
      expect(entry.environment ?? {}).not.toHaveProperty('IRONCURTAIN_MCP_TCP_TOKEN');
      expect(entry.command.join(' ')).not.toContain('2'.repeat(43));
    }
    expect(provisioningExecs.some((entry) => entry.command.includes('/usr/local/bin/ironcurtain-mcp-bridge.mjs'))).toBe(
      false,
    );
    expect(
      provisioningExecs.some(
        (entry) =>
          entry.command.join(' ').includes('http://ironcurtain.invalid/__ironcurtain/health') &&
          entry.environment?.IRONCURTAIN_HTTP_PROXY_AUTHORIZATION ===
            testTcpTransportCredentials().proxyAuthorization.header,
      ),
    ).toBe(true);
  });

  it('fails closed, with nothing seeded, when an install fails', async () => {
    const layers = makeDependencyLayers();
    const { python } = requireLayers(layers);
    const { docker, createCalls, removedContainers } = makeProvisioningDocker(layers, {
      exitCode: 1,
      stdout: '',
      stderr: 'No solution found when resolving dependencies\u0007',
    });

    const attempt = createSessionContainers(
      { ...makeMockCore({ tempDir, useTcp: false, docker }), ...layers },
      makeMockConfig(),
    );
    await expect(attempt).rejects.toThrow(/Workflow Python dependency provisioning failed: No solution found/);
    await expect(attempt).rejects.toThrow('\\u0007');
    await expect(attempt).rejects.not.toThrow('\u0007');

    expect(createCalls.map((call) => call.name)).toEqual([`ironcurtain-deps-${TEST_SHORT_ID}`]);
    expect(removedContainers).toContain('deps-container');
    expect(existsSync(provisionedRecordPath(python))).toBe(false);
    expect(existsSync(python.hostDir)).toBe(false);
  });

  it('refuses to trust a base whose provisioning container could not be removed', async () => {
    const layers = makeDependencyLayers();
    const { python } = requireLayers(layers);
    const { docker, createCalls } = makeProvisioningDocker(layers);
    // A container that survives removal could still be writing the base.
    docker.containerExists = async (id) => id === 'deps-container';

    await expect(
      createSessionContainers({ ...makeMockCore({ tempDir, useTcp: false, docker }), ...layers }, makeMockConfig()),
    ).rejects.toThrow(/could not be removed; refusing to trust the base/);

    expect(createCalls).toHaveLength(1);
    expect(existsSync(provisionedRecordPath(python))).toBe(false);
    expect(existsSync(python.hostDir)).toBe(false);
  });

  // --- UID remap (issue #232) ---
  it('waits for the Linux entrypoint handoff before the writable-storage check', async () => {
    const events: string[] = [];
    const { docker, createCalls } = makeMockDocker();
    docker.exec = async (_container, command, _timeout, user) => {
      if (command.includes('ironcurtain-agent-startup')) {
        expect(user).toBe('0:0');
        events.push('entrypoint-ready');
      } else if (command.some((arg) => arg.includes('.ironcurtain-write-probe'))) {
        expect(events).toEqual(['entrypoint-ready']);
        events.push('storage-check');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await createSessionContainers(makeMockCore({ tempDir, useTcp: false, docker }), makeMockConfig());
    expect(createCalls[0].command).toContain('ironcurtain-agent-startup');
    expect(createCalls[0].command.slice(-2)).toEqual(['sleep', 'infinity']);
    expect(events).toEqual(['entrypoint-ready', 'storage-check']);
  });

  it('does NOT pass --user 0:0 or UID env in TCP (macOS) mode', async () => {
    // On macOS, VirtioFS handles UID translation and `--user 0:0` would
    // break it; the agent container must run as the baked codespace user.
    // We construct a TCP-mode core but bypass the connectivity check by
    // returning exitCode 0 from the mocked exec.
    const healthCommands: string[][] = [];
    const { docker, createCalls, createdNetworks } = makeMockDocker({
      async exec(_container, command) {
        healthCommands.push([...command]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, docker });
    await createSessionContainers(core, makeMockConfig());

    // Two creates in TCP mode: [0] sidecar, [1] main container.
    expect(createCalls).toHaveLength(2);
    // The socat sidecar forks per connection; it is never left unbounded
    // (DINF-11), even without a nested-Docker partition. Its read-only,
    // no-new-privileges hardening (transport-sidecar-image.ts) is layered
    // on those bounds without dropping them.
    expect(createCalls[0].resources).toEqual({
      memoryMb: TRANSPORT_SIDECAR_LIMITS.memoryMb,
      cpus: TRANSPORT_SIDECAR_LIMITS.cpus,
    });
    expect(createCalls[0].trustedCreateOptions).toEqual({
      pidsLimit: TRANSPORT_SIDECAR_LIMITS.pidsLimit,
      ulimits: [
        {
          name: 'nofile',
          soft: TRANSPORT_SIDECAR_LIMITS.openFilesLimit,
          hard: TRANSPORT_SIDECAR_LIMITS.openFilesLimit,
        },
      ],
      readOnlyRootfs: true,
      securityOptions: ['no-new-privileges:true'],
    });
    expect(createCalls[0].user).toBe('65534:65534');
    const mainCreate = createCalls[1];
    const sidecarSubnet = createdNetworks[0].options?.subnet;
    if (typeof sidecarSubnet !== 'string') throw new Error('Expected an allocated internal subnet');
    const sidecarAddress = ironCurtainInternalSubnetHostAddress(sidecarSubnet, 2);
    expect(createCalls[0].network).toBe(mainCreate.network);
    expect(createCalls[0].ipv4Address).toBe(sidecarAddress);
    expect(createCalls[0].command.join(' ').replaceAll('\\', '')).toContain(`,bind=${sidecarAddress},`);
    expect(mainCreate.user).toBeUndefined();
    expect(mainCreate.env.IRONCURTAIN_AGENT_UID).toBeUndefined();
    expect(mainCreate.env.IRONCURTAIN_AGENT_GID).toBeUndefined();
    expect(healthCommands).toHaveLength(3);
    expect(healthCommands[0].join(' ')).toContain('.ironcurtain-write-probe');
    expect(healthCommands[1]).toContain('/usr/local/bin/ironcurtain-mcp-bridge.mjs');
    expect(healthCommands[1]).toContain('--health');
    expect(healthCommands[2].join(' ')).toContain('http://ironcurtain.invalid/__ironcurtain/health');
    expect(createdNetworks).toHaveLength(1);
    expect(createdNetworks[0].options).toMatchObject({
      internal: true,
      subnet: expect.stringMatching(/\/29$/),
      labels: expect.objectContaining({ 'ironcurtain.managed': 'true' }),
    });
  });

  // WP-27: the sidecar relays every tool call and CONNECT stream, so it runs
  // only from the locally built sidecar image, by the immutable ID its build
  // labels were verified on, read-only, unprivileged and without new
  // privileges. It used to be `alpine/socat` pulled and trusted by name.
  it('creates the TCP sidecar from the verified local build by immutable ID, read-only, as nobody, without new privileges', async () => {
    const built: Array<{ tag: string; contextDir: string; labels?: Record<string, string> }> = [];
    const pulled: string[] = [];
    const { docker, createCalls } = makeMockDocker({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const buildImage = docker.buildImage.bind(docker);
    docker.buildImage = async (tag, dockerfile, contextDir, labels, buildArgs) => {
      built.push({ tag, contextDir, labels });
      return buildImage(tag, dockerfile, contextDir, labels, buildArgs);
    };
    docker.pullImage = async (image) => {
      pulled.push(image);
    };
    await createSessionContainers(makeMockCore({ tempDir, useTcp: true, docker }), makeMockConfig());

    const sidecar = createCalls[0];
    expect(sidecar.name).toContain('sidecar');
    expect(built).toEqual([
      {
        tag: TRANSPORT_SIDECAR_IMAGE,
        contextDir: transportSidecarContextDir(),
        labels: {
          'ironcurtain.build-hash': computeTransportSidecarBuildHash(transportSidecarContextDir()),
          'ironcurtain.component': 'transport-sidecar',
        },
      },
    ]);
    expect(pulled).toEqual([]);
    expect(sidecar.image).toBe(MOCK_TRANSPORT_SIDECAR_IMAGE_ID);
    expect(sidecar.image).not.toMatch(/socat/);
    expect(sidecar.user).toBe('65534:65534');
    expect(sidecar.trustedCreateOptions).toMatchObject({
      readOnlyRootfs: true,
      securityOptions: ['no-new-privileges:true'],
    });
    expect(sidecar.capAdd ?? []).toEqual([]);
    expect(sidecar.command.join(' ').replaceAll('\\', '')).toContain('OPENSSL:host.docker.internal:');
    expect(sidecar.command.join(' ').replaceAll('\\', '')).toContain('verify=1');
    expect(sidecar.mounts).toContainEqual({
      source: resolve(tempDir, 'session', 'orientation', 'ca-cert.pem'),
      target: '/etc/ironcurtain-host-ca.pem',
      readonly: true,
    });
  });

  it('refuses to start the TCP sidecar from an image that is not the expected local build', async () => {
    const { docker, createCalls } = makeMockDocker();
    // The tag resolves to an image someone else built (or pulled and tagged):
    // the build hash does not match, so its ID is never used.
    docker.inspectImage = async () => ({
      id: `sha256:${'6'.repeat(64)}`,
      repoTags: [TRANSPORT_SIDECAR_IMAGE],
      labels: { 'ironcurtain.build-hash': 'f'.repeat(64), 'ironcurtain.component': 'transport-sidecar' },
      created: '',
    });
    await expect(
      createSessionContainers(makeMockCore({ tempDir, useTcp: true, docker }), makeMockConfig()),
    ).rejects.toThrow(/did not resolve to its expected local build/);
    expect(createCalls.some((call) => call.name.includes('sidecar'))).toBe(false);
  });

  it('refuses an incorrect sidecar address before agent creation and cleans its resources', async () => {
    const { docker, createCalls, removedContainers, removedNetworks } = makeMockDocker();
    docker.getContainerIp = async () => '172.30.0.254';
    await expect(
      createSessionContainers(makeMockCore({ tempDir, useTcp: true, docker }), makeMockConfig()),
    ).rejects.toThrow('planned internal IPv4 address');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].name).toContain('sidecar');
    expect(removedContainers).toContain('container-1');
    expect(removedNetworks).toContain(getInternalNetworkName(TEST_SHORT_ID));
  });

  it('mounts an empty skills directory when set (workflow-mode invariant)', async () => {
    // Workflow-mode bundles always create the skills dir at container
    // start so per-state persona transitions can re-stage into it later
    // (the bind mount is established once and cannot be added post-hoc).
    // An empty initial dir must still produce a mount.
    const skillsDir = join(tempDir, 'session', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    // No skill subdirs written — dir is empty.

    const mounts = await runSkillsMountScenario({
      skillsMount: { hostDir: skillsDir, target: TEST_SKILLS_CONTAINER_PATH },
    });

    const skillsMount = mounts.find((m) => m.target === TEST_SKILLS_CONTAINER_PATH);
    expect(skillsMount).toBeDefined();
    expect(skillsMount!.source).toBe(skillsDir);
    expect(skillsMount!.readonly).toBe(true);
  });

  // --- Test B (error-path critical) ---
  // This is the test that would have caught Fix 1's bug: the pre-fix catch
  // passed containerId:null to cleanupContainers, so a failed connectivity
  // check would leak the already-started main container. The test fails
  // both TCP-mode resources (sidecar + network) AND the main container
  // to defend against regressions from either end of the rollback path.
  it('throws when connectivity check fails and cleans up sidecar, network, and main container', async () => {
    const { docker, stoppedContainers, removedContainers, removedNetworks, createdNetworks } = makeMockDocker({
      async exec(_containerId, command) {
        if (command.some((arg) => arg.includes('.ironcurtain-write-probe'))) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        // Simulate the connectivity check failing: container can't reach
        // host-side proxies through the socat sidecar.
        return { exitCode: 1, stdout: '', stderr: 'Connection refused' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, docker });

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(
      /Internal network connectivity check failed/,
    );

    // The sidecar is `container-1` (first docker.create call) and the main
    // container is `container-2` (second). Both must be stopped and removed
    // regardless of where the failure occurred in the try block.
    expect(stoppedContainers).toContain('container-1'); // sidecar
    expect(stoppedContainers).toContain('container-2'); // main
    expect(removedContainers).toContain('container-1');
    expect(removedContainers).toContain('container-2');

    // The per-session internal network must also be cleaned up.
    const expectedNetworkName = getInternalNetworkName(TEST_SHORT_ID);
    expect(removedNetworks).toContain(expectedNetworkName);
    expect(createdNetworks).toHaveLength(4);
    const attemptedSubnets = createdNetworks.map((entry) => entry.options?.subnet);
    expect(new Set(attemptedSubnets).size).toBe(4);
    expect(new Set(attemptedSubnets.map((subnet) => dockerAllocationPoolForSubnet(String(subnet)))).size).toBe(4);
  });

  it('bounds writable-probe diagnostics and renders formatting tokens visibly', async () => {
    const { docker } = makeMockDocker();
    docker.exec = async () => ({ exitCode: 1, stdout: '', stderr: `setup\u0007 failed\u202e ${'x'.repeat(10000)}` });
    const error = await checkDockerContainerWritableStorage(docker, 'container-id').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('setup\\u0007 failed\\u202e');
    expect(message).not.toContain('\u0007');
    expect(message).not.toContain('\u202e');
    expect(message.length).toBeLessThan(2400);
    expect(message).toContain('...[+');
  });

  it('reports exhausted Docker writable storage before starting the agent', async () => {
    const docker = {
      async exec() {
        return { exitCode: 1, stdout: '', stderr: 'mkdir: No space left on device' };
      },
    } as unknown as ContainerRuntime;

    await expect(checkDockerContainerWritableStorage(docker, 'container-id')).rejects.toThrow(
      /Docker container writable storage check failed: mkdir: No space left on device.*docker system df/,
    );
  });

  it('does not diagnose unrelated writable-storage probe failures as disk exhaustion', async () => {
    const docker = {
      async exec() {
        return { exitCode: 1, stdout: '', stderr: 'mkdir: Permission denied' };
      },
    } as unknown as ContainerRuntime;

    await expect(checkDockerContainerWritableStorage(docker, 'container-id')).rejects.toThrow(
      /Permission denied.*Inspect the container state, Docker daemon logs, and filesystem permissions/,
    );
    await expect(checkDockerContainerWritableStorage(docker, 'container-id')).rejects.not.toThrow(/docker system df/);
  });

  // --- tcp-hostonly topology (apple-container) ---

  const HOST_ONLY = { name: 'ironcurtain-hostonly-net', subnet: '192.168.205.0/24', gateway: '192.168.205.1' };

  /** exec mock: proxy reachable at the gateway, egress probe blocked. */
  const healthyHostOnlyExec = async (
    _container: string,
    cmd: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const target = cmd.join(' ');
    if (target.includes('1.1.1.1')) return { exitCode: 1, stdout: '', stderr: 'Connection timed out' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  it('hostonly: attaches the main container to the host-only network with no sidecar', async () => {
    const { docker, createCalls, createdNetworks } = makeMockDocker({ exec: healthyHostOnlyExec });
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', hostOnlyNetwork: HOST_ONLY, docker });

    const result = await createSessionContainers(core, makeMockConfig());

    // Exactly one create: the main container. No socat sidecar.
    expect(createCalls).toHaveLength(1);
    const main = createCalls[0];
    expect(main.network).toBe(HOST_ONLY.name);
    expect(main.extraHosts).toBeUndefined();
    // Proxy env points at the vmnet gateway, not host.docker.internal.
    expect(main.env.HTTPS_PROXY).toBe(`http://${HOST_ONLY.gateway}:8443`);
    expect(main.env.HTTP_PROXY).toBe(`http://${HOST_ONLY.gateway}:8443`);
    // No single-file bind mounts: apple container virtiofs shares
    // directories only, so the apt proxy config is written via exec.
    expect(main.mounts.every((m) => !m.target.startsWith('/etc/apt/'))).toBe(true);

    expect(result.sidecarContainerId).toBeUndefined();
    // The prepare-phase network is reported as internalNetwork so the
    // standard teardown paths remove it.
    expect(result.internalNetwork).toBe(HOST_ONLY.name);
    // The network is created during the prepare phase, never here.
    expect(createdNetworks).toHaveLength(0);
  });

  it('hostonly: writes the apt proxy config via exec, then probes gateway reachability and egress', async () => {
    const execTargets: string[] = [];
    const { docker } = makeMockDocker({
      exec: async (container, cmd) => {
        execTargets.push(cmd.join(' '));
        return healthyHostOnlyExec(container, cmd);
      },
    });
    const execCalls = vi.spyOn(docker, 'exec');
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', hostOnlyNetwork: HOST_ONLY, docker });

    await createSessionContainers(core, makeMockConfig());

    const aptWrite = execTargets.find((t) => t.includes('/etc/apt/apt.conf.d/90-ironcurtain-proxy'));
    expect(aptWrite).toBeDefined();
    expect(aptWrite).toContain('$IRONCURTAIN_APT_PROXY_CONFIG');
    const aptConfiguration = execCalls.mock.calls.find((call) =>
      call[1].some((part) => part.includes('/etc/apt/apt.conf.d/90-ironcurtain-proxy')),
    )?.[5]?.IRONCURTAIN_APT_PROXY_CONFIG;
    expect(aptConfiguration).toContain(`http://${HOST_ONLY.gateway}:8443`);
    expect(aptConfiguration).toContain('Acquire::https::CaInfo "/etc/ironcurtain/ca-bundle.pem";');
    expect(execTargets.some((t) => t.includes(`TCP:${HOST_ONLY.gateway}:9123`))).toBe(true);
    expect(execTargets.some((t) => t.includes('TCP:1.1.1.1:443'))).toBe(true);
  });

  it('hostonly: aborts and cleans up when the gateway proxies are unreachable', async () => {
    const { docker, stoppedContainers, removedContainers, removedNetworks } = makeMockDocker({
      async exec(_container, cmd) {
        // Fail the socat connectivity probes; let the apt config write pass.
        if (cmd.some((c) => c.startsWith('TCP:'))) {
          return { exitCode: 1, stdout: '', stderr: 'Connection refused' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', hostOnlyNetwork: HOST_ONLY, docker });

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(
      /cannot reach host-side proxies at gateway/,
    );

    expect(stoppedContainers).toContain('container-1');
    expect(removedContainers).toContain('container-1');
    expect(removedNetworks).toContain(HOST_ONLY.name);
  });

  it('hostonly: aborts and cleans up when internet egress is NOT blocked', async () => {
    // Every probe succeeds — including the egress probe, meaning the
    // "host-only" network can reach the internet. Must fail closed.
    const { docker, removedContainers, removedNetworks } = makeMockDocker({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', hostOnlyNetwork: HOST_ONLY, docker });

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(/egress check failed/);

    expect(removedContainers).toContain('container-1');
    expect(removedNetworks).toContain(HOST_ONLY.name);
  });

  it('hostonly: throws when the bundle is missing its host-only network', async () => {
    const { docker, createCalls } = makeMockDocker({ exec: healthyHostOnlyExec });
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', docker });

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(
      /missing its host-only network or proxy ports/,
    );
    expect(createCalls).toHaveLength(0);
  });
});

// --- destroyDockerInfrastructure tests ---
//
// These tests exercise the teardown counterpart to createDockerInfrastructure().
// They drive a scripted DockerInfrastructure bundle with a mock ContainerRuntime
// and mock proxies to verify:
//   - all teardown steps run, in the right order
//   - UDS mode skips sidecar + network steps (those fields are undefined in
//     the bundle, so cleanupContainers has nothing to clean)
//   - TCP mode runs sidecar + network steps
//   - a failure in one step does not prevent subsequent steps from running
//     (error tolerance: callers in recovery paths depend on this function
//     never throwing)

/**
 * Tracked proxy: records whether `stop()` was called and optionally throws.
 * Used to assert ordering across proxy stops and to inject failures.
 */
interface TrackedProxy {
  stop: () => Promise<void>;
  stopped: boolean;
}

function makeTrackedMitmProxy(opts: { throwOnStop?: boolean } = {}): MitmProxy & TrackedProxy {
  const tracked = {
    stopped: false,
    async start() {
      return { socketPath: '/tmp/test-mitm-proxy.sock' };
    },
    async stop() {
      tracked.stopped = true;
      if (opts.throwOnStop) throw new Error('mitm-proxy stop failed');
    },
  } as unknown as MitmProxy & TrackedProxy;
  return tracked;
}

function makeTrackedDockerProxy(opts: { throwOnStop?: boolean } = {}): DockerProxy & TrackedProxy {
  const tracked = {
    socketPath: '/tmp/test-proxy.sock',
    port: undefined,
    stopped: false,
    async start() {},
    getHelpData() {
      return { serverDescriptions: {}, toolsByServer: {} };
    },
    async stop() {
      tracked.stopped = true;
      if (opts.throwOnStop) throw new Error('docker-proxy stop failed');
    },
  } as unknown as DockerProxy & TrackedProxy;
  return tracked;
}

/**
 * Builds a full DockerInfrastructure bundle for teardown tests. TCP-mode
 * fields (sidecarContainerId, internalNetwork) are populated only when
 * `useTcp` is true, matching what createSessionContainers() would produce.
 */
interface MakeBundleOptions {
  readonly tempDir: string;
  readonly useTcp: boolean;
  readonly docker: ContainerRuntime;
  readonly mitmProxy: MitmProxy;
  readonly proxy: DockerProxy;
}

function makeInfrastructureBundle(opts: MakeBundleOptions): DockerInfrastructure {
  const core = makeMockCore({ tempDir: opts.tempDir, useTcp: opts.useTcp, docker: opts.docker });
  // Overlay the tracked proxies onto the core (makeMockCore installs its own
  // defaults, which we don't want for teardown assertions).
  const coreWithProxies: PreContainerInfrastructure = {
    ...core,
    mitmProxy: opts.mitmProxy,
    proxy: opts.proxy,
  };
  return {
    ...coreWithProxies,
    containerId: 'main-container-id',
    containerName: 'ironcurtain-test-session',
    ...(opts.useTcp
      ? {
          sidecarContainerId: 'sidecar-container-id',
          internalNetwork: getInternalNetworkName(TEST_SHORT_ID),
        }
      : {}),
  };
}

describe('destroyDockerInfrastructure', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'destroy-infra-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs all teardown steps (TCP mode: container, sidecar, network, both proxies)', async () => {
    // Containers tear down before proxies (stop consumers before producers);
    // the two proxy stops run in parallel, so their relative order is not
    // part of the contract -- only that both were called.
    const { docker, stoppedContainers, removedContainers, removedNetworks } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: true, docker, mitmProxy, proxy });

    await destroyDockerInfrastructure(infra);

    // Main + sidecar containers both stopped + removed.
    expect(stoppedContainers).toContain('main-container-id');
    expect(stoppedContainers).toContain('sidecar-container-id');
    expect(removedContainers).toContain('main-container-id');
    expect(removedContainers).toContain('sidecar-container-id');

    // Internal network removed.
    expect(removedNetworks).toContain(infra.internalNetwork);

    // Both proxies stopped (parallel; order not asserted).
    expect(mitmProxy.stopped).toBe(true);
    expect(proxy.stopped).toBe(true);
  });

  it('sweeps the host mounts for planted privilege after the container is gone (DINF-3)', async () => {
    const { docker, removedContainers } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy();
    const containersRemovedAtScan: string[][] = [];
    const scan = vi.fn(async (when: string) => {
      containersRemovedAtScan.push([...removedContainers]);
      return {
        scannedEntries: 0,
        complete: true,
        stripped: [],
        unstripped: [],
        rootOwned: [],
        unreadable: [],
        omitted: 0,
        when,
        newFindings: { unstripped: [], rootOwned: [] },
      };
    });
    const infra: DockerInfrastructure = {
      ...makeInfrastructureBundle({ tempDir, useTcp: false, docker, mitmProxy, proxy }),
      privilegedFileScanner: { roots: [], scan },
    };

    // A scan that found nothing leaves nothing to report.
    await expect(destroyDockerInfrastructure(infra)).resolves.toEqual({});

    expect(scan).toHaveBeenCalledWith('session end');
    expect(containersRemovedAtScan).toEqual([['main-container-id']]);
  });

  it('returns what the final host-mount scan found left behind, also findings a turn reported already', async () => {
    const { docker } = makeMockDocker();
    const rootOwned = { path: join(tempDir, 'workspace', 'build'), uid: 0, mode: 0o755, kind: 'directory' as const };
    const infra: DockerInfrastructure = {
      ...makeInfrastructureBundle({
        tempDir,
        useTcp: false,
        docker,
        mitmProxy: makeTrackedMitmProxy(),
        proxy: makeTrackedDockerProxy(),
      }),
      privilegedFileScanner: {
        roots: [],
        scan: vi.fn(async (when: string) => ({
          scannedEntries: 3,
          complete: true,
          stripped: [],
          unstripped: [],
          rootOwned: [rootOwned],
          unreadable: [],
          omitted: 0,
          when,
          newFindings: { unstripped: [], rootOwned: [] },
        })),
      },
    };

    const teardown = await destroyDockerInfrastructure(infra);

    expect(teardown.privilegedFiles).toMatchObject({
      kind: 'host_privileged_files',
      when: 'session end',
      rootOwned: 1,
      paths: [rootOwned.path],
    });
  });

  it('UDS mode skips sidecar + network steps (neither is present in the bundle)', async () => {
    const { docker, stoppedContainers, removedContainers, removedNetworks } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: false, docker, mitmProxy, proxy });

    // Sanity: UDS bundle has no sidecar or internal network.
    expect(infra.sidecarContainerId).toBeUndefined();
    expect(infra.internalNetwork).toBeUndefined();

    await destroyDockerInfrastructure(infra);

    // Only the main container is cleaned up.
    expect(stoppedContainers).toEqual(['main-container-id']);
    expect(removedContainers).toEqual(['main-container-id']);

    // No network removal (networkName was null).
    expect(removedNetworks).toEqual([]);

    // Proxies still stopped.
    expect(mitmProxy.stopped).toBe(true);
    expect(proxy.stopped).toBe(true);
  });

  it('TCP mode removes the per-session internal network', async () => {
    const { docker, removedNetworks } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: true, docker, mitmProxy, proxy });

    await destroyDockerInfrastructure(infra);

    const expectedNetworkName = getInternalNetworkName(TEST_SHORT_ID);
    expect(infra.internalNetwork).toBe(expectedNetworkName);
    expect(removedNetworks).toEqual([expectedNetworkName]);
  });

  it('continues with remaining steps when the main container stop throws', async () => {
    // Force docker.stop() to throw. cleanupContainers() catches per-resource
    // failures internally, so downstream proxy stops should still run.
    const stoppedContainers: string[] = [];
    const removedContainers: string[] = [];
    const docker: ContainerRuntime = {
      ...makeMockDocker().docker,
      async stop(id: string) {
        stoppedContainers.push(id);
        if (id === 'main-container-id') {
          throw new Error('docker stop failed');
        }
      },
      async remove(id: string) {
        removedContainers.push(id);
      },
    };
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: true, docker, mitmProxy, proxy });

    // Must not throw -- error tolerance is the contract.
    // Resolves (with nothing to report: the bundle has no scanner).
    await expect(destroyDockerInfrastructure(infra)).resolves.toEqual({});

    // Main container stop was attempted (then swallowed).
    expect(stoppedContainers).toContain('main-container-id');
    // Sidecar cleanup still ran despite the main-container failure.
    expect(stoppedContainers).toContain('sidecar-container-id');
    expect(removedContainers).toContain('sidecar-container-id');
    // And the proxy steps still ran.
    expect(mitmProxy.stopped).toBe(true);
    expect(proxy.stopped).toBe(true);
  });

  it('continues with proxy.stop() when mitmProxy.stop() throws', async () => {
    // Directly exercise the per-step isolation around the proxy stops:
    // a throw from mitmProxy.stop() must not prevent proxy.stop().
    const { docker } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy({ throwOnStop: true });
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: false, docker, mitmProxy, proxy });

    // Resolves (with nothing to report: the bundle has no scanner).
    await expect(destroyDockerInfrastructure(infra)).resolves.toEqual({});

    expect(mitmProxy.stopped).toBe(true); // attempted
    expect(proxy.stopped).toBe(true); // still ran
  });

  it('still resolves when proxy.stop() throws (last step, must not propagate)', async () => {
    // Symmetric to the mitmProxy-throws test: proxy.stop() is the final step,
    // so there's no "subsequent step still runs" to verify, but the error
    // tolerance contract (never throws) still matters -- callers in recovery
    // paths depend on it.
    const { docker } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy({ throwOnStop: true });
    const infra = makeInfrastructureBundle({ tempDir, useTcp: false, docker, mitmProxy, proxy });

    // Resolves (with nothing to report: the bundle has no scanner).
    await expect(destroyDockerInfrastructure(infra)).resolves.toEqual({});

    expect(mitmProxy.stopped).toBe(true);
    expect(proxy.stopped).toBe(true); // attempted, error swallowed
  });
});

// ---------------------------------------------------------------------------
// Per-workflow runtime dependency cache hashing
// ---------------------------------------------------------------------------

describe('computeDockerBuildHash', () => {
  it('folds the checked-in Apple relay into the arm64 base and chained agent hashes', () => {
    const dockerDir = mkdtempSync(join(tmpdir(), 'ironcurtain-docker-build-hash-'));
    try {
      writeFileSync(join(dockerDir, 'Dockerfile.base.arm64'), 'FROM pinned\nCOPY apple-vm-egress-relay.mjs /relay\n');
      writeFileSync(join(dockerDir, 'Dockerfile.agent'), 'FROM base\n');
      writeFileSync(join(dockerDir, 'apple-vm-egress-relay.mjs'), 'export const version = 1;\n');

      const baseBefore = computeDockerBuildHash(dockerDir, ['Dockerfile.base.arm64']);
      const agentBefore = computeDockerBuildHash(dockerDir, ['Dockerfile.agent'], baseBefore);
      writeFileSync(join(dockerDir, 'apple-vm-egress-relay.mjs'), 'export const version = 2;\n');
      const baseAfter = computeDockerBuildHash(dockerDir, ['Dockerfile.base.arm64']);
      const agentAfter = computeDockerBuildHash(dockerDir, ['Dockerfile.agent'], baseAfter);

      expect(baseAfter).not.toBe(baseBefore);
      expect(agentAfter).not.toBe(agentBefore);
      expect(computeDockerBuildHash(dockerDir, ['Dockerfile.agent'], baseBefore)).toBe(agentBefore);
    } finally {
      rmSync(dockerDir, { recursive: true, force: true });
    }
  });

  it('rebuilds the nested-daemon image when its runc shim changes', () => {
    // A scratch copy of the shipped recipe, so the edit cannot touch the repository.
    const contextDir = mkdtempSync(join(tmpdir(), 'ironcurtain-nested-daemon-hash-'));
    try {
      cpSync(resolve('docker/nested-daemon'), contextDir, { recursive: true });
      const inputs = ['Dockerfile', 'entrypoint.sh', 'runtime-shim/main.go'];
      const before = computeDockerBuildHash(contextDir, inputs, 'toolchain');
      writeFileSync(join(contextDir, 'runtime-shim', 'main.go'), '\n// changed runc wrapper\n', { flag: 'a' });

      expect(computeDockerBuildHash(contextDir, inputs, 'toolchain')).not.toBe(before);
    } finally {
      rmSync(contextDir, { recursive: true, force: true });
    }
  });

  it('keeps the established hash for top-level-only recipes', () => {
    const dockerDir = mkdtempSync(join(tmpdir(), 'ironcurtain-docker-build-hash-compat-'));
    try {
      writeFileSync(join(dockerDir, 'Dockerfile'), 'FROM scratch\n');
      writeFileSync(join(dockerDir, 'entrypoint.sh'), '#!/bin/sh\n');
      writeFileSync(join(dockerDir, 'unrelated.txt'), 'not an input\n');
      const expected = createHash('sha256')
        .update('file:Dockerfile\n')
        .update('FROM scratch\n')
        .update('file:entrypoint.sh\n')
        .update('#!/bin/sh\n')
        .update('parent:base\n')
        .digest('hex');

      // Images built before nested inputs were hashed must not all rebuild.
      expect(computeDockerBuildHash(dockerDir, ['Dockerfile'], 'base')).toBe(expected);
    } finally {
      rmSync(dockerDir, { recursive: true, force: true });
    }
  });

  it('hashes listed directories recursively and refuses missing or escaping inputs', () => {
    const dockerDir = mkdtempSync(join(tmpdir(), 'ironcurtain-docker-build-hash-inputs-'));
    try {
      writeFileSync(join(dockerDir, 'Dockerfile'), 'FROM scratch\n');
      mkdirSync(join(dockerDir, 'shim', 'nested'), { recursive: true });
      writeFileSync(join(dockerDir, 'shim', 'nested', 'helper.go'), 'package main\n');
      const before = computeDockerBuildHash(dockerDir, ['Dockerfile', 'shim']);
      writeFileSync(join(dockerDir, 'shim', 'nested', 'helper.go'), 'package main // changed\n');
      expect(computeDockerBuildHash(dockerDir, ['Dockerfile', 'shim'])).not.toBe(before);

      expect(() => computeDockerBuildHash(dockerDir, ['Dockerfile', 'runtime-shim/main.go'])).toThrow(
        /Docker build input is missing: .*runtime-shim\/main\.go/u,
      );
      expect(() => computeDockerBuildHash(dockerDir, ['../outside'])).toThrow(/inside the build context/u);
      expect(() => computeDockerBuildHash(dockerDir, [join(dockerDir, 'Dockerfile')])).toThrow(
        /inside the build context/u,
      );
    } finally {
      rmSync(dockerDir, { recursive: true, force: true });
    }
  });
});

describe('computeWorkflowDependencyHash', () => {
  let scriptsDir: string;

  beforeEach(() => {
    scriptsDir = mkdtempSync(join(tmpdir(), 'wf-image-hash-'));
  });

  afterEach(() => {
    rmSync(scriptsDir, { recursive: true, force: true });
  });

  it('produces the same hash for the same agent hash and identical manifests', () => {
    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy==1.26.0\n');
    writeFileSync(join(scriptsDir, 'package.json'), '{ "dependencies": { "ajv": "^8" } }\n');

    const first = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);
    const second = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    expect(first).toBe(second);
    // sha256 hex digest
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the hash when requirements.txt content changes', () => {
    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy==1.26.0\n');
    const before = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy==2.0.0\n');
    const after = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    expect(after).not.toBe(before);
  });

  it('changes the hash when package.json content changes', () => {
    writeFileSync(join(scriptsDir, 'package.json'), '{ "dependencies": { "ajv": "^8" } }\n');
    const before = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    writeFileSync(join(scriptsDir, 'package.json'), '{ "dependencies": { "ajv": "^9" } }\n');
    const after = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    expect(after).not.toBe(before);
  });

  it('changes the hash when the parent agent hash changes (parent chaining)', () => {
    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy==1.26.0\n');

    const withAgentA = computeWorkflowDependencyHash('agent-hash-A', scriptsDir);
    const withAgentB = computeWorkflowDependencyHash('agent-hash-B', scriptsDir);

    expect(withAgentA).not.toBe(withAgentB);
  });

  it('folds package-lock.json into the hash when present', () => {
    writeFileSync(join(scriptsDir, 'package.json'), '{ "dependencies": { "ajv": "^8" } }\n');
    const withoutLock = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    writeFileSync(join(scriptsDir, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
    const withLock = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    expect(withLock).not.toBe(withoutLock);
  });
});

// Runtime workflow dependencies are installed into mounted caches at container
// start (see provisionWorkflowDependencies); no per-workflow image is ever
// built. `ensureImage` only ever materializes the shared agent image (and its
// base), never an `ironcurtain-wf-*` tag.
describe('ensureImage builds no per-workflow image', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ensure-image-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // The shared agent-image materialization is `resolveAgentImage` in the default
  // build-if-stale mode; the build hash it returns is what these tests assert on.
  async function ensureImage(image: string, docker: ContainerRuntime): Promise<string> {
    return (await resolveAgentImage(image, docker)).buildHash;
  }

  // The mock Docker stamps build labels per tag; capture every built tag so we
  // can assert no per-workflow image tag (`ironcurtain-wf-*`) is produced.
  function trackBuiltTags(docker: ContainerRuntime): string[] {
    const built: string[] = [];
    const original = docker.buildImage.bind(docker);
    docker.buildImage = async (tag, df, ctx, labels) => {
      built.push(tag);
      return original(tag, df, ctx, labels);
    };
    return built;
  }

  it('returns the shared agent image and builds only the agent + base images', async () => {
    const docker = createMockDocker();
    const built = trackBuiltTags(docker);

    const buildHash = await ensureImage('ironcurtain-claude-code:latest', docker);

    expect(typeof buildHash).toBe('string');
    expect(buildHash.length).toBeGreaterThan(0);
    expect(built).toContain('ironcurtain-claude-code:latest');
    expect(built.some((tag) => tag.startsWith('ironcurtain-wf-'))).toBe(false);
  });

  it('skips the rebuild when images are already up to date (content-hash labels)', async () => {
    const docker = createMockDocker();

    // First call builds; second call must be a no-op (labels already stamped).
    await ensureImage('ironcurtain-claude-code:latest', docker);
    const built = trackBuiltTags(docker);
    await ensureImage('ironcurtain-claude-code:latest', docker);

    expect(built).toEqual([]);
  });
});

describe('buildWorkflowExecCommand', () => {
  const layers = planWorkflowDependencyLayers({
    agentBuildHash: 'b'.repeat(64),
    manifests: { 'requirements.txt': Buffer.from('numpy\n'), 'package.json': Buffer.from('{}\n') },
    ironcurtainHome: '/host/home',
    runDependencyRoot: '/host/home/workflow-runs/wf/deps',
  });
  const pythonMount = layers.workflowPythonVenvMount;
  const nodeMount = layers.workflowNodeModulesMount;

  it('returns the command unchanged when no dependency mount is present', () => {
    const cmd = ['node', '/workflow-scripts/format_report.js'];
    expect(buildWorkflowExecCommand({}, cmd)).toEqual(cmd);
  });

  it('prepends the live $PATH (not a replacement) so the image PATH is preserved', () => {
    const wrapped = buildWorkflowExecCommand({ workflowPythonVenvMount: pythonMount }, [
      'node',
      '/workflow-scripts/format_report.js',
    ]);

    // Shell wrapper expands $PATH at runtime rather than hardcoding a PATH.
    expect(wrapped[0]).toBe('/bin/sh');
    expect(wrapped[1]).toBe('-lc');
    expect(wrapped[2]).toContain('export PATH=/opt/workflow-venv/bin:"$PATH"');
    expect(wrapped[2]).toContain('exec "$@"');
    // No Node layer, no NODE_PATH.
    expect(wrapped[2]).not.toContain('NODE_PATH');
    // Original argv is passed verbatim as positional params after the `sh` $0.
    expect(wrapped.slice(3)).toEqual(['sh', 'node', '/workflow-scripts/format_report.js']);
  });

  it('prepends both the venv bin and the node_modules/.bin when both mounts exist', () => {
    const wrapped = buildWorkflowExecCommand(
      { workflowPythonVenvMount: pythonMount, workflowNodeModulesMount: nodeMount },
      ['python', '-c', 'print(1)'],
    );
    expect(wrapped[2]).toContain('export PATH=/opt/workflow-venv/bin:/opt/workflow-node_modules/.bin:"$PATH"');
    // NODE_PATH is scoped to deterministic helper execs; the container env never sets it.
    expect(wrapped[2]).toContain('export NODE_PATH=/opt/workflow-node_modules;');
    expect(wrapped.slice(3)).toEqual(['sh', 'python', '-c', 'print(1)']);
  });

  it('returns an empty command unchanged (no shell wrapper)', () => {
    expect(buildWorkflowExecCommand({ workflowPythonVenvMount: pythonMount }, [])).toEqual([]);
  });
});
