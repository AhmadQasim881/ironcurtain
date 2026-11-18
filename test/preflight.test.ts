import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSessionMode, PreflightError } from '../src/session/preflight.js';
import { checkDockerAvailable, type DockerAvailability, type ProbeExecFileFn } from '../src/docker/docker-probe.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ResolvedProviderProfile, ResolvedUserConfig } from '../src/config/user-config.js';
import type { AgentId } from '../src/docker/agent-adapter.js';
import {
  preflightCredentialSources,
  readOnlyCredentialSources,
  type CredentialSources,
} from '../src/docker/oauth-credentials.js';

import { TEST_SANDBOX_DIR, REAL_TMP } from './fixtures/test-policy.js';
import { testUserConfig } from './helpers/user-config.js';

/** No OAuth credentials — forces API key path. */
const noOAuthSources: CredentialSources = {
  loadFromFile: () => null,
  loadFromKeychain: () => null,
};

/** OAuth credentials present (file), no API key — covers the OAuth-only paths. */
const oauthOnlySources: CredentialSources = {
  loadFromFile: () => ({
    accessToken: 'sk-ant-oat01-test',
    refreshToken: 'sk-ant-ort01-test',
    expiresAt: Date.now() + 3_600_000,
  }),
  loadFromKeychain: () => null,
};

function createTestConfig(
  overrides: {
    anthropicApiKey?: string;
    preferredMode?: 'container' | 'builtin';
    agentModelId?: string;
    /** Further user-config fields, applied last. */
    userConfig?: Partial<ResolvedUserConfig>;
  } = {},
): IronCurtainConfig {
  const agentModelId = overrides.agentModelId ?? 'anthropic:claude-sonnet-4-6';
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: {
      filesystem: { command: 'echo', args: ['test'] },
    },
    protectedPaths: [],
    generatedDir: `${REAL_TMP}/test-generated`,
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
    agentModelId,
    escalationTimeoutSeconds: 300,
    userConfig: testUserConfig({
      agentModelId,
      anthropicApiKey: overrides.anthropicApiKey ?? 'test-api-key',
      // Native-default registry: no OpenRouter routing, so preflight falls
      // through to agent-native credential detection (G13 §9.7).
      modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
      memory: { enabled: true, autoSave: true, llmBaseUrl: undefined, llmApiKey: undefined, offlineModels: false },
      preferredMode: overrides.preferredMode ?? 'container',
      packageInstall: { enabled: true, quarantineDays: 2, allowedPackages: [], deniedPackages: [] },
      dockerResources: { memoryMb: 8192, cpus: 4, pidsLimit: 4096 },
      ...overrides.userConfig,
    }),
  };
}

/** `config` with some user-config fields replaced (the resolved user config is read-only). */
function withUserConfig(config: IronCurtainConfig, overrides: Partial<ResolvedUserConfig>): IronCurtainConfig {
  return { ...config, userConfig: { ...config.userConfig, ...overrides } };
}

/**
 * Registers an OpenRouter profile in the resolved `modelProviders` registry
 * without moving `default` (unless `makeDefault`). Mirrors how `--provider-profile`
 * selects a non-default OpenRouter profile at session start.
 */
function withOpenRouterProfile(
  config: IronCurtainConfig,
  name: string,
  apiKey: string,
  makeDefault = false,
): IronCurtainConfig {
  const openrouterProfile: ResolvedProviderProfile = {
    type: 'openrouter',
    apiKey,
    modelMap: [{ match: '*', model: 'z-ai/glm-5.2' }],
    usesDefaultMap: false,
    perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
    providerPreference: undefined,
    sessionAffinity: true,
  };
  return {
    ...config,
    userConfig: {
      ...config.userConfig,
      modelProviders: {
        default: makeDefault ? name : config.userConfig.modelProviders.default,
        profiles: { ...config.userConfig.modelProviders.profiles, [name]: openrouterProfile },
      },
    },
  };
}

const dockerAvailable = (): Promise<DockerAvailability> => Promise.resolve({ available: true });
const dockerUnavailable = (): Promise<DockerAvailability> =>
  Promise.resolve({
    available: false,
    reason: 'Docker not available',
    detailedMessage: 'docker daemon not running (test fixture)',
  });

