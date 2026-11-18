import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyGitConfigEntry,
  DISABLED_HOOKS_PATH,
  GIT_DIR_WALK_LIMIT_DETAIL,
  hardenedGitEnv,
  inspectRepoConfig,
  parseGitConfigBytes,
  readTrustedGitConfig,
  readTrustedGitConfigAsync,
  readTrustedGitConfigEntries,
  runGit,
  type RepoConfigFinding,
  type TrustedGitConfig,
} from '../src/security/git-hardening.js';

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const posix = process.platform !== 'win32';
const NO_TRUSTED_CONFIG: TrustedGitConfig = { entries: [] };

/** True when names in the temporary directory are looked up case-insensitively (the macOS default). */
function tmpdirIsCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'ironcurtain-case-probe-'));
  try {
    writeFileSync(join(probe, 'name'), '');
    return existsSync(join(probe, 'NAME'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const caseInsensitiveTmp = posix && tmpdirIsCaseInsensitive();

/** The command-scope config entries an environment carries, in order. */
function configEntries(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const count = Number(env.GIT_CONFIG_COUNT ?? '0');
  return Array.from({ length: count }, (_, index) => [
    env[`GIT_CONFIG_KEY_${index}`] ?? '<missing>',
    env[`GIT_CONFIG_VALUE_${index}`] ?? '<missing>',
  ]);
}

/** The value git would use for a single-valued key: the last command-scope entry. */
function effective(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return configEntries(env)
    .filter(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase())
    .at(-1)?.[1];
}

describe('hardenedGitEnv', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: ['/usr/bin', '.', '', 'relative/bin', '/bin'].join(delimiter),
    HOME: '/home/user',
    GIT_DIR: '/elsewhere/.git',
    GIT_WORK_TREE: '/elsewhere',
    GIT_INDEX_FILE: '/elsewhere/index',
    GIT_CONFIG_PARAMETERS: "'core.hookspath'='/evil'",
    GIT_ASKPASS: '/usr/lib/askpass',
    SSH_ASKPASS: '/usr/lib/ssh-askpass',
    GIT_CONFIG_GLOBAL: '/home/user/.gitconfig-work',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '/work',
  };

  it('pins every fixed-name command key at command scope', () => {
    const env = hardenedGitEnv({ baseEnv, trustedConfig: NO_TRUSTED_CONFIG });
    expect(effective(env, 'core.fsmonitor')).toBe('false');
    expect(effective(env, 'core.hooksPath')).toBe(DISABLED_HOOKS_PATH);
    expect(effective(env, 'core.pager')).toBe('cat');
    expect(effective(env, 'core.editor')).toBe('true');
    expect(effective(env, 'sequence.editor')).toBe('true');
    expect(effective(env, 'safe.bareRepository')).toBe('explicit');
    expect(effective(env, 'core.sshCommand')).toBe('ssh');
    expect(effective(env, 'core.askPass')).toBe('');
    expect(effective(env, 'commit.gpgSign')).toBe('false');
    expect(effective(env, 'tag.gpgSign')).toBe('false');
    expect(effective(env, 'tag.forceSignAnnotated')).toBe('false');
    expect(effective(env, 'push.gpgSign')).toBe('false');
    expect(effective(env, 'gpg.program')).toBe('gpg');
    expect(effective(env, 'gpg.ssh.program')).toBe('ssh-keygen');
    expect(effective(env, 'gpg.ssh.defaultKeyCommand')).toBe('false');
    expect(effective(env, 'core.alternateRefsCommand')).toBe('true');
    expect(effective(env, 'tar.tgz.command')).toBe('gzip -cn');
    expect(effective(env, 'tar.tar.gz.command')).toBe('gzip -cn');
    expect(effective(env, 'maintenance.auto')).toBe('false');
    expect(effective(env, 'gc.auto')).toBe('0');
    expect(effective(env, 'maintenance.autoDetach')).toBe('false');
    expect(effective(env, 'gc.autoDetach')).toBe('false');
    expect(effective(env, 'credential.helper')).toBe('');
    expect(env.GIT_PAGER).toBe('cat');
    expect(env.GIT_EDITOR).toBe('true');
    expect(env.GIT_SEQUENCE_EDITOR).toBe('true');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_PROXY_COMMAND).toBe('');
    expect(env.GCM_INTERACTIVE).toBe('never');
  });

  it('allows only the requested transports and always denies ext and fd', () => {
    const env = hardenedGitEnv({ baseEnv, trustedConfig: NO_TRUSTED_CONFIG });
    expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh');
    expect(effective(env, 'protocol.allow')).toBe('never');
    expect(effective(env, 'protocol.https.allow')).toBe('always');
    expect(effective(env, 'protocol.ssh.allow')).toBe('always');
    for (const protocol of ['file', 'git', 'http', 'ext', 'fd']) {
      expect(effective(env, `protocol.${protocol}.allow`)).toBe('never');
    }
    const httpsOnly = hardenedGitEnv({ baseEnv, trustedConfig: NO_TRUSTED_CONFIG, allowedProtocols: ['https'] });
    expect(httpsOnly.GIT_ALLOW_PROTOCOL).toBe('https');
    expect(effective(httpsOnly, 'protocol.ssh.allow')).toBe('never');
    expect(() =>
      hardenedGitEnv({ baseEnv, trustedConfig: NO_TRUSTED_CONFIG, allowedProtocols: ['ext' as 'https'] }),
    ).toThrow(/unsupported git protocol/u);
  });

  it('removes repository selection, injected config and askpass, and sanitizes PATH', () => {
    const env = hardenedGitEnv({ baseEnv, trustedConfig: NO_TRUSTED_CONFIG });
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS']) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.PATH).toBe(['/usr/bin', '/bin'].join(delimiter));
    // Identity and credential configuration stay intact.
    expect(env.GIT_CONFIG_GLOBAL).toBe('/home/user/.gitconfig-work');
    expect(env.HOME).toBe('/home/user');
    // The caller's environment is not mutated.
    expect(baseEnv.GIT_DIR).toBe('/elsewhere/.git');
  });

  it('keeps valid inherited command-scope entries ahead of the overrides and drops malformed ones', () => {
    const env = hardenedGitEnv({ baseEnv, trustedConfig: NO_TRUSTED_CONFIG });
    expect(configEntries(env)[0]).toEqual(['safe.directory', '/work']);
    const malformed = hardenedGitEnv({
      baseEnv: { ...baseEnv, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/w' },
      trustedConfig: NO_TRUSTED_CONFIG,
    });
    expect(configEntries(malformed).some(([key]) => key === 'safe.directory')).toBe(false);
    expect(configEntries(malformed).every(([key, value]) => key !== '<missing>' && value !== '<missing>')).toBe(true);
  });

  it('resets credential helpers, then replays the trusted ones in order', () => {
    const env = hardenedGitEnv({
      baseEnv,
      trustedConfig: {
        entries: [
          { scope: 'system', key: 'credential.helper', value: 'cache' },
          { scope: 'global', key: 'credential.https://github.com.helper', value: '' },
          { scope: 'global', key: 'credential.https://github.com.helper', value: '!gh auth git-credential' },
          { scope: 'global', key: 'credential.helper', value: null },
          { scope: 'global', key: 'core.sshcommand', value: 'ssh -o IdentitiesOnly=yes' },
          { scope: 'global', key: 'gpg.program', value: '/opt/gpg2' },
          { scope: 'global', key: 'gpg.x509.program', value: '/opt/gpgsm' },
          { scope: 'global', key: 'gpg.ssh.defaultkeycommand', value: 'ssh-add -L' },
          { scope: 'system', key: 'core.alternaterefscommand', value: '/opt/alternate-refs' },
        ],
      },
    });
    const helpers = configEntries(env).filter(([key]) => key.startsWith('credential.'));
    expect(helpers).toEqual([
      ['credential.helper', ''],
      ['credential.helper', 'cache'],
      ['credential.https://github.com.helper', ''],
      ['credential.https://github.com.helper', '!gh auth git-credential'],
    ]);
    expect(effective(env, 'core.sshCommand')).toBe('ssh -o IdentitiesOnly=yes');
    expect(effective(env, 'gpg.program')).toBe('/opt/gpg2');
    expect(effective(env, 'gpg.openpgp.program')).toBe('/opt/gpg2');
    expect(effective(env, 'gpg.x509.program')).toBe('/opt/gpgsm');
    expect(effective(env, 'gpg.ssh.defaultKeyCommand')).toBe('ssh-add -L');
    expect(effective(env, 'core.alternateRefsCommand')).toBe('/opt/alternate-refs');
  });

  it('applies explicit ssh, askpass, ceiling, hooks and extra options', () => {
    const env = hardenedGitEnv({
      baseEnv,
      trustedConfig: NO_TRUSTED_CONFIG,
      sshCommand: 'ssh -o BatchMode=yes',
      allowAskPass: true,
      ceilingDirectories: ['/sandbox-parent'],
      hooksPath: '/opt/empty-hooks',
      extraConfig: [
        ['http.lowSpeedLimit', '1000'],
        ['core.hooksPath', '/dev/null'],
      ],
    });
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
    expect(effective(env, 'core.sshCommand')).toBe('ssh -o BatchMode=yes');
    expect(env.GIT_ASKPASS).toBe('/usr/lib/askpass');
    expect(effective(env, 'core.askPass')).toBe('/usr/lib/ssh-askpass');
    expect(env.GCM_INTERACTIVE).toBeUndefined();
    expect(env.GIT_CEILING_DIRECTORIES).toBe('/sandbox-parent');
    expect(configEntries(env).at(-2)).toEqual(['http.lowSpeedLimit', '1000']);
    expect(effective(env, 'core.hooksPath')).toBe('/dev/null');

    const merged = hardenedGitEnv({
      baseEnv: { ...baseEnv, GIT_CEILING_DIRECTORIES: '/a' },
      trustedConfig: NO_TRUSTED_CONFIG,
      ceilingDirectories: ['/b', '/a'],
    });
    expect(merged.GIT_CEILING_DIRECTORIES).toBe(['/a', '/b'].join(delimiter));
  });

  it('rejects unsafe option values', () => {
    const options = { baseEnv, trustedConfig: NO_TRUSTED_CONFIG };
    expect(() => hardenedGitEnv({ ...options, hooksPath: 'hooks' })).toThrow(/absolute/u);
    expect(() => hardenedGitEnv({ ...options, ceilingDirectories: ['relative'] })).toThrow(/absolute/u);
    expect(() => hardenedGitEnv({ ...options, sshCommand: ' ' })).toThrow(/empty/u);
    expect(() => hardenedGitEnv({ ...options, extraConfig: [['not a key', 'x']] })).toThrow(/invalid git config key/u);
  });
});

describe.skipIf(!gitAvailable || !posix)('hardened git against a planted repository', () => {
  let root: string;
  let home: string;
  let markers: string;
  let baseEnv: NodeJS.ProcessEnv;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: baseEnv, encoding: 'utf8' });
  const marker = (name: string): string => join(markers, name);
  const touch = (name: string): string => `touch ${marker(name)}`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ironcurtain-git-hardening-'));
    expect(root).toMatch(/^[\w/.-]+$/u); // marker paths are embedded in shell snippets below
    home = join(root, 'home');
    markers = join(root, 'markers');
    mkdirSync(home);
    mkdirSync(markers);
    writeFileSync(
      join(home, '.gitconfig'),
      '[user]\n\tname = Test\n\temail = test@localhost\n[init]\n\tdefaultBranch = main\n',
    );
    baseEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function plantRepository(): string {
    const upstream = join(root, 'upstream');
    git(root, 'init', '-q', upstream);
    git(upstream, 'commit', '-q', '--allow-empty', '-m', 'upstream');
    const repo = join(root, 'repo');
    git(root, 'init', '-q', repo);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'init');

    writeFileSync(join(root, 'include.cfg'), `[core]\n\tfsmonitor = "${touch('include-fsmonitor')}; false"\n`);
    const planted = [
      '[core]',
      `\tfsmonitor = "${touch('fsmonitor')}; false"`,
      `\tpager = "${touch('pager')}; cat"`,
      `\teditor = "${touch('editor')}; true"`,
      `\tsshCommand = "${touch('repo-ssh')}; false"`,
      '[sequence]',
      `\teditor = "${touch('sequence-editor')}; true"`,
      '[include]',
      `\tpath = ${join(root, 'include.cfg')}`,
      '[credential]',
      `\thelper = "!${touch('repo-helper')}; false"`,
      '[remote "origin"]',
      `\turl = ${upstream}`,
      `\tuploadpack = "${touch('uploadpack')}; git-upload-pack"`,
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[remote "sshremote"]',
      '\turl = ssh://example.invalid/repo.git',
      '',
    ].join('\n');
    writeFileSync(join(repo, '.git', 'config'), readFileSync(join(repo, '.git', 'config'), 'utf8') + planted);
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'reference-transaction']) {
      const path = join(repo, '.git', 'hooks', hook);
      writeFileSync(path, `#!/bin/sh\n${touch(`hook-${hook}`)}\n`);
      chmodSync(path, 0o755);
    }
    return repo;
  }

  it('runs status, diff, add, commit, checkout and fetch with no planted command executing', async () => {
    const repo = plantRepository();
    const trustedSsh = join(root, 'trusted-ssh.sh');
    writeFileSync(trustedSsh, `#!/bin/sh\n${touch('trusted-ssh')}\nexit 1\n`);
    chmodSync(trustedSsh, 0o755);
    writeFileSync(join(home, '.gitconfig'), `[core]\n\tsshCommand = ${trustedSsh}\n`, { flag: 'a' });

    const env = hardenedGitEnv({ baseEnv, ceilingDirectories: [root] });
    const run = (...args: string[]) => runGit(args, { cwd: repo, env, timeoutMs: 20_000 });

    writeFileSync(join(repo, 'a.txt'), 'two\n');
    await expect(run('status', '--porcelain')).resolves.toMatchObject({ stdout: ' M a.txt\n' });
    await expect(run('diff')).resolves.toMatchObject({ exitCode: 0 });
    await run('add', 'a.txt');
    await run('commit', '-q', '-m', 'change');
    await run('checkout', '-q', '-b', 'feature');
    await expect(run('log', '-1', '--format=%s')).resolves.toMatchObject({ stdout: 'change\n' });

    await expect(run('fetch', 'origin')).rejects.toMatchObject({
      code: 'GIT_FAILED',
      stderr: expect.stringContaining("transport 'file' not allowed"),
    });
    await expect(run('fetch', `file://${join(root, 'upstream')}`)).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(run('fetch', `ext::sh -c touch% ${marker('ext')}`)).rejects.toMatchObject({
      stderr: expect.stringContaining("transport 'ext' not allowed"),
    });
    // ssh transport uses the user's trusted command, never the repository's.
    await expect(run('fetch', 'sshremote')).rejects.toMatchObject({ code: 'GIT_FAILED' });

    expect(readdirSync(markers)).toEqual(['trusted-ssh']);

    // Control: the same repository without the hardened env does execute the plants.
    execFileSync('git', ['status', '--porcelain'], { cwd: repo, env: baseEnv, stdio: 'ignore' });
    expect(existsSync(marker('include-fsmonitor'))).toBe(true);
  }, 60_000);

  it('runs no alternate-refs, signing-key or archive filter command and no background maintenance', async () => {
    const upstream = join(root, 'upstream');
    git(root, 'init', '-q', upstream);
    git(upstream, 'commit', '-q', '--allow-empty', '-m', 'upstream');
    const borrowed = join(root, 'borrowed');
    git(root, 'init', '-q', borrowed);
    git(borrowed, 'commit', '-q', '--allow-empty', '-m', 'borrowed');
    const repo = join(root, 'repo');
    git(root, 'init', '-q', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    // fetch runs core.alternateRefsCommand when objects/info/alternates exists.
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${join(borrowed, '.git', 'objects')}\n`);
    git(repo, 'config', 'core.alternateRefsCommand', `${touch('alternate-refs')}; true`);
    // `git tag <name> -m <msg>` signs under tag.forceSignAnnotated, and ssh
    // signing without user.signingKey runs gpg.ssh.defaultKeyCommand.
    git(repo, 'config', 'tag.forceSignAnnotated', 'true');
    git(repo, 'config', 'gpg.format', 'ssh');
    git(repo, 'config', 'gpg.ssh.defaultKeyCommand', touch('default-key-command'));
    // `git archive` runs the built-in gzip formats' configured filter command.
    git(repo, 'config', 'tar.tgz.command', `${touch('tar-tgz')}; gzip -cn`);
    git(repo, 'config', 'tar.tar.gz.command', `${touch('tar-tar-gz')}; gzip -cn`);
    // The agent can force automatic maintenance after every command.
    git(repo, 'config', 'gc.auto', '1');

    const trace = join(root, 'trace.log');
    const env = { ...hardenedGitEnv({ baseEnv, allowedProtocols: ['file'] }), GIT_TRACE: trace };
    const run = (...args: string[]) => runGit(args, { cwd: repo, env, timeoutMs: 20_000 });
    await run('fetch', '-q', upstream, 'HEAD');
    await run('tag', 'plain', '-m', 'annotated, unsigned');
    await expect(run('tag', '-s', 'signed', '-m', 'explicitly signed')).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await run('commit', '-q', '--allow-empty', '-m', 'after');
    await run('archive', '--format=tgz', '-o', join(root, 'out.tgz'), 'HEAD');
    await run('archive', '-o', join(root, 'out.tar.gz'), 'HEAD');
    for (const archive of ['out.tgz', 'out.tar.gz']) {
      expect(readFileSync(join(root, archive)).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    }
    expect(readdirSync(markers)).toEqual([]);
    // Host-side git never starts automatic maintenance on the agent's repository...
    const maintenanceRuns = (): string[] =>
      readFileSync(trace, 'utf8')
        .split('\n')
        .filter((line) => /run_command: git (?:maintenance|gc) /u.test(line));
    expect(maintenanceRuns()).toEqual([]);
    // ...and if a caller re-enables it, it stays in the foreground, inside the killable process group.
    const reenabled = {
      ...hardenedGitEnv({ baseEnv, allowedProtocols: ['file'], extraConfig: [['maintenance.auto', 'true']] }),
      GIT_TRACE: trace,
    };
    await runGit(['commit', '-q', '--allow-empty', '-m', 'maintained'], {
      cwd: repo,
      env: reenabled,
      timeoutMs: 20_000,
    });
    expect(maintenanceRuns().length).toBeGreaterThan(0);
    expect(maintenanceRuns().every((line) => line.endsWith(' --no-detach'))).toBe(true);

    // Control: without the hardened env the same commands run the plants (gc.auto is
    // removed first so the control leaves no detached gc behind in the temp directory).
    git(repo, 'config', '--unset', 'gc.auto');
    git(upstream, 'commit', '-q', '--allow-empty', '-m', 'second');
    const control = (...args: string[]) => spawnSync('git', args, { cwd: repo, env: baseEnv, stdio: 'ignore' }).status;
    expect(control('fetch', '-q', upstream, 'HEAD')).toBe(0);
    expect(control('tag', 'control', '-m', 'control')).not.toBe(0);
    expect(control('archive', '--format=tgz', '-o', join(root, 'control.tgz'), 'HEAD')).toBe(0);
    expect(readdirSync(markers).sort()).toEqual(['alternate-refs', 'default-key-command', 'tar-tgz']);
  }, 60_000);

  it('drops repository credential helpers and still applies the trusted global helper', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      response.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = "!f() { ${touch('global-helper')}; }; f"\n`, {
        flag: 'a',
      });
      const repo = join(root, 'repo');
      git(root, 'init', '-q', repo);
      git(repo, 'config', 'credential.helper', `!${touch('repo-helper')}; false`);
      git(repo, 'config', `credential.${origin}.helper`, `!${touch('repo-url-helper')}; false`);

      const env = hardenedGitEnv({ baseEnv, allowedProtocols: ['http'] });
      await expect(
        runGit(['fetch', `${origin}/repo.git`], { cwd: repo, env, timeoutMs: 20_000 }),
      ).rejects.toMatchObject({ code: 'GIT_FAILED' });
      expect(readdirSync(markers)).toEqual(['global-helper']);
    } finally {
      server.close();
    }
  }, 60_000);

  it('reads trusted helpers and commands from global config and its includes only', async () => {
    writeFileSync(join(home, 'extra.cfg'), '[credential]\n\thelper = from-include\n');
    writeFileSync(
      join(home, '.gitconfig'),
      [
        '[credential]',
        '\thelper = store',
        '[credential "https://github.com"]',
        '\thelper =',
        '\thelper = !gh auth git-credential',
        '[core]',
        '\tsshCommand = ssh -4',
        '[gpg "ssh"]',
        '\tdefaultKeyCommand = ssh-add -L',
        '[include]',
        `\tpath = ${join(home, 'extra.cfg')}`,
        '',
      ].join('\n'),
      { flag: 'a' },
    );
    const repo = join(root, 'repo');
    git(root, 'init', '-q', repo);
    git(repo, 'config', 'credential.helper', 'repo-local');

    git(repo, 'config', 'gpg.ssh.defaultKeyCommand', 'repo-local-key-command');
    git(repo, 'config', 'core.alternateRefsCommand', 'repo-local-alternates');

    const trusted = readTrustedGitConfig({ baseEnv: { ...baseEnv, GIT_DIR: join(repo, '.git') } });
    expect(trusted.entries).toEqual([
      { scope: 'global', key: 'credential.helper', value: 'store' },
      { scope: 'global', key: 'credential.https://github.com.helper', value: '' },
      { scope: 'global', key: 'credential.https://github.com.helper', value: '!gh auth git-credential' },
      { scope: 'global', key: 'core.sshcommand', value: 'ssh -4' },
      { scope: 'global', key: 'gpg.ssh.defaultkeycommand', value: 'ssh-add -L' },
      { scope: 'global', key: 'credential.helper', value: 'from-include' },
    ]);
    expect(readTrustedGitConfig({ baseEnv: { ...baseEnv, PATH: join(root, 'no-git-here') } })).toEqual({
      entries: [],
    });

    // The non-blocking reader returns the same snapshot and fails closed the same way.
    await expect(readTrustedGitConfigAsync({ baseEnv: { ...baseEnv, GIT_DIR: join(repo, '.git') } })).resolves.toEqual(
      trusted,
    );
    await expect(
      readTrustedGitConfigAsync({ baseEnv: { ...baseEnv, PATH: join(root, 'no-git-here') } }),
    ).resolves.toEqual({ entries: [] });
    await expect(readTrustedGitConfigAsync({ baseEnv, signal: AbortSignal.abort() })).resolves.toEqual({
      entries: [],
    });
  });

  it('tells "no matching entry" apart from a failed read of trusted config', () => {
    const pattern = '^(remote\\..+\\.(url|pushurl)|url\\..+\\.(insteadof|pushinsteadof))$';
    expect(readTrustedGitConfigEntries(pattern, { baseEnv })).toEqual({ ok: true, entries: [] });

    writeFileSync(
      join(home, '.gitconfig'),
      '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[remote "dotfiles"]\n\turl = https://example.com/d\n',
      { flag: 'a' },
    );
    const repo = join(root, 'repo');
    git(root, 'init', '-q', repo);
    git(repo, 'config', 'url.https://evil.example/.insteadOf', 'https://github.com/');
    expect(readTrustedGitConfigEntries(pattern, { baseEnv: { ...baseEnv, GIT_DIR: join(repo, '.git') } })).toEqual({
      ok: true,
      entries: [
        { scope: 'global', key: 'url.git@github.com:.insteadof', value: 'https://github.com/' },
        { scope: 'global', key: 'remote.dotfiles.url', value: 'https://example.com/d' },
      ],
    });
    expect(readTrustedGitConfigEntries(pattern, { baseEnv: { ...baseEnv, PATH: join(root, 'no-git-here') } })).toEqual({
      ok: false,
    });
  });
});

