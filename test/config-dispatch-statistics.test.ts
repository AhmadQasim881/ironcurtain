/**
 * The web UI's statistics toggle (`config.setStatistics`) writes config.json
 * through saveUserConfig. It must never replace a config.json it cannot parse:
 * that file still holds the user's API keys and server credentials.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { configDispatch } from '../src/web-ui/dispatch/config-dispatch.js';
import type { WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import {
  readConfig,
  seedConfig,
  setupConfigEnv,
  teardownConfigEnv,
  type ConfigTestEnv,
} from './helpers/config-test-setup.js';

let env: ConfigTestEnv;
let ctx: WorkflowDispatchContext;

beforeEach(() => {
  env = setupConfigEnv('config-dispatch-statistics');
  ctx = { allowPolicyMutation: true, eventBus: new WebEventBus() } as WorkflowDispatchContext;
});

afterEach(() => {
  teardownConfigEnv(env);
});

describe('config.setStatistics', () => {
  it('refuses to overwrite a config.json with a JSON typo and emits no change', async () => {
    const configPath = resolve(env.testHome, 'config.json');
    const typo = [
      '{',
      '  "anthropicApiKey": "sk-ant-api03-keep-me",',
      '  "serverCredentials": { "github": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_keep_me" } },',
      '  "statistics": { "enabled": true, "retentionDays": 90 },',
      '}',
      '',
    ].join('\n');
    writeFileSync(configPath, typo, { mode: 0o600 });
    const emit = vi.spyOn(ctx.eventBus, 'emit');

    await expect(
      configDispatch(ctx, 'config.setStatistics', { enabled: false, retentionDays: 30 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringMatching(/Invalid JSON/) });

    expect(readFileSync(configPath, 'utf8')).toBe(typo);
    expect(readdirSync(env.testHome)).toEqual(['config.json']);
    expect(emit).not.toHaveBeenCalled();
  });

  it('saves the statistics section atomically and owner-only, keeping every other setting', async () => {
    seedConfig(env.testHome, {
      anthropicApiKey: 'sk-ant-api03-keep-me',
      serverCredentials: { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_keep_me' } },
      statistics: { enabled: true, retentionDays: 90 },
    });

    await expect(configDispatch(ctx, 'config.setStatistics', { enabled: false, retentionDays: 30 })).resolves.toEqual({
      enabled: false,
      retentionDays: 30,
    });

    expect(readConfig(env.testHome)).toEqual({
      anthropicApiKey: 'sk-ant-api03-keep-me',
      serverCredentials: { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_keep_me' } },
      statistics: { enabled: false, retentionDays: 30 },
    });
    expect(statSync(resolve(env.testHome, 'config.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(env.testHome).sort()).toEqual(['config.json', 'config.json.bak']);
  });
});
