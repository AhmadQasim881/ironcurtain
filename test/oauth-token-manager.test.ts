import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthTokenManager, type TokenManagerDeps } from '../src/docker/oauth-token-manager.js';
import {
  loadCredentialsFromFile,
  saveOAuthCredentials,
  type OAuthCredentials,
} from '../src/docker/oauth-credentials.js';

function validCreds(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
  return {
    accessToken: 'access-token-original',
    refreshToken: 'refresh-token-original',
    expiresAt: Date.now() + 3_600_000, // 1 hour
    ...overrides,
  };
}

function nearExpiryCreds(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
  return {
    accessToken: 'access-token-expiring',
    refreshToken: 'refresh-token-expiring',
    expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes (within 5-min buffer)
    ...overrides,
  };
}

function refreshedCreds(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
  return {
    accessToken: 'access-token-refreshed',
    refreshToken: 'refresh-token-refreshed',
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<TokenManagerDeps>): TokenManagerDeps {
  return {
    loadCredentials: vi.fn(() => null),
    loadFromKeychain: vi.fn(() => null),
    refreshToken: vi.fn(async () => null),
    saveCredentials: vi.fn(),
    credentialsFilePath: '/fake/.credentials.json',
    now: () => Date.now(),
    ...overrides,
  };
}

describe('OAuthTokenManager', () => {
  describe('getValidAccessToken', () => {
    it('returns current token when not near expiry', async () => {
      const creds = validCreds();
      const deps = makeDeps();
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-token-original');
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('proactively refreshes when token is near expiry', async () => {
      const creds = nearExpiryCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-token-refreshed');
      expect(deps.refreshToken).toHaveBeenCalledWith('refresh-token-expiring', undefined);
      expect(deps.saveCredentials).toHaveBeenCalledWith(newCreds, '/fake/.credentials.json', {
        refreshedFrom: 'refresh-token-expiring',
      });
    });

    it('refreshes with the client kind of the credentials being refreshed', async () => {
      const creds = nearExpiryCreds({ clientKind: 'anthropic-cli' });
      const deps = makeDeps({
        refreshToken: vi.fn(async () => refreshedCreds({ clientKind: 'anthropic-cli' })),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      await manager.getValidAccessToken();
      expect(deps.refreshToken).toHaveBeenCalledWith('refresh-token-expiring', 'anthropic-cli');
    });

    it('takes the client kind from re-read file credentials over the initial ones', async () => {
      const creds = nearExpiryCreds(); // untagged (claude-code)
      const fileCreds = nearExpiryCreds({ refreshToken: 'refresh-from-file', clientKind: 'anthropic-cli' });
      const deps = makeDeps({
        loadCredentials: vi.fn(() => fileCreds),
        refreshToken: vi.fn(async () => refreshedCreds({ clientKind: 'anthropic-cli' })),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      await manager.getValidAccessToken();
      expect(deps.refreshToken).toHaveBeenCalledWith('refresh-from-file', 'anthropic-cli');
    });

    it('re-reads credentials file before refreshing', async () => {
      const creds = nearExpiryCreds();
      const fileCreds = validCreds({ accessToken: 'access-from-file' });
      const deps = makeDeps({
        loadCredentials: vi.fn(() => fileCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-from-file');
      // Should NOT call refreshToken since file had valid creds
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('returns current token if refresh fails but token not yet expired', async () => {
      const creds = nearExpiryCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => null),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.getValidAccessToken();
      // Falls back to existing token
      expect(token).toBe('access-token-expiring');
    });
  });

  describe('handleAuthFailure', () => {
    it('refreshes and returns new token on success', async () => {
      const creds = validCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBe('access-token-refreshed');
      expect(deps.saveCredentials).toHaveBeenCalled();
    });

    it('returns null when refresh is unrecoverable', async () => {
      const creds = validCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => null),
        refreshToken: vi.fn(async () => null),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBeNull();
    });

    it('uses file credentials on fallback re-read after refresh failure', async () => {
      const creds = validCreds();
      let readCount = 0;
      const deps = makeDeps({
        loadCredentials: vi.fn(() => {
          readCount++;
          // First read: return expired creds (or null)
          if (readCount === 1) return null;
          // Second read (fallback): return fresh creds from host CC
          return validCreds({ accessToken: 'access-from-host-cc' });
        }),
        refreshToken: vi.fn(async () => null),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBe('access-from-host-cc');
      expect(deps.loadCredentials).toHaveBeenCalledTimes(2);
    });

    it('uses refresh token from file when available', async () => {
      const creds = nearExpiryCreds();
      const fileCreds = nearExpiryCreds({
        refreshToken: 'refresh-from-file',
      });
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => fileCreds),
        refreshToken: vi.fn(async () => newCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      // File creds are also expired, so it should use the file's refresh token
      await manager.handleAuthFailure();
      expect(deps.refreshToken).toHaveBeenCalledWith('refresh-from-file', undefined);
    });
  });

  describe('concurrency', () => {
    it('deduplicates concurrent refresh calls', async () => {
      const creds = validCreds();
      const newCreds = refreshedCreds();
      const refreshFn = vi.fn(
        () => new Promise<OAuthCredentials>((resolve) => setTimeout(() => resolve(newCreds), 50)),
      );
      const deps = makeDeps({ refreshToken: refreshFn });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      // Launch two concurrent handleAuthFailure calls
      const [token1, token2] = await Promise.all([manager.handleAuthFailure(), manager.handleAuthFailure()]);

      expect(token1).toBe('access-token-refreshed');
      expect(token2).toBe('access-token-refreshed');
      // refreshToken should only be called once (deduplication)
      expect(refreshFn).toHaveBeenCalledTimes(1);
    });

    it('allows new refresh after previous completes', async () => {
      const creds = validCreds();
      const refreshFn = vi.fn(async () => refreshedCreds());
      const deps = makeDeps({ refreshToken: refreshFn });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      await manager.handleAuthFailure();
      await manager.handleAuthFailure();
      // Two separate calls should each trigger a refresh
      expect(refreshFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('accessToken getter', () => {
    it('returns initial token', () => {
      const creds = validCreds();
      const deps = makeDeps();
      const manager = new OAuthTokenManager(creds, undefined, deps);
      expect(manager.accessToken).toBe('access-token-original');
    });

    it('returns updated token after refresh', async () => {
      const creds = validCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      await manager.handleAuthFailure();
      expect(manager.accessToken).toBe('access-token-refreshed');
    });
  });

  describe('error handling', () => {
    it('continues even if saveCredentials throws', async () => {
      const creds = validCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
        saveCredentials: vi.fn(() => {
          throw new Error('disk full');
        }),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.handleAuthFailure();
      // Should still return the new token despite save failure
      expect(token).toBe('access-token-refreshed');
      expect(manager.accessToken).toBe('access-token-refreshed');
    });
  });

  describe('canRefresh: false (refresh disabled)', () => {
    it('re-reads file and uses valid credentials without refresh', async () => {
      const creds = nearExpiryCreds();
      const fileCreds = validCreds({ accessToken: 'access-from-file' });
      const deps = makeDeps({
        loadCredentials: vi.fn(() => fileCreds),
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: false }, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-from-file');
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('returns null when file has no valid creds and refresh is disabled', async () => {
      const creds = nearExpiryCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => null),
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: false }, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBeNull();
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });
  });

  describe('Keychain-sourced creds (canRefresh: true with keychainServiceName)', () => {
    it('re-reads Keychain and uses valid credentials without refresh', async () => {
      const creds = nearExpiryCreds();
      const keychainCreds = validCreds({ accessToken: 'access-from-keychain' });
      const deps = makeDeps({
        loadCredentials: vi.fn(() => null),
        loadFromKeychain: vi.fn(() => keychainCreds),
        keychainServiceName: 'Claude Code-credentials',
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-from-keychain');
      expect(deps.loadFromKeychain).toHaveBeenCalled();
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('does not save credentials when Keychain fast path succeeds', async () => {
      const creds = nearExpiryCreds();
      const keychainCreds = validCreds({ accessToken: 'access-from-keychain' });
      const deps = makeDeps({
        loadFromKeychain: vi.fn(() => keychainCreds),
        keychainServiceName: 'Claude Code-credentials',
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      await manager.getValidAccessToken();
      expect(deps.saveCredentials).not.toHaveBeenCalled();
    });

    it('self-refreshes when both file and Keychain are expired', async () => {
      const creds = nearExpiryCreds();
      const newCreds = refreshedCreds();
      const writeToKeychain = vi.fn();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => nearExpiryCreds()),
        loadFromKeychain: vi.fn(() => nearExpiryCreds()),
        refreshToken: vi.fn(async () => newCreds),
        keychainServiceName: 'Claude Code-credentials',
        writeToKeychain,
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBe('access-token-refreshed');
      expect(deps.refreshToken).toHaveBeenCalled();
      expect(writeToKeychain).toHaveBeenCalledWith(newCreds, 'Claude Code-credentials');
    });

    it('returns null when self-refresh also fails', async () => {
      const creds = validCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => null),
        loadFromKeychain: vi.fn(() => null),
        refreshToken: vi.fn(async () => null),
        keychainServiceName: 'Claude Code-credentials',
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBeNull();
      expect(deps.refreshToken).toHaveBeenCalled();
    });

    it('uses Keychain refresh token when file has none', async () => {
      const creds = nearExpiryCreds();
      const keychainExpired = nearExpiryCreds({ refreshToken: 'refresh-from-keychain' });
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => null),
        loadFromKeychain: vi.fn(() => keychainExpired),
        refreshToken: vi.fn(async () => newCreds),
        keychainServiceName: 'Claude Code-credentials',
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      await manager.handleAuthFailure();
      expect(deps.refreshToken).toHaveBeenCalledWith('refresh-from-keychain', undefined);
    });

    it('prefers file refresh token over Keychain refresh token', async () => {
      const creds = nearExpiryCreds();
      const fileExpired = nearExpiryCreds({ refreshToken: 'refresh-from-file' });
      const keychainExpired = nearExpiryCreds({ refreshToken: 'refresh-from-keychain' });
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => fileExpired),
        loadFromKeychain: vi.fn(() => keychainExpired),
        refreshToken: vi.fn(async () => newCreds),
        keychainServiceName: 'Claude Code-credentials',
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      await manager.handleAuthFailure();
      expect(deps.refreshToken).toHaveBeenCalledWith('refresh-from-file', undefined);
    });

    it('does not consult Keychain when keychainServiceName is not set', async () => {
      const creds = nearExpiryCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => null),
        loadFromKeychain: vi.fn(() => validCreds({ accessToken: 'should-not-use' })),
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      await manager.handleAuthFailure();
      expect(deps.loadFromKeychain).not.toHaveBeenCalled();
    });
  });

  describe('Keychain write-back (canRefresh: true with keychainServiceName)', () => {
    it('saves to Keychain instead of file on successful refresh', async () => {
      const creds = nearExpiryCreds();
      const newCreds = refreshedCreds();
      const writeKcFn = vi.fn();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
        writeToKeychain: writeKcFn,
        keychainServiceName: 'Claude Code-credentials',
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-token-refreshed');
      expect(writeKcFn).toHaveBeenCalledWith(newCreds, 'Claude Code-credentials');
      expect(deps.saveCredentials).not.toHaveBeenCalled();
    });

    it('saves to file when keychainServiceName is not set', async () => {
      const creds = nearExpiryCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-token-refreshed');
      expect(deps.saveCredentials).toHaveBeenCalledWith(newCreds, '/fake/.credentials.json', {
        refreshedFrom: 'refresh-token-expiring',
      });
    });

    it('continues when Keychain write throws', async () => {
      const creds = nearExpiryCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
        writeToKeychain: vi.fn(() => {
          throw new Error('Keychain locked');
        }),
        keychainServiceName: 'Claude Code',
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: true }, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-token-refreshed');
      expect(manager.accessToken).toBe('access-token-refreshed');
    });
  });
});

describe('OAuthTokenManager refresh write-back to the real credentials file', () => {
  let dir: string;
  let credPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oauth-token-manager-file-'));
    credPath = join(dir, '.credentials.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCredentialsFile(oauth: OAuthCredentials): void {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: oauth, mcpOAuth: { keep: true } }), { mode: 0o600 });
  }

  function fileDeps(refreshToken: TokenManagerDeps['refreshToken']): Partial<TokenManagerDeps> {
    return {
      loadCredentials: loadCredentialsFromFile,
      loadFromKeychain: () => null,
      saveCredentials: saveOAuthCredentials,
      credentialsFilePath: credPath,
      refreshToken,
    };
  }

  it('keeps and adopts a token the host stored while our refresh grant was in flight', async () => {
    const expired = { accessToken: 'expired-at', refreshToken: 'rt-0', expiresAt: Date.now() - 1_000 };
    writeCredentialsFile(expired);
    const host = { accessToken: 'host-at', refreshToken: 'host-rt-1', expiresAt: Date.now() + 8 * 3_600_000 };
    const manager = new OAuthTokenManager(
      expired,
      undefined,
      fileDeps(async () => {
        // The host CLI refreshes and rewrites the file before our grant returns.
        writeCredentialsFile(host);
        return { accessToken: 'ours-at', refreshToken: 'ours-rt', expiresAt: Date.now() + 3_600_000 };
      }),
    );

    expect(await manager.getValidAccessToken()).toBe('host-at');
    expect(JSON.parse(readFileSync(credPath, 'utf-8'))).toEqual({ claudeAiOauth: host, mcpOAuth: { keep: true } });
    expect(manager.accessToken).toBe('host-at');
  });

  it('writes its refreshed token when the file still holds the token it refreshed from', async () => {
    const expired = { accessToken: 'expired-at', refreshToken: 'rt-0', expiresAt: Date.now() - 1_000 };
    writeCredentialsFile(expired);
    const ours = { accessToken: 'ours-at', refreshToken: 'ours-rt', expiresAt: Date.now() + 3_600_000 };
    const refresh = vi.fn(async () => ours);
    const manager = new OAuthTokenManager(expired, undefined, fileDeps(refresh));

    expect(await manager.getValidAccessToken()).toBe('ours-at');
    expect(refresh).toHaveBeenCalledWith('rt-0', undefined);
    expect(JSON.parse(readFileSync(credPath, 'utf-8'))).toEqual({ claudeAiOauth: ours, mcpOAuth: { keep: true } });
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
  });
});
