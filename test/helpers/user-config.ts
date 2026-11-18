/**
 * A complete `ResolvedUserConfig` for tests that build an `IronCurtainConfig`
 * by hand instead of loading `~/.ironcurtain/config.json`.
 *
 * Hand-built configs used to list only the fields a test happened to need and
 * pass the rest as missing, which the type checker now rejects: a field the
 * runtime gains would otherwise reach the code under test as `undefined`.
 * The type cannot catch a field that is optional for embedders but always
 * set by the loader (`fetch`, `policy`, `egressPolicy`, `observability`,
 * `taintEscalation`, `contentAssessment`, `modelPricingOverrides`,
 * `maxConcurrentAgentSessions`, `cron`, `agentCliVersions`, `personas`,
 * `retention`), so test/test-user-config.test.ts checks that this helper sets
 * exactly the fields `loadUserConfig()` resolves.
 */

import { resolveSandboxPolicy } from '../../src/config/sandbox-policy.js';
import {
  CRON_CONFIG_DEFAULTS,
  NATIVE_PROFILE_NAME,
  PERSONAS_CONFIG_DEFAULTS,
  RETENTION_CONFIG_DEFAULTS,
  USER_CONFIG_DEFAULTS,
  type ResolvedUserConfig,
} from '../../src/config/user-config.js';

/**
 * What `loadUserConfig()` resolves for an empty config file, except that no
 * credential or base URL is set and every subsystem a test would have to opt
 * into is off: memory, auto-compaction, auto-approval, package installs,
 * snapshots, statistics and nested Docker. The OS-sandbox policy is what a
 * session resolves when the config leaves it unset (environment, then the
 * platform default). `overrides` replaces whole top-level fields.
 */
export function testUserConfig(overrides: Partial<ResolvedUserConfig> = {}): ResolvedUserConfig {
  return {
    agentModelId: USER_CONFIG_DEFAULTS.agentModelId,
    policyModelId: USER_CONFIG_DEFAULTS.policyModelId,
    prefilterModelId: USER_CONFIG_DEFAULTS.prefilterModelId,
    anthropicApiKey: '',
    googleApiKey: '',
    openaiApiKey: '',
    anthropicBaseUrl: '',
    openaiBaseUrl: '',
    googleBaseUrl: '',
    escalationTimeoutSeconds: USER_CONFIG_DEFAULTS.escalationTimeoutSeconds,
    resourceBudget: { ...USER_CONFIG_DEFAULTS.resourceBudget },
    modelPricingOverrides: {},
    autoCompact: { ...USER_CONFIG_DEFAULTS.autoCompact, enabled: false },
    autoApprove: { ...USER_CONFIG_DEFAULTS.autoApprove, enabled: false },
    auditRedaction: { ...USER_CONFIG_DEFAULTS.auditRedaction },
    observability: { ...USER_CONFIG_DEFAULTS.observability },
    taintEscalation: { enabled: false, tools: {} },
    contentAssessment: { ...USER_CONFIG_DEFAULTS.contentAssessment },
    memory: { enabled: false, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined, offlineModels: false },
    webSearch: { provider: null, brave: null, tavily: null, serpapi: null },
    fetch: { allowPrivateNetworks: false },
    policy: { onStale: 'warn' },
    egressPolicy: { enabled: false, allowedHosts: [] },
    modelProviders: { default: NATIVE_PROFILE_NAME, profiles: { [NATIVE_PROFILE_NAME]: { type: 'native' } } },
    serverCredentials: {},
    signal: null,
    gooseProvider: 'anthropic',
    gooseModel: 'claude-sonnet-4-20250514',
    preferredDockerAgent: 'claude-code',
    preferredMode: USER_CONFIG_DEFAULTS.preferredMode,
    containerRuntime: 'auto',
    sandboxPolicy: resolveSandboxPolicy(undefined),
    packageInstall: { enabled: false, quarantineDays: 2, allowedPackages: [], deniedPackages: [] },
    credentialProtection: { extraPaths: [], disabledStores: [] },
    agentSudo: true,
    agentCliVersions: {},
    dockerResources: { ...USER_CONFIG_DEFAULTS.dockerResources },
    maxConcurrentAgentSessions: USER_CONFIG_DEFAULTS.maxConcurrentAgentSessions,
    snapshot: { ...USER_CONFIG_DEFAULTS.snapshot, enabled: false },
    dockerWorkload: { enabled: false },
    statistics: { enabled: false, retentionDays: USER_CONFIG_DEFAULTS.statistics.retentionDays },
    cron: { ...CRON_CONFIG_DEFAULTS },
    personas: { ...PERSONAS_CONFIG_DEFAULTS },
    retention: { ...RETENTION_CONFIG_DEFAULTS },
    ...overrides,
  };
}
