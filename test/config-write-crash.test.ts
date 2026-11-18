/**
 * A crash or a full disk in the middle of a config / credential write must
 * leave the previous file intact. The writes go to a temporary file that is
 * renamed into place, so failing the rename (the process dying between write
 * and rename) or the write itself (ENOSPC) is simulated by intercepting
 * node:fs for the modules under test. So is a host credentials file that
 * exists but cannot be read, which a write-back must leave alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const failure = vi.hoisted(() => ({
  /** Basename of a rename destination to fail, as if the process died before the rename. */
  renameTo: undefined as string | undefined,
  /** Fail any write whose bytes contain this text with ENOSPC. */
  writeContaining: undefined as string | undefined,
  /** Basename of a file whose reads fail with EACCES (these tests run as root, so chmod cannot). */
  readDenied: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realWriteSync = actual.writeSync as (...args: unknown[]) => number;
  const realReadFileSync = actual.readFileSync as (...args: unknown[]) => unknown;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => {
      if (failure.readDenied !== undefined && basename(String(args[0])) === failure.readDenied) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${String(args[0])}'`), { code: 'EACCES' });
      }
      return realReadFileSync(...args);
    },
    renameSync: (from: PathLike, to: PathLike) => {
      if (failure.renameTo !== undefined && basename(String(to)) === failure.renameTo) {
        throw Object.assign(new Error('simulated crash before rename'), { code: 'EIO' });
      }
      actual.renameSync(from, to);
    },
    writeSync: (...args: unknown[]) => {
      const data = args[1];
      if (
        failure.writeContaining !== undefined &&
        data instanceof Uint8Array &&
        Buffer.from(data).toString('utf8').includes(failure.writeContaining)
      ) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return realWriteSync(...args);
    },
  };
});

import { saveUserConfig } from '../src/config/user-config.js';
import { loadOAuthToken, saveOAuthToken, saveRefreshedOAuthToken } from '../src/auth/oauth-token-store.js';
import { saveCodexOAuthCredentials, saveOAuthCredentials } from '../src/docker/oauth-credentials.js';

const ORIGINAL_CONFIG = `${JSON.stringify(
  {
    anthropicApiKey: 'sk-ant-api03-keep-me',
    serverCredentials: { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_keep_me' } },
    statistics: { enabled: true, retentionDays: 90 },
  },
  null,
  2,
)}\n`;

let home: string;
const savedHome = process.env.IRONCURTAIN_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ironcurtain-write-crash-'));
  process.env.IRONCURTAIN_HOME = home;
});

