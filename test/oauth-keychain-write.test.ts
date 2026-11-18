/**
 * writeToKeychain keeps the token JSON out of every process's arguments
 * (where any local user can read it from the process list): the update is
 * an `add-generic-password -X <hex>` command written to `security -i` on
 * stdin, and the stored entry is read back to verify the write. It keeps no
 * newer token the host stored meanwhile (a documented residual risk).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const security = vi.hoisted(() => ({ stored: undefined as string | undefined, calls: [] as unknown[][] }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => 'darwin', userInfo: () => ({ ...actual.userInfo(), username: 'alice' }) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((file: string, args: readonly string[], options?: { input?: string }) => {
      security.calls.push([file, [...args], options?.input]);
      if (file !== 'security') throw new Error(`unexpected ${file}`);
      if (args[0] === 'find-generic-password') {
        if (security.stored === undefined) throw new Error('The specified item could not be found in the keychain.');
        return `${security.stored}\n`;
      }
      if (args[0] === '-i') {
        const match = /-X ([0-9a-f]+)\n$/.exec(options?.input ?? '');
        if (match) security.stored = Buffer.from(match[1], 'hex').toString('utf8');
        return '';
      }
      throw new Error(`unexpected security ${args.join(' ')}`);
    }),
  };
});

import { writeToKeychain } from '../src/docker/oauth-credentials.js';

const credentials = {
  accessToken: 'sk-ant-oat01-secret-access',
  refreshToken: 'sk-ant-ort01-secret-refresh',
  expiresAt: 42,
};

describe('writeToKeychain', () => {
  beforeEach(() => {
    security.calls.length = 0;
    security.stored = JSON.stringify({ claudeAiOauth: { accessToken: 'old', scopes: ['user:inference'] }, other: 1 });
  });

  it('writes through stdin, never with the token in argv, and keeps the other fields', () => {
    writeToKeychain(credentials, 'Claude Code-credentials');

    const argvs = security.calls.map((call) => (call[1] as string[]).join(' '));
    const tokenHex = Buffer.from(credentials.refreshToken).toString('hex');
    for (const argv of argvs) {
      expect(argv).not.toContain(credentials.accessToken);
      expect(argv).not.toContain(credentials.refreshToken);
      expect(argv).not.toContain(tokenHex);
    }
    const write = security.calls.find((call) => (call[1] as string[])[0] === '-i');
    expect(write?.[2]).toMatch(/^add-generic-password -U -s "Claude Code-credentials" -a "alice" -X [0-9a-f]+\n$/);

    expect(JSON.parse(security.stored ?? '{}')).toEqual({
      claudeAiOauth: {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: 42,
        scopes: ['user:inference'],
      },
      other: 1,
    });
  });

  it('fails when the entry read back is not what was written', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockImplementationOnce(() => `${security.stored ?? ''}\n`); // the initial read
    vi.mocked(execFileSync).mockImplementationOnce(() => ''); // `security -i` that applied nothing
    expect(() => writeToKeychain(credentials, 'Claude Code-credentials')).toThrow(/not applied/);
  });

  it('does not pass on the output of a failed security run, which could echo the token', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockImplementationOnce(() => `${security.stored ?? ''}\n`); // the initial read
    vi.mocked(execFileSync).mockImplementationOnce((_file, _args, options) => {
      throw Object.assign(new Error(`Command failed: security -i\n${String((options as { input?: string }).input)}`), {
        status: 1,
      });
    });
    let message = '';
    try {
      writeToKeychain(credentials, 'Claude Code-credentials');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe('security could not update Keychain item "Claude Code-credentials" (exit 1)');
  });

  it('has no keep-newer check: a newer token the host stored after the grant is overwritten', () => {
    // docs/SECURITY_CONCERNS.md §10 lists this as a residual risk; the
    // read-back only confirms the write. Change the residual if this changes.
    security.stored = JSON.stringify({
      claudeAiOauth: { accessToken: 'host-newer', refreshToken: 'host-rotated', expiresAt: 8_000_000_000_000 },
    });
    writeToKeychain(credentials, 'Claude Code-credentials');
    expect((JSON.parse(security.stored) as { claudeAiOauth?: unknown }).claudeAiOauth).toEqual({
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: 42,
    });
  });

  it('refuses a service name it cannot quote safely', () => {
    expect(() => writeToKeychain(credentials, 'bad"name')).toThrow(/safely/);
  });
});
