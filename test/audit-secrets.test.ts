/**
 * Tests for `collectAuditRedactionSecrets`: the exact credential values
 * IronCurtain holds that audit redaction replaces wherever they appear.
 *
 * Every test points HOME, the IronCurtain home and the Anthropic CLI and
 * Codex config locations at a fresh temporary directory, so the host
 * credential stores of whoever runs the suite are never read (and never
 * show up in a failure diff).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectAuditRedactionSecrets, resolveLogRedaction } from '../src/trusted-process/audit-secrets.js';

describe('collectAuditRedactionSecrets', () => {
  let tmpHome: string;
  let ironcurtainHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'audit-secrets-home-'));
    ironcurtainHome = join(tmpHome, '.ironcurtain');
    vi.stubEnv('HOME', tmpHome);
    vi.stubEnv('IRONCURTAIN_HOME', ironcurtainHome);
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', join(tmpHome, 'anthropic'));
    vi.stubEnv('XDG_CONFIG_HOME', join(tmpHome, 'xdg'));
    vi.stubEnv('CODEX_HOME', join(tmpHome, 'codex'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('collects configured server credentials, provider keys and web search keys', () => {
    const secrets = collectAuditRedactionSecrets(
      {
        serverCredentials: {
          github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'github-token-' + 'value-0123456789' },
          fetch: { BRAVE_API_KEY: 'brave-key-' + 'value-0123456789' },
        },
        anthropicApiKey: 'anthropic-key-' + 'value-0123456789',
        googleApiKey: '',
        openaiApiKey: 'openai-key-' + 'value-0123456789',
        modelProviders: {
          profiles: {
            native: { type: 'native' },
            router: { type: 'openrouter', apiKey: 'router-key-' + 'value-0123456789' },
          },
        },
        memory: { llmApiKey: 'memory-key-' + 'value-0123456789' },
        webSearch: { brave: null, tavily: { apiKey: 'tavily-key-' + 'value-0123456789' }, serpapi: null },
      },
      { includeHostCredentialStores: false },
    );

    expect(secrets).toEqual([
      'github-token-value-0123456789',
      'brave-key-value-0123456789',
      'anthropic-key-value-0123456789',
      'openai-key-value-0123456789',
      'router-key-value-0123456789',
      'memory-key-value-0123456789',
      'tavily-key-value-0123456789',
    ]);
  });

  it('accepts a configuration without any credential fields', () => {
    expect(collectAuditRedactionSecrets({}, { includeHostCredentialStores: false })).toEqual([]);
  });

  it('finds nothing in empty host credential stores', () => {
    expect(collectAuditRedactionSecrets({})).toEqual([]);
  });

  it('reads OAuth tokens and client secrets from the IronCurtain home', () => {
    mkdirSync(join(ironcurtainHome, 'oauth'), { recursive: true });
    writeFileSync(
      join(ironcurtainHome, 'oauth', 'google.json'),
      JSON.stringify({
        accessToken: 'google-access-' + 'token-0123456789',
        refreshToken: 'google-refresh-' + 'token-0123456789',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      }),
    );
    writeFileSync(
      join(ironcurtainHome, 'oauth', 'google-credentials.json'),
      JSON.stringify({
        installed: {
          client_id: 'client-id.apps.googleusercontent.com',
          client_secret: 'client-' + 'secret-0123456789',
        },
      }),
    );

    expect(collectAuditRedactionSecrets({})).toEqual([
      'google-access-token-0123456789',
      'google-refresh-token-0123456789',
      'client-secret-0123456789',
    ]);
  });

  it('reads both Claude credential stores and the Codex store, not only the store a session would use', () => {
    // Claude Code's store and the Anthropic CLI store can both hold live
    // tokens; the session uses whichever it prefers, so redaction must
    // know both. The Claude Code store is the preferred one here.
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'claude-code-access-' + 'token-0123456789',
          refreshToken: 'claude-code-refresh-' + 'token-0123456789',
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    mkdirSync(join(tmpHome, 'anthropic', 'credentials'), { recursive: true });
    writeFileSync(
      join(tmpHome, 'anthropic', 'credentials', 'default.json'),
      JSON.stringify({
        type: 'oauth_token',
        access_token: 'anthropic-cli-access-' + 'token-0123456789',
        refresh_token: 'anthropic-cli-refresh-' + 'token-0123456789',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    mkdirSync(join(tmpHome, 'codex'), { recursive: true });
    writeFileSync(
      join(tmpHome, 'codex', 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'codex-access-' + 'token-0123456789',
          refresh_token: 'codex-refresh-' + 'token-0123456789',
          id_token: 'codex-id-' + 'token-0123456789',
        },
      }),
    );

    expect(collectAuditRedactionSecrets({})).toEqual([
      'claude-code-access-token-0123456789',
      'claude-code-refresh-token-0123456789',
      'anthropic-cli-access-token-0123456789',
      'anthropic-cli-refresh-token-0123456789',
      'codex-access-token-0123456789',
      'codex-refresh-token-0123456789',
      'codex-id-token-0123456789',
    ]);
  });

  it('skips the host credential stores when asked to', () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'claude-code-access-' + 'token-0123456789',
          refreshToken: 'claude-code-refresh-' + 'token-0123456789',
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );

    expect(collectAuditRedactionSecrets({}, { includeHostCredentialStores: false })).toEqual([]);
  });

  it('ignores a malformed credential store and still returns the rest', () => {
    mkdirSync(join(ironcurtainHome, 'oauth'), { recursive: true });
    writeFileSync(join(ironcurtainHome, 'oauth', 'google.json'), '{not json');
    writeFileSync(join(ironcurtainHome, 'oauth', 'google-credentials.json'), JSON.stringify({ installed: {} }));

    const key = 'anthropic-key-' + 'value-0123456789';
    expect(collectAuditRedactionSecrets({ anthropicApiKey: key })).toEqual([key]);
  });

  describe('resolveLogRedaction', () => {
    it('returns the prepared credential values while audit redaction is on (the default)', () => {
      const long = 'anthropic-key-' + 'value-0123456789-long';
      const short = 'openai-key-' + 'value-01';
      const redaction = resolveLogRedaction({ anthropicApiKey: short, openaiApiKey: long, googleApiKey: 'tiny' });
      // Longest first; values below MIN_SECRET_LENGTH are dropped.
      expect(redaction).toEqual({ secrets: [long, short] });
      expect(resolveLogRedaction({ auditRedaction: { enabled: true }, anthropicApiKey: long })).toEqual({
        secrets: [long],
      });
    });

    it('includes the host credential stores', () => {
      mkdirSync(join(ironcurtainHome, 'oauth'), { recursive: true });
      writeFileSync(
        join(ironcurtainHome, 'oauth', 'google.json'),
        JSON.stringify({
          accessToken: 'google-access-' + 'token-0123456789',
          refreshToken: 'google-refresh-' + 'token-0123456789',
          expiresAt: Date.now() + 3_600_000,
          scopes: [],
        }),
      );
      expect(resolveLogRedaction({})?.secrets).toEqual(
        expect.arrayContaining(['google-access-token-0123456789', 'google-refresh-token-0123456789']),
      );
    });

    it('returns null when audit redaction is turned off', () => {
      expect(
        resolveLogRedaction({
          auditRedaction: { enabled: false },
          anthropicApiKey: 'anthropic-key-' + 'value-0123456789',
        }),
      ).toBeNull();
    });
  });
});
