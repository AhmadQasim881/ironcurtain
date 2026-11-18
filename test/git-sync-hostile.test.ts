/**
 * Cron git sync against a workspace written by a hostile agent.
 *
 * After the first sync, each test plants something in the workspace that
 * host git would honour if it ran there (config keys that run programs,
 * hooks, attribute-selected filters, redirected remotes, gitfile/symlink/
 * commondir redirects, ...). The next sync must run none of it, must fetch
 * the job's own URL, and must leave the tracked files equal to upstream with
 * a `.git` IronCurtain wrote itself.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncGitRepo, type GitSyncResult } from '../src/cron/git-sync.js';
import { inspectRepoConfig } from '../src/security/git-hardening.js';
import {
  createGitSyncFixture,
  gitAtLeast,
  gitAvailable,
  posix,
  startLagProbe,
  type GitSyncFixture,
} from './fixtures/git-sync-fixture.js';

const UPSTREAM_FILES = {
  'README.md': 'upstream readme\n',
  'src/app.js': 'console.log("upstream");\n',
  'filtered.txt': 'filtered\n',
};

describe.skipIf(!gitAvailable || !posix)('git sync against a hostile workspace', () => {
  let f: GitSyncFixture;
  let secret: string;
  let secretCommit: string;

  beforeEach(async () => {
    f = createGitSyncFixture();
    f.commitUpstream(UPSTREAM_FILES, 'one');
    secret = f.createRepository('secret', { 'SECRET.txt': 'host-only secret\n' });
    secretCommit = f.head(secret);
    const first = await syncGitRepo(f.syncOptions());
    expect(first).toMatchObject({ ok: true });
    // Upstream moves on, so the next sync fetches, moves refs and checks files out:
    // every point where the old in-workspace git ran planted code.
    f.commitUpstream({ 'README.md': 'upstream readme v2\n', 'filtered.txt': 'filtered v2\n' }, 'two');
    // The agent also edits a tracked file, so diffing and resetting have work to do.
    writeFileSync(join(f.workspace, 'src', 'app.js'), 'console.log("agent");\n');
  });

  afterEach(() => {
    f.cleanup();
  });

  const dotGit = (...parts: string[]): string => join(f.workspace, '.git', ...parts);

  /** Replace the workspace .git/config with the given sections (after a minimal core section). */
  function writeWorkspaceConfig(...lines: string[]): void {
    writeFileSync(
      dotGit('config'),
      ['[core]', '\trepositoryformatversion = 0', '\tbare = false', ...lines, ''].join('\n'),
    );
  }

  function appendWorkspaceConfig(...lines: string[]): void {
    appendFileSync(dotGit('config'), ['', ...lines, ''].join('\n'));
  }

  /** A complete repository outside the workspace that a redirect can point at, armed with payloads. */
  function armedRepository(): string {
    const evil = f.createRepository('evil', { 'EVIL.txt': 'evil\n' });
    appendFileSync(
      join(evil, '.git', 'config'),
      [
        '[core]',
        `\tfsmonitor = "${f.touch('evil-fsmonitor')}; false"`,
        '[remote "origin"]',
        `\turl = ${f.uri}`,
        `\tuploadpack = "${f.touch('evil-uploadpack')}; git-upload-pack"`,
        '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        '',
      ].join('\n'),
    );
    mkdirSync(join(evil, '.git', 'hooks'), { recursive: true });
    for (const hook of ['post-checkout', 'reference-transaction']) {
      const path = join(evil, '.git', 'hooks', hook);
      writeFileSync(path, `#!/bin/sh\n${f.touch(`evil-hook-${hook}`)}\n`);
      chmodSync(path, 0o755);
    }
    return evil;
  }

  /** Sync, then check the invariants every hostile case shares. */
  async function syncAndExpectSafe(): Promise<GitSyncResult> {
    const result = await syncGitRepo(f.syncOptions());
    // Checked first, before any test-side git touches the workspace.
    expect(f.markersCreated()).toEqual([]);
    expect(result).toMatchObject({ ok: true, branch: 'main', commit: f.head() });

    // The fetch went to the job's URL: the mirror and the agent's origin/* hold upstream, never the secret repo.
    expect(f.git(f.root, '--git-dir', f.mirror, 'rev-parse', 'refs/heads/main').trim()).toBe(f.head());
    const secretInMirror = spawnSync('git', ['--git-dir', f.mirror, 'cat-file', '-e', `${secretCommit}^{commit}`], {
      env: f.baseEnv,
      stdio: 'ignore',
    });
    expect(secretInMirror.status).not.toBe(0);
    // The workspace .git is a plain directory IronCurtain wrote, with nothing host git would execute.
    expect(lstatSync(dotGit()).isDirectory()).toBe(true);
    expect(inspectRepoConfig(f.workspace, { stopAt: f.workspace }).findings).toEqual([]);
    expect(f.git(f.workspace, 'config', '--get', 'remote.origin.url').trim()).toBe(f.uri);
    expect(f.git(f.workspace, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(f.head());

    // Tracked files match upstream, and nothing from the secret repository arrived.
    for (const [path, content] of f.trackedFiles()) {
      expect(readFileSync(join(f.workspace, path), 'utf8')).toBe(content);
    }
    expect(existsSync(join(f.workspace, 'SECRET.txt'))).toBe(false);
    expect(f.git(f.workspace, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    return result;
  }

  it('does not run core.fsmonitor from the workspace config', async () => {
    appendWorkspaceConfig('[core]', `\tfsmonitor = "${f.touch('fsmonitor')}; false"`);
    await syncAndExpectSafe();
  });

  it('does not run executable hooks planted in the workspace .git', async () => {
    mkdirSync(dotGit('hooks'), { recursive: true });
    const hooks = [
      'post-checkout',
      'post-merge',
      'reference-transaction',
      'post-index-change',
      'pre-auto-gc',
      'post-rewrite',
      'fsmonitor-watchman',
      'pre-commit',
    ];
    for (const hook of hooks) {
      writeFileSync(dotGit('hooks', hook), `#!/bin/sh\n${f.touch(`hook-${hook}`)}\n`);
      chmodSync(dotGit('hooks', hook), 0o755);
    }
    // core.hooksPath pointing back at them must not help either.
    appendWorkspaceConfig('[core]', `\thooksPath = ${dotGit('hooks')}`);
    await syncAndExpectSafe();
  });

  it('does not run filter or diff drivers selected through .git/info/attributes', async () => {
    mkdirSync(dotGit('info'), { recursive: true });
    writeFileSync(dotGit('info', 'attributes'), '* filter=evil diff=evil merge=evil\nfiltered.txt filter=evilproc\n');
    writeFileSync(join(f.root, 'attributes'), '* filter=evil diff=evil\n');
    appendWorkspaceConfig(
      '[core]',
      `\tattributesFile = ${join(f.root, 'attributes')}`,
      '[filter "evil"]',
      `\tsmudge = "${f.touch('smudge')}; cat"`,
      `\tclean = "${f.touch('clean')}; cat"`,
      '[filter "evilproc"]',
      `\tprocess = "${f.touch('filter-process')}"`,
      '[diff "evil"]',
      `\ttextconv = "${f.touch('textconv')}; cat"`,
      `\tcommand = "${f.touch('diff-command')}"`,
      '[diff]',
      `\texternal = "${f.touch('diff-external')}"`,
    );
    await syncAndExpectSafe();
  });

  it('does not run remote.origin.uploadpack', async () => {
    appendWorkspaceConfig('[remote "origin"]', `\tuploadpack = "${f.touch('uploadpack')}; git-upload-pack"`);
    await syncAndExpectSafe();
  });

  it('does not run core.sshCommand or core.gitProxy for an ssh or git origin', async () => {
    writeWorkspaceConfig(
      `\tsshCommand = "${f.touch('ssh-command')}; false"`,
      `\tgitProxy = "${f.touch('git-proxy')}"`,
      '[remote "origin"]',
      '\turl = ssh://example.invalid/repo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[remote "other"]',
      '\turl = git://example.invalid/repo.git',
    );
    await syncAndExpectSafe();
  });

  it('fetches the job URL, not a changed origin URL', async () => {
    writeWorkspaceConfig(
      '[remote "origin"]',
      `\turl = file://${secret}`,
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    );
    await syncAndExpectSafe();
  });

  it('ignores url.insteadOf rewrites and credential helpers in the workspace config', async () => {
    appendWorkspaceConfig(
      `[url "file://${secret}"]`,
      `\tinsteadOf = ${f.uri}`,
      '[credential]',
      `\thelper = "!${f.touch('credential-helper')}; false"`,
    );
    await syncAndExpectSafe();
  });

  it('ignores include.path and includeIf', async () => {
    writeFileSync(join(f.root, 'evil.cfg'), `[core]\n\tfsmonitor = "${f.touch('include-fsmonitor')}; false"\n`);
    appendWorkspaceConfig(
      '[include]',
      `\tpath = ${join(f.root, 'evil.cfg')}`,
      `[includeIf "gitdir:${f.root}/"]`,
      `\tpath = ${join(f.root, 'evil.cfg')}`,
    );
    await syncAndExpectSafe();
  });

  it('ignores a commondir redirect to an armed common directory', async () => {
    const common = join(f.workspace, 'evil-common');
    cpSync(dotGit(), common, { recursive: true });
    appendFileSync(join(common, 'config'), `\n[core]\n\tfsmonitor = "${f.touch('commondir-fsmonitor')}; false"\n`);
    writeFileSync(dotGit('commondir'), '../evil-common\n');
    await syncAndExpectSafe();
  });

  it('replaces a gitfile .git without touching the repository it points at', async () => {
    const evil = armedRepository();
    const evilConfig = readFileSync(join(evil, '.git', 'config'), 'utf8');
    rmSync(dotGit(), { recursive: true, force: true });
    writeFileSync(dotGit(), `gitdir: ${join(evil, '.git')}\n`);
    await syncAndExpectSafe();
    expect(readFileSync(join(evil, '.git', 'config'), 'utf8')).toBe(evilConfig);
    const armedHooks = readdirSync(join(evil, '.git', 'hooks')).filter((name) => !name.endsWith('.sample'));
    expect(armedHooks.sort()).toEqual(['post-checkout', 'reference-transaction']);
    expect(existsSync(join(f.workspace, 'EVIL.txt'))).toBe(false);
  });

  it('replaces a symlinked .git without following it', async () => {
    const evil = armedRepository();
    const evilConfig = readFileSync(join(evil, '.git', 'config'), 'utf8');
    rmSync(dotGit(), { recursive: true, force: true });
    symlinkSync(join(evil, '.git'), dotGit());
    await syncAndExpectSafe();
    expect(readFileSync(join(evil, '.git', 'config'), 'utf8')).toBe(evilConfig);
    expect(existsSync(join(evil, '.git', 'HEAD'))).toBe(true);
    expect(existsSync(join(evil, 'EVIL.txt'))).toBe(true);
  });

  it('never checks files out into a core.worktree redirect', async () => {
    const outside = join(f.root, 'outside-worktree');
    mkdirSync(outside);
    appendWorkspaceConfig('[core]', `\tworktree = ${outside}`);
    await syncAndExpectSafe();
    expect(readdirSync(outside)).toEqual([]);
  });

  it('does not borrow objects through objects/info/alternates', async () => {
    writeFileSync(dotGit('objects', 'info', 'alternates'), `${join(secret, '.git', 'objects')}\n`);
    await syncAndExpectSafe();
    expect(existsSync(dotGit('objects', 'info', 'alternates'))).toBe(false);
  });

  it('does not block on a FIFO planted as .git/HEAD or at a tracked path', async () => {
    rmSync(dotGit('HEAD'));
    execFileSync('mkfifo', [dotGit('HEAD')]);
    rmSync(join(f.workspace, 'README.md'));
    execFileSync('mkfifo', [join(f.workspace, 'README.md')]);
    const result = await syncAndExpectSafe();
    // The planted FIFO cannot hide the agent's edits from the report.
    expect(result.ok && result.discardedChanges).toMatch(/README\.md/u);
    expect(result.ok && result.discardedChanges).toMatch(/src\/app\.js/u);
  }, 30_000);

  it('does not write through symlinks planted at tracked paths', async () => {
    const outsideDir = join(f.root, 'outside-dir');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'app.js'), 'outside\n');
    const outsideFile = join(f.root, 'outside-file');
    writeFileSync(outsideFile, 'outside\n');
    rmSync(join(f.workspace, 'src'), { recursive: true, force: true });
    symlinkSync(outsideDir, join(f.workspace, 'src'));
    rmSync(join(f.workspace, 'README.md'));
    symlinkSync(outsideFile, join(f.workspace, 'README.md'));
    await syncAndExpectSafe();
    expect(readFileSync(join(outsideDir, 'app.js'), 'utf8')).toBe('outside\n');
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside\n');
    expect(lstatSync(join(f.workspace, 'src')).isDirectory()).toBe(true);
    expect(lstatSync(join(f.workspace, 'README.md')).isFile()).toBe(true);
  });

  it.skipIf(!gitAtLeast(2, 41))(
    'does not let a work-tree .gitattributes select a filter from trusted config',
    async () => {
      // A driver the user really configured (git-lfs style); only upstream attributes may select it.
      appendFileSync(
        join(f.home, '.gitconfig'),
        `[filter "userdrv"]\n\tclean = "${f.touch('user-clean')}; cat"\n\tsmudge = "${f.touch('user-smudge')}; cat"\n`,
      );
      writeFileSync(join(f.workspace, '.gitattributes'), '* filter=userdrv\n');
      await syncAndExpectSafe();
      expect(readFileSync(join(f.workspace, '.gitattributes'), 'utf8')).toBe('* filter=userdrv\n');
    },
  );

  it('reports only the agent edit as discarded and keeps untracked files', async () => {
    writeFileSync(join(f.workspace, 'last-run.md'), 'summary\n');
    const result = await syncAndExpectSafe();
    expect(result.ok && result.discardedChanges).toMatch(/src\/app\.js/u);
    expect(result.ok && result.discardedChanges).not.toMatch(/README|filtered/u);
    expect(readFileSync(join(f.workspace, 'last-run.md'), 'utf8')).toBe('summary\n');
  });
});

