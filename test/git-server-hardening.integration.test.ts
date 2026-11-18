/**
 * End-to-end check that the relay hardens the git MCP backend against
 * repository configuration an agent planted.
 *
 * Spawns the real relay (`mcp-proxy-server.ts`, `SERVER_FILTER=git`) with the
 * shipped `git` entry from `mcp-servers.json` and drives the real
 * `@cyanheads/git-mcp-server` over MCP stdio, as a session does. The
 * repository inside `ALLOWED_DIRECTORY` carries what an agent can write
 * there (Code Mode through the filesystem server, Docker Agent Mode through
 * the bind-mounted workspace): command-valued `core.*` keys, an include,
 * hooks, repository credential helpers, a `remote.<name>.uploadpack` and
 * remotes over `file`, `ext`, ssh and https. Every planted command touches a
 * file in `markers/`, which must stay empty after git_status, git_log,
 * git_diff, git_commit, git_checkout and git_fetch; clones over `file://`, a
 * local path and `ext::` must be refused. The user's own global ssh command
 * and credential helper (which touch files in `trusted/`) must still apply.
 *
 * The git entry runs with `sandbox: false`, so the result does not depend on
 * bubblewrap/socat: this is the protection left when srt is unavailable and
 * the sandbox policy only warns (and srt would block the marker writes
 * outside the sandbox anyway, hiding a failure).
 */

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMcpServerPaths } from '../src/config/index.js';
import type { MCPServerConfig } from '../src/config/types.js';
import { permissiveJsonSchemaValidator } from '../src/trusted-process/permissive-output-validator.js';
import { VERSION } from '../src/version.js';
import { createTlsIdentity } from './helpers/fake-parent-proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const proxyServerPath = resolve(projectRoot, 'src/trusted-process/mcp-proxy-server.ts');
const tsxBin = resolve(projectRoot, 'node_modules/.bin/tsx');
const generatedDir = resolve(projectRoot, 'src/config/generated');

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const posix = process.platform !== 'win32';

interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
}

/**
 * The https remote only has to answer 401 so that git consults credential
 * helpers. Certificate verification is off (`GIT_SSL_NO_VERIFY`, trusted
 * configuration: the git server's own `env` block, since a relay hands its
 * backend just the allowlist of child-env.ts, which has no TLS override):
 * CA-file handling differs between git's TLS backends, and trust is not
 * what this test is about.
 */
const TLS_ENV = { GIT_SSL_NO_VERIFY: '1' } as const;

