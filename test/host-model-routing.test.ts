/**
 * Host model roles bound to a gateway profile must reach the gateway with a
 * model ID it can route: OpenRouter needs `vendor/model`, so an unmapped bare
 * ID (from `openai:gpt-5`, or the default Anthropic IDs under `modelMap: []`)
 * would fail with a provider error mid-session. These checks are offline
 * warnings (config editor, doctor), never load errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { findHostModelRoutingWarnings } from '../src/config/model-provider.js';
import { describeGatewayModelIdProblem } from '../src/config/provider-definitions.js';
import {
  HOST_MODEL_ROLES,
  USER_CONFIG_DEFAULTS,
  hostRoleModelId,
  loadUserConfig,
  type ResolvedProviderProfile,
} from '../src/config/user-config.js';

describe('host model routing warnings', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-host-routing-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  function load(config: Record<string, unknown>) {
    writeFileSync(resolve(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    return loadUserConfig({ readOnly: true });
  }

  function profile(
    config: ReturnType<typeof load>,
    name: string,
  ): Exclude<ResolvedProviderProfile, { type: 'native' }> {
    const found = config.modelProviders.profiles[name];
    if (found.type === 'native') throw new Error('expected a gateway profile');
    return found;
  }

  it('flags an unmapped bare ID on OpenRouter, including the defaults under an empty model map', () => {
    const config = load({
      agentModelId: 'openai:gpt-5',
      hostModelProfiles: { agent: 'router', policy: 'bare', summary: 'router' },
      modelProviders: {
        profiles: { router: { type: 'openrouter' }, bare: { type: 'openrouter', modelMap: [] } },
      },
    });

    const warnings = findHostModelRoutingWarnings(config);

    expect(warnings.map((warning) => [warning.role, warning.profileName, warning.modelId])).toEqual([
      ['agent', 'router', 'openai:gpt-5'],
      ['policy', 'bare', 'anthropic:claude-sonnet-4-6'],
    ]);
    expect(warnings[0].message).toContain('Host role "agent" (profile "router")');
    expect(warnings[0].message).toContain('reaches OpenRouter as "gpt-5"');
    expect(warnings[0].message).toContain('"vendor/model"');
  });

  it('accepts mapped IDs, vendor-qualified IDs and native or Z.AI bindings', () => {
    const config = load({
      agentModelId: 'openai/gpt-5',
      prefilterModelId: 'anthropic:claude-haiku-4-5',
      hostModelProfiles: { agent: 'router', prefilter: 'router', policy: 'glm', summary: 'native' },
      modelProviders: { profiles: { router: { type: 'openrouter' }, glm: { type: 'zai', modelMap: [] } } },
    });

    expect(findHostModelRoutingWarnings(config)).toEqual([]);
    // Z.AI takes bare IDs such as glm-5.3, so it is never flagged.
    expect(describeGatewayModelIdProblem(profile(config, 'glm'), 'gpt-5')).toBeUndefined();
    expect(describeGatewayModelIdProblem(profile(config, 'router'), 'anthropic:claude-opus-4-6')).toBeUndefined();
    expect(describeGatewayModelIdProblem(profile(config, 'router'), 'mistral-large')).toMatch(/mistral-large/);
  });

  it('reads each role from its own config field', () => {
    const config = load({
      agentModelId: 'anthropic:a',
      policyModelId: 'anthropic:p',
      prefilterModelId: 'anthropic:f',
      autoCompact: { summaryModelId: 'anthropic:s' },
      autoApprove: { modelId: 'anthropic:x' },
      contentAssessment: { llmModelId: 'anthropic:c' },
    });
    expect(HOST_MODEL_ROLES.map((role) => hostRoleModelId(config, role))).toEqual([
      'anthropic:a',
      'anthropic:p',
      'anthropic:f',
      'anthropic:s',
      'anthropic:x',
      'anthropic:c',
    ]);
    // A hand-built config without the section requests the default model.
    expect(hostRoleModelId({ ...config, contentAssessment: undefined }, 'contentAssessment')).toBe(
      USER_CONFIG_DEFAULTS.contentAssessment.llmModelId,
    );
  });

  it('checks the outbound content check model like every other gateway-bound role', () => {
    const config = load({
      contentAssessment: { enabled: true, llmCheck: true, llmModelId: 'openai:gpt-5' },
      hostModelProfiles: { contentAssessment: 'router' },
      modelProviders: { profiles: { router: { type: 'openrouter' } } },
    });

    const warnings = findHostModelRoutingWarnings(config);

    expect(warnings.map((warning) => [warning.role, warning.profileName, warning.modelId])).toEqual([
      ['contentAssessment', 'router', 'openai:gpt-5'],
    ]);
    expect(warnings[0].message).toContain('reaches OpenRouter as "gpt-5"');
  });
});