describe.skipIf(!gitAvailable || !posix)('git sync against a hung remote', () => {
  let f: GitSyncFixture;

  beforeEach(() => {
    f = createGitSyncFixture();
    f.commitUpstream(UPSTREAM_FILES, 'one');
  });

  afterEach(() => {
    f.cleanup();
  });

  it('times out a remote that accepts the connection and never answers, without blocking the event loop', async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const { port } = server.address() as AddressInfo;
    try {
      const probe = startLagProbe();
      const started = performance.now();
      const result = await syncGitRepo(
        f.syncOptions({
          uri: `http://127.0.0.1:${port}/repo.git`,
          timeouts: { remoteQueryMs: 1_500, initialFetchMs: 1_500, fetchMs: 1_500, localMs: 30_000 },
        }),
      );
      const lag = probe.stop();
      expect(result).toMatchObject({ ok: false, kind: 'sync_timeout' });
      expect(result.ok ? '' : result.message).toMatch(/timed out/u);
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(lag).toBeLessThan(100);
      // Nothing was set up for a repository that never answered.
      expect(existsSync(f.mirror)).toBe(false);
      expect(readdirSync(f.workspace)).toEqual([]);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  }, 30_000);

  it('times out a fetch that stalls over ssh, kills the ssh process and keeps the event loop free', async () => {
    // A stand-in ssh: the first connection (ls-remote) serves the upstream,
    // the second (the fetch) hangs. It records how git invoked it. Named
    // `ssh` so git treats it as OpenSSH instead of probing it with -G.
    mkdirSync(join(f.root, 'bin'));
    const fakeSsh = join(f.root, 'bin', 'ssh');
    const log = join(f.root, 'ssh.log');
    const state = join(f.root, 'ssh.state');
    const pidFile = join(f.root, 'ssh.pid');
    writeFileSync(
      fakeSsh,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${log}`,
        `if [ ! -e ${state} ]; then`,
        `  : > ${state}`,
        `  exec git upload-pack ${f.upstream}`,
        'fi',
        `echo $$ > ${pidFile}`,
        'exec sleep 600',
        '',
      ].join('\n'),
    );
    chmodSync(fakeSsh, 0o755);

    const probe = startLagProbe();
    const started = performance.now();
    const result = await syncGitRepo(
      f.syncOptions({
        uri: 'ssh://example.invalid/repo.git',
        baseEnv: { ...f.baseEnv, GIT_SSH_COMMAND: fakeSsh },
        timeouts: { remoteQueryMs: 20_000, initialFetchMs: 1_500, fetchMs: 1_500, localMs: 30_000 },
      }),
    );
    const lag = probe.stop();
    expect(result).toMatchObject({ ok: false, kind: 'sync_timeout' });
    expect(result.ok ? '' : result.message).toMatch(
      /^fetching ssh:\/\/example\.invalid\/repo\.git: git fetch timed out/u,
    );
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(lag).toBeLessThan(100);

    // ssh ran in batch mode with connect and keepalive limits, for both connections.
    const invocations = readFileSync(log, 'utf8').trim().split('\n');
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      for (const option of ['BatchMode=yes', 'ConnectTimeout=30', 'ServerAliveInterval=15', 'ServerAliveCountMax=4']) {
        expect(invocation).toContain(`-o ${option}`);
      }
    }
    // The stalled ssh (here: sleep) was killed with git's process group.
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    expect(existsSync(f.mirror)).toBe(false);
  }, 40_000);
});