describe.skipIf(!gitAvailable || !posix)('git MCP backend hardening through the relay', () => {
  let root: string;
  let home: string;
  let markers: string;
  let trusted: string;
  let upstream: string;
  let outer: string;
  let sandbox: string;
  let repo: string;
  let plain: string;
  let setupEnv: NodeJS.ProcessEnv;
  let server: https.Server;
  let httpsOrigin: string;
  let client: Client;
  let relayStderr = '';

  const marker = (name: string): string => join(markers, name);
  const touch = (name: string): string => `touch ${marker(name)}`;
  /** Test-side git for fixtures and controls: the plain environment, hooks off. */
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: setupEnv, encoding: 'utf8' });

  async function call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const result = await client.callTool({ name, arguments: args }, CompatibilityCallToolResultSchema, {
      timeout: 60_000,
    });
    const content = Array.isArray(result.content) ? (result.content as Array<{ text?: unknown }>) : [];
    const text = content.map((item) => (typeof item.text === 'string' ? item.text : '')).join('\n');
    return { isError: result.isError === true, text };
  }

  async function expectSuccess(name: string, args: Record<string, unknown>): Promise<string> {
    const outcome = await call(name, args);
    expect(outcome, `${name} failed: ${outcome.text}\nrelay stderr:\n${relayStderr}`).toMatchObject({
      isError: false,
    });
    return outcome.text;
  }

  async function expectRefused(name: string, args: Record<string, unknown>, reason?: string): Promise<void> {
    const outcome = await call(name, args);
    expect(outcome.isError, `${name} unexpectedly succeeded: ${outcome.text}`).toBe(true);
    if (reason !== undefined) expect(outcome.text).toContain(reason);
  }

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-git-relay-')));
    expect(root).toMatch(/^[\w/.-]+$/u); // embedded unquoted in shell snippets below
    home = join(root, 'home');
    markers = join(root, 'markers');
    trusted = join(root, 'trusted');
    upstream = join(root, 'upstream');
    // A repository above the session (a home-directory dotfiles repo, say).
    outer = join(root, 'outer');
    sandbox = join(outer, 'session', 'sandbox');
    repo = join(sandbox, 'repo');
    plain = join(sandbox, 'plain');
    for (const dir of [home, markers, trusted, join(root, 'relay-cwd'), join(root, 'ironcurtain-home'), plain]) {
      mkdirSync(dir, { recursive: true });
    }

    // The user's own (trusted) global configuration: identity, an ssh
    // command and a credential helper that must keep working.
    const trustedSsh = join(root, 'trusted-ssh.sh');
    writeFileSync(trustedSsh, `#!/bin/sh\ntouch ${join(trusted, 'ssh-command')}\nexit 1\n`);
    chmodSync(trustedSsh, 0o755);
    writeFileSync(
      join(home, '.gitconfig'),
      [
        '[user]',
        '\tname = IronCurtain Test',
        '\temail = test@localhost',
        '[init]',
        '\tdefaultBranch = main',
        '[core]',
        `\tsshCommand = ${trustedSsh}`,
        '[credential]',
        `\thelper = "!f() { touch ${join(trusted, 'credential-helper')}; echo username=agent; echo password=secret; }; f"`,
        '',
      ].join('\n'),
    );
    setupEnv = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      ...TLS_ENV,
    };

    const tls = createTlsIdentity(['localhost']);
    server = https.createServer({ key: tls.keyPem, cert: tls.certPem }, (_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      response.end();
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    httpsOrigin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

    git(root, 'init', '-q', upstream);
    git(upstream, 'commit', '-q', '--allow-empty', '-m', 'upstream');
    git(root, 'init', '-q', outer);
    writeFileSync(join(plain, 'notes.txt'), 'not a repository\n');
    git(root, 'init', '-q', repo);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'init');

    // Everything below is what an agent can plant in its own repository.
    writeFileSync(join(sandbox, 'include.cfg'), `[core]\n\tfsmonitor = "${touch('include-fsmonitor')}; false"\n`);
    const planted = [
      '[core]',
      `\tfsmonitor = "${touch('fsmonitor')}; false"`,
      `\tpager = "${touch('pager')}; cat"`,
      `\teditor = "${touch('editor')}; true"`,
      `\tsshCommand = "${touch('repo-ssh-command')}; false"`,
      '[sequence]',
      `\teditor = "${touch('sequence-editor')}; true"`,
      '[include]',
      `\tpath = ${join(sandbox, 'include.cfg')}`,
      '[credential]',
      `\thelper = "!${touch('repo-credential-helper')}; false"`,
      `[credential "${httpsOrigin}"]`,
      `\thelper = "!${touch('repo-url-credential-helper')}; false"`,
      '[remote "origin"]',
      `\turl = ${upstream}`,
      `\tuploadpack = "${touch('uploadpack')}; git-upload-pack"`,
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[remote "viafile"]',
      `\turl = file://${upstream}`,
      `\tuploadpack = "${touch('uploadpack-file-url')}; git-upload-pack"`,
      '[remote "viaext"]',
      `\turl = "ext::sh -c ${touch('ext-remote').replace(' ', '% ')}"`,
      '[remote "viassh"]',
      '\turl = ssh://example.invalid/repo.git',
      '[remote "viahttps"]',
      `\turl = ${httpsOrigin}/repo.git`,
      '',
    ].join('\n');
    writeFileSync(join(repo, '.git', 'config'), planted, { flag: 'a' });
    for (const hook of [
      'pre-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-commit',
      'post-checkout',
      'reference-transaction',
      'post-index-change',
    ]) {
      const path = join(repo, '.git', 'hooks', hook);
      writeFileSync(path, `#!/bin/sh\n${touch(`hook-${hook}`)}\n`);
      chmodSync(path, 0o755);
    }

    const servers = JSON.parse(readFileSync(resolve(projectRoot, 'src/config/mcp-servers.json'), 'utf8')) as Record<
      string,
      MCPServerConfig
    >;
    // Test-only git settings go in the server's env block: of its own GIT_*
    // variables the relay forwards only git's config-file selection
    // (GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM, child-env.ts) to the backend.
    const gitConfig: MCPServerConfig = {
      ...servers.git,
      sandbox: false,
      env: { ...servers.git.env, GIT_CONFIG_NOSYSTEM: '1', ...TLS_ENV },
    };
    resolveMcpServerPaths({ git: gitConfig });

    client = new Client(
      { name: 'git-hardening-test', version: VERSION },
      { capabilities: { roots: { listChanged: true } }, jsonSchemaValidator: permissiveJsonSchemaValidator },
    );
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [proxyServerPath],
      cwd: join(root, 'relay-cwd'),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        LANG: 'C',
        IRONCURTAIN_HOME: join(root, 'ironcurtain-home'),
        MCP_SERVERS_CONFIG: JSON.stringify({ git: gitConfig }),
        SERVER_FILTER: 'git',
        GENERATED_DIR: generatedDir,
        PROTECTED_PATHS: '[]',
        SANDBOX_POLICY: 'warn',
        ALLOWED_DIRECTORY: sandbox,
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      relayStderr += chunk.toString('utf8');
    });
    await client.connect(transport, { timeout: 90_000 });
  }, 120_000);

  afterAll(async () => {
    if (typeof client !== 'undefined') await client.close().catch(() => {});
    await new Promise<void>((resolveClose) => {
      if (typeof server === 'undefined') resolveClose();
      else server.close(() => resolveClose());
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('runs no planted command on status, log, diff, commit, checkout and fetch', async () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');

    expect(await expectSuccess('git_status', { path: repo })).toContain('a.txt');
    expect(await expectSuccess('git_diff', { path: repo })).toContain('two');
    expect(await expectSuccess('git_log', { path: repo })).toContain('init');
    await expectSuccess('git_commit', { path: repo, message: 'change', filesToStage: ['a.txt'] });
    await expectSuccess('git_checkout', { path: repo, target: 'feature', createBranch: true });
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('change');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature');
    expect(readdirSync(markers)).toEqual([]);

    // Local transports are refused outright, so the planted uploadpack never runs.
    await expectRefused('git_fetch', { path: repo, remote: 'origin' }, "transport 'file' not allowed");
    await expectRefused('git_fetch', { path: repo, remote: 'viafile' }, "transport 'file' not allowed");
    await expectRefused('git_fetch', { path: repo, remote: 'viaext' }, "transport 'ext' not allowed");
    // ssh uses the user's trusted command (which fails here), never the repository's.
    await expectRefused('git_fetch', { path: repo, remote: 'viassh' });
    // https consults the user's global helper only; the repository's helpers are dropped.
    await expectRefused('git_fetch', { path: repo, remote: 'viahttps' }, 'Authentication failed');

    expect(readdirSync(markers)).toEqual([]);
    expect(readdirSync(trusted).sort()).toEqual(['credential-helper', 'ssh-command']);
  }, 120_000);

  it('refuses file://, local-path and ext:: clones', async () => {
    await expectRefused(
      'git_clone',
      { url: `file://${upstream}`, path: join(sandbox, 'clone-file-url') },
      "transport 'file' not allowed",
    );
    await expectRefused(
      'git_clone',
      { url: upstream, path: join(sandbox, 'clone-local-path') },
      "transport 'file' not allowed",
    );
    // The server's own URL schema already rejects ext:: here; a planted ext::
    // remote (fetched above) is what reaches git and GIT_ALLOW_PROTOCOL.
    await expectRefused('git_clone', {
      url: `ext::sh -c ${touch('ext-clone').replace(' ', '% ')}`,
      path: join(sandbox, 'clone-ext'),
    });
    for (const name of ['clone-file-url', 'clone-local-path', 'clone-ext']) {
      expect(existsSync(join(sandbox, name, '.git'))).toBe(false);
    }
    expect(readdirSync(markers)).toEqual([]);
  }, 120_000);

  it('never discovers a repository above the allowed directory', async () => {
    // Control: plain git run from the sandbox finds the enclosing repository.
    expect(git(plain, 'rev-parse', '--show-toplevel').trim()).toBe(outer);
    await expectRefused('git_status', { path: plain }, 'not a git repository');
  }, 120_000);

  it('control: the same repository runs the plants under plain git', async () => {
    // Asynchronous, so this process keeps serving the https remote meanwhile.
    const plainGit = (...args: string[]): Promise<void> =>
      new Promise((resolveRun) => {
        execFile('git', args, { cwd: repo, env: setupEnv, timeout: 30_000 }, () => resolveRun());
      });
    await plainGit('status', '--porcelain');
    await plainGit('fetch', 'origin');
    await plainGit('fetch', 'viassh');
    await plainGit('fetch', 'viahttps');
    expect(readdirSync(markers)).toEqual(
      expect.arrayContaining([
        'include-fsmonitor',
        'uploadpack',
        'hook-reference-transaction',
        'repo-ssh-command',
        'repo-credential-helper',
        'repo-url-credential-helper',
      ]),
    );
  }, 60_000);
});
