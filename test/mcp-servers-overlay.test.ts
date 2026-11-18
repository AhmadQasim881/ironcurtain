/**
 * The user-level MCP server configuration (`$IRONCURTAIN_HOME/mcp-servers.json`,
 * src/config/mcp-servers-overlay.ts): servers it adds reach the runtime
 * (loadConfig), the pipeline (loadPipelineConfig, used by compile-policy and
 * annotate-tools) and annotate-tools; built-in servers may only be adjusted
 * through env and their network allowlist; every field is validated and
 * reserved names are refused in either file.
 */

import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeProtectedPaths, loadConfig } from '../src/config/index.js';
import {
  collectDeclaredEnvVars,
  describeMcpServerAdjustments,
  getPackageMcpServersPath,
  isMcpServersConfigError,
  loadBuiltinMcpServers,
  loadMcpServers,
  removeUserMcpServerEntry,
  updateUserMcpServers,
  warnOnMcpServerAdjustments,
  type McpServersConfigError,
} from '../src/config/mcp-servers-overlay.js';
import { getUserMcpServersPath } from '../src/config/paths.js';
import { getCredentialEnvKeys } from '../src/config/trusted-env.js';
import { checkConfigLoad } from '../src/doctor/checks.js';
import { MEMORY_SERVER_NAME } from '../src/memory/memory-annotations.js';
import { main as annotateMain } from '../src/pipeline/annotate.js';
import { loadPipelineConfig } from '../src/pipeline/pipeline-shared.js';
import { RESERVED_SERVER_NAMES, SESSION_INJECTED_SERVER_NAMES } from '../src/types/reserved-servers.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_SERVER = resolve(projectRoot, 'test/fixtures/cwd-probe-server.mjs');
const IS_ROOT = process.getuid?.() === 0;
/** loadConfig() rethrows the loader's error unchanged. */
const McpErrorMatcher = /is not a valid MCP server configuration/;

let root: string;
let home: string;
let userPath: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-mcp-overlay-')));
  home = join(root, 'home');
  userPath = join(home, 'mcp-servers.json');
  vi.stubEnv('IRONCURTAIN_HOME', home);
  vi.stubEnv('ALLOWED_DIRECTORY', join(root, 'sandbox'));
  // loadUserConfig() announces the config file it creates; loaders warn.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function writeUserFile(value: unknown, mode = 0o600): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(userPath, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode });
  chmodSync(userPath, mode);
}

function writeHome(): void {
  writeUserFile({});
}

/** The error a load throws (the loader throws synchronously). */
function loadError(fn: () => unknown): McpServersConfigError {
  try {
    fn();
  } catch (err) {
    if (isMcpServersConfigError(err)) return err;
    throw err;
  }
  throw new Error('expected the load to fail');
}

const NOTES = { command: '/opt/notes/bin/server', args: ['--stdio'], description: 'Notes' };

