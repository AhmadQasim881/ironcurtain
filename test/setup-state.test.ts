/**
 * The first-start setup marker (src/config/setup-state.ts): config.json's
 * `setupCompleted`, not the file's existence, decides whether
 * `ironcurtain start` runs the wizard. A user whose first command is doctor
 * (which writes nothing), mux or the daemon (whose config load creates
 * config.json), or any command that saves config into a fresh home, still
 * gets the wizard later; a config.json from before the marker never brings
 * it back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type ConfigTestEnv,
  configExists,
  readConfig,
  seedConfig,
  setupConfigEnv,
  teardownConfigEnv,
} from './helpers/config-test-setup.js';
import {
  formatSetupPendingNotice,
  readFirstStartSetupState,
  shouldRunFirstStartWizard,
} from '../src/config/setup-state.js';
import { loadConfig } from '../src/config/index.js';
import { loadUserConfig, saveUserConfig } from '../src/config/user-config.js';
import { checkConfigLoad } from '../src/doctor/checks.js';

/** `ironcurtain start` at a terminal, not as a mux or web UI child. */
const INTERACTIVE_START = { interactive: true, ptyChild: false } as const;

describe('first-start setup marker', () => {
  let env: ConfigTestEnv;

  beforeEach(() => {
    env = setupConfigEnv('setup-state');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownConfigEnv(env);
  });

  describe('readFirstStartSetupState', () => {
    it('is pending in a fresh home', () => {
      expect(readFirstStartSetupState()).toBe('pending');
      expect(configExists(env.testHome)).toBe(false);
    });

    it('follows the marker in config.json', () => {
      seedConfig(env.testHome, { setupCompleted: false });
      expect(readFirstStartSetupState()).toBe('pending');
      seedConfig(env.testHome, { setupCompleted: true });
      expect(readFirstStartSetupState()).toBe('completed');
    });

    it('treats a config.json from before the marker as set up, so an upgrade never brings the wizard back', () => {
      seedConfig(env.testHome, { agentModelId: 'anthropic:claude-sonnet-4-6' });
      expect(readFirstStartSetupState()).toBe('unrecorded');
      expect(shouldRunFirstStartWizard(INTERACTIVE_START)).toBe(false);
    });

    it('leaves an unreadable config.json to the regular load (never prompts over it)', () => {
      mkdirSync(env.testHome, { recursive: true });
      writeFileSync(resolve(env.testHome, 'config.json'), '{ not json');
      expect(readFirstStartSetupState()).toBe('unrecorded');
      writeFileSync(resolve(env.testHome, 'config.json'), '[true]');
      expect(readFirstStartSetupState()).toBe('unrecorded');
      seedConfig(env.testHome, { setupCompleted: 'yes' });
      expect(readFirstStartSetupState()).toBe('unrecorded');
    });
  });

  describe('commands that run before the wizard', () => {
    it('running doctor first creates nothing and still leaves the wizard for start', () => {
      const { result } = checkConfigLoad();

      expect(result.status).toBe('ok');
      expect(configExists(env.testHome)).toBe(false);
      expect(readFirstStartSetupState()).toBe('pending');
      expect(shouldRunFirstStartWizard(INTERACTIVE_START)).toBe(true);
    });

    it('running mux or the daemon first (a creating config load) still leaves the wizard for start', () => {
      // mux-command.ts and daemon-command.ts load the config this way.
      loadConfig();

      expect(readConfig(env.testHome).setupCompleted).toBe(false);
      expect(readFirstStartSetupState()).toBe('pending');
      expect(shouldRunFirstStartWizard(INTERACTIVE_START)).toBe(true);
    });

    it('a later load keeps the marker and never backfills one into a pre-marker file', () => {
      loadUserConfig();
      loadUserConfig();
      expect(readConfig(env.testHome).setupCompleted).toBe(false);

      seedConfig(env.testHome, { agentModelId: 'anthropic:claude-sonnet-4-6' });
      loadUserConfig();
      const legacy = readConfig(env.testHome);
      expect(legacy).not.toHaveProperty('setupCompleted');
      // The load did backfill the defaults: the marker is not one of them.
      expect(legacy.escalationTimeoutSeconds).toBeDefined();
    });

    it('a save that creates config.json (mcp, setup-signal, web UI) marks setup as not run', () => {
      saveUserConfig({ escalationTimeoutSeconds: 120 });

      expect(readConfig(env.testHome)).toEqual({ setupCompleted: false, escalationTimeoutSeconds: 120 });
      expect(shouldRunFirstStartWizard(INTERACTIVE_START)).toBe(true);
    });

    it('a save never adds the marker to an existing file and keeps the one it has', () => {
      seedConfig(env.testHome, { agentModelId: 'anthropic:claude-sonnet-4-6' });
      saveUserConfig({ escalationTimeoutSeconds: 120 });
      expect(readConfig(env.testHome)).not.toHaveProperty('setupCompleted');

      seedConfig(env.testHome, { setupCompleted: true });
      saveUserConfig({ escalationTimeoutSeconds: 90 });
      expect(readConfig(env.testHome).setupCompleted).toBe(true);
    });

    it('the wizard marking completion on a fresh home records true', () => {
      saveUserConfig({ autoApprove: { enabled: false }, setupCompleted: true });

      expect(readConfig(env.testHome).setupCompleted).toBe(true);
      expect(shouldRunFirstStartWizard(INTERACTIVE_START)).toBe(false);
    });
  });

  describe('shouldRunFirstStartWizard', () => {
    it('needs a terminal and never runs in a `start --pty` child of mux or the web UI', () => {
      expect(readFirstStartSetupState()).toBe('pending');
      expect(shouldRunFirstStartWizard({ interactive: true, ptyChild: false })).toBe(true);
      expect(shouldRunFirstStartWizard({ interactive: false, ptyChild: false })).toBe(false);
      expect(shouldRunFirstStartWizard({ interactive: true, ptyChild: true })).toBe(false);
    });
  });

  it('the notice names the home and how to run setup', () => {
    const notice = formatSetupPendingNotice();
    expect(notice).toContain(env.testHome);
    expect(notice).toContain('`ironcurtain setup`');
  });
});
