/**
 * test/helpers/user-config.ts stands in for `loadUserConfig()` in tests that
 * build an `IronCurtainConfig` by hand. These checks keep it in step with the
 * loader: a field the loader always resolves but the helper leaves out would
 * reach the code under test as `undefined`, a path production never takes.
 * The type checker cannot catch that for fields that are optional for
 * embedders (`fetch`, `policy`, `egressPolicy`, `observability`,
 * `taintEscalation`, `contentAssessment`, `modelPricingOverrides`,
 * `maxConcurrentAgentSessions`, `cron`, `agentCliVersions`, `personas`).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadUserConfig, type ResolvedUserConfig } from '../src/config/user-config.js';
import { testUserConfig } from './helpers/user-config.js';

/** Top-level fields that hold a value, sorted (an `undefined` field is unset). */
function setFields(config: ResolvedUserConfig): string[] {
  return Object.entries(config)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name)
    .sort();
}

describe('testUserConfig', () => {
  let home: string;

  beforeEach(() => {
    // No config file: the loader resolves its defaults and writes nothing.
    home = mkdtempSync(join(tmpdir(), 'test-user-config-'));
    vi.stubEnv('IRONCURTAIN_HOME', home);
    // The helper sets no credential or base URL; neither may the environment.
    for (const name of [
      'ANTHROPIC_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_BASE_URL',
      'OPENAI_BASE_URL',
      'GOOGLE_API_BASE_URL',
    ]) {
      vi.stubEnv(name, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('sets exactly the fields loadUserConfig() resolves', () => {
    expect(setFields(testUserConfig())).toEqual(setFields(loadUserConfig({ readOnly: true })));
  });

  it('matches the loaded defaults except for the opt-in subsystems it turns off', () => {
    const loaded = loadUserConfig({ readOnly: true });
    expect(testUserConfig()).toEqual({
      ...loaded,
      autoCompact: { ...loaded.autoCompact, enabled: false },
      memory: { ...loaded.memory, enabled: false, autoSave: false },
      packageInstall: { ...loaded.packageInstall, enabled: false },
      snapshot: { ...loaded.snapshot, enabled: false },
      statistics: { ...loaded.statistics, enabled: false },
    });
  });

  it('keeps auto-approval, nested Docker, private-network fetches and policy-evaluated egress off', () => {
    const config = testUserConfig();
    expect(config.autoApprove.enabled).toBe(false);
    expect(config.dockerWorkload).toEqual({ enabled: false });
    expect(config.fetch).toEqual({ allowPrivateNetworks: false });
    expect(config.egressPolicy).toEqual({ enabled: false, allowedHosts: [] });
  });
});