describe('loading', () => {
  beforeEach(() => {
    writeHome();
  });

  it('is the package servers alone when there is no user file', () => {
    rmSync(userPath);
    const loaded = loadMcpServers();
    expect(loaded.userFileExists).toBe(false);
    expect(loaded.userServers).toEqual([]);
    expect(loaded.adjustments).toEqual([]);
    expect(Object.keys(loaded.servers)).toEqual(loaded.builtinServers);
    expect(loaded.builtinServers).toEqual(expect.arrayContaining(['filesystem', 'git', 'fetch', 'github']));
    expect(loaded.servers).toEqual(loadBuiltinMcpServers());
  });

  it('adds a user server after the built-ins, in every reader: runtime, compile and annotate', async () => {
    writeUserFile({ _comment: 'mine', notes: { ...NOTES, _comment: 'kept out of the definition' } });

    const loaded = loadMcpServers();
    expect(loaded.userServers).toEqual(['notes']);
    expect(Object.keys(loaded.servers).at(-1)).toBe('notes');
    expect(loaded.servers.notes).toEqual(NOTES);

    // Runtime: sessions spawn from loadConfig().mcpServers.
    expect(loadConfig().mcpServers.notes).toEqual(NOTES);
    // Pipeline: compile-policy and annotate-tools load loadPipelineConfig().
    expect(loadPipelineConfig().mcpServers.notes).toEqual(NOTES);
  });

  it('annotate-tools knows a server defined only in the user file', async () => {
    writeUserFile({ probe: { command: process.execPath, args: [PROBE_SERVER], sandbox: false } });
    const output: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    const savedExitCode = process.exitCode;
    try {
      // --check connects to the server and reports it as not annotated yet:
      // it is configured (an unknown server would exit at once).
      await annotateMain(['--check', '--server', 'probe']);
      expect(exit).not.toHaveBeenCalled();
      expect(output.join('\n')).not.toContain("unknown server 'probe'");
      expect(output.join('\n')).toContain('probe');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = savedExitCode;
    }
  }, 30_000);

  it('resolves package-relative paths for built-ins only; user servers run as written', () => {
    writeUserFile({ local: { command: 'node', args: ['node_modules/some-mcp/index.js', './src/server.ts'] } });
    const servers = loadConfig().mcpServers;
    expect(servers.local.args).toEqual(['node_modules/some-mcp/index.js', './src/server.ts']);
    expect(isAbsolute(servers.git.args[0])).toBe(true);
  });

  it('ignores comment keys and an empty file', () => {
    writeUserFile({ _comment: 'nothing yet' });
    expect(loadMcpServers().userServers).toEqual([]);
    writeUserFile({});
    expect(loadMcpServers().userFileExists).toBe(true);
  });
});

