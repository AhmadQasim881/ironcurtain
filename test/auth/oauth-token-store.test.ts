import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadOAuthToken,
  saveOAuthToken,
  saveRefreshedOAuthToken,
  deleteOAuthToken,
  isTokenExpired,
} from '../../src/auth/oauth-token-store.js';
import type { StoredOAuthToken } from '../../src/auth/oauth-provider.js';

function makeToken(overrides?: Partial<StoredOAuthToken>): StoredOAuthToken {
  return {
    accessToken: 'ya29.test-access-token',
    refreshToken: '1//test-refresh-token',
    expiresAt: Date.now() + 3600 * 1000,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    ...overrides,
  };
}

describe('oauth-token-store', () => {
  let testDir: string;
  const originalEnv = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    testDir = resolve(tmpdir(), `ironcurtain-token-test-${process.pid}-${Date.now()}`);
    mkdirSync(resolve(testDir, 'oauth'), { recursive: true });
    process.env.IRONCURTAIN_HOME = testDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalEnv;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('loadOAuthToken', () => {
    it('returns null when no token file exists', () => {
      expect(loadOAuthToken('google')).toBeNull();
    });

    it('loads a valid token file', () => {
      const token = makeToken();
      writeFileSync(resolve(testDir, 'oauth', 'google.json'), JSON.stringify(token));

      const loaded = loadOAuthToken('google');
      expect(loaded).toEqual(token);
    });

    it('throws on invalid JSON', () => {
      writeFileSync(resolve(testDir, 'oauth', 'google.json'), 'not valid json{{{');

      expect(() => loadOAuthToken('google')).toThrow(/Invalid JSON/);
    });

    it('throws when accessToken is missing', () => {
      writeFileSync(
        resolve(testDir, 'oauth', 'google.json'),
        JSON.stringify({ refreshToken: 'rt', expiresAt: 123, scopes: [] }),
      );

      expect(() => loadOAuthToken('google')).toThrow(/Missing or empty accessToken/);
    });

    it('throws when refreshToken is missing', () => {
      writeFileSync(
        resolve(testDir, 'oauth', 'google.json'),
        JSON.stringify({ accessToken: 'at', expiresAt: 123, scopes: [] }),
      );

      expect(() => loadOAuthToken('google')).toThrow(/Missing or empty refreshToken/);
    });

    it('throws when expiresAt is missing', () => {
      writeFileSync(
        resolve(testDir, 'oauth', 'google.json'),
        JSON.stringify({ accessToken: 'at', refreshToken: 'rt', scopes: [] }),
      );

      expect(() => loadOAuthToken('google')).toThrow(/Missing or invalid expiresAt/);
    });

    it('throws when scopes is missing', () => {
      writeFileSync(
        resolve(testDir, 'oauth', 'google.json'),
        JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: 123 }),
      );

      expect(() => loadOAuthToken('google')).toThrow(/Missing or invalid scopes/);
    });

    it('throws when scopes contains non-string values', () => {
      writeFileSync(
        resolve(testDir, 'oauth', 'google.json'),
        JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: 123, scopes: [42] }),
      );

      expect(() => loadOAuthToken('google')).toThrow(/Missing or invalid scopes/);
    });
  });

  describe('saveOAuthToken', () => {
    it('writes a token and reads it back', () => {
      const token = makeToken();
      saveOAuthToken('google', token);

      const loaded = loadOAuthToken('google');
      expect(loaded).toEqual(token);
    });

    it('creates the oauth directory if it does not exist', () => {
      // Remove the pre-created oauth dir
      rmSync(resolve(testDir, 'oauth'), { recursive: true, force: true });

      const token = makeToken();
      saveOAuthToken('google', token);

      const loaded = loadOAuthToken('google');
      expect(loaded).toEqual(token);
    });

    it('creates a missing IronCurtain home with owner-only permissions', () => {
      rmSync(testDir, { recursive: true });

      saveOAuthToken('google', makeToken());

      expect(statSync(testDir).mode & 0o777).toBe(0o700);
    });

    it('sets file permissions to 0o600', () => {
      saveOAuthToken('google', makeToken());

      const stat = statSync(resolve(testDir, 'oauth', 'google.json'));
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('overwrites an existing token file', () => {
      saveOAuthToken('google', makeToken({ accessToken: 'first' }));
      saveOAuthToken('google', makeToken({ accessToken: 'second' }));

      const loaded = loadOAuthToken('google');
      expect(loaded?.accessToken).toBe('second');
    });

    it('replaces a world-readable token file with an owner-only one under umask 002, leaving no temp or lock file', () => {
      const tokenPath = resolve(testDir, 'oauth', 'google.json');
      writeFileSync(tokenPath, JSON.stringify(makeToken({ accessToken: 'old' })), { mode: 0o644 });

      const previousUmask = process.umask(0o002);
      try {
        saveOAuthToken('google', makeToken({ accessToken: 'new' }));
      } finally {
        process.umask(previousUmask);
      }

      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      expect(loadOAuthToken('google')?.accessToken).toBe('new');
      expect(readdirSync(resolve(testDir, 'oauth'))).toEqual(['google.json']);
    });

    it('authorization always replaces the stored token, even one that expires later', () => {
      saveOAuthToken('google', makeToken({ accessToken: 'refreshed', expiresAt: Date.now() + 7_200_000 }));
      saveOAuthToken('google', makeToken({ accessToken: 'reauthorized', scopes: ['scope-a', 'scope-b'] }));

      expect(loadOAuthToken('google')).toMatchObject({ accessToken: 'reauthorized', scopes: ['scope-a', 'scope-b'] });
    });
  });

  describe('saveRefreshedOAuthToken', () => {
    const tokenPath = (): string => resolve(testDir, 'oauth', 'google.json');

    it('replaces the token it was refreshed from and returns the refreshed token', () => {
      saveOAuthToken(
        'google',
        makeToken({ accessToken: 'expired', refreshToken: 'rt-1', expiresAt: Date.now() - 1_000 }),
      );
      const refreshed = makeToken({ accessToken: 'refreshed', refreshToken: 'rt-1' });

      expect(saveRefreshedOAuthToken('google', refreshed, 'rt-1')).toEqual(refreshed);
      expect(loadOAuthToken('google')).toEqual(refreshed);
      expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
    });

    it('never clobbers a token another process stored with a later expiry', () => {
      const newer = makeToken({
        accessToken: 'stored-by-other',
        refreshToken: 'rt-1',
        expiresAt: Date.now() + 7_200_000,
      });
      saveOAuthToken('google', newer);
      const before = readFileSync(tokenPath(), 'utf8');

      const ours = makeToken({ accessToken: 'ours', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 });
      expect(saveRefreshedOAuthToken('google', ours, 'rt-1')).toEqual(newer);
      expect(readFileSync(tokenPath(), 'utf8')).toBe(before);
    });

    it('keeps a token stored by a re-authorization (new refresh token and scopes) while the refresh was in flight', () => {
      const reauthorized = makeToken({
        accessToken: 'reauthorized',
        refreshToken: 'rt-new-grant',
        expiresAt: Date.now() + 50 * 60_000,
        scopes: ['scope-a', 'scope-b'],
      });
      saveOAuthToken('google', reauthorized);

      const ours = makeToken({ accessToken: 'ours', refreshToken: 'rt-old', expiresAt: Date.now() + 3_600_000 });
      expect(saveRefreshedOAuthToken('google', ours, 'rt-old')).toEqual(reauthorized);
      expect(loadOAuthToken('google')).toEqual(reauthorized);
    });

    it('replaces a token with another refresh token once it is no longer usable', () => {
      saveOAuthToken(
        'google',
        makeToken({ accessToken: 'stale', refreshToken: 'rt-other', expiresAt: Date.now() + 60_000 }),
      );
      const ours = makeToken({ accessToken: 'ours', refreshToken: 'rt-old' });

      expect(saveRefreshedOAuthToken('google', ours, 'rt-old')).toEqual(ours);
      expect(loadOAuthToken('google')).toEqual(ours);
    });

    it('writes the refreshed token when the file is missing or unreadable', () => {
      const ours = makeToken({ accessToken: 'ours', refreshToken: 'rt-1' });
      expect(saveRefreshedOAuthToken('google', ours, 'rt-1')).toEqual(ours);

      writeFileSync(tokenPath(), '{ torn');
      expect(saveRefreshedOAuthToken('google', ours, 'rt-1')).toEqual(ours);
      expect(loadOAuthToken('google')).toEqual(ours);
      expect(readdirSync(resolve(testDir, 'oauth'))).toEqual(['google.json']);
    });
  });

  describe('deleteOAuthToken', () => {
    it('removes an existing token file', () => {
      saveOAuthToken('google', makeToken());
      expect(loadOAuthToken('google')).not.toBeNull();

      deleteOAuthToken('google');
      expect(loadOAuthToken('google')).toBeNull();
    });

    it('is a no-op when no token file exists', () => {
      // Should not throw
      deleteOAuthToken('nonexistent-provider');
    });
  });

  describe('isTokenExpired', () => {
    it('returns false for a token expiring well in the future', () => {
      const token = makeToken({ expiresAt: Date.now() + 3600 * 1000 });
      expect(isTokenExpired(token)).toBe(false);
    });

    it('returns true for a token that already expired', () => {
      const token = makeToken({ expiresAt: Date.now() - 1000 });
      expect(isTokenExpired(token)).toBe(true);
    });

    it('returns true when within the 5-minute buffer', () => {
      // 4 minutes from now -- less than the 5-minute buffer
      const token = makeToken({ expiresAt: Date.now() + 4 * 60 * 1000 });
      expect(isTokenExpired(token)).toBe(true);
    });

    it('returns false when just outside the 5-minute buffer', () => {
      // 6 minutes from now -- safely outside the buffer
      const token = makeToken({ expiresAt: Date.now() + 6 * 60 * 1000 });
      expect(isTokenExpired(token)).toBe(false);
    });
  });
});
