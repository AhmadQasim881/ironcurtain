/**
 * The relays' per-user scratch root (spawn-cwd.ts `ensurePrivateScratchRoot`)
 * keeps one relay's srt settings, working directories and OAuth access-token
 * files away from every other sandboxed server.
 *
 * Each relay writes its google-workspace access token next to its srt
 * settings. Those used to live in a fresh `os.tmpdir()/ironcurtain-srt-*`
 * directory, and srt does not deny `/tmp`, so any other sandboxed server --
 * the git server, another session's google-workspace server -- could read
 * the token. Now every settings directory sits inside one 0700 per-user
 * root that every sandboxed server has in its `denyRead` baseline, and each
 * server gets back only its own working directory and credential
 * directory.
 *
 * The first test checks the settings the relay writes and always runs. The
 * second runs the real srt (bubblewrap or Seatbelt) and is skipped where
 * srt cannot start a sandbox at all (the smoke test fails).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensurePrivateScratchRoot } from '../src/trusted-process/spawn-cwd.js';
import {
  checkSandboxAvailability,
  cleanupSettingsFiles,
  resolveSandboxConfig,
  rewriteServerSettings,
  runOsSandboxSmokeTest,
  wrapServerCommand,
  writeServerSettings,
  type ResolvedSandboxConfig,
} from '../src/trusted-process/sandbox-integration.js';
import {
  GWORKSPACE_CREDENTIAL_FILENAME,
  writeGWorkspaceCredentialFile,
} from '../src/trusted-process/gworkspace-credentials.js';

interface RelayFiles {
  readonly settingsDir: string;
  readonly settingsPath: string;
  readonly cwdPath: string;
  readonly credsDir: string;
  readonly resolved: ResolvedSandboxConfig;
}

interface SrtFilesystemSettings {
  readonly filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] };
}

function isAtOrUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

describe('per-user scratch root isolation', () => {
  let sessionSandbox: string;
  const settingsDirs: string[] = [];

  beforeAll(() => {
    sessionSandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-scratch-iso-session-')));
  });

  afterAll(() => {
    for (const dir of settingsDirs) cleanupSettingsFiles(dir);
    rmSync(sessionSandbox, { recursive: true, force: true });
  });

  /**
   * What one relay prepares for its OAuth-backed server: the srt settings
   * and working directory (resolveServerSandboxConfigs), then the
   * credential file and its re-exposure (the OAuth branch of main()).
   */
  function prepareRelay(token: string): RelayFiles {
    const settingsDir = mkdtempSync(join(ensurePrivateScratchRoot(), 'srt-'));
    settingsDirs.push(settingsDir);
    const resolved = resolveSandboxConfig({ command: 'sh', args: [] }, sessionSandbox, true, 'enforce', 'gw');
    if (!resolved.sandboxed) throw new Error('expected a sandboxed config');
    const { settingsPath, cwdPath } = writeServerSettings('gw', resolved.config, settingsDir);
    const credsDir = join(settingsDir, 'gw-creds');
    writeGWorkspaceCredentialFile(credsDir, token, Date.now() + 3_600_000, ['scope']);
    rewriteServerSettings(settingsPath, { allowRead: [credsDir], allowWrite: [credsDir] });
    return { settingsDir, settingsPath, cwdPath, credsDir, resolved };
  }

  it("denies the scratch root and re-exposes only the server's own directories", () => {
    const scratchRoot = ensurePrivateScratchRoot();
    const own = prepareRelay('token-own');
    const sibling = prepareRelay('token-sibling');
    const settings = JSON.parse(readFileSync(own.settingsPath, 'utf-8')) as SrtFilesystemSettings;

    expect(settings.filesystem.denyRead).toContain(scratchRoot);
    expect(settings.filesystem.allowRead).toEqual(expect.arrayContaining([own.cwdPath, own.credsDir]));
    expect(settings.filesystem.allowWrite).toEqual(expect.arrayContaining([own.cwdPath, own.credsDir]));
    // Nothing else inside the root comes back: not the root, not this
    // relay's settings directory, nothing of the sibling's.
    for (const entry of [...settings.filesystem.allowRead, ...settings.filesystem.allowWrite]) {
      if (!isAtOrUnder(entry, scratchRoot)) continue;
      expect([own.cwdPath, own.credsDir]).toContain(entry);
      expect(isAtOrUnder(entry, sibling.settingsDir)).toBe(false);
    }
  });

  describe.skipIf(!checkSandboxAvailability().platformSupported)('under the real srt', () => {
    let srtWorks = false;

    beforeAll(async () => {
      srtWorks = checkSandboxAvailability().errors.length === 0 && (await runOsSandboxSmokeTest()).ok;
    }, 30_000);

    it("lets a server read its own access token but not another relay's", ({ skip }) => {
      if (!srtWorks) skip();
      const own = prepareRelay('token-own-run');
      const sibling = prepareRelay('token-sibling-run');
      const ownFile = join(own.credsDir, GWORKSPACE_CREDENTIAL_FILENAME);
      const siblingFile = join(sibling.credsDir, GWORKSPACE_CREDENTIAL_FILENAME);
      for (const path of [ownFile, siblingFile]) expect(path).not.toContain("'");
      const script = [
        `cat '${ownFile}'`,
        `cat '${siblingFile}' 2>/dev/null || echo SIBLING-HIDDEN`,
        `cat '${sibling.settingsPath}' 2>/dev/null || echo SIBLING-SETTINGS-HIDDEN`,
        `echo written > '${join(own.credsDir, 'probe')}' && echo OWN-WRITABLE`,
      ].join('; ');
      const wrapped = wrapServerCommand('gw', 'sh', ['-c', script], own.resolved, own.settingsDir);
      const result = spawnSync(wrapped.command, wrapped.args, { cwd: own.cwdPath, encoding: 'utf-8', timeout: 30_000 });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('token-own-run');
      expect(result.stdout).not.toContain('token-sibling-run');
      expect(result.stdout).toContain('SIBLING-HIDDEN');
      expect(result.stdout).toContain('SIBLING-SETTINGS-HIDDEN');
      expect(result.stdout).toContain('OWN-WRITABLE');
    }, 30_000);
  });
});