describe('validation', () => {
  beforeEach(() => {
    writeHome();
  });

  it('names the file and each offending field, and fails closed in loadConfig', () => {
    writeUserFile({
      notes: { command: '/opt/notes', args: 'not-an-array', extra: 1 },
      net: { command: 'npx', args: [], sandbox: { network: { allowedDomains: ['https://x.example'] } } },
      envy: { command: 'npx', args: [], env: { 'bad name': '1', OK: 2 } },
      rel: { command: './bin/server', args: [] },
    });
    const err = loadError(() => loadMcpServers());
    expect(err.code).toBe('MCP_SERVERS_INVALID');
    expect(err.path).toBe(userPath);
    expect(err.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^notes\.args: expected an array/),
        'notes.extra: unknown field',
        expect.stringMatching(/^net\.sandbox\.network\.allowedDomains\[0\]: is not a domain pattern/),
        expect.stringMatching(/^envy\.env\.OK: expected a string/),
        expect.stringMatching(/^rel\.command: "\.\/bin\/server" is a relative path/),
      ]),
    );
    expect(err.message).toContain(`${userPath} is not a valid MCP server configuration`);
    expect(() => loadConfig()).toThrow(/notes\.extra: unknown field/);
    expect(() => loadPipelineConfig()).toThrow(/MCP server configuration/);
  });

  it('refuses an env name that is not one', () => {
    writeUserFile({ envy: { command: 'npx', args: [], env: { 'bad name': '1' } } });
    expect(loadError(() => loadMcpServers()).problems).toEqual([
      'envy.env["bad name"]: not an environment variable name',
    ]);
  });

  it('refuses a file that is not JSON or not an object', () => {
    writeUserFile('{not json');
    expect(loadError(() => loadMcpServers()).problems[0]).toMatch(/^not valid JSON/);
    writeUserFile(['notes']);
    expect(loadError(() => loadMcpServers()).problems[0]).toMatch(/expected an object/);
  });

  it.each([['UpperCase'], ['under_score'], ['double--hyphen'], ['-leading'], ['1digit'], ['a'.repeat(64)]])(
    'refuses the server name %j',
    (name) => {
      writeUserFile({ [name]: NOTES });
      expect(loadError(() => loadMcpServers()).problems[0]).toMatch(/invalid server name/);
    },
  );

  it('accepts names of lowercase letters, digits and single hyphens', () => {
    writeUserFile({ 'my-server2': NOTES, x: NOTES });
    expect(loadMcpServers().userServers).toEqual(['my-server2', 'x']);
  });

  it('refuses the reserved names in the user file', () => {
    writeUserFile({ proxy: NOTES, memory: NOTES });
    const problems = loadError(() => loadMcpServers()).problems;
    expect(problems).toEqual([
      expect.stringMatching(/^proxy: the server name "proxy" is reserved/),
      expect.stringMatching(/^memory: the server name "memory" is reserved for the memory server/),
    ]);
  });

  // `network` (the MITM egress-policy namespace) and `workflow` (the
  // coordinator's workflow_commit tool) are virtual servers too: a user server
  // under either name would share their annotations and rules.
  it.each(['network', 'workflow'])('refuses the reserved virtual server name %j in the user file', (name) => {
    expect(RESERVED_SERVER_NAMES.has(name)).toBe(true);
    writeUserFile({ [name]: NOTES });
    expect(loadError(() => loadMcpServers()).problems).toEqual([
      `${name}: the server name "${name}" is reserved for IronCurtain's internal tools`,
    ]);
    expect(() => loadConfig()).toThrow(McpErrorMatcher);
  });

  it('refuses every reserved virtual server name, in either file', () => {
    const packagePath = join(root, 'package-mcp-servers.json');
    for (const name of RESERVED_SERVER_NAMES) {
      writeUserFile({ [name]: NOTES });
      expect(loadError(() => loadMcpServers()).problems[0]).toMatch(/is reserved for IronCurtain's internal tools/);
      writeFileSync(packagePath, JSON.stringify({ [name]: NOTES }));
      const err = loadError(() => loadMcpServers({ packagePath, userPath }));
      expect(err.path).toBe(packagePath);
      expect(err.problems[0]).toMatch(/is reserved for IronCurtain's internal tools/);
    }
  });

  it('refuses the reserved names in the package file too', () => {
    const packagePath = join(root, 'package-mcp-servers.json');
    writeFileSync(packagePath, JSON.stringify({ memory: NOTES }));
    const err = loadError(() => loadMcpServers({ packagePath, userPath }));
    expect(err.path).toBe(packagePath);
    expect(err.problems[0]).toMatch(/reserved for the memory server/);
  });

  it('reserves the name sessions give the memory server', () => {
    expect(SESSION_INJECTED_SERVER_NAMES.has(MEMORY_SERVER_NAME)).toBe(true);
    expect(RESERVED_SERVER_NAMES.has('proxy')).toBe(true);
  });

  it('refuses a user file every user can write', () => {
    writeUserFile({ notes: NOTES }, 0o666);
    expect(loadError(() => loadMcpServers()).problems[0]).toMatch(/every user can write it \(mode 0666\)/);
    // Group-writable (a user-private-group umask) is accepted.
    chmodSync(userPath, 0o664);
    expect(loadMcpServers().userServers).toEqual(['notes']);
  });

  it.skipIf(!fifoSupported)(
    'refuses a FIFO at the user path without blocking, here and in the credential loader',
    () => {
      rmSync(userPath, { force: true });
      makeFifo(userPath);
      const unblocker = startFifoUnblocker(userPath, 5);
      const started = Date.now();
      let problems: readonly string[];
      let keys: ReadonlySet<string>;
      try {
        problems = loadError(() => loadMcpServers()).problems;
        keys = getCredentialEnvKeys(undefined, userPath);
      } finally {
        unblocker.stop();
      }
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(problems).toEqual(['(top level): not a regular file']);
      expect(keys.has('ANTHROPIC_API_KEY')).toBe(true);
    },
  );

  it.runIf(IS_ROOT)('refuses a user file owned by another user', () => {
    writeUserFile({ notes: NOTES });
    // Root may read any file; the check is about who could have written it.
    chownSync(userPath, 12345, 12345);
    expect(loadError(() => loadMcpServers()).problems[0]).toMatch(/the file is owned by uid 12345/);
  });

  it('validates the shipped file with the same schema', () => {
    expect(() => loadBuiltinMcpServers()).not.toThrow();
    const packagePath = join(root, 'package-mcp-servers.json');
    writeFileSync(packagePath, JSON.stringify({ broken: { command: 'node' } }));
    expect(loadError(() => loadBuiltinMcpServers(packagePath)).problems).toEqual([
      'broken.args: missing (expected an array)',
    ]);
  });
});

