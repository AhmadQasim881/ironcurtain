import { describe, expect, it } from 'vitest';
import { planHostModelRoles } from '../src/session/host-model-roles.js';
import type { ResolvedProviderProfile, ResolvedUserConfig } from '../src/config/user-config.js';

const OPENROUTER_PROFILE: ResolvedProviderProfile = {
  type: 'openrouter',
  apiKey: '',
  modelMap: [{ match: '*', model: 'z-ai/glm-5.2' }],
  usesDefaultMap: false,
  perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
  providerPreference: undefined,
  sessionAffinity: true,
};

function userConfig(overrides: Partial<ResolvedUserConfig> = {}): ResolvedUserConfig {
  return {
    agentModelId: 'openai:gpt-4o',
    anthropicApiKey: '',
    openaiApiKey: 'sk-openai',
    googleApiKey: '',
    modelProviders: {
      default: 'native',
      profiles: { native: { type: 'native' }, router: OPENROUTER_PROFILE },
    },
    autoCompact: {
      enabled: true,
      thresholdTokens: 160_000,
      keepRecentMessages: 10,
      summaryModelId: 'anthropic:claude-haiku-4-5',
    },
    autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
    memory: { enabled: true, autoSave: true, llmBaseUrl: undefined, llmApiKey: undefined },
    ...overrides,
  } as unknown as ResolvedUserConfig;
}

const BUILTIN = { mode: 'builtin', agentModelId: 'openai:gpt-4o', memoryEnabled: false } as const;

