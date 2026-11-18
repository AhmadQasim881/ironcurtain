import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadClientCredentials } from '../../src/auth/oauth-provider.js';
import { getOAuthProvider } from '../../src/auth/oauth-registry.js';
import { runAuthCommand } from '../../src/auth/auth-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captures stdout and stderr writes, suppresses process.exit. */
async function captureOutput(fn: () => Promise<void>, exitCalls: unknown[] = []): Promise<string> {
  const writes: string[] = [];
  const origWrite = process.stdout.write;
  const origErrWrite = process.stderr.write;
  process.stdout.write = (chunk: string) => {
    writes.push(chunk);
    return true;
  };
  // printHelp() uses console.error which writes to stderr
  process.stderr.write = (chunk: string) => {
    writes.push(chunk);
    return true;
  };
  const origConsoleError = console.error;
  console.error = ((...args: unknown[]) => {
    writes.push(args.map(String).join(' '));
  }) as typeof console.error;

  const origExit = process.exit;
  process.exit = ((code?: unknown) => {
    exitCalls.push(code);
  }) as typeof process.exit;

  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    console.error = origConsoleError;
    process.exit = origExit;
  }
  return writes.join('');
}

// ---------------------------------------------------------------------------
// Auth import subcommand (file copy + permissions)
// ---------------------------------------------------------------------------