describe('built-in servers (owner decision: add only; adjust documented fields)', () => {
  beforeEach(() => {
    writeHome();
  });

  it.each([
    [{ git: { command: '/bin/sh' } }, /^git\.command: the command of the built-in server "git" cannot be replaced/],
    [{ git: { args: ['x'] } }, /^git\.args: the arguments of the built-in server "git" cannot be replaced/],
    [{ git: { description: 'x' } }, /^git\.description: the description of the built-in server "git" cannot be/],
    [{ filesystem: { sandbox: false } }, /^filesystem\.sandbox: the sandbox of the built-in server "filesystem"/],
    [
      { filesystem: { sandbox: { filesystem: { confineToRoots: false } } } },
      /^filesystem\.sandbox\.filesystem: the sandbox of the built-in server "filesystem" cannot be replaced/,
    ],
    [
      { filesystem: { sandbox: { network: { allowedDomains: ['*'] } } } },
      /^filesystem\.sandbox\.network: the built-in server "filesystem" has no network allowlist to adjust/,
    ],
    [{ fetch: { sandbox: { network: { allowedDomains: ['x.example'] } } } }, /fetch\.sandbox\.network: the built-in/],
    [{ git: { sandbox: { network: false } } }, /^git\.sandbox\.network: the sandbox of the built-in server "git"/],
    [{ git: { timeout: 3 } }, /^git\.timeout: unknown field/],
    [{ git: 'replace me' }, /^git: expected an object/],
  ])('refuses %j', (file, problem) => {
    writeUserFile(file);
    const err = loadError(() => loadMcpServers());
    expect(err.problems).toEqual([expect.stringMatching(problem)]);
    expect(() => loadConfig()).toThrow(McpErrorMatcher);
  });

  it.each(['NODE_OPTIONS', 'LD_PRELOAD', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL', 'HTTPS_PROXY', 'PATH', 'DOCKER_HOST'])(
    'refuses the process-level variable %s in a built-in env adjustment',
    (name) => {
      writeUserFile({ git: { env: { [name]: 'x' } } });
      expect(loadError(() => loadMcpServers()).problems).toEqual([
        expect.stringMatching(new RegExp(`^git\\.env\\.${name}: cannot be set for a built-in server`)),
      ]);
    },
  );

  it('merges env adjustments key by key and replaces the network lists', () => {
    const shipped = loadBuiltinMcpServers();
    writeUserFile({
      git: {
        _why: 'self-hosted forge',
        env: { LOG_LEVEL: 'debug' },
        sandbox: { network: { allowedDomains: ['github.com', 'git.example.com'], deniedDomains: ['evil.example'] } },
      },
      fetch: { env: { SEARCH_REGION: 'eu' } },
    });
    const loaded = loadMcpServers();
    const git = loaded.servers.git;
    expect(git.command).toBe(shipped.git.command);
    expect(git.args).toEqual(shipped.git.args);
    expect(git.env).toEqual({ ...shipped.git.env, LOG_LEVEL: 'debug' });
    expect(git.sandbox).toEqual({
      ...(shipped.git.sandbox as object),
      network: { allowedDomains: ['github.com', 'git.example.com'], deniedDomains: ['evil.example'] },
    });
    expect(loaded.servers.fetch.env).toEqual({ ...shipped.fetch.env, SEARCH_REGION: 'eu' });
    expect(loaded.servers.fetch.sandbox).toBe(false);
    expect(loaded.adjustments).toEqual([
      {
        server: 'git',
        env: ['LOG_LEVEL'],
        allowedDomains: ['github.com', 'git.example.com'],
        deniedDomains: ['evil.example'],
      },
      { server: 'fetch', env: ['SEARCH_REGION'] },
    ]);
    // The user's adjustments never change who the built-in is.
    expect(loaded.userServers).toEqual([]);
  });

  it('keeps the shipped allowlist when only the denylist is adjusted', () => {
    const shipped = loadBuiltinMcpServers();
    writeUserFile({ git: { sandbox: { network: { deniedDomains: ['gitlab.com'] } } } });
    const gitSandbox = loadMcpServers().servers.git.sandbox;
    const shippedNetwork = shipped.git.sandbox && shipped.git.sandbox.network;
    expect(gitSandbox && gitSandbox.network).toEqual({
      allowedDomains: shippedNetwork ? shippedNetwork.allowedDomains : [],
      deniedDomains: ['gitlab.com'],
    });
  });

  it('warns about every adjustment, once per process however often it is loaded', () => {
    writeUserFile({ git: { env: { LOG_LEVEL: 'warn-once-check' } } });
    const loaded = loadMcpServers();
    expect(describeMcpServerAdjustments(loaded)).toEqual([
      `Warning: ${userPath} adjusts the built-in MCP server "git": env LOG_LEVEL.`,
    ]);
    const written: string[] = [];
    warnOnMcpServerAdjustments(loaded, (text) => written.push(text));
    warnOnMcpServerAdjustments(loadMcpServers(), (text) => written.push(text));
    expect(written).toEqual([`Warning: ${userPath} adjusts the built-in MCP server "git": env LOG_LEVEL.\n`]);
  });

  it('loadConfig prints the adjustment warning', () => {
    writeUserFile({ git: { env: { LOG_LEVEL: 'loadconfig-warning-check' } } });
    loadConfig();
    const stderr = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0]));
    expect(stderr.some((line) => line.includes('adjusts the built-in MCP server "git"'))).toBe(true);
  });

  it('an empty adjustment changes nothing and warns about nothing', () => {
    writeUserFile({ git: {}, fetch: { env: {} } });
    const loaded = loadMcpServers();
    expect(loaded.adjustments).toEqual([]);
    expect(loaded.servers.git).toEqual(loadBuiltinMcpServers().git);
  });
});

