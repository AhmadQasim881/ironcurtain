/**
 * Unit tests for the trusted credential loader (src/config/trusted-env.ts) and
 * the IRONCURTAIN_HOME resolution it depends on (src/config/paths.ts).
 *
 * The CLI-level regression (a hostile `<cwd>/.env` against the real entry
 * point) lives in test/cli-env-isolation.test.ts.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lchownSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getIronCurtainHome, resolveIronCurtainHome } from '../src/config/paths.js';
import {
  ENV_FILE_ENV_VAR,
  formatTrustedEnvReport,
  getCredentialEnvKeys,
  getExplicitEnvFilePath,
  getTrustedEnvFilePath,
  getTrustedEnvFilePaths,
  isForbiddenEnvKey,
  loadTrustedEnv,
  splitEnvFileOption,
  type TrustedEnvError,
} from '../src/config/trusted-env.js';

const CURRENT_UID = process.getuid?.();
const IS_ROOT = CURRENT_UID === 0;
const KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_PERSONAL_ACCESS_TOKEN']);

/** Captures the error a function throws (the loader throws synchronously). */
function thrown(fn: () => unknown): TrustedEnvError {
  try {
    fn();
  } catch (error) {
    return error as TrustedEnvError;
  }
  throw new Error('expected the call to throw');
}