describe('parseGitConfigBytes / classifyGitConfigEntry', () => {
  it('names entries the way git does and never follows includes', () => {
    const parsed = parseGitConfigBytes(
      Buffer.from(
        [
          '[remote "Origin.Mirror"]',
          '\turl = "https://github.com/a/b" ; comment',
          '[remote.LEGACY]',
          '\tpushurl = https://evil.example/x',
          '[url "https://evil.example/"]',
          '\tpushInsteadOf = https://github.com/',
          '[include]',
          '\tpath = /dev/stdin',
          '',
        ].join('\n'),
      ),
    );
    expect(parsed.syntaxErrorLine).toBeUndefined();
    expect(parsed.entries.map(({ section, subsection, name, value }) => [section, subsection, name, value])).toEqual([
      ['remote', 'Origin.Mirror', 'url', 'https://github.com/a/b'],
      ['remote', 'legacy', 'pushurl', 'https://evil.example/x'],
      ['url', 'https://evil.example/', 'pushinsteadof', 'https://github.com/'],
      ['include', undefined, 'path', '/dev/stdin'],
    ]);
    expect(parsed.entries.map((entry) => classifyGitConfigEntry(entry))).toEqual([
      undefined,
      undefined,
      'network',
      'include',
    ]);
  });

  it('reports the first syntax error, where git refuses the file', () => {
    const parsed = parseGitConfigBytes(Buffer.from('[core]\n\tbare = false\n[remote "x"\n\turl = y\n'));
    // `git config -f <file> --list` reports "bad config line 4" for this input too.
    expect(parsed.syntaxErrorLine).toBe(4);
    expect(parsed.entries.map((entry) => entry.key)).toEqual(['core.bare']);
  });
});