describe('doctor', () => {
  it('reports an invalid user file under "MCP servers", naming the file to fix', () => {
    writeUserFile({ git: { command: '/bin/sh' } });
    const { result, config } = checkConfigLoad();
    expect(config).toBeUndefined();
    expect(result).toMatchObject({ name: 'MCP servers', status: 'fail' });
    expect(result.message).toContain('git.command');
    expect(result.hint).toContain(userPath);
  });
});

describe('protection', () => {
  it('lists the user file as a protected path, even when it does not exist', () => {
    const paths = computeProtectedPaths({
      constitutionPath: join(root, 'constitution.md'),
      generatedDir: join(root, 'generated'),
      packageGeneratedDir: join(root, 'generated'),
      mcpServersPath: getPackageMcpServersPath(),
      auditLogPath: join(root, 'audit.jsonl'),
    });
    expect(paths).toContain(getUserMcpServersPath());
    expect(getUserMcpServersPath()).toBe(userPath);
  });

  it('loadConfig protects it as well as the shipped file', () => {
    const { protectedPaths } = loadConfig();
    expect(protectedPaths).toContain(userPath);
    expect(protectedPaths).toContain(realpathSync(getPackageMcpServersPath()));
  });
});

describe('updateUserMcpServers', () => {
  it('writes the edited file owner-only, keeping comments and other entries', () => {
    writeUserFile({ _comment: 'keep me', other: NOTES });
    chmodSync(userPath, 0o644);
    const { loaded, result } = updateUserMcpServers((entries) => {
      entries.notes = NOTES;
      return 'done';
    });
    expect(result).toBe('done');
    expect(loaded.userServers).toEqual(['other', 'notes']);
    expect(statSync(userPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(userPath, 'utf-8'))).toEqual({ _comment: 'keep me', other: NOTES, notes: NOTES });
  });

  it('creates the file (and the home) when absent', () => {
    updateUserMcpServers((entries) => {
      entries.notes = NOTES;
    });
    expect(loadMcpServers().userServers).toEqual(['notes']);
  });

  it('never rewrites a broken file by default, and writes nothing when the edit is invalid', () => {
    writeUserFile({ broken: { command: 'x' } });
    const before = readFileSync(userPath, 'utf-8');
    expect(() =>
      updateUserMcpServers((entries) => {
        entries.notes = NOTES;
      }),
    ).toThrow(/broken\.args/);
    expect(readFileSync(userPath, 'utf-8')).toBe(before);

    writeUserFile({ ok: NOTES });
    const valid = readFileSync(userPath, 'utf-8');
    expect(() =>
      updateUserMcpServers((entries) => {
        entries.git = { command: '/bin/sh', args: [] };
      }),
    ).toThrow(/git\.command/);
    expect(readFileSync(userPath, 'utf-8')).toBe(valid);
  });
});