describe('auth import credential import', () => {
  let tempDir: string;
  let sourceDir: string;
  const originalEnv = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `ironcurtain-test-setup-${process.pid}-${Date.now()}`);
    sourceDir = resolve(tmpdir(), `ironcurtain-test-source-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    process.env.IRONCURTAIN_HOME = tempDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('copies credentials file to oauth dir with correct permissions', async () => {
    const sourceFile = resolve(sourceDir, 'creds.json');
    const credContent = JSON.stringify({
      installed: {
        client_id: 'copy-test-id.apps.googleusercontent.com',
        client_secret: 'GOCSPX-copy-test',
      },
    });
    writeFileSync(sourceFile, credContent);

    const output = await captureOutput(() => runAuthCommand(['import', 'google', sourceFile]));

    const provider = getOAuthProvider('google');
    const destFile = resolve(tempDir, 'oauth', provider.credentialsFilename);
    expect(existsSync(destFile)).toBe(true);

    const copied = readFileSync(destFile, 'utf-8');
    expect(JSON.parse(copied)).toEqual(JSON.parse(credContent));

    const stats = statSync(destFile);
    expect(stats.mode & 0o777).toBe(0o600);

    expect(output).toContain('copy-test-id.apps.go');
    expect(output).toContain('Next step');
  });

  it('creates oauth directory if it does not exist', async () => {
    const sourceFile = resolve(sourceDir, 'creds.json');
    writeFileSync(sourceFile, JSON.stringify({ client_id: 'test', client_secret: 'test' }));

    await captureOutput(() => runAuthCommand(['import', 'google', sourceFile]));

    expect(existsSync(resolve(tempDir, 'oauth'))).toBe(true);
  });

  it('creates a missing IronCurtain home with owner-only permissions', async () => {
    const sourceFile = resolve(sourceDir, 'creds.json');
    writeFileSync(sourceFile, JSON.stringify({ client_id: 'test', client_secret: 'test' }));
    rmSync(tempDir, { recursive: true });

    await captureOutput(() => runAuthCommand(['import', 'google', sourceFile]));

    expect(statSync(tempDir).mode & 0o777).toBe(0o700);
  });

  it('shows Google setup guide when credentials file path is missing', async () => {
    const output = await captureOutput(() => runAuthCommand(['import', 'google']));

    expect(output).toContain('Google Cloud Project Setup');
    expect(output).toContain('console.cloud.google.com');
    expect(output).toContain('Desktop app');
  });

  // Regression: the file used to be copied over the stored credentials first
  // and validated afterwards, so a wrong file destroyed working credentials.
  it.each([
    ['not JSON', '{ this is not json'],
    ['without a client_id', JSON.stringify({ installed: { client_secret: 'GOCSPX-x' } })],
    ['without a client_secret', JSON.stringify({ client_id: 'id-only' })],
  ])('refuses a credentials file that is %s and keeps the existing credentials', async (_label, content) => {
    const provider = getOAuthProvider('google');
    const destFile = resolve(tempDir, 'oauth', provider.credentialsFilename);
    mkdirSync(resolve(tempDir, 'oauth'), { recursive: true });
    const working = JSON.stringify({ installed: { client_id: 'working-id', client_secret: 'working-secret' } });
    writeFileSync(destFile, working, { mode: 0o600 });
    const sourceFile = resolve(sourceDir, 'wrong.json');
    writeFileSync(sourceFile, content);

    const exitCalls: unknown[] = [];
    const output = await captureOutput(() => runAuthCommand(['import', 'google', sourceFile]), exitCalls);

    expect(readFileSync(destFile, 'utf-8')).toBe(working);
    expect(exitCalls).toEqual([1]);
    expect(output).toContain('Invalid credentials file');
    expect(output).toContain('Nothing was imported');
    expect(output).not.toContain('Credentials saved');
  });

  it('refuses a source that is not a regular file', async () => {
    const exitCalls: unknown[] = [];
    const output = await captureOutput(() => runAuthCommand(['import', 'google', sourceDir]), exitCalls);

    expect(exitCalls).toEqual([1]);
    expect(output).toContain('is not a regular file');
    expect(existsSync(resolve(tempDir, 'oauth', getOAuthProvider('google').credentialsFilename))).toBe(false);
  });

  it('replaces existing credentials atomically with an owner-only file', async () => {
    const provider = getOAuthProvider('google');
    const oauthDir = resolve(tempDir, 'oauth');
    mkdirSync(oauthDir, { recursive: true });
    writeFileSync(resolve(oauthDir, provider.credentialsFilename), '{"client_id":"old","client_secret":"old"}', {
      mode: 0o644,
    });
    const sourceFile = resolve(sourceDir, 'creds.json');
    writeFileSync(sourceFile, JSON.stringify({ client_id: 'new-id', client_secret: 'new-secret' }), { mode: 0o644 });

    await captureOutput(() => runAuthCommand(['import', 'google', sourceFile]));

    const destFile = resolve(oauthDir, provider.credentialsFilename);
    expect(loadClientCredentials(provider)).toEqual({ clientId: 'new-id', clientSecret: 'new-secret' });
    expect(statSync(destFile).mode & 0o777).toBe(0o600);
    // No temporary file is left behind next to it.
    expect(readdirSync(oauthDir)).toEqual([provider.credentialsFilename]);
  });
});

// ---------------------------------------------------------------------------
// Auth command help, status, and revoke
// ---------------------------------------------------------------------------

describe('auth-command', () => {
  let tempDir: string;
  const originalEnv = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `ironcurtain-test-auth-${process.pid}-${Date.now()}`);
    mkdirSync(resolve(tempDir, 'oauth'), { recursive: true });
    process.env.IRONCURTAIN_HOME = tempDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // --help flag
  // -----------------------------------------------------------------------

  it('shows help with --help flag', async () => {
    const output = await captureOutput(() => runAuthCommand(['--help']));

    expect(output).toContain('ironcurtain auth');
    expect(output).toContain('Manage third-party OAuth providers');
    expect(output).toContain('import');
    expect(output).toContain('revoke');
    expect(output).toContain('--scopes');
  });

  it('shows help with -h flag', async () => {
    const output = await captureOutput(() => runAuthCommand(['-h']));

    expect(output).toContain('ironcurtain auth');
    expect(output).toContain('Subcommands');
  });

  it('runs subcommand normally when --help is not the first arg', async () => {
    // --help after a subcommand should not intercept; the subcommand runs normally
    const output = await captureOutput(() => runAuthCommand(['status', '--help']));

    expect(output).toContain('OAuth Provider Status');
  });

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  it('shows status with no args', async () => {
    const output = await captureOutput(() => runAuthCommand([]));

    expect(output).toContain('Google Workspace');
    expect(output).toContain('not configured');
    expect(output).toContain('not authorized');
  });

  it('shows configured status when credentials exist', async () => {
    const provider = getOAuthProvider('google');
    writeFileSync(
      resolve(tempDir, 'oauth', provider.credentialsFilename),
      JSON.stringify({ installed: { client_id: 'test', client_secret: 'test' } }),
    );

    const output = await captureOutput(() => runAuthCommand(['status']));

    expect(output).toContain('configured');
  });

  // -----------------------------------------------------------------------
  // Revoke
  // -----------------------------------------------------------------------

  /** Writes a stored Google token and returns its path. */
  function writeStoredToken(): string {
    const tokenPath = resolve(tempDir, 'oauth', 'google.json');
    writeFileSync(
      tokenPath,
      JSON.stringify({
        accessToken: 'fake-access',
        refreshToken: 'fake-refresh',
        expiresAt: Date.now() + 3600000,
        scopes: ['test'],
      }),
    );
    return tokenPath;
  }

  /** Runs `auth revoke google` against a stubbed revocation endpoint. */
  async function revokeWith(fetchImpl: () => Promise<Response>): Promise<{ output: string; exitCode: unknown }> {
    const origFetch = globalThis.fetch;
    const savedExitCode = process.exitCode;
    globalThis.fetch = vi.fn(fetchImpl);
    try {
      const output = await captureOutput(() => runAuthCommand(['revoke', 'google']));
      return { output, exitCode: process.exitCode };
    } finally {
      globalThis.fetch = origFetch;
      process.exitCode = savedExitCode;
    }
  }

  it('revokes a stored token and deletes the file once the provider confirms it', async () => {
    const tokenPath = writeStoredToken();

    const { output, exitCode } = await revokeWith(() => Promise.resolve(new Response('', { status: 200 })));

    expect(existsSync(tokenPath)).toBe(false);
    expect(output).toContain('Token revoked');
    expect(exitCode).not.toBe(1);
  });

  it('handles revoke when no token exists', async () => {
    const output = await captureOutput(() => runAuthCommand(['revoke', 'google']));

    expect(output).toContain('No stored token found');
  });

  // Regression: a failed revocation used to delete the only local copy of a
  // token that was still valid at Google, and report "Token revoked".
  it.each([
    ['a network error', () => Promise.reject(new Error('network error'))],
    ['a server error', () => Promise.resolve(new Response('backend unavailable', { status: 503 }))],
    ['another client error', () => Promise.resolve(new Response('{"error":"invalid_request"}', { status: 400 }))],
  ])('keeps the local token when revocation fails with %s', async (_label, fetchImpl) => {
    const tokenPath = writeStoredToken();

    const { output, exitCode } = await revokeWith(fetchImpl);

    expect(existsSync(tokenPath)).toBe(true);
    expect(output).toContain('Warning');
    expect(output).toContain('NOT revoked');
    expect(output).toContain('https://myaccount.google.com/permissions');
    expect(output).not.toContain('Token revoked');
    expect(exitCode).toBe(1);
  });

  it('deletes the local token when the provider reports it is already invalid (400 invalid_token)', async () => {
    const tokenPath = writeStoredToken();

    const { output, exitCode } = await revokeWith(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_token', error_description: 'Token expired or revoked' }), {
          status: 400,
        }),
      ),
    );

    expect(existsSync(tokenPath)).toBe(false);
    expect(output).toContain('no longer valid');
    expect(exitCode).not.toBe(1);
  });

  // -----------------------------------------------------------------------
  // Credentials loaded after import
  // -----------------------------------------------------------------------

  it('shows credentials loaded after setup', () => {
    const provider = getOAuthProvider('google');
    writeFileSync(
      resolve(tempDir, 'oauth', provider.credentialsFilename),
      JSON.stringify({ installed: { client_id: 'loaded-id', client_secret: 'loaded-secret' } }),
    );

    const result = loadClientCredentials(provider);
    expect(result).not.toBeNull();
    expect(result!.clientId).toBe('loaded-id');
  });
});