let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-trusted-env-')));
  home = join(root, 'home');
  cwd = join(root, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function writeEnv(path: string, content: string, mode = 0o600): void {
  writeFileSync(path, content);
  chmodSync(path, mode);
}

function load(env: NodeJS.ProcessEnv, extra: { expectedUid?: number } = {}) {
  return loadTrustedEnv({ env, cwd, allowedKeys: KEYS, ...extra });
}

describe('resolveIronCurtainHome / getIronCurtainHome', () => {
  it('treats an unset or empty value as the default ~/.ironcurtain', () => {
    const fallback = resolve(homedir(), '.ironcurtain');
    expect(resolveIronCurtainHome(undefined)).toBe(fallback);
    expect(resolveIronCurtainHome('')).toBe(fallback);
  });

  it('accepts and normalizes an absolute path', () => {
    expect(resolveIronCurtainHome('/srv/ic/../ic-home/')).toBe('/srv/ic-home');
  });

  it.each(['rel/home', '.', './ic', '~/ic', '~'])('rejects the relative value %j', (value) => {
    expect(() => resolveIronCurtainHome(value)).toThrow(/IRONCURTAIN_HOME must be an absolute path/);
  });

  it('getIronCurtainHome applies the same rules to the process environment', () => {
    vi.stubEnv('IRONCURTAIN_HOME', '');
    expect(getIronCurtainHome()).toBe(resolve(homedir(), '.ironcurtain'));
    vi.stubEnv('IRONCURTAIN_HOME', 'relative/home');
    expect(() => getIronCurtainHome()).toThrow(/absolute path/);
    vi.stubEnv('IRONCURTAIN_HOME', home);
    expect(getIronCurtainHome()).toBe(home);
  });
});

describe('isForbiddenEnvKey', () => {
  it.each([
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'IRONCURTAIN_HOME',
    'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS',
    'IRONCURTAIN_ENV_FILE',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'GIT_SSH_COMMAND',
    'GIT_CONFIG_COUNT',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'ANTHROPIC_BASE_URL',
    'OPENAI_BASE_URL',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'DOTENV_CONFIG_QUIET',
    'BASH_ENV',
    'ENV',
    'PATH',
    'HOME',
    'ALLOWED_DIRECTORY',
    'AUDIT_LOG_PATH',
    'SANDBOX_POLICY',
    // Outranks SANDBOX_POLICY and config.json; a .env must not downgrade "enforce".
    'IRONCURTAIN_SANDBOX_POLICY',
    'CODEX_HOME',
    'ANTHROPIC_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'SSL_CERT_FILE',
    'npm_config_userconfig',
    'MCP_SERVERS_CONFIG',
  ])('forbids %s', (key) => {
    expect(isForbiddenEnvKey(key)).toBe(true);
  });

  it.each(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ZAI_API_KEY'])(
    'allows the credential name %s',
    (key) => {
      expect(isForbiddenEnvKey(key)).toBe(false);
    },
  );
});

describe('getCredentialEnvKeys', () => {
  it('derives provider, gateway and bundled MCP pass-through keys', () => {
    const keys = getCredentialEnvKeys();
    for (const key of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'OPENROUTER_API_KEY',
      'ZAI_API_KEY',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
    ]) {
      expect(keys.has(key)).toBe(true);
    }
    for (const key of keys) expect(isForbiddenEnvKey(key)).toBe(false);
  });

  it('takes only bare -e names from mcp-servers.json and drops forbidden ones', () => {
    const mcpPath = join(root, 'mcp-servers.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({
        a: { command: 'docker', args: ['run', '-e', 'MY_SERVICE_TOKEN', '-e', 'LITERAL=value', 'img'] },
        b: { command: 'docker', args: ['-e', 'NODE_OPTIONS', '-e', 'ANTHROPIC_BASE_URL', '-e', 'bad name'] },
        c: { command: 'x', args: 'not-an-array' },
      }),
    );
    const keys = getCredentialEnvKeys(mcpPath);
    expect(keys.has('MY_SERVICE_TOKEN')).toBe(true);
    for (const key of ['LITERAL', 'LITERAL=value', 'NODE_OPTIONS', 'ANTHROPIC_BASE_URL', 'bad name']) {
      expect(keys.has(key)).toBe(false);
    }
  });

  it("adds the -e names of the user's own mcp-servers.json, minus forbidden ones", () => {
    const bundled = join(root, 'bundled.json');
    writeFileSync(bundled, JSON.stringify({ gh: { command: 'docker', args: ['run', '-e', 'BUNDLED_TOKEN', 'img'] } }));
    const user = join(home, 'mcp-servers.json');
    writeFileSync(
      user,
      JSON.stringify({
        notion: { command: 'docker', args: ['run', '-e', 'NOTION_TOKEN', '-e', 'LD_PRELOAD', 'img'] },
        _comment: 'ignored',
      }),
    );
    const keys = getCredentialEnvKeys(bundled, user);
    expect(keys.has('BUNDLED_TOKEN')).toBe(true);
    expect(keys.has('NOTION_TOKEN')).toBe(true);
    expect(keys.has('LD_PRELOAD')).toBe(false);
    // A broken user file only means fewer loadable keys (loadConfig reports it).
    writeFileSync(user, '{not json');
    expect(getCredentialEnvKeys(bundled, user).has('BUNDLED_TOKEN')).toBe(true);
  });

  it('loads a credential that a server in the user file forwards, from the home .env', () => {
    writeFileSync(
      join(home, 'mcp-servers.json'),
      JSON.stringify({ notion: { command: 'docker', args: ['run', '-e', 'NOTION_TOKEN', 'img'] } }),
    );
    writeEnv(join(home, '.env'), 'NOTION_TOKEN=secret-notion\nNOT_DECLARED=x\n');
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home };
    const result = loadTrustedEnv({ env, cwd });
    expect(env.NOTION_TOKEN).toBe('secret-notion');
    expect(env.NOT_DECLARED).toBeUndefined();
    expect(result.appliedKeys).toContain('NOTION_TOKEN');
  });

  it('falls back to the provider keys when mcp-servers.json is missing or malformed', () => {
    const broken = join(root, 'broken.json');
    writeFileSync(broken, '{not json');
    for (const path of [broken, join(root, 'missing.json')]) {
      const keys = getCredentialEnvKeys(path);
      expect(keys.has('ANTHROPIC_API_KEY')).toBe(true);
      expect(keys.has('GITHUB_PERSONAL_ACCESS_TOKEN')).toBe(false);
    }
  });
});

describe('splitEnvFileOption', () => {
  it('takes a leading --env-file <path> and resolves it against cwd', () => {
    expect(splitEnvFileOption(['--env-file', 'keys.env', 'start', 'task'], '/work')).toEqual({
      envFile: '/work/keys.env',
      rest: ['start', 'task'],
    });
  });

  it('accepts the --env-file=<path> form and absolute paths', () => {
    expect(splitEnvFileOption(['--env-file=/etc/ic.env', 'mux'], '/work')).toEqual({
      envFile: '/etc/ic.env',
      rest: ['mux'],
    });
  });

  it('leaves arguments after the subcommand alone', () => {
    const args = ['start', '--env-file', 'x', 'explain --env-file'];
    expect(splitEnvFileOption(args, '/work')).toEqual({ envFile: undefined, rest: args });
  });

  it.each([
    [['--env-file']],
    [['--env-file', '']],
    [['--env-file=']],
    [['--env-file', 'a', '--env-file', 'b', 'start']],
  ])('rejects %j', (args) => {
    expect(thrown(() => splitEnvFileOption(args, '/work')).code).toBe('USAGE');
  });
});