afterEach(() => {
  failure.renameTo = undefined;
  failure.writeContaining = undefined;
  failure.readDenied = undefined;
  if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('config.json', () => {
  beforeEach(() => {
    writeFileSync(join(home, 'config.json'), ORIGINAL_CONFIG, { mode: 0o600 });
  });

  it('a crash between write and rename leaves the old file, with no temp or lock file behind', () => {
    failure.renameTo = 'config.json';

    expect(() => saveUserConfig({ statistics: { enabled: false, retentionDays: 7 } })).toThrow(/rename/);

    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(ORIGINAL_CONFIG);
    // Only the backup of the (unchanged) previous version was written.
    expect(readdirSync(home).sort()).toEqual(['config.json', 'config.json.bak']);
    expect(readFileSync(join(home, 'config.json.bak'), 'utf8')).toBe(ORIGINAL_CONFIG);
  });

  it('ENOSPC while writing leaves the old file', () => {
    failure.writeContaining = '"retentionDays": 7';

    expect(() => saveUserConfig({ statistics: { enabled: false, retentionDays: 7 } })).toThrow();

    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(ORIGINAL_CONFIG);
    expect(readdirSync(home).sort()).toEqual(['config.json', 'config.json.bak']);
  });
});

describe('OAuth token store', () => {
  const token = {
    accessToken: 'ya29.old',
    refreshToken: '1//refresh',
    expiresAt: Date.now() + 60_000,
    scopes: ['scope-a'],
  };

  beforeEach(() => {
    mkdirSync(join(home, 'oauth'), { mode: 0o700 });
    writeFileSync(join(home, 'oauth', 'google.json'), `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  });

  it('a crash between write and rename keeps the old token', () => {
    failure.renameTo = 'google.json';

    expect(() => saveOAuthToken('google', { ...token, accessToken: 'ya29.new' })).toThrow(/rename/);
    expect(() =>
      saveRefreshedOAuthToken(
        'google',
        { ...token, accessToken: 'ya29.new', expiresAt: Date.now() + 3_600_000 },
        token.refreshToken,
      ),
    ).toThrow(/rename/);

    expect(loadOAuthToken('google')).toEqual(token);
    expect(readdirSync(join(home, 'oauth'))).toEqual(['google.json']);
  });

  it('ENOSPC while writing keeps the old token', () => {
    failure.writeContaining = 'ya29.new';

    expect(() => saveOAuthToken('google', { ...token, accessToken: 'ya29.new' })).toThrow();

    expect(loadOAuthToken('google')).toEqual(token);
    expect(readdirSync(join(home, 'oauth'))).toEqual(['google.json']);
  });
});

describe('host CLI credential write-back', () => {
  it('a crash between write and rename keeps the Claude Code credentials file', () => {
    const credPath = join(home, '.credentials.json');
    const original = `${JSON.stringify({
      claudeAiOauth: { accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() - 1_000 },
      mcpOAuth: { keep: true },
    })}\n`;
    writeFileSync(credPath, original, { mode: 0o600 });
    failure.renameTo = '.credentials.json';

    expect(() =>
      saveOAuthCredentials({ accessToken: 'new', refreshToken: 'rt-new', expiresAt: Date.now() + 3_600_000 }, credPath),
    ).toThrow(/rename/);

    expect(readFileSync(credPath, 'utf8')).toBe(original);
    expect(readdirSync(home)).toEqual(['.credentials.json']);
  });

  it('leaves a credentials file it cannot read alone instead of replacing it with only our fields', () => {
    // E.g. the host CLI once ran as root: the file is unreadable, yet the
    // directory is ours, so a rename would succeed and drop mcpOAuth.
    const credPath = join(home, '.credentials.json');
    const original = `${JSON.stringify({
      claudeAiOauth: { accessToken: 'host-at', refreshToken: 'rt-0', expiresAt: Date.now() + 3_600_000 },
      mcpOAuth: { keep: true },
    })}\n`;
    writeFileSync(credPath, original, { mode: 0o600 });
    const authPath = join(home, 'auth.json');
    const codexOriginal = `${JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'old', refresh_token: 'rt' } })}\n`;
    writeFileSync(authPath, codexOriginal, { mode: 0o600 });
    const ours = { accessToken: 'new', refreshToken: 'rt-new', expiresAt: Date.now() + 7_200_000 };

    failure.readDenied = '.credentials.json';
    expect(() => saveOAuthCredentials(ours, credPath, { refreshedFrom: 'rt-0' })).toThrow(/EACCES/);
    failure.readDenied = 'auth.json';
    expect(() => saveCodexOAuthCredentials(ours, authPath, { refreshedFrom: 'rt' })).toThrow(/EACCES/);
    failure.readDenied = undefined;

    expect(readFileSync(credPath, 'utf8')).toBe(original);
    expect(readFileSync(authPath, 'utf8')).toBe(codexOriginal);
    expect(readdirSync(home).sort()).toEqual(['.credentials.json', 'auth.json']);
  });

  it('a crash between write and rename keeps the Codex auth.json', () => {
    const authPath = join(home, 'auth.json');
    const original = `${JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'old', refresh_token: 'rt' } })}\n`;
    writeFileSync(authPath, original, { mode: 0o600 });
    failure.renameTo = 'auth.json';

    expect(() =>
      saveCodexOAuthCredentials({ accessToken: 'new', refreshToken: 'rt2', expiresAt: Date.now() + 1_000 }, authPath),
    ).toThrow(/rename/);

    expect(readFileSync(authPath, 'utf8')).toBe(original);
    expect(readdirSync(home)).toEqual(['auth.json']);
  });
});
