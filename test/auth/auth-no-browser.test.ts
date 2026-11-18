/**
 * `ironcurtain auth <provider> --no-browser`: on a headless host the
 * authorization URL is printed instead of opened, and the URL the browser was
 * redirected to is pasted back. The token exchange is stubbed (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const prompts = vi.hoisted(() => ({ text: vi.fn(), openBrowser: vi.fn() }));
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, text: (...args: unknown[]) => prompts.text(...args) };
});
// A browser must never be launched in headless mode.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => prompts.openBrowser(...args) };
});

import { runAuthCommand } from '../../src/auth/auth-command.js';

describe('auth <provider> --no-browser', () => {
  let home: string;
  let savedHome: string | undefined;
  let stdout: string[];
  let savedFetch: typeof globalThis.fetch;
  let savedIsTTY: boolean | undefined;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-auth-headless-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    mkdirSync(resolve(home, 'oauth'), { recursive: true, mode: 0o700 });
    writeFileSync(
      resolve(home, 'oauth', 'google-credentials.json'),
      JSON.stringify({ installed: { client_id: 'headless-client', client_secret: 'headless-secret' } }),
      { mode: 0o600 },
    );
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    savedIsTTY = process.stdin.isTTY;
    // Non-interactive: no scope picker, default scopes.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true });
    vi.restoreAllMocks();
    prompts.text.mockReset();
    prompts.openBrowser.mockReset();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('prints the authorization URL, accepts the pasted redirect and stores the token', async () => {
    const exchanged: URLSearchParams[] = [];
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      exchanged.push(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'headless-access',
            refresh_token: 'headless-refresh',
            expires_in: 3600,
            scope: 'scope-a',
          }),
          { status: 200 },
        ),
      );
    });
    // The user copies the address bar after consent: the printed URL's
    // redirect_uri with a code and the same state.
    prompts.text.mockImplementation(() => {
      const printed = stdout.join('').match(/https:\/\/accounts\.google\.com\/\S+/u)?.[0] ?? '';
      const auth = new URL(printed);
      const redirect = new URL(auth.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', 'pasted-code');
      redirect.searchParams.set('state', auth.searchParams.get('state') ?? '');
      return Promise.resolve(redirect.toString());
    });

    await runAuthCommand(['google', '--no-browser']);

    expect(prompts.openBrowser).not.toHaveBeenCalled();
    expect(prompts.text).toHaveBeenCalledTimes(1);
    expect(stdout.join('')).toContain('Open this URL in a browser on any machine');
    expect(exchanged[0]?.get('code')).toBe('pasted-code');
    expect(exchanged[0]?.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
    const stored = JSON.parse(readFileSync(resolve(home, 'oauth', 'google.json'), 'utf-8')) as {
      accessToken: string;
    };
    expect(stored.accessToken).toBe('headless-access');
  });
});