describe('getTrustedEnvFilePath / getExplicitEnvFilePath', () => {
  it('derives the home .env from IRONCURTAIN_HOME and adds an explicit file', () => {
    expect(getTrustedEnvFilePath({ IRONCURTAIN_HOME: home })).toBe(join(home, '.env'));
    expect(getTrustedEnvFilePath({ IRONCURTAIN_HOME: '' })).toBe(resolve(homedir(), '.ironcurtain', '.env'));
    const explicit = join(root, 'keys.env');
    expect(getTrustedEnvFilePaths({ IRONCURTAIN_HOME: home, [ENV_FILE_ENV_VAR]: explicit })).toEqual([
      join(home, '.env'),
      explicit,
    ]);
    expect(getTrustedEnvFilePaths({ IRONCURTAIN_HOME: home, [ENV_FILE_ENV_VAR]: '' })).toEqual([join(home, '.env')]);
  });

  it('rejects a relative IRONCURTAIN_ENV_FILE', () => {
    expect(thrown(() => getExplicitEnvFilePath({ [ENV_FILE_ENV_VAR]: 'keys.env' })).code).toBe('INVALID_PATH');
  });
});

describe('loadTrustedEnv', () => {
  it('copies only allowlisted credential keys from the home .env and reports the rest by name', () => {
    writeEnv(
      join(home, '.env'),
      [
        '# comment',
        'export ANTHROPIC_API_KEY="sk-ant-home"',
        'NODE_OPTIONS=--require ./pwn.cjs',
        'IRONCURTAIN_HOME=/tmp/attacker',
        'ANTHROPIC_BASE_URL=https://attacker.invalid',
        'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS=1',
        'DOTENV_CONFIG_QUIET=true',
        'LD_PRELOAD=/tmp/x.so',
        'UNRELATED=1',
      ].join('\n'),
    );
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home };
    const result = load(env);

    expect(env).toEqual({ IRONCURTAIN_HOME: home, ANTHROPIC_API_KEY: 'sk-ant-home' });
    expect(result.loadedFiles).toEqual([join(home, '.env')]);
    expect(result.appliedKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(result.ignoredKeys).toEqual([
      {
        file: join(home, '.env'),
        keys: [
          'ANTHROPIC_BASE_URL',
          'DOTENV_CONFIG_QUIET',
          'IRONCURTAIN_HOME',
          'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS',
          'LD_PRELOAD',
          'NODE_OPTIONS',
          'UNRELATED',
        ],
      },
    ]);
    expect(result.permissionWarnings).toEqual([]);
  });

  it('applies the default allowlist when none is passed', () => {
    writeEnv(join(home, '.env'), 'OPENROUTER_API_KEY=sk-or\nNODE_OPTIONS=--inspect\n');
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home };
    loadTrustedEnv({ env, cwd });
    expect(env.OPENROUTER_API_KEY).toBe('sk-or');
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('never reads <cwd>/.env and reports it as ignored', () => {
    writeEnv(join(cwd, '.env'), 'ANTHROPIC_API_KEY=sk-from-cwd\nNODE_OPTIONS=--require ./x.cjs\n');
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home };
    const result = load(env);
    expect(env).toEqual({ IRONCURTAIN_HOME: home });
    expect(result.loadedFiles).toEqual([]);
    expect(result.ignoredCwdEnvFile).toBe(join(cwd, '.env'));
  });

  it('reports a dangling-symlink .env in the working directory too', () => {
    symlinkSync(join(root, 'nowhere'), join(cwd, '.env'));
    expect(load({ IRONCURTAIN_HOME: home }).ignoredCwdEnvFile).toBe(join(cwd, '.env'));
  });

  it('does not report the working-directory .env when it is the file it loaded', () => {
    writeEnv(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-home\n');
    const result = loadTrustedEnv({ env: { IRONCURTAIN_HOME: home }, cwd: home, allowedKeys: KEYS });
    expect(result.loadedFiles).toEqual([join(home, '.env')]);
    expect(result.ignoredCwdEnvFile).toBeUndefined();
  });

  it('skips an absent home .env silently', () => {
    const result = load({ IRONCURTAIN_HOME: home });
    expect(result).toMatchObject({ loadedFiles: [], appliedKeys: [], ignoredKeys: [], permissionWarnings: [] });
    expect(result.ignoredCwdEnvFile).toBeUndefined();
  });

  it('lets a non-empty environment value win and fills an empty one', () => {
    writeEnv(
      join(home, '.env'),
      'ANTHROPIC_API_KEY=sk-file\nOPENAI_API_KEY=sk-openai-file\nGITHUB_PERSONAL_ACCESS_TOKEN=\n',
    );
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home, ANTHROPIC_API_KEY: 'sk-shell', OPENAI_API_KEY: '' };
    const result = load(env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-shell');
    expect(env.OPENAI_API_KEY).toBe('sk-openai-file');
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    expect(result.appliedKeys).toEqual(['OPENAI_API_KEY']);
  });

  it('loads an explicit IRONCURTAIN_ENV_FILE, whose values win over the home file', () => {
    const explicit = join(root, 'work.env');
    writeEnv(explicit, 'ANTHROPIC_API_KEY=sk-explicit\nHTTPS_PROXY=http://attacker.invalid\n');
    writeEnv(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-home\nOPENAI_API_KEY=sk-openai-home\n');
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home, [ENV_FILE_ENV_VAR]: explicit };
    const result = load(env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-explicit');
    expect(env.OPENAI_API_KEY).toBe('sk-openai-home');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(result.loadedFiles).toEqual([explicit, join(home, '.env')]);
    expect(result.ignoredKeys).toEqual([{ file: explicit, keys: ['HTTPS_PROXY'] }]);
  });

  it('filters an explicitly named <cwd>/.env through the allowlist and does not call it ignored', () => {
    writeEnv(join(cwd, '.env'), 'ANTHROPIC_API_KEY=sk-explicit-cwd\nNODE_OPTIONS=--require ./x.cjs\n');
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home, [ENV_FILE_ENV_VAR]: join(cwd, '.env') };
    const result = load(env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-explicit-cwd');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(result.ignoredCwdEnvFile).toBeUndefined();
  });

  it('fails when the explicit file is missing, without copying anything', () => {
    writeEnv(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-home\n');
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home, [ENV_FILE_ENV_VAR]: join(root, 'missing.env') };
    expect(thrown(() => load(env)).code).toBe('NOT_FOUND');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('rejects a relative IRONCURTAIN_ENV_FILE', () => {
    expect(thrown(() => load({ IRONCURTAIN_HOME: home, [ENV_FILE_ENV_VAR]: 'keys.env' })).code).toBe('INVALID_PATH');
  });

  it('rejects a relative IRONCURTAIN_HOME before reading any file', () => {
    writeEnv(join(cwd, '.env'), 'ANTHROPIC_API_KEY=sk-cwd\n');
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: 'rel' };
    expect(() => load(env)).toThrow(/IRONCURTAIN_HOME must be an absolute path/);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('uses the default home for an empty IRONCURTAIN_HOME', () => {
    const result = load({ IRONCURTAIN_HOME: '' });
    expect(result.homeEnvFile).toBe(resolve(homedir(), '.ironcurtain', '.env'));
  });

  it('refuses a world-writable file', () => {
    writeEnv(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-home\n', 0o666);
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home };
    const error = thrown(() => load(env));
    expect(error.code).toBe('INSECURE');
    expect(error.message).toMatch(/writable by every user \(mode 0666\)/);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it.skipIf(CURRENT_UID === undefined)('refuses a file owned by another user', () => {
    writeEnv(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-home\n');
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home };
    const error = thrown(() => load(env, { expectedUid: (CURRENT_UID ?? 0) + 4242 }));
    expect(error.code).toBe('INSECURE');
    expect(error.message).toMatch(/the file is owned by uid \d+, not the current user/);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it.skipIf(!IS_ROOT)('refuses a file chowned to another user (real ownership, needs root)', () => {
    writeEnv(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-home\n');
    lchownSync(join(home, '.env'), 4242, 4242);
    expect(thrown(() => load({ IRONCURTAIN_HOME: home })).code).toBe('INSECURE');
  });

  it('follows a symlink the user owns to a file the user owns', () => {
    const target = join(root, 'dotfiles.env');
    writeEnv(target, 'ANTHROPIC_API_KEY=sk-linked\n');
    symlinkSync(target, join(home, '.env'));
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home };
    load(env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-linked');
  });

  it.skipIf(!IS_ROOT)('refuses a symlink owned by another user even when the target is fine', () => {
    const target = join(root, 'dotfiles.env');
    writeEnv(target, 'ANTHROPIC_API_KEY=sk-linked\n');
    symlinkSync(target, join(home, '.env'));
    lchownSync(join(home, '.env'), 4242, 4242);
    const error = thrown(() => load({ IRONCURTAIN_HOME: home }));
    expect(error.code).toBe('INSECURE');
    expect(error.message).toMatch(/the symlink is owned by uid 4242/);
  });

  it('refuses a symlink to a world-writable file', () => {
    const target = join(root, 'shared.env');
    writeEnv(target, 'ANTHROPIC_API_KEY=sk-linked\n', 0o666);
    symlinkSync(target, join(home, '.env'));
    expect(thrown(() => load({ IRONCURTAIN_HOME: home })).code).toBe('INSECURE');
  });

  it('loads a group-writable or other-readable file but warns', () => {
    writeEnv(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-home\n', 0o664);
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home };
    const result = load(env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-home');
    expect(result.permissionWarnings).toEqual([{ file: join(home, '.env'), mode: 0o664 }]);
    const [line] = formatTrustedEnvReport(result);
    expect(line).toMatch(/is group-writable and readable by others \(mode 0664\)\. Run: chmod 600 /);
  });

  it('refuses a directory', () => {
    mkdirSync(join(home, '.env'));
    expect(thrown(() => load({ IRONCURTAIN_HOME: home })).code).toBe('NOT_REGULAR_FILE');
  });

  it('refuses a FIFO without blocking', () => {
    const fifo = join(home, '.env');
    try {
      execFileSync('mkfifo', ['-m', '600', fifo]);
    } catch {
      return; // no mkfifo on this platform
    }
    expect(thrown(() => load({ IRONCURTAIN_HOME: home })).code).toBe('NOT_REGULAR_FILE');
  });

  it('refuses an oversized file', () => {
    writeEnv(join(home, '.env'), `ANTHROPIC_API_KEY=${'x'.repeat(1024 * 1024 + 1)}\n`);
    const env: NodeJS.ProcessEnv = { IRONCURTAIN_HOME: home };
    expect(thrown(() => load(env)).code).toBe('TOO_LARGE');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('formatTrustedEnvReport', () => {
  it('prints one line per finding and names where credentials go now', () => {
    const lines = formatTrustedEnvReport({
      homeEnvFile: '/home/me/.ironcurtain/.env',
      loadedFiles: ['/home/me/.ironcurtain/.env'],
      appliedKeys: ['ANTHROPIC_API_KEY'],
      ignoredKeys: [{ file: '/home/me/.ironcurtain/.env', keys: ['ANTHROPIC_BASE_URL', 'NODE_OPTIONS'] }],
      permissionWarnings: [],
      ignoredCwdEnvFile: '/work/proj/.env',
    });
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toContain('\n');
    expect(lines[0]).toContain(
      'ignored non-credential keys in /home/me/.ironcurtain/.env: ANTHROPIC_BASE_URL, NODE_OPTIONS',
    );
    expect(lines[1]).toBe(
      'Note: ignoring /work/proj/.env: IronCurtain does not read .env from the current directory. ' +
        'Put credentials in /home/me/.ironcurtain/.env or pass --env-file <path> (or set IRONCURTAIN_ENV_FILE).',
    );
  });

  it('escapes control characters in an agent-chosen directory name', () => {
    const [line] = formatTrustedEnvReport({
      homeEnvFile: '/home/me/.ironcurtain/.env',
      loadedFiles: [],
      appliedKeys: [],
      ignoredKeys: [],
      permissionWarnings: [],
      ignoredCwdEnvFile: '/work/\u001b]52;c;cHduZWQ=\u0007evil/.env',
    });
    const codes = Array.from({ length: line.length }, (_, index) => line.charCodeAt(index));
    expect(codes.some((code) => code < 0x20 || code === 0x7f)).toBe(false);
    expect(line).toContain('\\u001b]52;c;cHduZWQ=\\u0007evil/.env');
  });
});
