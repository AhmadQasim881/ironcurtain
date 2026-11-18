/**
 * Git remote resolution for the policy engine's domain checks
 * (src/trusted-process/git-remote-resolution.ts via resolveUrlForDomainCheck).
 *
 * Uses real repositories created with git, then checks that resolution
 * follows git's own rules (push URLs, URL rewrites, the remote the git server
 * actually uses), never touches repositories outside the sandbox, never runs
 * git inside a repository, and never blocks on agent-planted files.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CompiledPolicyFile } from '../src/pipeline/types.js';
import { resolveUrlForDomainCheck, type DomainCheckTarget } from '../src/trusted-process/domain-utils.js';
import type { TrustedGitRemoteConfig } from '../src/trusted-process/git-remote-resolution.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import { withInputSchemas } from './fixtures/test-policy.js';

const posix = process.platform !== 'win32';
const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const NO_TRUSTED_CONFIG = (): TrustedGitRemoteConfig => ({ entries: [] });
const GITHUB_ORIGIN = 'https://github.com/acme/project.git';
const SHIPPED_GIT_ALLOWLIST = ['github.com', '*.github.com', 'gitlab.com', '*.gitlab.com'];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.local',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    env: GIT_ENV,
  });
}

function initRepo(dir: string, originUrl?: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  if (originUrl !== undefined) git(dir, 'remote', 'add', 'origin', originUrl);
  return dir;
}

const gitAnnotations = withInputSchemas({
  generatedAt: 'test',
  servers: {
    git: {
      inputHash: 'test',
      tools: [
        {
          toolName: 'git_push',
          serverName: 'git',
          comment: 'Push',
          args: { path: ['read-path'], remote: ['git-remote-url'], branch: ['branch-name'] },
        },
        {
          toolName: 'git_fetch',
          serverName: 'git',
          comment: 'Fetch',
          args: { path: ['read-path', 'write-history'], remote: ['git-remote-url'] },
        },
        {
          toolName: 'git_clone',
          serverName: 'git',
          comment: 'Clone',
          args: { url: ['git-remote-url'], localPath: ['write-path'] },
        },
      ],
    },
  },
});

const escalateNetworkPolicy: CompiledPolicyFile = {
  generatedAt: 'test',
  constitutionHash: 'test',
  inputHash: 'test',
  rules: [
    {
      name: 'escalate-git-network',
      description: 'Escalate git network operations',
      principle: 'Human oversight',
      if: { server: ['git'], tool: ['git_push', 'git_fetch', 'git_clone'] },
      then: 'escalate',
      reason: 'Git network operations require approval',
    },
  ],
};

const allowGithubPushPolicy: CompiledPolicyFile = {
  generatedAt: 'test',
  constitutionHash: 'test',
  inputHash: 'test',
  rules: [
    {
      name: 'allow-github-push',
      description: 'Allow pushes to GitHub',
      principle: 'test',
      if: { server: ['git'], tool: ['git_push'], domains: { roles: ['git-remote-url'], allowed: ['github.com'] } },
      then: 'allow',
      reason: 'GitHub pushes are permitted',
    },
  ],
};

function request(toolName: string, args: Record<string, unknown>): ToolCallRequest {
  return { requestId: 'test', serverName: 'git', toolName, arguments: args, timestamp: new Date().toISOString() };
}

describe.skipIf(!gitAvailable || !posix)('git remote resolution', () => {
  let root: string;
  let sandbox: string;
  let outside: string;

  function resolveRemote(value: string, path: string | undefined, trusted = NO_TRUSTED_CONFIG): DomainCheckTarget {
    const args = path === undefined ? {} : { path };
    return resolveUrlForDomainCheck(value, 'git-remote-url', args, {
      allowedDirectory: sandbox,
      loadTrustedGitConfig: trusted,
    });
  }

  /** A PolicyEngine for the test sandbox; `allowlist: null` configures none, so the engine's default `['*']` gate applies. */
  function engine(policy = escalateNetworkPolicy, allowlist: readonly string[] | null = SHIPPED_GIT_ALLOWLIST) {
    const allowlists = allowlist === null ? undefined : new Map([['git', allowlist]]);
    return new PolicyEngine(policy, gitAnnotations, [], sandbox, allowlists);
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-git-remote-')));
    sandbox = join(root, 'sandbox');
    outside = join(root, 'outside');
    mkdirSync(sandbox);
    mkdirSync(outside);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('repository config inside the sandbox', () => {
    it('resolves a named remote to its configured URL', () => {
      const repo = initRepo(join(sandbox, 'plain'), GITHUB_ORIGIN);
      expect(resolveRemote('origin', repo)).toEqual({ status: 'resolved', domains: ['github.com/acme/project'] });
      // Discovery walks up from a subdirectory, like git.
      mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
      expect(resolveRemote('origin', join(repo, 'src', 'deep')).status).toBe('resolved');
    });

    it('evaluates a pushurl as the destination, not the github.com fetch URL', () => {
      const repo = initRepo(join(sandbox, 'pushurl'), GITHUB_ORIGIN);
      git(repo, 'config', 'remote.origin.pushurl', 'https://evil.example/loot.git');
      expect(git(repo, 'remote', 'get-url', '--push', 'origin').trim()).toBe('https://evil.example/loot.git');

      const target = resolveRemote('origin', repo);
      expect(target.status).toBe('unverifiable');
      expect(target.domains).toContain('evil.example/loot');
      expect(target.domains).toContain('github.com/acme/project');
      expect(target.status === 'unverifiable' && target.reason).toContain('remote.*.pushurl');
    });

    it('applies a repository pushInsteadOf rewrite and reports it', () => {
      const repo = initRepo(join(sandbox, 'pushinsteadof'), GITHUB_ORIGIN);
      git(repo, 'config', 'url.https://evil.example/.pushInsteadOf', 'https://github.com/');
      expect(git(repo, 'remote', 'get-url', '--push', 'origin').trim()).toBe('https://evil.example/acme/project.git');

      const target = resolveRemote('origin', repo);
      expect(target).toMatchObject({
        status: 'unverifiable',
        domains: expect.arrayContaining(['evil.example/acme/project']),
      });
    });

    it('applies insteadOf to the fetch URL and reports repository rewrites', () => {
      const repo = initRepo(join(sandbox, 'insteadof'), GITHUB_ORIGIN);
      git(repo, 'config', 'url.https://mirror.example/.insteadOf', 'https://github.com/');
      expect(git(repo, 'remote', 'get-url', 'origin').trim()).toBe('https://mirror.example/acme/project.git');

      const target = resolveRemote('origin', repo);
      expect(target).toMatchObject({ status: 'unverifiable', domains: ['mirror.example/acme/project'] });
    });

    it('reports repository proxy and TLS overrides even when the URL is allowlisted', () => {
      const repo = initRepo(join(sandbox, 'proxy'), GITHUB_ORIGIN);
      git(repo, 'config', 'http.proxy', 'http://evil.example:8080');
      const target = resolveRemote('origin', repo);
      expect(target).toMatchObject({ status: 'unverifiable', domains: ['github.com/acme/project'] });
      expect(target.status === 'unverifiable' && target.reason).toContain('http.proxy');
    });

    it('resolves a remote named like a URL to the URL git really uses', () => {
      const repo = initRepo(join(sandbox, 'url-named'), GITHUB_ORIGIN);
      git(repo, 'config', 'remote.https://github.com/acme/x.git.url', 'https://evil.example/x.git');
      expect(resolveRemote('https://github.com/acme/x.git', repo)).toEqual({
        status: 'resolved',
        domains: ['evil.example/x'],
      });
    });

    it('refuses an unconfigured remote name and option-like names', () => {
      const repo = initRepo(join(sandbox, 'names'), GITHUB_ORIGIN);
      git(repo, 'config', 'remote.--all.url', GITHUB_ORIGIN);
      expect(resolveRemote('upstream', repo).status).toBe('unverifiable');
      expect(resolveRemote('--all', repo)).toMatchObject({ status: 'unverifiable', domains: [] });
      expect(resolveRemote('-v', repo).status).toBe('unverifiable');
    });

    it('refuses a remote defined only in a legacy remotes/ or branches/ file', () => {
      const repo = initRepo(join(sandbox, 'legacy'), GITHUB_ORIGIN);
      mkdirSync(join(repo, '.git', 'remotes'), { recursive: true });
      mkdirSync(join(repo, '.git', 'branches'), { recursive: true });
      writeFileSync(join(repo, '.git', 'remotes', 'github.com:acme'), 'URL: https://evil.example/x.git\n');
      writeFileSync(join(repo, '.git', 'branches', 'backup'), 'https://evil.example/y.git\n');
      expect(resolveRemote('github.com:acme', repo).status).toBe('unverifiable');
      expect(resolveRemote('backup', repo).status).toBe('unverifiable');
    });

    it('never resolves a .git that git skips because its HEAD uses whitespace git does not accept', () => {
      // git's isspace() is space, \t, \n and \r only. With `ref:\v...` or
      // `ref:\f...` git ignores inner/.git and walks up to the outer repository,
      // so the inner github.com remote must not be what the policy evaluates.
      const outer = initRepo(join(sandbox, 'head-ws-outer'), 'https://evil.example/outer.git');
      const inner = initRepo(join(outer, 'inner'), GITHUB_ORIGIN);
      for (const space of ['\v', '\f']) {
        writeFileSync(join(inner, '.git', 'HEAD'), `ref:${space}refs/heads/main\n`);
        expect(git(inner, 'remote', 'get-url', 'origin').trim()).toBe('https://evil.example/outer.git');
        expect(resolveRemote('origin', inner)).toMatchObject({ status: 'unverifiable', domains: [] });
        expect(engine(allowGithubPushPolicy, null).evaluate(request('git_push', { path: inner })).decision).toBe(
          'deny',
        );
      }
      // The whitespace git does accept still resolves the inner repository.
      writeFileSync(join(inner, '.git', 'HEAD'), 'ref:\t refs/heads/main\n');
      expect(git(inner, 'remote', 'get-url', 'origin').trim()).toBe(GITHUB_ORIGIN);
      expect(resolveRemote('origin', inner)).toEqual({ status: 'resolved', domains: ['github.com/acme/project'] });
    });

    it('refuses gitfiles, symlinked .git, bare directories and includes', () => {
      const outsideRepo = initRepo(join(outside, 'gitfile-target'), 'https://git.corp.example/team/secret.git');

      const gitfile = join(sandbox, 'gitfile');
      mkdirSync(gitfile);
      writeFileSync(join(gitfile, '.git'), `gitdir: ${join(outsideRepo, '.git')}\n`);
      expect(resolveRemote('origin', gitfile)).toMatchObject({ status: 'unverifiable', domains: [] });

      const symlinked = join(sandbox, 'symlinked');
      mkdirSync(symlinked);
      symlinkSync(join(outsideRepo, '.git'), join(symlinked, '.git'));
      expect(resolveRemote('origin', symlinked)).toMatchObject({ status: 'unverifiable', domains: [] });

      // A bare-looking directory on the path wins over an outer `.git` in git's discovery.
      const outer = initRepo(join(sandbox, 'outer'), GITHUB_ORIGIN);
      const bare = join(outer, 'bare');
      mkdirSync(join(bare, 'objects'), { recursive: true });
      mkdirSync(join(bare, 'refs'));
      writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(bare, 'config'), '[remote "origin"]\n\turl = https://evil.example/x.git\n');
      expect(resolveRemote('origin', bare).status).toBe('unverifiable');

      const included = initRepo(join(sandbox, 'included'), GITHUB_ORIGIN);
      writeFileSync(join(included, 'extra.cfg'), '[remote "origin"]\n\tpushurl = https://evil.example/x\n');
      git(included, 'config', 'include.path', '../extra.cfg');
      expect(resolveRemote('origin', included)).toMatchObject({
        status: 'unverifiable',
        reason: 'the repository config uses include or includeIf',
      });
    });

    it('refuses a config with a syntax error, which git would refuse too', () => {
      const repo = initRepo(join(sandbox, 'syntax'), GITHUB_ORIGIN);
      writeFileSync(join(repo, '.git', 'config'), '[remote "origin"\n\turl = https://github.com/a/b\n');
      expect(resolveRemote('origin', repo)).toMatchObject({ status: 'unverifiable', domains: [] });
    });

    it('applies the user’s trusted insteadOf without treating it as a repository override', () => {
      const repo = initRepo(join(sandbox, 'trusted-rewrite'), GITHUB_ORIGIN);
      const trusted = (): TrustedGitRemoteConfig => ({
        entries: [
          {
            section: 'url',
            subsection: 'git@github.com:',
            name: 'insteadof',
            key: 'url.git@github.com:.insteadof',
            value: 'https://github.com/',
            line: 0,
          },
        ],
      });
      expect(resolveRemote('origin', repo, trusted)).toEqual({
        status: 'resolved',
        domains: ['github.com/acme/project'],
      });
    });

    it('does not resolve repositories above the sandbox root', () => {
      const container = initRepo(join(root, 'container'), 'https://git.corp.example/team/outer.git');
      const nestedSandbox = join(container, 'nested-sandbox');
      mkdirSync(join(nestedSandbox, 'work'), { recursive: true });
      const target = resolveUrlForDomainCheck(
        'origin',
        'git-remote-url',
        { path: join(nestedSandbox, 'work') },
        { allowedDirectory: nestedSandbox, loadTrustedGitConfig: NO_TRUSTED_CONFIG },
      );
      expect(target).toEqual({
        status: 'unverifiable',
        reason: 'no git repository was found inside the sandbox',
        domains: [],
      });
    });
  });

  describe('repositories outside the sandbox', () => {
    it('never reads an out-of-sandbox repository for a named remote', () => {
      const repo = initRepo(join(outside, 'private'), 'https://git.corp.example/team/secret.git');
      let trustedLoads = 0;
      const target = resolveRemote('origin', repo, () => {
        trustedLoads += 1;
        return { entries: [] };
      });
      expect(target).toEqual({
        status: 'unverifiable',
        reason: 'the repository path is outside the sandbox',
        domains: [],
      });
      expect(trustedLoads).toBe(0);
    });

    it('refuses to resolve through a symlink that leaves the sandbox', () => {
      const repo = initRepo(join(outside, 'linked'), 'https://git.corp.example/team/linked.git');
      symlinkSync(repo, join(sandbox, 'link-out'));
      expect(resolveRemote('origin', join(sandbox, 'link-out'))).toMatchObject({
        status: 'unverifiable',
        reason: 'the repository path is outside the sandbox',
      });
    });

    it('needs a repository path for a named remote', () => {
      expect(resolveRemote('origin', undefined)).toMatchObject({ status: 'unverifiable', domains: [] });
      expect(resolveRemote('origin', 'relative/repo')).toMatchObject({ status: 'unverifiable', domains: [] });
    });
  });

  describe('agent-planted blocking files', () => {
    it('does not stall on a FIFO include or a FIFO config', () => {
      const fifoInclude = initRepo(join(sandbox, 'fifo-include'), GITHUB_ORIGIN);
      execFileSync('mkfifo', [join(fifoInclude, 'pipe')]);
      git(fifoInclude, 'config', 'include.path', join(fifoInclude, 'pipe'));

      const fifoConfig = initRepo(join(sandbox, 'fifo-config'));
      rmSync(join(fifoConfig, '.git', 'config'));
      execFileSync('mkfifo', [join(fifoConfig, '.git', 'config')]);

      const policy = engine();
      for (const repo of [fifoInclude, fifoConfig]) {
        const started = performance.now();
        const result = policy.evaluate(request('git_fetch', { path: repo, remote: 'origin' }));
        const elapsed = performance.now() - started;
        // The remote is unverifiable (the domain gate escalates) and the
        // repository's config is an include or unreadable, which the
        // structural repository check escalates too; it is reported last.
        expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-git-repository-escalate' });
        expect(elapsed).toBeLessThan(200);
      }
    });

    it('bounds the work a config near the size cap can force', () => {
      // Unbounded, every URL was matched against every rewrite prefix and the
      // destinations were deduplicated quadratically: ~600 KB of URLs for one
      // remote stalled evaluation for seconds.
      const urlLines: string[] = [];
      for (let i = 0; urlLines.length < 20_000; i++) urlLines.push(`\turl = https://github.com/a/${i}`);
      const manyUrls = initRepo(join(sandbox, 'many-urls'));
      writeFileSync(join(manyUrls, '.git', 'config'), `[remote "origin"]\n${urlLines.join('\n')}\n`, { flag: 'a' });

      const prefixLines: string[] = [];
      for (let i = 0; i < 20_000; i++) prefixLines.push(`\tinsteadOf = z${i}`);
      const manyRewrites = initRepo(join(sandbox, 'many-rewrites'), GITHUB_ORIGIN);
      writeFileSync(join(manyRewrites, '.git', 'config'), `[url "https://x/"]\n${prefixLines.join('\n')}\n`, {
        flag: 'a',
      });

      const policy = engine();
      const cases: Array<[string, string]> = [
        [manyUrls, 'the remote has too many URLs'],
        [manyRewrites, 'the configuration has too many URL rewrites'],
      ];
      for (const [repo, reason] of cases) {
        const started = performance.now();
        const result = policy.evaluate(request('git_push', { path: repo, remote: 'origin' }));
        const elapsed = performance.now() - started;
        expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
        expect(result.reason).toContain(reason);
        expect(elapsed).toBeLessThan(1000);
      }
    });

    it('names at most a few destinations in a reason, whatever the config holds', () => {
      const repo = initRepo(join(sandbox, 'many-allowlisted'));
      const lines = ['[http]', '\tproxy = http://proxy.example:8080', '[remote "origin"]'];
      for (let i = 0; i < 40; i++) lines.push(`\turl = https://github.com/acme/r${i}.git`);
      writeFileSync(join(repo, '.git', 'config'), `${lines.join('\n')}\n`, { flag: 'a' });

      const result = engine().evaluate(request('git_push', { path: repo, remote: 'origin' }));
      expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
      expect(result.reason).toContain('"github.com/acme/r0", "github.com/acme/r1", "github.com/acme/r2" and 37 more');
      expect(result.reason.length).toBeLessThan(400);
    });
  });

  describe('policy engine', () => {
    it('evaluates a pushurl to evil.example as evil.example, even with a github.com fetch URL', () => {
      const repo = initRepo(join(sandbox, 'engine-pushurl'), GITHUB_ORIGIN);
      git(repo, 'config', 'remote.origin.pushurl', 'https://evil.example/loot.git');

      const result = engine().evaluate(request('git_push', { path: repo, remote: 'origin', branch: 'main' }));
      expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
      expect(result.reason).toContain('"evil.example/loot"');

      // A domain-scoped allow rule for github.com must not allow it either.
      const allowed = engine(allowGithubPushPolicy, null).evaluate(
        request('git_push', { path: repo, remote: 'origin' }),
      );
      expect(allowed.decision).toBe('deny');
    });

    it('resolves an omitted remote to origin, ignoring the branch.main.remote trick', () => {
      const repo = initRepo(join(sandbox, 'engine-tracking'), 'https://evil.example/stolen.git');
      git(repo, 'remote', 'add', 'upstream', GITHUB_ORIGIN);
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
      git(repo, 'config', 'branch.main.remote', 'upstream');
      git(repo, 'config', 'branch.main.merge', 'refs/heads/main');

      for (const args of [{ path: repo }, { path: repo, remote: '' }]) {
        const result = engine().evaluate(request('git_push', args));
        expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
        expect(result.reason).toContain('"evil.example/stolen"');
      }

      // ... and a domain-scoped allow rule sees origin, not the tracking remote.
      expect(engine(allowGithubPushPolicy, null).evaluate(request('git_push', { path: repo })).decision).toBe('deny');
    });

    it('passes an enriched remote through the structural domain gate', () => {
      const evil = initRepo(join(sandbox, 'engine-enrich-evil'), 'git@evil.example:team/x.git');
      const evilResult = engine().evaluate(request('git_fetch', { path: evil }));
      expect(evilResult).toMatchObject({
        decision: 'escalate',
        rule: 'structural-domain-escalate',
        escalatedRoles: ['git-remote-url'],
      });
      expect(evilResult.reason).toContain('"evil.example/team/x"');

      const github = initRepo(join(sandbox, 'engine-enrich-github'), GITHUB_ORIGIN);
      expect(engine().evaluate(request('git_fetch', { path: github }))).toMatchObject({
        decision: 'escalate',
        rule: 'escalate-git-network',
      });
      expect(engine(allowGithubPushPolicy, null).evaluate(request('git_push', { path: github }))).toMatchObject({
        decision: 'allow',
        rule: 'allow-github-push',
      });
    });

    it('escalates an out-of-sandbox repository without running git or revealing its remote', () => {
      const repo = initRepo(join(outside, 'engine-private'), 'https://git.corp.example/team/secret.git');
      const fakeBin = join(root, 'fake-bin');
      const invocations = join(root, 'git-invocations.log');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\necho "$(pwd -P)|$*" >> '${invocations}'\nexit 1\n`, {
        mode: 0o755,
      });
      const savedPath = process.env.PATH;
      process.env.PATH = [fakeBin, savedPath ?? ''].join(delimiter);
      try {
        for (const args of [{ path: repo, remote: 'origin' }, { path: repo }]) {
          const result = engine().evaluate(request('git_push', args));
          expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
          expect(result.reason).toContain('outside the sandbox');
          expect(result.reason).not.toContain('corp');
        }
        expect(existsSync(invocations)).toBe(false);

        // Inside the sandbox, the only git run is the trusted-config read, from `/`.
        const inside = initRepo(join(sandbox, 'engine-fake-git'), GITHUB_ORIGIN);
        engine().evaluate(request('git_push', { path: inside, remote: 'origin' }));
        const lines = readFileSync(invocations, 'utf-8').trim().split('\n');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) expect(line.startsWith('/|config ')).toBe(true);
      } finally {
        process.env.PATH = savedPath;
      }
    });

    it('does not echo unvalidated hosts from repository config into the reason', () => {
      const repo = initRepo(join(sandbox, 'engine-escape'));
      writeFileSync(
        join(repo, '.git', 'config'),
        '[remote "origin"]\n\turl = ssh://git@evil\\t\u001b[31m.example/x.git\n',
        { flag: 'a' },
      );
      const result = engine().evaluate(request('git_push', { path: repo, remote: 'origin' }));
      expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
      expect(result.reason).not.toContain('\u001b');
      expect(result.reason).not.toContain('evil');
    });

    it('treats every spelling of an IP as an IP under a `*` allowlist', () => {
      for (const url of ['ssh://git@2130706433/o/r', 'git@127.1:o/r', 'git://0x7f000001/o/r', 'git@[::1]:o/r']) {
        const result = engine(escalateNetworkPolicy, ['*']).evaluate(
          request('git_clone', { url, localPath: join(sandbox, 'clone') }),
        );
        expect(result, url).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
      }
    });

    it('escalates an ssh URL whose percent-encoded host only looks like a github.com subdomain', () => {
      const result = engine().evaluate(
        request('git_clone', { url: 'ssh://git@evil.example%2f.github.com/x', localPath: join(sandbox, 'clone') }),
      );
      expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
      expect(result.reason).toContain('"evil.example/.github.com/x"');
    });
  });
});