describe('resolveSessionMode', () => {
  describe('explicit --agent', () => {
    it('succeeds when Docker and API key are available', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig(),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'apikey' });
      expect(result.reason).toBe('Explicit --agent selection (API key)');
    });

    it('throws PreflightError when the selected container runtime is unavailable', async () => {
      const promise = resolveSessionMode({
        config: createTestConfig(),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerUnavailable,
        credentialSources: noOAuthSources,
      });

      await expect(promise).rejects.toThrow(PreflightError);
      await expect(promise).rejects.toThrow(/selected container runtime is not available/);
    });

    it('throws PreflightError when no credentials are available', async () => {
      const promise = resolveSessionMode({
        config: createTestConfig({ anthropicApiKey: '' }),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      await expect(promise).rejects.toThrow(PreflightError);
      await expect(promise).rejects.toThrow(/authentication/);
    });

    it('selects builtin mode when --agent builtin is specified', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig(),
        requestedAgent: 'builtin' as AgentId,
        isDockerAvailable: dockerUnavailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'builtin' });
      expect(result.reason).toBe('Explicit --agent builtin');
    });

    it('checks container runtime before credentials (runtime error shown first)', async () => {
      await expect(
        resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '' }),
          requestedAgent: 'claude-code' as AgentId,
          isDockerAvailable: dockerUnavailable,
          credentialSources: noOAuthSources,
        }),
      ).rejects.toThrow(/selected container runtime is not available/);
    });

    it('succeeds with OAuth credentials and no API key', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig({ anthropicApiKey: '' }),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerAvailable,
        credentialSources: oauthOnlySources,
      });

      expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'oauth' });
      expect(result.reason).toBe('Explicit --agent selection (OAuth)');
    });

    it('refreshes an expired Claude login only after the selected runtime is available', async () => {
      const expired = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1 };
      const files = [{ credentials: expired, filePath: '/fixture/claude.json' }];
      const passiveRead = vi.spyOn(readOnlyCredentialSources, 'loadFromFilesWithSource').mockReturnValue(files);
      const activeRead = vi.spyOn(preflightCredentialSources, 'loadFromFilesWithSource').mockReturnValue(files);
      const refresh = vi.spyOn(preflightCredentialSources, 'refreshToken').mockResolvedValue({
        ...expired,
        expiresAt: Date.now() + 3_600_000,
      });
      const save = vi.spyOn(preflightCredentialSources, 'saveToFile').mockReturnValue(undefined);
      try {
        const config = createTestConfig({ anthropicApiKey: '' });
        await expect(resolveSessionMode({ config, isDockerAvailable: dockerUnavailable })).rejects.toThrow(
          /container runtime is not available/,
        );
        expect(refresh).not.toHaveBeenCalled();
        const result = await resolveSessionMode({ config, isDockerAvailable: dockerAvailable });
        expect(result.mode).toMatchObject({ agent: 'claude-code', authKind: 'oauth' });
        expect(refresh).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledOnce();
      } finally {
        passiveRead.mockRestore();
        activeRead.mockRestore();
        refresh.mockRestore();
        save.mockRestore();
      }
    });

    it('selects codex with Codex ChatGPT OAuth and no OpenAI API key', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ironcurtain-codex-preflight-'));
      const oldCodexHome = process.env.CODEX_HOME;
      const readClaude = vi.spyOn(preflightCredentialSources, 'loadFromFilesWithSource').mockReturnValue([
        {
          credentials: { accessToken: 'fixture', refreshToken: 'fixture', expiresAt: Date.now() + 3_600_000 },
          filePath: '/fixture/claude.json',
        },
      ]);
      try {
        process.env.CODEX_HOME = tmp;
        writeFileSync(
          join(tmp, 'auth.json'),
          JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'codex-token' } }),
        );

        const config = createTestConfig({ anthropicApiKey: '', userConfig: { openaiApiKey: '' } });
        const result = await resolveSessionMode({
          config,
          requestedAgent: 'codex' as AgentId,
          isDockerAvailable: dockerAvailable,
        });

        expect(result.mode).toEqual({ kind: 'docker', agent: 'codex', authKind: 'oauth' });
        expect(result.reason).toBe('Explicit --agent selection (OAuth)');
        expect(readClaude).not.toHaveBeenCalled();
      } finally {
        readClaude.mockRestore();
        if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = oldCodexHome;
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('--agent codex reports Codex login guidance when auth is missing', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ironcurtain-codex-preflight-empty-'));
      const oldCodexHome = process.env.CODEX_HOME;
      try {
        process.env.CODEX_HOME = tmp;
        const promise = resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '' }),
          requestedAgent: 'codex' as AgentId,
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        await expect(promise).rejects.toThrow(/codex login/);
        await expect(promise).rejects.toThrow(/OPENAI_API_KEY is not required/);
      } finally {
        if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = oldCodexHome;
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('--agent goose surfaces the OAuth-not-usable-with-goose addendum on OAuth-only', async () => {
      const config = createTestConfig({
        anthropicApiKey: '',
        userConfig: { preferredDockerAgent: 'goose', gooseProvider: 'anthropic' },
      });

      const promise = resolveSessionMode({
        config,
        requestedAgent: 'goose' as AgentId,
        isDockerAvailable: dockerAvailable,
        credentialSources: oauthOnlySources,
      });

      await expect(promise).rejects.toThrow(/OAuth credentials are not usable with goose/);
    });
  });

  describe('default mode (no --agent)', () => {
    describe('preferredMode = container', () => {
      it('selects Docker (claude-code, API key) when both Docker and API key are available', async () => {
        const result = await resolveSessionMode({
          config: createTestConfig(),
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'apikey' });
        expect(result.reason).toBe('claude-code (API key)');
      });

      it('selects Docker (claude-code, OAuth) when only OAuth is configured', async () => {
        const result = await resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '' }),
          isDockerAvailable: dockerAvailable,
          credentialSources: oauthOnlySources,
        });

        expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'oauth' });
        expect(result.reason).toBe('claude-code (OAuth)');
      });

      it('selects Docker (goose) when preferredDockerAgent=goose and goose provider key is set', async () => {
        const config = createTestConfig({ userConfig: { preferredDockerAgent: 'goose', gooseProvider: 'anthropic' } });

        const result = await resolveSessionMode({
          config,
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        expect(result.mode).toEqual({ kind: 'docker', agent: 'goose', authKind: 'apikey' });
        expect(result.reason).toBe('goose (API key)');
      });

      it('selects Docker (codex) when preferredDockerAgent=codex and Codex OAuth is present', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'ironcurtain-codex-preferred-'));
        const oldCodexHome = process.env.CODEX_HOME;
        try {
          process.env.CODEX_HOME = tmp;
          writeFileSync(
            join(tmp, 'auth.json'),
            JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'codex-token' } }),
          );
          const config = createTestConfig({ anthropicApiKey: '', userConfig: { preferredDockerAgent: 'codex' } });

          const result = await resolveSessionMode({
            config,
            isDockerAvailable: dockerAvailable,
            credentialSources: noOAuthSources,
          });

          expect(result.mode).toEqual({ kind: 'docker', agent: 'codex', authKind: 'oauth' });
          expect(result.reason).toBe('codex (OAuth)');
        } finally {
          if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
          else process.env.CODEX_HOME = oldCodexHome;
          rmSync(tmp, { recursive: true, force: true });
        }
      });

      it('throws with goose+OAuth-only and includes the goose-OAuth-not-usable addendum', async () => {
        const config = createTestConfig({
          anthropicApiKey: '',
          userConfig: { preferredDockerAgent: 'goose', gooseProvider: 'anthropic' },
        });

        const promise = resolveSessionMode({
          config,
          isDockerAvailable: dockerAvailable,
          credentialSources: oauthOnlySources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/goose/);
        await expect(promise).rejects.toThrow(/OAuth credentials are not usable with goose/);
      });

      it('throws when the container runtime is unavailable, with --agent builtin and ironcurtain config hints', async () => {
        const promise = resolveSessionMode({
          config: createTestConfig(),
          isDockerAvailable: dockerUnavailable,
          credentialSources: noOAuthSources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/selected container runtime is not available/);
        await expect(promise).rejects.toThrow(/--agent builtin/);
        await expect(promise).rejects.toThrow(/ironcurtain config/);
      });

      it('throws via the preferred-mode helper (not the explicit-mode helper) when no credentials are configured', async () => {
        const promise = resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '' }),
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        // The preferred-mode helper leads with "preferredMode is" and offers
        // both the one-shot and permanent escapes. The explicit-mode helper
        // would say "--agent claude-code requires authentication" instead.
        await expect(promise).rejects.toThrow(/preferredMode is "container"/);
        await expect(promise).rejects.not.toThrow(/--agent claude-code requires authentication/);
      });
    });

    describe('preferredMode = builtin', () => {
      it('selects builtin when an Anthropic API key is configured', async () => {
        const isDockerAvailable = vi.fn(dockerAvailable);
        const result = await resolveSessionMode({
          config: createTestConfig({ preferredMode: 'builtin' }),
          isDockerAvailable,
          credentialSources: noOAuthSources,
        });

        expect(result.mode).toEqual({ kind: 'builtin' });
        expect(result.reason).toBe('preferredMode = builtin');
        // Builtin path must not probe Docker — fast feedback for missing keys.
        expect(isDockerAvailable).not.toHaveBeenCalled();
      });

      it('throws without probing OAuth or Docker when no ANTHROPIC_API_KEY is set', async () => {
        // Two cases that both hit the same `apiKey.length === 0` check before
        // any auth or Docker probe. Spied sources prove the shortcut.
        const dockerSpy = vi.fn(dockerAvailable);
        const loadFromFile = vi.fn(() => null);
        const loadFromKeychain = vi.fn(() => null);

        const promise = resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '', preferredMode: 'builtin' }),
          isDockerAvailable: dockerSpy,
          credentialSources: { loadFromFile, loadFromKeychain },
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/no ANTHROPIC_API_KEY/);
        expect(dockerSpy).not.toHaveBeenCalled();
        expect(loadFromFile).not.toHaveBeenCalled();
        expect(loadFromKeychain).not.toHaveBeenCalled();
      });

      it('uses the provider inferred from agentModelId for builtin API key validation', async () => {
        const dockerSpy = vi.fn(dockerAvailable);
        const loadFromFile = vi.fn(() => null);
        const loadFromKeychain = vi.fn(() => null);

        const promise = resolveSessionMode({
          config: createTestConfig({
            anthropicApiKey: '',
            preferredMode: 'builtin',
            agentModelId: 'openai:gpt-4o',
          }),
          isDockerAvailable: dockerSpy,
          credentialSources: { loadFromFile, loadFromKeychain },
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/no OPENAI_API_KEY/);
        // The message names the provider and the configured model that drove it,
        // and omits the Anthropic-only OAuth caveat for non-Anthropic providers.
        await expect(promise).rejects.toThrow(/"openai" provider/);
        await expect(promise).rejects.toThrow(/openai:gpt-4o/);
        await expect(promise).rejects.not.toThrow(/OAuth/);
        expect(dockerSpy).not.toHaveBeenCalled();
        expect(loadFromFile).not.toHaveBeenCalled();
        expect(loadFromKeychain).not.toHaveBeenCalled();
      });

      it('includes the Anthropic OAuth caveat when the configured provider is anthropic', async () => {
        const dockerSpy = vi.fn(dockerAvailable);
        const loadFromFile = vi.fn(() => null);
        const loadFromKeychain = vi.fn(() => null);

        const promise = resolveSessionMode({
          config: createTestConfig({
            anthropicApiKey: '',
            preferredMode: 'builtin',
            agentModelId: 'anthropic:claude-sonnet-4-6',
          }),
          isDockerAvailable: dockerSpy,
          credentialSources: { loadFromFile, loadFromKeychain },
        });

        await expect(promise).rejects.toThrow(/no ANTHROPIC_API_KEY/);
        await expect(promise).rejects.toThrow(/Claude OAuth credentials are not usable/);
        expect(dockerSpy).not.toHaveBeenCalled();
      });
    });

    describe('--agent overrides preferredMode', () => {
      it('--agent builtin wins when preferredMode = container', async () => {
        const result = await resolveSessionMode({
          config: createTestConfig({ preferredMode: 'container' }),
          requestedAgent: 'builtin' as AgentId,
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        expect(result.mode).toEqual({ kind: 'builtin' });
        expect(result.reason).toBe('Explicit --agent builtin');
      });

      it('--agent builtin fails fast without an API key for the agent model, like preferredMode = builtin', async () => {
        // The explicit path used to skip the key check, so the session started
        // and its first turn failed on the API call. It now refuses up front
        // with an explicit-flag message, before any Docker or OAuth probe.
        const dockerSpy = vi.fn().mockResolvedValue({ available: true });
        const loadFromFile = vi.fn(() => null);
        const loadFromKeychain = vi.fn(() => null);
        for (const preferredMode of ['builtin', 'container'] as const) {
          const promise = resolveSessionMode({
            config: createTestConfig({ anthropicApiKey: '', preferredMode }),
            requestedAgent: 'builtin' as AgentId,
            isDockerAvailable: dockerSpy,
            credentialSources: { loadFromFile, loadFromKeychain },
          });

          await expect(promise).rejects.toThrow(PreflightError);
          await expect(promise).rejects.toThrow(/--agent builtin requires an API key, but no ANTHROPIC_API_KEY/);
          await expect(promise).rejects.not.toThrow(/preferredMode is/);
        }
        expect(dockerSpy).not.toHaveBeenCalled();
        expect(loadFromFile).not.toHaveBeenCalled();
        expect(loadFromKeychain).not.toHaveBeenCalled();
      });

      it('--agent builtin checks the configured agent provider, not Anthropic', async () => {
        const config = createTestConfig({ anthropicApiKey: '', agentModelId: 'openai:gpt-4o' });
        const result = await resolveSessionMode({
          config: withUserConfig(config, { openaiApiKey: 'sk-openai-test' }),
          requestedAgent: 'builtin' as AgentId,
          isDockerAvailable: dockerUnavailable,
          credentialSources: noOAuthSources,
        });
        expect(result.mode).toEqual({ kind: 'builtin' });

        await expect(
          resolveSessionMode({
            config: withUserConfig(config, { openaiApiKey: '' }),
            requestedAgent: 'builtin' as AgentId,
            isDockerAvailable: dockerUnavailable,
            credentialSources: noOAuthSources,
          }),
        ).rejects.toThrow(/no OPENAI_API_KEY/);
      });

      it('--agent claude-code with unavailable container runtime throws the explicit-mode message', async () => {
        const promise = resolveSessionMode({
          config: createTestConfig({ preferredMode: 'builtin' }),
          requestedAgent: 'claude-code' as AgentId,
          isDockerAvailable: dockerUnavailable,
          credentialSources: noOAuthSources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        // The explicit-mode message attributes the failure to the flag the user typed.
        await expect(promise).rejects.toThrow(/--agent claude-code requires container mode/);
      });
    });
  });

  it.each([undefined, 'goose' as AgentId])(
    'names the Google host key for native Goose (agent %s)',
    async (requestedAgent) => {
      const promise = resolveSessionMode({
        config: createTestConfig({ userConfig: { preferredDockerAgent: 'goose', gooseProvider: 'google' } }),
        requestedAgent,
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });
      await expect(promise).rejects.toThrow(/Set GOOGLE_GENERATIVE_AI_API_KEY/);
    },
  );

  describe('host-model role warnings', () => {
    /** An OpenAI-only user: the agent runs on OpenAI, the role defaults stay on Anthropic. */
    function openAiOnlyConfig(preferredMode: 'container' | 'builtin'): IronCurtainConfig {
      const config = createTestConfig({ anthropicApiKey: '', preferredMode, agentModelId: 'openai:gpt-4o' });
      return withUserConfig(config, {
        openaiApiKey: 'sk-openai-test',
        autoCompact: { ...config.userConfig.autoCompact, enabled: true },
      });
    }

    it('an OpenAI-only builtin user with autoCompact gets a warning, not a refusal', async () => {
      const result = await resolveSessionMode({
        config: openAiOnlyConfig('builtin'),
        isDockerAvailable: dockerUnavailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'builtin' });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toMatch(/summary model "anthropic:claude-haiku-4-5" has no credentials/);
      expect(result.warnings?.[0]).toMatch(/no ANTHROPIC_API_KEY is configured/);
      expect(result.warnings?.[0]).toMatch(/summarizes with the agent model "openai:gpt-4o"/);
    });

    it('warns that auto-approve is off when its model has no key, in either mode', async () => {
      const openAiOnly = openAiOnlyConfig('builtin');
      const builtin = withUserConfig(openAiOnly, {
        autoCompact: { ...openAiOnly.userConfig.autoCompact, enabled: false },
        autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' },
      });
      const builtinResult = await resolveSessionMode({
        config: builtin,
        requestedAgent: 'builtin' as AgentId,
        isDockerAvailable: dockerUnavailable,
        credentialSources: noOAuthSources,
      });
      expect(builtinResult.warnings).toEqual([expect.stringMatching(/^Auto-approve is off for this session/)]);

      const container = withUserConfig(createTestConfig({ anthropicApiKey: '' }), {
        autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' },
      });
      const containerResult = await resolveSessionMode({
        config: container,
        isDockerAvailable: dockerAvailable,
        credentialSources: oauthOnlySources,
      });
      expect(containerResult.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'oauth' });
      expect(containerResult.warnings).toEqual([expect.stringMatching(/^Auto-approve is off for this session/)]);
    });

    it('has no warnings when every role the session uses has credentials', async () => {
      const base = createTestConfig({ preferredMode: 'builtin' });
      const config = withUserConfig(base, {
        autoCompact: { ...base.userConfig.autoCompact, enabled: true },
        autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' },
      });
      const result = await resolveSessionMode({
        config,
        isDockerAvailable: dockerUnavailable,
        credentialSources: noOAuthSources,
      });
      expect(result.warnings).toBeUndefined();
    });
  });

  // §9.7 / G13: the per-session --provider-profile override must be honored by
  // preflight credential detection, so an OpenRouter-only user (no agent-native
  // creds, native default) is authenticated against the profile's OpenRouter
  // key rather than spuriously blocked. Regression guard for the Copilot finding
  // on PR #361 (preflight resolved only modelProviders.default).
  describe('--provider-profile credential resolution', () => {
    it('honors an OpenRouter --provider-profile override on a native-default config with no agent creds', async () => {
      // default=native, no Anthropic key, no OAuth — the pre-fix behavior blocked here.
      const config = withOpenRouterProfile(createTestConfig({ anthropicApiKey: '' }), 'glm', 'sk-or-v1-live');

      const result = await resolveSessionMode({
        config,
        providerProfileName: 'glm',
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'apikey' });
    });

    it('still blocks (default profile) when the override is absent — fix is scoped to the flag', async () => {
      const config = withOpenRouterProfile(createTestConfig({ anthropicApiKey: '' }), 'glm', 'sk-or-v1-live');

      const promise = resolveSessionMode({
        config,
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      await expect(promise).rejects.toThrow(PreflightError);
      await expect(promise).rejects.toThrow(/preferredMode is "container"/);
    });

    it('blocks when the selected OpenRouter profile has no key (missing creds, not native fallthrough)', async () => {
      const config = withOpenRouterProfile(createTestConfig({ anthropicApiKey: '' }), 'glm-nokey', '');

      const promise = resolveSessionMode({
        config,
        providerProfileName: 'glm-nokey',
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      await expect(promise).rejects.toThrow(PreflightError);
      await expect(promise).rejects.toThrow(/Set OPENROUTER_API_KEY/);
    });

    it('surfaces the authoritative unknown-profile error for an unknown name, before credential detection', async () => {
      // The bug scenario: an OpenRouter-only user (native default, NO agent
      // creds) typos `--provider-profile`. Preflight must surface the
      // authoritative available-profiles listing from resolveActiveProfile —
      // NOT mask it behind a generic "no credentials" error by degrading to
      // the (credential-less) default.
      const config = withOpenRouterProfile(createTestConfig({ anthropicApiKey: '' }), 'glm', 'sk-or-v1-live');

      const promise = resolveSessionMode({
        config,
        providerProfileName: 'does-not-exist',
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      await expect(promise).rejects.toThrow('Unknown provider profile "does-not-exist". Available: native, glm.');
      // The confusing generic credential error must NOT be what the user sees.
      await expect(promise).rejects.not.toThrow(/preferredMode is "container"/);
    });

    it('surfaces the unknown-profile error identically even when the default profile HAS creds', async () => {
      // Same typo, but the native default now carries a valid API key. The
      // error must be identical: the name is resolved before credential
      // detection, so whether the default has creds is irrelevant.
      const config = withOpenRouterProfile(createTestConfig(), 'glm', 'sk-or-v1-live');

      await expect(
        resolveSessionMode({
          config,
          providerProfileName: 'does-not-exist',
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        }),
      ).rejects.toThrow('Unknown provider profile "does-not-exist". Available: native, glm.');
    });
  });
});

// ---- Helpers for checkDockerAvailable tests --------------------------

/**
 * Builds the error shape Node's `execFile` produces on `timeout`. We don't
 * call the real `child_process.execFile` from these tests so we have to
 * synthesize the expected shape.
 */
function makeTimeoutError(): Error {
  return Object.assign(new Error('Command timed out'), {
    code: null,
    killed: true,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
  });
}

function makeEnoentError(): Error {
  return Object.assign(new Error('spawn docker ENOENT'), {
    code: 'ENOENT',
    stdout: '',
    stderr: '',
  });
}

function makePermissionDeniedError(): Error {
  return Object.assign(new Error('Command failed'), {
    code: 1,
    stdout: '',
    stderr: 'Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
  });
}

describe('checkDockerAvailable', () => {
  it('returns available:true on the first attempt when docker info succeeds', async () => {
    const execFileFn: ProbeExecFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    const result = await checkDockerAvailable(execFileFn);

    expect(result).toEqual({ available: true });
    expect(execFileFn).toHaveBeenCalledTimes(1);
  });

  it('recovers on the second attempt after a single timeout', async () => {
    const execFileFn = vi
      .fn<ProbeExecFileFn>()
      .mockRejectedValueOnce(makeTimeoutError())
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await checkDockerAvailable(execFileFn);

    expect(result).toEqual({ available: true });
    expect(execFileFn).toHaveBeenCalledTimes(2);
  });

  it('exhausts all attempts on persistent timeouts and reports a timeout-flavored error', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockRejectedValue(makeTimeoutError());

    const result = await checkDockerAvailable(execFileFn);

    // 1 initial attempt + 2 retries = 3 total attempts
    expect(execFileFn).toHaveBeenCalledTimes(3);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('Docker not available');
      expect(result.detailedMessage).toMatch(/did not respond/);
      expect(result.detailedMessage).toMatch(/3 attempts/);
    }
  });

  it('does not retry when docker binary is missing (ENOENT)', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockRejectedValue(makeEnoentError());

    const result = await checkDockerAvailable(execFileFn);

    expect(execFileFn).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.detailedMessage).toMatch(/not found in your PATH/);
    }
  });

  it('does not retry on permission denied', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockRejectedValue(makePermissionDeniedError());

    const result = await checkDockerAvailable(execFileFn);

    expect(execFileFn).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.detailedMessage).toMatch(/Permission denied/);
    }
  });

  it('does not retry when daemon is unreachable (deterministic stderr)', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockRejectedValue(
      Object.assign(new Error('Command failed'), {
        code: 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      }),
    );

    const result = await checkDockerAvailable(execFileFn);

    expect(execFileFn).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.detailedMessage).toMatch(/Cannot connect to the Docker daemon/);
    }
  });

  it('uses a 10 second per-attempt timeout', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockResolvedValue({ stdout: '', stderr: '' });

    await checkDockerAvailable(execFileFn);

    expect(execFileFn).toHaveBeenCalledWith('docker', ['info'], { timeout: 10_000 });
  });
});
