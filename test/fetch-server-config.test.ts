/**
 * The host-to-fetch-server channel for `fetch.allowPrivateNetworks`: the user
 * config is the only authority, it reaches the server through its env, and a
 * missing or unrecognized value fails closed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyFetchServerOptions, loadConfig } from '../src/config/index.js';
import type { MCPServerConfig } from '../src/config/types.js';
import { FETCH_ALLOW_PRIVATE_NETWORKS_ENV, isPrivateNetworkFetchEnabled } from '../src/servers/fetch-env.js';

describe('isPrivateNetworkFetchEnabled', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    [' 1 ', true],
    ['0', false],
    ['false', false],
    ['', false],
    ['yes', false],
    [undefined, false],
  ])('%j -> %s', (value, expected) => {
    expect(isPrivateNetworkFetchEnabled({ [FETCH_ALLOW_PRIVATE_NETWORKS_ENV]: value })).toBe(expected);
  });
});

describe('applyFetchServerOptions', () => {
  function servers(): Record<string, MCPServerConfig> {
    return {
      fetch: { command: 'node', args: ['fetch.js'], env: { KEEP: 'me' } },
      git: { command: 'node', args: ['git.js'] },
    };
  }

  it('always writes an explicit 1 or 0 into the fetch server env, keeping its other variables', () => {
    const enabled = servers();
    applyFetchServerOptions(enabled, { allowPrivateNetworks: true });
    expect(enabled.fetch.env).toEqual({ KEEP: 'me', [FETCH_ALLOW_PRIVATE_NETWORKS_ENV]: '1' });

    const disabled = servers();
    applyFetchServerOptions(disabled, { allowPrivateNetworks: false });
    expect(disabled.fetch.env).toEqual({ KEEP: 'me', [FETCH_ALLOW_PRIVATE_NETWORKS_ENV]: '0' });
    expect(disabled.git.env).toBeUndefined();
  });

  it('does nothing when no fetch server is configured', () => {
    const onlyGit: Record<string, MCPServerConfig> = { git: { command: 'node', args: ['git.js'] } };
    applyFetchServerOptions(onlyGit, { allowPrivateNetworks: true });
    expect(onlyGit).toEqual({ git: { command: 'node', args: ['git.js'] } });
  });
});

describe('loadConfig fetch server env', () => {
  let testHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-fetch-config-'));
    for (const key of ['IRONCURTAIN_HOME', FETCH_ALLOW_PRIVATE_NETWORKS_ENV]) saved[key] = process.env[key];
    process.env.IRONCURTAIN_HOME = testHome;
    // loadUserConfig() announces the config file it creates.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  it('defaults to 0, overriding a stray host variable', () => {
    process.env[FETCH_ALLOW_PRIVATE_NETWORKS_ENV] = '1';
    expect(loadConfig().mcpServers.fetch.env?.[FETCH_ALLOW_PRIVATE_NETWORKS_ENV]).toBe('0');
  });

  it('is 1 when the user config opts in', () => {
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify({ fetch: { allowPrivateNetworks: true } }));
    expect(loadConfig().mcpServers.fetch.env?.[FETCH_ALLOW_PRIVATE_NETWORKS_ENV]).toBe('1');
  });
});

describe('loadConfig({ readOnly: true })', () => {
  let testHome: string;
  const savedHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-readonly-config-'));
    process.env.IRONCURTAIN_HOME = resolve(testHome, 'home');
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('resolves the defaults without creating the home or config.json (doctor loads this way)', () => {
    const config = loadConfig({ readOnly: true });
    expect(config.mcpServers.fetch.env?.[FETCH_ALLOW_PRIVATE_NETWORKS_ENV]).toBe('0');
    expect(existsSync(resolve(testHome, 'home'))).toBe(false);
  });

  it('neither backfills nor rewrites an existing config.json', () => {
    const home = resolve(testHome, 'home');
    mkdirSync(home);
    const text = JSON.stringify({ fetch: { allowPrivateNetworks: true } });
    writeFileSync(resolve(home, 'config.json'), text);
    expect(loadConfig({ readOnly: true }).mcpServers.fetch.env?.[FETCH_ALLOW_PRIVATE_NETWORKS_ENV]).toBe('1');
    expect(readFileSync(resolve(home, 'config.json'), 'utf-8')).toBe(text);
    expect(existsSync(resolve(home, 'config.json.bak'))).toBe(false);
  });
});