describe('removeUserMcpServerEntry', () => {
  it('removes a broken entry, keeping comments and the other entries, owner-only', () => {
    writeUserFile({ _comment: 'keep me', broken: { command: 'x' }, ok: NOTES }, 0o644);
    expect(removeUserMcpServerEntry('broken')).toEqual({ removed: true, remainingProblems: [] });
    expect(JSON.parse(readFileSync(userPath, 'utf-8'))).toEqual({ _comment: 'keep me', ok: NOTES });
    expect(statSync(userPath).mode & 0o777).toBe(0o600);
    expect(loadMcpServers().userServers).toEqual(['ok']);
  });

  it('removes one entry of several broken ones and returns what is still wrong', () => {
    // Every loader refuses this file; neither entry could be removed if the
    // result had to be valid.
    writeUserFile({ a: { command: 'x' }, b: { command: 'y' }, MyServer: NOTES });
    const first = removeUserMcpServerEntry('a');
    expect(first.removed).toBe(true);
    expect(first.remainingProblems).toEqual([
      'b.args: missing (expected an array)',
      expect.stringMatching(/^MyServer: invalid server name/),
    ]);
    expect(Object.keys(JSON.parse(readFileSync(userPath, 'utf-8')) as object)).toEqual(['b', 'MyServer']);
    expect(removeUserMcpServerEntry('MyServer').remainingProblems).toEqual(['b.args: missing (expected an array)']);
    expect(removeUserMcpServerEntry('b')).toEqual({ removed: true, remainingProblems: [] });
    expect(loadMcpServers().userFileExists).toBe(true);
  });

  it('writes nothing for an entry that is not there, or when there is no file', () => {
    writeUserFile({ broken: { command: 'x' } });
    const before = readFileSync(userPath, 'utf-8');
    expect(removeUserMcpServerEntry('other')).toEqual({ removed: false, remainingProblems: [] });
    expect(readFileSync(userPath, 'utf-8')).toBe(before);
    rmSync(userPath);
    expect(removeUserMcpServerEntry('other').removed).toBe(false);
    expect(existsSync(userPath)).toBe(false);
  });

  it('still refuses a file that is not an object or that every user can write', () => {
    writeUserFile(['notes']);
    expect(() => removeUserMcpServerEntry('notes')).toThrow(/expected an object/);
    writeUserFile({ notes: NOTES }, 0o666);
    expect(() => removeUserMcpServerEntry('notes')).toThrow(/every user can write it/);
    expect(JSON.parse(readFileSync(userPath, 'utf-8'))).toEqual({ notes: NOTES });
  });
});

describe('collectDeclaredEnvVars', () => {
  it('collects -e passthroughs, credential-like env keys and empty-valued slots', () => {
    expect(
      collectDeclaredEnvVars({
        command: 'docker',
        args: ['run', '-e', 'GITHUB_TOKEN', '-e', 'LITERAL=1', 'img'],
        env: { DATABASE_URL: '', MCP_TRANSPORT_TYPE: 'stdio', SERVICE_API_KEY: 'inline' },
      }),
    ).toEqual(['DATABASE_URL', 'GITHUB_TOKEN', 'SERVICE_API_KEY']);
  });
});