describe.skipIf(!gitAvailable || !posix)('runGit', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ironcurtain-run-git-'));
    expect(root).toMatch(/^[\w/.-]+$/u);
    env = hardenedGitEnv({
      baseEnv: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
      trustedConfig: NO_TRUSTED_CONFIG,
      ceilingDirectories: [dirname(root)],
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A shell alias that records its PID and then sleeps, as a stand-in for a hung helper. */
  function hangArgs(pidFile: string): string[] {
    return ['-c', `alias.hang=!echo $$ > ${pidFile}; exec sleep 60`, 'hang'];
  }

  function isRunning(pid: number): boolean {
    if (process.platform === 'linux') {
      try {
        const state = readFileSync(`/proc/${pid}/stat`, 'utf8')
          .replace(/^.*\) /su, '')
          .charAt(0);
        return state !== 'Z' && state !== 'X';
      } catch {
        return false;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('condition not reached in time');
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  it('returns output and reports non-zero exits', async () => {
    await expect(runGit(['--version'], { cwd: root, env })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringMatching(/^git version /u),
    });
    await expect(runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root, env })).rejects.toMatchObject({
      code: 'GIT_FAILED',
      exitCode: 128,
    });
    await expect(
      runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root, env, allowNonZeroExit: true }),
    ).resolves.toMatchObject({ exitCode: 128 });
  });

  it('feeds input to stdin and closes it', async () => {
    await expect(runGit(['hash-object', '--stdin'], { cwd: root, env, input: 'hello\n' })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'ce013625030ba8dba906f756967f9e9ca394464a\n',
    });
    // Without input, stdin is closed: a command that reads it sees EOF instead of waiting.
    await expect(runGit(['hash-object', '--stdin'], { cwd: root, env, timeoutMs: 10_000 })).resolves.toMatchObject({
      stdout: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\n',
    });
  });

  it('kills the whole process group on timeout', async () => {
    const pidFile = join(root, 'hang.pid');
    const started = Date.now();
    await expect(runGit(hangArgs(pidFile), { cwd: root, env, timeoutMs: 3_000 })).rejects.toMatchObject({
      code: 'GIT_TIMEOUT',
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await waitFor(() => !isRunning(pid));
  }, 30_000);

  it('kills the whole process group on abort', async () => {
    const pidFile = join(root, 'abort.pid');
    const controller = new AbortController();
    const pending = runGit(hangArgs(pidFile), { cwd: root, env, signal: controller.signal, timeoutMs: 30_000 });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'GIT_ABORTED' });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await waitFor(() => !isRunning(pid));
    await expect(runGit(['--version'], { cwd: root, env, signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'GIT_ABORTED',
    });
  }, 30_000);

  it('caps output and reports spawn failures', async () => {
    await expect(
      runGit(['-c', 'alias.big=!head -c 200000 /dev/zero', 'big'], { cwd: root, env, maxOutputBytes: 1_000 }),
    ).rejects.toMatchObject({ code: 'GIT_OUTPUT_TOO_LARGE' });
    await expect(runGit(['--version'], { cwd: join(root, 'missing'), env })).rejects.toMatchObject({
      code: 'GIT_SPAWN_FAILED',
    });
  });

  it('refuses a timeout setTimeout cannot represent instead of timing out at once', async () => {
    await expect(runGit(['--version'], { cwd: root, env, timeoutMs: 2 ** 31 })).rejects.toThrow(RangeError);
    await expect(runGit(['--version'], { cwd: root, env, timeoutMs: 2 ** 31 - 1 })).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it('never resolves git through a relative PATH entry', async () => {
    const planted = join(root, 'workspace');
    mkdirSync(planted);
    writeFileSync(join(planted, 'git'), `#!/bin/sh\ntouch ${join(root, 'planted-git-ran')}\necho fake\n`);
    chmodSync(join(planted, 'git'), 0o755);
    const result = await runGit(['--version'], {
      cwd: planted,
      env: { ...env, PATH: `.${delimiter}${process.env.PATH ?? ''}` },
    });
    expect(result.stdout).toMatch(/^git version /u);
    expect(existsSync(join(root, 'planted-git-ran'))).toBe(false);
  });
});

describe.skipIf(!gitAvailable || !posix)('inspectRepoConfig', () => {
  let root: string;
  let repo: string;
  const gitEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ironcurtain-inspect-repo-'));
    repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo], { env: gitEnv() });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const configPath = (): string => join(repo, '.git', 'config');
  const summary = (findings: readonly RepoConfigFinding[]): string[] =>
    findings.map((finding) => `${finding.kind}:${finding.key ?? finding.file}`).sort();

  it('reports nothing for a freshly initialized repository', () => {
    const inspection = inspectRepoConfig(repo);
    expect(inspection.repoRoot).toBe(repo);
    expect(inspection.gitDir).toBe(join(repo, '.git'));
    expect(inspection.findings).toEqual([]);
  });

  it('flags worktree, include, driver, command and network keys and ignores benign ones', () => {
    writeFileSync(
      configPath(),
      [
        '[core]',
        '\tworktree = ../../outside',
        '\tfsmonitor = "touch /tmp/x; false"',
        '\thooksPath = /tmp/hooks',
        '\tsshCommand = evil',
        '[CORE]',
        '\tWorkTree = /elsewhere',
        '[include]',
        '\tpath = ~/evil.cfg',
        '[includeIf "gitdir:/x/"]',
        '\tpath = rel.cfg',
        '[filter "lfs"]',
        '\tsmudge = evil-smudge %f',
        '[diff "img"]',
        '\ttextconv = evil-textconv',
        '[diff]',
        '\texternal = evil-external',
        '[merge "ours"]',
        '\tdriver = evil-merge %O %A %B',
        '[credential]',
        '\thelper = "!evil"',
        '\thelper =',
        '[remote "origin"]',
        '\turl = https://example.com/repo.git',
        '\tuploadpack = evil-upload',
        '[alias]',
        '\tst = status',
        '\tpwn = "!evil"',
        '[url "https://evil.example/"]',
        '\tinsteadOf = https://github.com/',
        '[http]',
        '\tsslVerify = false',
        '\tcurloptResolve = github.com:443:10.0.0.1',
        '[http "https://github.com"]',
        '\tproxy = http://evil.example:8080',
        '[tar "tar.xz"]',
        '\tcommand = evil-xz',
        '[trailer "sob"]',
        '\tcmd = evil-trailer',
        '[user]',
        '\tname = Someone',
        '[core]',
        '\tfsmonitor = false',
        '',
      ].join('\n'),
    );
    const { findings } = inspectRepoConfig(repo);
    expect(summary(findings)).toEqual(
      [
        'worktree:core.worktree',
        'worktree:core.worktree',
        'command:core.fsmonitor',
        'command:core.hookspath',
        'command:core.sshcommand',
        'include:include.path',
        'include:includeif.gitdir:/x/.path',
        'driver:filter.lfs.smudge',
        'driver:diff.img.textconv',
        'driver:diff.external',
        'driver:merge.ours.driver',
        'command:credential.helper',
        'command:remote.origin.uploadpack',
        'command:alias.pwn',
        'network:url.https://evil.example/.insteadof',
        'network:http.sslverify',
        'network:http.curloptresolve',
        'network:http.https://github.com.proxy',
        'command:tar.tar.xz.command',
        'command:trailer.sob.cmd',
      ].sort(),
    );
    const worktrees = findings.filter((finding) => finding.kind === 'worktree');
    expect(worktrees.map((finding) => finding.resolvedPath)).toEqual([
      resolve(repo, '.git', '../../outside'),
      '/elsewhere',
    ]);
    const includes = findings.filter((finding) => finding.kind === 'include');
    expect(includes.map((finding) => finding.resolvedPath)).toEqual([
      join(process.env.HOME ?? '', 'evil.cfg'),
      join(dirname(configPath()), 'rel.cfg'),
    ]);
    expect(findings.find((finding) => finding.key === 'core.fsmonitor')).toMatchObject({
      value: 'touch /tmp/x; false',
      line: 3,
    });
  });

  it('parses quoting, continuations, CRLF, a BOM and same-line keys the way git does', () => {
    writeFileSync(
      configPath(),
      '﻿[core] worktree = /same-line\r\n' +
        '\tsshCommand = touch \\\n  continued\r\n' +
        '\tpager = "a;b" ; trailing comment\r\n' +
        '[remote.origin]\n\tuploadpack = deprecated-subsection\n' +
        '[credential "HTTPS://Example.COM"]\n\thelper = scoped\n',
    );
    const { findings } = inspectRepoConfig(repo);
    expect(findings.map((finding) => [finding.key, finding.value])).toEqual([
      ['core.worktree', '/same-line'],
      ['core.sshcommand', 'touch   continued'],
      ['core.pager', 'a;b'],
      ['remote.origin.uploadpack', 'deprecated-subsection'],
      ['credential.HTTPS://Example.COM.helper', 'scoped'],
    ]);
  });

  it('names keys the way git splits them, so dotted headers and empty subsections cannot hide a driver', () => {
    expect(root).toMatch(/^[\w/.-]+$/u); // marker paths are embedded in shell snippets below
    const markers = join(root, 'markers');
    mkdirSync(markers);
    writeFileSync(
      configPath(),
      [
        readFileSync(configPath(), 'utf8'),
        '[filter.a "b"]',
        `\tclean = "touch ${join(markers, 'dotted-filter')}; cat"`,
        '[filter ""]',
        `\tclean = "touch ${join(markers, 'empty-filter')}; cat"`,
        '[diff.x "y"]',
        '\ttextconv = evil-textconv',
        '[merge ""]',
        '\tdriver = evil-merge %O %A %B',
        '[remote.origin "mirror"]',
        '\tuploadpack = evil-upload',
        '[core ""]',
        '\tworktree = /not-core-worktree',
        '',
      ].join('\n'),
    );
    // Git itself runs both filter drivers: [filter.a "b"] is driver "a.b", [filter ""] is driver "".
    const gitOptions = { cwd: repo, env: gitEnv(), stdio: 'ignore' } as const;
    mkdirSync(join(repo, 'dotted'));
    mkdirSync(join(repo, 'empty'));
    writeFileSync(join(repo, 'dotted', '.gitattributes'), '* filter=a.b\n');
    writeFileSync(join(repo, 'empty', '.gitattributes'), '* filter=\n');
    writeFileSync(join(repo, 'dotted', 'file'), 'x\n');
    writeFileSync(join(repo, 'empty', 'file'), 'x\n');
    execFileSync('git', ['add', 'dotted/file', 'empty/file'], gitOptions);
    expect(readdirSync(markers).sort()).toEqual(['dotted-filter', 'empty-filter']);
    // ...while [core ""] is "core..worktree", which git never reads as core.worktree.
    expect(spawnSync('git', ['config', '--get', 'core.worktree'], gitOptions).status).toBe(1);

    expect(summary(inspectRepoConfig(repo).findings)).toEqual(
      [
        'driver:filter.a.b.clean',
        'driver:filter..clean',
        'driver:diff.x.y.textconv',
        'driver:merge..driver',
        'command:remote.origin.mirror.uploadpack',
      ].sort(),
    );
  });

  it('resolves gitfile and core.worktree paths without expanding ~, as git does', () => {
    execFileSync('git', ['config', 'core.worktree', '~/tree'], { cwd: repo, env: gitEnv() });
    expect(inspectRepoConfig(repo).findings).toEqual([
      expect.objectContaining({ kind: 'worktree', resolvedPath: join(repo, '.git', '~', 'tree') }),
    ]);
    const redirected = join(root, 'redirected');
    mkdirSync(redirected);
    writeFileSync(join(redirected, '.git'), 'gitdir: ~/target.git\n');
    expect(inspectRepoConfig(redirected).findings).toEqual([
      expect.objectContaining({ kind: 'gitfile', resolvedPath: join(redirected, '~', 'target.git') }),
    ]);
  });

  it('reports a syntax error, keeping the findings before it', () => {
    writeFileSync(configPath(), '[core]\n\tfsmonitor = evil\n\tthis is not valid\n\tworktree = /x\n');
    expect(inspectRepoConfig(repo).findings).toEqual([
      expect.objectContaining({ kind: 'command', key: 'core.fsmonitor' }),
      expect.objectContaining({ kind: 'unreadable', line: 3, detail: 'git config syntax error' }),
    ]);
    writeFileSync(configPath(), '[core]\n\tfsmonitor = "evil\n');
    expect(summary(inspectRepoConfig(repo).findings)).toEqual([`unreadable:${configPath()}`]);
  });

  it('reports a gitfile redirect and follows it only inside the allowed root', () => {
    const target = join(root, 'elsewhere');
    execFileSync('git', ['init', '-q', target], { env: gitEnv() });
    writeFileSync(join(target, '.git', 'config'), '[core]\n\tfsmonitor = evil\n');
    const redirected = join(root, 'redirected');
    mkdirSync(redirected);
    writeFileSync(join(redirected, '.git'), 'gitdir: ../elsewhere/.git\n');

    const contained = inspectRepoConfig(redirected);
    expect(summary(contained.findings)).toEqual([`gitfile:${join(redirected, '.git')}`]);
    expect(contained.findings[0]).toMatchObject({ value: '../elsewhere/.git', resolvedPath: join(target, '.git') });
    expect(contained.gitDir).toBeUndefined();

    const followed = inspectRepoConfig(redirected, { followRedirectsWithin: root });
    expect(followed.gitDir).toBe(realpathSync(join(target, '.git')));
    expect(summary(followed.findings)).toContain('command:core.fsmonitor');

    writeFileSync(join(redirected, '.git'), 'nonsense\n');
    expect(summary(inspectRepoConfig(redirected).findings)).toEqual([`unreadable:${join(redirected, '.git')}`]);
  });

  it('reports a symlinked .git, commondir, alternates and hooks', () => {
    const linked = join(root, 'linked');
    mkdirSync(linked);
    symlinkSync(join(repo, '.git'), join(linked, '.git'));
    expect(inspectRepoConfig(linked).findings).toEqual([
      expect.objectContaining({ kind: 'git-dir-symlink', value: join(repo, '.git') }),
    ]);
    expect(inspectRepoConfig(linked, { followRedirectsWithin: root }).gitDir).toBe(realpathSync(join(repo, '.git')));

    const other = join(root, 'other.git');
    mkdirSync(other);
    writeFileSync(join(other, 'config'), '[core]\n\tsshCommand = evil\n');
    writeFileSync(join(repo, '.git', 'commondir'), `${other}\n`);
    mkdirSync(join(repo, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), '/somewhere/objects\n');
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');

    const notFollowed = inspectRepoConfig(repo);
    expect(summary(notFollowed.findings)).toEqual([`commondir:${join(repo, '.git', 'commondir')}`]);
    expect(notFollowed.commonDir).toBeUndefined();

    const followed = inspectRepoConfig(repo, { followRedirectsWithin: root });
    expect(followed.commonDir).toBe(realpathSync(other));
    expect(summary(followed.findings)).toEqual(
      [`commondir:${join(repo, '.git', 'commondir')}`, 'command:core.sshcommand'].sort(),
    );

    rmSync(join(repo, '.git', 'commondir'));
    expect(summary(inspectRepoConfig(repo).findings)).toEqual(
      [
        `alternates:${join(repo, '.git', 'objects', 'info', 'alternates')}`,
        `hook:${join(repo, '.git', 'hooks', 'pre-commit')}`,
      ].sort(),
    );
  });

  it('reports symlinked, oversized or FIFO config files as unreadable without blocking', () => {
    const real = join(root, 'real-config');
    writeFileSync(real, '[core]\n\tfsmonitor = evil\n');
    rmSync(configPath());
    symlinkSync(real, configPath());
    expect(inspectRepoConfig(repo).findings).toEqual([
      expect.objectContaining({ kind: 'unreadable', file: configPath(), detail: 'cannot read safely (SYMLINK)' }),
    ]);

    rmSync(configPath());
    writeFileSync(configPath(), `[core]\n${'\tbare = false\n'.repeat(20)}`);
    expect(inspectRepoConfig(repo, { maxConfigBytes: 64 }).findings).toEqual([
      expect.objectContaining({ kind: 'unreadable', detail: 'cannot read safely (TOO_LARGE)' }),
    ]);

    rmSync(configPath());
    execFileSync('mkfifo', [configPath()]);
    const moduleUrl = pathToFileURL(resolve('src/security/git-hardening.ts')).href;
    const program = [
      `import { inspectRepoConfig } from ${JSON.stringify(moduleUrl)};`,
      'process.stdout.write(JSON.stringify(inspectRepoConfig(process.argv[1]).findings));',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program, repo], {
      encoding: 'utf8',
      timeout: 20_000,
      killSignal: 'SIGKILL',
    });
    expect(child.error, 'inspection must not block on a FIFO').toBeUndefined();
    expect(JSON.parse(child.stdout)).toEqual([
      expect.objectContaining({ kind: 'unreadable', detail: 'cannot read safely (NOT_REGULAR_FILE)' }),
    ]);
  });

  it('walks up to the repository, honours stopAt and handles no repository', () => {
    const deep = join(repo, 'src', 'deep');
    mkdirSync(deep, { recursive: true });
    expect(inspectRepoConfig(deep).repoRoot).toBe(repo);
    expect(inspectRepoConfig(deep, { stopAt: join(repo, 'src') })).toEqual({ findings: [] });
    const empty = join(root, 'not-a-repo');
    mkdirSync(empty);
    expect(inspectRepoConfig(empty, { stopAt: root })).toEqual({ findings: [] });
  });

  it('reports symbolic links among the git internals that leave the allowed root', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const gitDir = join(repo, '.git');
    symlinkSync(elsewhere, join(gitDir, 'logs'));
    mkdirSync(join(gitDir, 'refs', 'heads', 'feature'), { recursive: true });
    symlinkSync(elsewhere, join(gitDir, 'refs', 'heads', 'feature', 'deep'));
    symlinkSync(elsewhere, join(gitDir, 'objects', 'ab'));
    // A rebase in progress: git writes the patch and message files here.
    mkdirSync(join(gitDir, 'rebase-merge'));
    symlinkSync(join(elsewhere, 'patch'), join(gitDir, 'rebase-merge', 'patch'));
    // Dangling: git would create the file it points to.
    symlinkSync(join(elsewhere, 'missing', 'msg'), join(gitDir, 'COMMIT_EDITMSG'));

    const inspection = inspectRepoConfig(repo);
    expect(summary(inspection.findings)).toEqual(
      [
        `internal-symlink:${join(gitDir, 'COMMIT_EDITMSG')}`,
        `internal-symlink:${join(gitDir, 'logs')}`,
        `internal-symlink:${join(gitDir, 'objects', 'ab')}`,
        `internal-symlink:${join(gitDir, 'rebase-merge', 'patch')}`,
        `internal-symlink:${join(gitDir, 'refs', 'heads', 'feature', 'deep')}`,
      ].sort(),
    );
    expect(inspection.findings).toContainEqual({
      kind: 'internal-symlink',
      file: join(gitDir, 'logs'),
      value: elsewhere,
    });

    // Links that resolve inside the allowed root are followed, not reported;
    // the dangling ones cannot be resolved and still are.
    expect(summary(inspectRepoConfig(repo, { followRedirectsWithin: root }).findings)).toEqual([
      `internal-symlink:${join(gitDir, 'COMMIT_EDITMSG')}`,
      `internal-symlink:${join(gitDir, 'rebase-merge', 'patch')}`,
    ]);
    expect(summary(inspectRepoConfig(repo, { followRedirectsWithin: repo }).findings)).toHaveLength(5);
  });

  it('follows a link that stays inside the allowed root and reports a link below its target that leaves it', () => {
    const shared = join(root, 'shared-refs');
    mkdirSync(join(shared, 'heads'), { recursive: true });
    rmSync(join(repo, '.git', 'refs'), { recursive: true });
    symlinkSync(shared, join(repo, '.git', 'refs'));
    symlinkSync('/', join(shared, 'heads', 'escape'));
    expect(summary(inspectRepoConfig(repo, { followRedirectsWithin: root }).findings)).toEqual([
      `internal-symlink:${join(realpathSync(shared), 'heads', 'escape')}`,
    ]);
  });

  it('bounds the walk of the git dir and reports a walk it cannot finish as unreadable', () => {
    const heads = join(repo, '.git', 'refs', 'heads');
    for (let i = 0; i < 20; i += 1) writeFileSync(join(heads, `branch-${i}`), `${'0'.repeat(40)}\n`);
    expect(inspectRepoConfig(repo).findings).toEqual([]);
    expect(inspectRepoConfig(repo, { maxGitDirEntries: 10 }).findings).toEqual([
      expect.objectContaining({ kind: 'unreadable', detail: GIT_DIR_WALK_LIMIT_DETAIL }),
    ]);

    // A link cycle inside the allowed root ends at the depth cap.
    symlinkSync('..', join(heads, 'loop'));
    expect(inspectRepoConfig(repo, { followRedirectsWithin: root }).findings).toEqual([
      expect.objectContaining({ kind: 'unreadable', detail: GIT_DIR_WALK_LIMIT_DETAIL }),
    ]);
  });

  it('walks objects/info and objects/pack, whose commit-graph and multi-pack-index git rewrites through a link', () => {
    // With fetch.writeCommitGraph (repository config) `git fetch` locks the
    // commit-graph chain file through a link at its name and renames the new
    // chain over the link's target.
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    for (const name of ['chain', 'graph', 'midx']) writeFileSync(join(elsewhere, name), 'host file\n');
    const objects = join(repo, '.git', 'objects');
    mkdirSync(join(objects, 'info', 'commit-graphs'), { recursive: true });
    symlinkSync(join(elsewhere, 'chain'), join(objects, 'info', 'commit-graphs', 'commit-graph-chain'));
    symlinkSync(join(elsewhere, 'graph'), join(objects, 'info', 'commit-graph'));
    symlinkSync(join(elsewhere, 'midx'), join(objects, 'pack', 'multi-pack-index'));

    expect(summary(inspectRepoConfig(repo, { followRedirectsWithin: repo }).findings)).toEqual(
      [
        `internal-symlink:${join(objects, 'info', 'commit-graph')}`,
        `internal-symlink:${join(objects, 'info', 'commit-graphs', 'commit-graph-chain')}`,
        `internal-symlink:${join(objects, 'pack', 'multi-pack-index')}`,
      ].sort(),
    );
    expect(inspectRepoConfig(repo, { followRedirectsWithin: root }).findings).toEqual([]);
  });

  // A case-insensitive filesystem opens `.git/LOGS` when git asks for
  // `.git/logs`, so the directories to walk are found by path, not by the
  // names a listing returns.
  it.skipIf(!caseInsensitiveTmp)('walks the directories git opens whatever case their names are stored in', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'host-file'), 'host file\n');
    const gitDir = join(repo, '.git');
    // Renamed through another name, so the variant is the name stored.
    const storeAs = (from: string, to: string): void => {
      renameSync(from, `${from}-renaming`);
      renameSync(`${from}-renaming`, to);
    };
    storeAs(join(gitDir, 'refs'), join(gitDir, 'REFS'));
    symlinkSync(elsewhere, join(gitDir, 'REFS', 'escape'));
    storeAs(join(gitDir, 'objects', 'info'), join(gitDir, 'objects', 'Info'));
    symlinkSync(join(elsewhere, 'host-file'), join(gitDir, 'objects', 'Info', 'commit-graph'));

    expect(summary(inspectRepoConfig(repo, { followRedirectsWithin: repo }).findings)).toEqual(
      [
        `internal-symlink:${join(gitDir, 'objects', 'info', 'commit-graph')}`,
        `internal-symlink:${join(gitDir, 'refs', 'escape')}`,
      ].sort(),
    );
  });

  it('leaves config files, commondir and hooks to their own checks', () => {
    const elsewhere = join(root, 'elsewhere-hooks');
    mkdirSync(elsewhere);
    rmSync(join(repo, '.git', 'hooks'), { recursive: true });
    symlinkSync(elsewhere, join(repo, '.git', 'hooks'));
    expect(inspectRepoConfig(repo, { inspectHooks: false }).findings).toEqual([]);
    expect(summary(inspectRepoConfig(repo).findings)).toEqual([`hook:${join(repo, '.git', 'hooks')}`]);
  });

  it('skips the hooks directory when asked, and still inspects the config', () => {
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    execFileSync('git', ['config', 'filter.x.clean', 'cat'], { cwd: repo, env: gitEnv() });
    expect(summary(inspectRepoConfig(repo).findings)).toEqual(
      ['driver:filter.x.clean', `hook:${join(repo, '.git', 'hooks', 'pre-commit')}`].sort(),
    );
    expect(summary(inspectRepoConfig(repo, { inspectHooks: false }).findings)).toEqual(['driver:filter.x.clean']);

    // A hooks directory that is not even listable costs nothing either.
    rmSync(join(repo, '.git', 'hooks'), { recursive: true });
    symlinkSync(join(root, 'missing-hooks'), join(repo, '.git', 'hooks'));
    expect(summary(inspectRepoConfig(repo, { inspectHooks: false }).findings)).toEqual(['driver:filter.x.clean']);
  });
});