describe('planHostModelRoles', () => {
  describe('summary (auto-compaction)', () => {
    it("summarizes with the agent's model when the summary model has no key", () => {
      const input = userConfig();
      const plan = planHostModelRoles(input, BUILTIN);

      expect(plan.userConfig.autoCompact).toEqual({ ...input.autoCompact, summaryModelId: 'openai:gpt-4o' });
      expect(plan.userConfig.hostModelProfiles).toEqual({});
      expect(plan.notices).toEqual([
        {
          role: 'summary',
          action: 'agent_model',
          message: expect.stringMatching(
            /^Auto-compaction's summary model "anthropic:claude-haiku-4-5" has no credentials \(no ANTHROPIC_API_KEY is configured\); this session summarizes with the agent model "openai:gpt-4o" instead\./,
          ),
        },
      ]);
      // The caller's configuration is not changed.
      expect(input.autoCompact.summaryModelId).toBe('anthropic:claude-haiku-4-5');
    });

    it("binds the summary to the agent's host profile, so it is created exactly like the agent model", () => {
      const routed = { ...OPENROUTER_PROFILE, apiKey: 'sk-or' };
      const input = userConfig({
        openaiApiKey: '',
        modelProviders: { default: 'native', profiles: { native: { type: 'native' }, router: routed } },
        hostModelProfiles: { agent: 'router', summary: 'native' },
      });
      const plan = planHostModelRoles(input, BUILTIN);

      expect(plan.userConfig.autoCompact.summaryModelId).toBe('openai:gpt-4o');
      expect(plan.userConfig.hostModelProfiles).toEqual({ agent: 'router', summary: 'router' });
      expect(plan.notices.map((notice) => notice.action)).toEqual(['agent_model']);
    });

    it('turns auto-compaction off when neither the summary nor the agent model has a key', () => {
      const plan = planHostModelRoles(userConfig({ openaiApiKey: '' }), BUILTIN);

      expect(plan.userConfig.autoCompact.enabled).toBe(false);
      expect(plan.notices).toEqual([
        { role: 'summary', action: 'disabled', message: expect.stringMatching(/^Auto-compaction is off/) },
      ]);
    });

    it('leaves a working summary model, a disabled feature and container sessions alone', () => {
      const withKey = userConfig({ anthropicApiKey: 'sk-ant' });
      expect(planHostModelRoles(withKey, BUILTIN)).toEqual({ userConfig: withKey, notices: [] });

      const disabled = userConfig({
        autoCompact: { enabled: false, thresholdTokens: 1, keepRecentMessages: 1, summaryModelId: 'anthropic:x' },
      });
      expect(planHostModelRoles(disabled, BUILTIN)).toEqual({ userConfig: disabled, notices: [] });

      const docker = userConfig();
      expect(planHostModelRoles(docker, { ...BUILTIN, mode: 'docker' })).toEqual({ userConfig: docker, notices: [] });
    });
  });

  describe('autoApprove', () => {
    it('turns auto-approve off without swapping its model, in either mode', () => {
      for (const mode of ['builtin', 'docker'] as const) {
        const input = userConfig({
          autoCompact: { enabled: false, thresholdTokens: 1, keepRecentMessages: 1, summaryModelId: 'anthropic:x' },
          autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' },
        });
        const plan = planHostModelRoles(input, { ...BUILTIN, mode });

        expect(plan.userConfig.autoApprove).toEqual({ enabled: false, modelId: 'anthropic:claude-haiku-4-5' });
        expect(plan.notices).toEqual([
          {
            role: 'autoApprove',
            action: 'disabled',
            message: expect.stringMatching(/^Auto-approve is off for this session: .*every escalation goes to a human/),
          },
        ]);
      }
    });

    it('names the host profile when the profile, not the provider, lacks a key', () => {
      const plan = planHostModelRoles(
        userConfig({
          anthropicApiKey: 'sk-ant',
          autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' },
          hostModelProfiles: { autoApprove: 'router' },
        }),
        BUILTIN,
      );
      expect(plan.notices).toEqual([
        expect.objectContaining({
          role: 'autoApprove',
          message: expect.stringContaining('host model profile "router" has no API key'),
        }),
      ]);
    });

    it('keeps auto-approve whose model has a key', () => {
      const input = userConfig({
        anthropicApiKey: 'sk-ant',
        autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' },
      });
      expect(planHostModelRoles(input, BUILTIN).notices).toEqual([]);
    });
  });

  describe('memory', () => {
    const withMemory = { ...BUILTIN, memoryEnabled: true };
    const noCompaction = {
      autoCompact: { enabled: false, thresholdTokens: 1, keepRecentMessages: 1, summaryModelId: 'anthropic:x' },
    };

    it('says memory runs without its LLM when no key, base URL or Anthropic key is configured', () => {
      const input = userConfig(noCompaction);
      const plan = planHostModelRoles(input, withMemory);
      expect(plan.userConfig).toBe(input);
      expect(plan.notices).toEqual([
        { role: 'memory', action: 'degraded', message: expect.stringMatching(/^Memory runs without its LLM/) },
      ]);
    });

    it('is quiet when memory has an LLM, or is not used', () => {
      for (const memory of [
        {
          enabled: true,
          autoSave: true,
          llmBaseUrl: 'http://localhost:11434/v1',
          llmApiKey: undefined,
          offlineModels: false,
        },
        { enabled: true, autoSave: true, llmBaseUrl: undefined, llmApiKey: 'sk-memory', offlineModels: false },
      ]) {
        expect(planHostModelRoles(userConfig({ ...noCompaction, memory }), withMemory).notices).toEqual([]);
      }
      expect(
        planHostModelRoles(userConfig({ ...noCompaction, anthropicApiKey: 'sk-ant' }), withMemory).notices,
      ).toEqual([]);
      expect(planHostModelRoles(userConfig(noCompaction), BUILTIN).notices).toEqual([]);
    });
  });

  it('tolerates a hand-built configuration without the optional sections', () => {
    const bare = { anthropicApiKey: '', openaiApiKey: '' } as unknown as ResolvedUserConfig;
    expect(planHostModelRoles(bare, { ...BUILTIN, memoryEnabled: true }).notices).toEqual([
      expect.objectContaining({ role: 'memory' }),
    ]);
  });
});
