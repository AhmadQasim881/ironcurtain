/**
 * Scratch repositories for the cron git-sync tests: an upstream work tree
 * served as a `file://` URL, a job directory (workspace + mirror), a private
 * HOME with its own global git config, and a markers directory that planted
 * payloads touch when they run.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { GitSyncOptions } from '../../src/cron/git-sync.js';

export const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
export const posix = process.platform !== 'win32';

/** `[major, minor]` of the installed git, or `[0, 0]`. */
export function gitVersion(): readonly [number, number] {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const match = /git version (\d+)\.(\d+)/u.exec(result.stdout);
  return match === null ? [0, 0] : [Number(match[1]), Number(match[2])];
}

export function gitAtLeast(major: number, minor: number): boolean {
  const [actualMajor, actualMinor] = gitVersion();
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

export interface GitSyncFixture {
  readonly root: string;
  readonly home: string;
  readonly markers: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Non-bare upstream repository (branch `main`). */
  readonly upstream: string;
  /** `file://` URL of {@link upstream}. */
  readonly uri: string;
  readonly jobDir: string;
  readonly workspace: string;
  readonly mirror: string;
  /** Test-side git (hooks off), never pointed at a planted repository before a sync. */
  git(cwd: string, ...args: string[]): string;
  /** Shell snippet that creates marker `name`. */
  touch(name: string): string;
  /** Markers created so far, sorted. */
  markersCreated(): string[];
  /** Write (string) or delete (null) files in the upstream and commit them; returns the commit id. */
  commitUpstream(changes: Readonly<Record<string, string | null>>, message?: string, repo?: string): string;
  /** Create another non-bare repository with the given files committed on `main`; returns its path. */
  createRepository(name: string, files: Readonly<Record<string, string>>): string;
  /** Path -> content of every file tracked at `HEAD` of a repository (default: the upstream). */
  trackedFiles(repo?: string): Map<string, string>;
  /** `HEAD` commit of a repository (default: the upstream). */
  head(repo?: string): string;
  syncOptions(overrides?: Partial<GitSyncOptions>): GitSyncOptions;
  cleanup(): void;
}

export function createGitSyncFixture(): GitSyncFixture {
  const root = mkdtempSync(join(tmpdir(), 'ironcurtain-git-sync-'));
  if (!/^[\w/.-]+$/u.test(root)) throw new Error(`unexpected characters in temp path ${root}`); // embedded in shell snippets
  const home = join(root, 'home');
  const markers = join(root, 'markers');
  mkdirSync(home);
  mkdirSync(markers);
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Test\n\temail = test@localhost\n[init]\n\tdefaultBranch = main\n',
  );
  const baseEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
  const jobDir = join(root, 'jobs', 'job-1');
  const workspace = join(jobDir, 'workspace');
  const mirror = join(jobDir, 'repo.git');

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd,
      env: baseEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const commitUpstream = (
    changes: Readonly<Record<string, string | null>>,
    message = 'update',
    repo = join(root, 'upstream'),
  ): string => {
    for (const [path, content] of Object.entries(changes)) {
      const target = join(repo, path);
      if (content === null) {
        git(repo, 'rm', '-q', '--', path);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
        git(repo, 'add', '--', path);
      }
    }
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', 'HEAD').trim();
  };

  const createRepository = (name: string, files: Readonly<Record<string, string>>): string => {
    const repo = join(root, name);
    git(root, 'init', '-q', '-b', 'main', repo);
    commitUpstream(files, `init ${name}`, repo);
    return repo;
  };

  const upstream = join(root, 'upstream');
  git(root, 'init', '-q', '-b', 'main', upstream);

  return {
    root,
    home,
    markers,
    baseEnv,
    upstream,
    uri: `file://${upstream}`,
    jobDir,
    workspace,
    mirror,
    git,
    touch: (name) => `touch ${join(markers, name)}`,
    markersCreated: () => readdirSync(markers).sort(),
    commitUpstream,
    createRepository,
    trackedFiles(repo = upstream) {
      const files = new Map<string, string>();
      for (const path of git(repo, 'ls-tree', '-r', '-z', '--name-only', 'HEAD').split('\0')) {
        if (path !== '') files.set(path, readFileSync(join(repo, path), 'utf8'));
      }
      return files;
    },
    head: (repo = upstream) => git(repo, 'rev-parse', 'HEAD').trim(),
    syncOptions(overrides = {}) {
      return {
        uri: `file://${upstream}`,
        workspaceDir: workspace,
        mirrorDir: mirror,
        managedWorkspace: true,
        baseEnv,
        timeouts: { remoteQueryMs: 30_000, initialFetchMs: 30_000, fetchMs: 30_000, localMs: 30_000 },
        ...overrides,
      };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Event-loop lag probe: the longest delay beyond `intervalMs` between timer callbacks. */
export function startLagProbe(intervalMs = 10): { stop(): number } {
  let last = performance.now();
  let maxLag = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - intervalMs);
    last = now;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return maxLag;
    },
  };
}
