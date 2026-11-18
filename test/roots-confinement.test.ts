/**
 * Unit and config-level tests for the filesystem server's confinement to its
 * MCP roots (src/trusted-process/roots-confinement.ts and the
 * `confineToRoots` handling in sandbox-integration.ts):
 *
 * - the hidden regions and the srt profile composition;
 * - which roots a profile may expose;
 * - how the program is located so it still runs with the home hidden;
 * - the restart supervisor the relay uses when the roots change;
 * - the macOS Seatbelt profile srt generates for the shipped filesystem
 *   entry (the config-level counterpart of the bubblewrap acceptance test in
 *   test/filesystem-toctou.integration.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPServerConfig } from '../src/config/types.js';
import type { ClientState, McpRoot } from '../src/trusted-process/mcp-client-manager.js';
import { rootUriForPath } from '../src/trusted-process/policy-roots.js';
import {
  ConfinedBackendSupervisor,
  InFlightCalls,
  confinedRootDirectories,
  confinedSandboxParams,
  isSafeReadPath,
  resolveConfinedLaunch,
  rootExposureRefusal,
  sameDirectorySet,
  type ConfinedBackendLauncher,
} from '../src/trusted-process/roots-confinement.js';
import {
  confinementHiddenRegions,
  resolveSandboxConfig,
  sandboxRuntimePackageDir,
  writeServerSettings,
  type ResolvedSandboxParams,
} from '../src/trusted-process/sandbox-integration.js';
import { getTrustedSpawnCwd } from '../src/trusted-process/spawn-cwd.js';
import { macosProfileFor, seatbeltReadDecision, seatbeltWriteDecision } from './helpers/seatbelt-profile.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Runs `fn` with environment overrides (undefined deletes), restoring the previous values afterwards. */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function loadShippedMcpServers(): Record<string, MCPServerConfig> {
  const path = fileURLToPath(new URL('../src/config/mcp-servers.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, MCPServerConfig>;
}

function resolveSandboxed(config: MCPServerConfig, sessionSandboxDir: string): ResolvedSandboxParams {
  const result = resolveSandboxConfig(config, sessionSandboxDir, true, 'enforce', 'test');
  if (!result.sandboxed) throw new Error('expected a sandboxed config');
  return result.config;
}

function root(path: string): McpRoot {
  return { uri: rootUriForPath(path), name: 'test' };
}

function writeFile(path: string, content = 'x'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeExecutable(path: string): void {
  writeFile(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
}

/**
 * A throwaway user home with an IronCurtain home holding the session
 * sandbox, a policy root, an approvable project, credential stores and a
 * private temp directory. Everything is canonical. Callers remove `base`.
 */
interface FakeHost {
  readonly base: string;
  readonly home: string;
  readonly icHome: string;
  readonly sandbox: string;
  readonly downloads: string;
  readonly approved: string;
  readonly other: string;
  readonly tmp: string;
}

function makeFakeHost(): FakeHost {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'roots-confinement-')));
  const home = join(base, 'home');
  const icHome = join(home, '.ironcurtain');
  const host: FakeHost = {
    base,
    home,
    icHome,
    sandbox: join(icHome, 'sessions', 's1', 'sandbox'),
    downloads: join(home, 'Downloads'),
    approved: join(home, 'projects', 'approved'),
    other: join(home, 'projects', 'other'),
    tmp: join(base, 'tmp'),
  };
  for (const dir of [host.sandbox, host.downloads, host.approved, host.other, host.tmp]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFile(join(home, 'data.txt'), 'HOME-SECRET');
  writeFile(join(icHome, 'config.json'), 'IC-SECRET');
  writeFile(join(home, '.aws', 'credentials'), 'AWS-SECRET');
  mkdirSync(join(home, '.aws', 'sso'), { recursive: true });
  mkdirSync(join(home, '.ssh', 'id_backup'), { recursive: true });
  return host;
}

/** Environment that points the confinement at a fake host. */
function hostEnv(host: FakeHost): Record<string, string | undefined> {
  return {
    HOME: host.home,
    TMPDIR: host.tmp,
    XDG_RUNTIME_DIR: undefined,
    IRONCURTAIN_HOME: undefined,
    ANTHROPIC_CONFIG_DIR: undefined,
    XDG_CONFIG_HOME: undefined,
    CODEX_HOME: undefined,
  };
}

// ── Hidden regions and the resolved profile ──────────────────────────────

describe('confinementHiddenRegions', () => {
  it('hides the home, the temporary directories and the per-user runtime directory', () => {
    const regions = withEnv(
      { HOME: '/home/u-test', TMPDIR: '/var/folders/x/T/', XDG_RUNTIME_DIR: '/run/user/4242' },
      () => confinementHiddenRegions(),
    );
    expect(regions).toEqual(['/home/u-test', '/var/folders/x/T', '/tmp', '/var/tmp', '/run/user/4242']);
  });

  it('never hides the filesystem root and ignores a relative runtime directory', () => {
    const regions = withEnv({ HOME: '/', TMPDIR: '/tmp', XDG_RUNTIME_DIR: 'run/user' }, () =>
      confinementHiddenRegions(),
    );
    expect(regions).toEqual(['/tmp', '/var/tmp']);
  });
});

describe('resolveSandboxConfig with confineToRoots', () => {
  let host: FakeHost;

  beforeEach(() => {
    host = makeFakeHost();
  });

  afterEach(() => {
    rmSync(host.base, { recursive: true, force: true });
  });

  it('confines the shipped filesystem server: hidden regions on top of the baseline, no network', () => {
    withEnv(hostEnv(host), () => {
      const params = resolveSandboxed(loadShippedMcpServers().filesystem, host.sandbox);
      expect(params.confineToRoots).toBe(true);
      expect(params.network).toBe(false);
      expect(params.denyRead).toEqual(
        expect.arrayContaining([host.icHome, join(host.home, '.aws'), host.home, host.tmp, '/tmp', '/var/tmp']),
      );
      // Roots are added by the relay at launch; the profile starts with the sandbox only.
      expect(params.allowRead).toEqual([host.sandbox]);
      expect(params.allowWrite).toEqual([host.sandbox]);
    });
  });

  it('leaves servers without confineToRoots as they were (git keeps reading the home)', () => {
    withEnv(hostEnv(host), () => {
      const params = resolveSandboxed(loadShippedMcpServers().git, host.sandbox);
      expect(params.confineToRoots).toBeUndefined();
      expect(params.denyRead).not.toContain(host.home);
      expect(params.denyRead).not.toContain(host.tmp);
    });
  });
});

// ── Root selection ───────────────────────────────────────────────────────

describe('confinedRootDirectories', () => {
  let host: FakeHost;

  beforeEach(() => {
    host = makeFakeHost();
  });

  afterEach(() => {
    rmSync(host.base, { recursive: true, force: true });
  });

  it('exposes existing canonical directories outside the sandbox, sorted and de-duplicated', () => {
    withEnv(hostEnv(host), () => {
      const roots = [root(host.sandbox), root(host.downloads), root(host.approved), root(host.downloads)];
      expect(confinedRootDirectories(roots, host.sandbox)).toEqual([host.downloads, host.approved].sort());
    });
  });

  it('drops roots in the sandbox, the IronCurtain home and the credential stores', () => {
    withEnv(hostEnv(host), () => {
      mkdirSync(join(host.sandbox, 'sub'));
      mkdirSync(join(host.icHome, 'oauth'));
      const roots = [
        root(join(host.sandbox, 'sub')),
        root(host.icHome),
        root(join(host.icHome, 'oauth')),
        root(join(host.home, '.aws')),
        root(join(host.home, '.aws', 'sso')),
        root(join(host.home, '.ssh', 'id_backup')),
      ];
      expect(confinedRootDirectories(roots, host.sandbox)).toEqual([]);
    });
  });

  it('refuses roots that contain the IronCurtain home, a credential store or a hidden region', () => {
    withEnv(hostEnv(host), () => {
      mkdirSync(join(host.home, '.config', 'gh'), { recursive: true });
      const refused = [
        host.home,
        dirname(host.home),
        '/',
        join(host.home, '.config'),
        join(host.home, '.ssh'),
        host.tmp,
        dirname(host.tmp),
      ];
      expect(confinedRootDirectories(refused.map(root), host.sandbox)).toEqual([]);
      for (const directory of refused) expect(rootExposureRefusal(directory), directory).toBeDefined();
      expect(rootExposureRefusal(host.home)).toMatch(/contains/);
      expect(rootExposureRefusal(join(host.icHome, 'oauth'))).toMatch(/in the IronCurtain home/);
      expect(rootExposureRefusal(host.downloads)).toBeUndefined();
      expect(rootExposureRefusal(host.approved)).toBeUndefined();
    });
  });

  // The baseline also hides the gcloud and kube stores, the shell startup
  // files and a `.env` in IronCurtain's package root: a root holding one of
  // them would re-open it (macOS re-allows reads inside a denied region).
  it('refuses roots in or around the cloud stores, shell startup files and the package-root .env', () => {
    withEnv(hostEnv(host), () => {
      const gcloud = join(host.home, '.config', 'gcloud');
      const kube = join(host.home, '.kube');
      const fish = join(host.home, '.config', 'fish');
      for (const dir of [gcloud, join(kube, 'cache'), join(fish, 'conf.d')]) mkdirSync(dir, { recursive: true });

      expect(rootExposureRefusal(gcloud)).toMatch(/in the IronCurtain home or a credential store/);
      expect(rootExposureRefusal(join(fish, 'conf.d'))).toMatch(/in the IronCurtain home or a credential store/);
      expect(rootExposureRefusal(kube)).toMatch(/contains the IronCurtain home or a credential store/);
      expect(rootExposureRefusal(join(kube, 'cache'))).toBeUndefined();
      // Whether or not a .env is there: the deny entry exists either way.
      const packageRoot = getTrustedSpawnCwd();
      expect(rootExposureRefusal(packageRoot)).toMatch(/contains the IronCurtain home or a credential store/);
      expect(rootExposureRefusal(dirname(packageRoot))).toMatch(/contains/);
      expect(confinedRootDirectories([gcloud, kube, packageRoot].map(root), host.sandbox)).toEqual([]);
    });
  });

  // Regression: srt reads allow entries as patterns. `Album [Live]` would
  // expose `Album L`, `Album i`, ... (readable on Linux, readable and
  // writable on macOS) and not the approved directory itself.
  it('refuses roots spelled with glob characters, which srt would read as a pattern', () => {
    withEnv(hostEnv(host), () => {
      const bracketed = join(host.home, 'Music', 'Album [Live]');
      const starred = join(host.home, 'notes*');
      const questioned = join(host.home, 'What?');
      const sibling = join(host.home, 'Music', 'Album L');
      for (const dir of [bracketed, starred, questioned, sibling]) mkdirSync(dir, { recursive: true });

      for (const dir of [bracketed, starred, questioned]) {
        expect(rootExposureRefusal(dir), dir).toMatch(/pattern/);
      }
      expect(confinedRootDirectories([bracketed, starred, questioned].map(root), host.sandbox)).toEqual([]);
      expect(rootExposureRefusal(sibling)).toBeUndefined();
    });
  });

  it('drops roots that are missing, files, redirected by a symlink, or not file: URIs', () => {
    withEnv(hostEnv(host), () => {
      const link = join(host.base, 'link-to-other');
      symlinkSync(host.other, link);
      const roots: McpRoot[] = [
        root(join(host.home, 'missing')),
        root(join(host.home, 'data.txt')),
        root(link),
        root(join(link, '.')),
        { uri: 'https://example.com/x', name: 'web' },
        { uri: 'not a uri', name: 'junk' },
      ];
      expect(confinedRootDirectories(roots, host.sandbox)).toEqual([]);
    });
  });

  it('compares directory sets regardless of order and duplicates', () => {
    expect(sameDirectorySet(['/a', '/b'], ['/b', '/a', '/a'])).toBe(true);
    expect(sameDirectorySet(['/a'], ['/a', '/b'])).toBe(false);
    expect(sameDirectorySet([], [])).toBe(true);
  });
});

// ── Profile composition ──────────────────────────────────────────────────

describe('confinedSandboxParams', () => {
  let host: FakeHost;

  beforeEach(() => {
    host = makeFakeHost();
  });

  afterEach(() => {
    rmSync(host.base, { recursive: true, force: true });
  });

  it('exposes the roots readable and writable and the program read-only', () => {
    withEnv(hostEnv(host), () => {
      const params = resolveSandboxed(loadShippedMcpServers().filesystem, host.sandbox);
      const nodePrefix = join(host.home, '.nvm', 'versions', 'node', 'v22.11.0');
      const confined = confinedSandboxParams(params, [host.downloads, host.approved], [nodePrefix, '/opt/node']);

      expect(confined.allowWrite).toEqual([host.sandbox, host.downloads, host.approved]);
      expect(confined.allowRead).toEqual([host.sandbox, host.downloads, host.approved, nodePrefix, '/opt/node']);
      expect(confined.denyRead).toEqual(params.denyRead);
      expect(confined.confineToRoots).toBe(true);
    });
  });

  it('never re-exposes a hidden region, an ancestor of one, or the baseline through a read path', () => {
    withEnv(hostEnv(host), () => {
      const unsafe = [host.home, dirname(host.home), '/', host.tmp, join(host.icHome, 'bin'), join(host.home, '.aws')];
      for (const path of unsafe) expect(isSafeReadPath(path)).toBe(false);
      expect(isSafeReadPath('relative/dir')).toBe(false);
      expect(isSafeReadPath(join(host.home, 'src', 'ironcurtain', 'node_modules'))).toBe(true);
      expect(isSafeReadPath('/usr/local')).toBe(true);

      const params = resolveSandboxed(loadShippedMcpServers().filesystem, host.sandbox);
      const confined = confinedSandboxParams(params, [], unsafe);
      expect(confined.allowRead).toEqual([host.sandbox]);
    });
  });

  // Regression: discoverNodePaths() and the installation of ~/.local/bin/node
  // both yield ~/.local, which holds ~/.local/share (keyrings, mail, shell
  // histories) and ~/.local/state.
  it('never re-exposes a per-user data directory or a directory holding one', () => {
    const custom = join(host.base, 'xdg-data');
    withEnv({ ...hostEnv(host), XDG_DATA_HOME: custom }, () => {
      const unsafe = [
        join(host.home, '.local'),
        join(host.home, '.local', 'share'),
        join(host.home, '.local', 'state'),
        join(host.home, '.config'),
        join(host.home, '.cache'),
        join(host.home, 'Library'),
        custom,
        dirname(custom),
      ];
      for (const path of unsafe) expect(isSafeReadPath(path), path).toBe(false);
      // Dedicated tool directories beneath them stay usable.
      for (const path of [
        join(host.home, '.local', 'bin'),
        join(host.home, '.local', 'share', 'fnm', 'node-versions', 'v24', 'installation'),
        join(host.home, '.config', 'nvm', 'versions', 'node', 'v24'),
        join(host.home, '.nvm', 'versions', 'node', 'v24'),
      ]) {
        expect(isSafeReadPath(path), path).toBe(true);
      }

      const params = resolveSandboxed(loadShippedMcpServers().filesystem, host.sandbox);
      const confined = confinedSandboxParams(params, [], [join(host.home, '.local'), join(host.home, '.local', 'bin')]);
      expect(confined.allowRead).toEqual([host.sandbox, join(host.home, '.local', 'bin')]);
    });
  });

  it('never re-exposes a read path spelled with glob characters, which srt would read as a pattern', () => {
    withEnv(hostEnv(host), () => {
      for (const path of ['/opt/node[24]', '/opt/node-*', '/opt/node?/lib'])
        expect(isSafeReadPath(path), path).toBe(false);
    });
  });
});

// ── Launch resolution ────────────────────────────────────────────────────

describe('resolveConfinedLaunch', () => {
  let host: FakeHost;

  beforeEach(() => {
    host = makeFakeHost();
  });

  afterEach(() => {
    rmSync(host.base, { recursive: true, force: true });
  });

  it('runs the canonical program and script and exposes their installation and node_modules', () => {
    const prefix = join(host.base, 'opt', 'node-v22');
    writeExecutable(join(prefix, 'bin', 'node'));
    const linkBin = join(host.base, 'link-bin');
    mkdirSync(linkBin);
    symlinkSync(join(prefix, 'bin', 'node'), join(linkBin, 'node'));

    const realModules = join(host.base, 'pkg', 'node_modules');
    const script = join(realModules, '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js');
    writeFile(script);
    const checkout = join(host.base, 'checkout');
    mkdirSync(checkout);
    symlinkSync(realModules, join(checkout, 'node_modules'));
    const sandboxLink = join(host.base, 'sandbox-link');
    symlinkSync(host.sandbox, sandboxLink);

    const launch = withEnv(hostEnv(host), () =>
      resolveConfinedLaunch(
        'node',
        [join(checkout, 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js'), sandboxLink],
        { PATH: ['/usr/bin', '/bin'].join(delimiter) },
        // The relay's own Node.js, reached through a symlink.
        join(linkBin, 'node'),
      ),
    );

    expect(launch.command).toBe(join(prefix, 'bin', 'node'));
    expect(launch.args).toEqual([script, host.sandbox]);
    expect(launch.readPaths).toEqual(expect.arrayContaining([prefix, realModules]));
    const srtPackage = sandboxRuntimePackageDir();
    if (srtPackage !== undefined) expect(launch.readPaths).toContain(srtPackage);
    expect(launch.readPaths).not.toContain(dirname(script));
  });

  it('exposes only the bin directory of a program installed directly in the home', () => {
    writeExecutable(join(host.home, 'bin', 'node'));
    const launch = withEnv(hostEnv(host), () =>
      resolveConfinedLaunch('node', [], { PATH: '/usr/bin:/bin' }, join(host.home, 'bin', 'node')),
    );
    expect(launch.command).toBe(join(host.home, 'bin', 'node'));
    expect(launch.readPaths).toContain(join(host.home, 'bin'));
    expect(launch.readPaths).not.toContain(host.home);
  });

  // Regression: the prefix of ~/.local/bin/node (n with N_PREFIX=~/.local, a
  // tarball unpacked there) is ~/.local, which also holds every application's
  // data and state; exposing it let a swapped symlink read ~/.local/share.
  it('exposes only the bin directory of a Node.js installed into ~/.local, never the data beside it', () => {
    const localBin = join(host.home, '.local', 'bin');
    writeExecutable(join(localBin, 'node'));
    writeFile(join(host.home, '.local', 'share', 'keyrings', 'login.keyring'), 'KEYRING');
    const launch = withEnv(hostEnv(host), () =>
      resolveConfinedLaunch('node', [], { PATH: '/usr/bin:/bin' }, join(localBin, 'node')),
    );
    expect(launch.command).toBe(join(localBin, 'node'));
    expect(launch.readPaths).toContain(localBin);
    expect(launch.readPaths).not.toContain(join(host.home, '.local'));
  });

  // Regression: Volta (and mise) put a symlink named `node` on PATH that
  // points at one dispatcher binary choosing the tool by the name it was
  // started as. Its canonical path names the dispatcher, so running that
  // started the dispatcher instead of Node.js and the server never came up.
  it('runs node as the Node.js the relay runs on, never a version manager shim found on PATH', () => {
    const voltaBin = join(host.home, '.volta', 'bin');
    writeExecutable(join(voltaBin, 'volta-shim'));
    symlinkSync(join(voltaBin, 'volta-shim'), join(voltaBin, 'node'));
    const relayNode = join(host.base, 'opt', 'node-v24', 'bin', 'node');
    writeExecutable(relayNode);

    const launch = withEnv(hostEnv(host), () =>
      resolveConfinedLaunch('node', [], { PATH: [voltaBin, '/usr/bin', '/bin'].join(delimiter) }, relayNode),
    );
    expect(launch.command).toBe(relayNode);
    expect(launch.readPaths).toContain(join(host.base, 'opt', 'node-v24'));
    expect(launch.readPaths).not.toContain(join(host.home, '.volta'));
    expect(launch.readPaths).not.toContain(voltaBin);
  });

  it('looks up commands other than node on PATH and runs them by their canonical path', () => {
    const prefix = join(host.base, 'opt', 'tool');
    writeExecutable(join(prefix, 'bin', 'my-server'));
    const linkBin = join(host.base, 'link-bin');
    mkdirSync(linkBin);
    symlinkSync(join(prefix, 'bin', 'my-server'), join(linkBin, 'my-server'));
    const launch = withEnv(hostEnv(host), () =>
      resolveConfinedLaunch('my-server', [], { PATH: [linkBin, '/usr/bin', '/bin'].join(delimiter) }),
    );
    expect(launch.command).toBe(join(prefix, 'bin', 'my-server'));
    expect(launch.readPaths).toContain(prefix);
  });

  it("exposes a script's own directory when it is not in a node_modules tree", () => {
    const script = join(host.base, 'servers', 'custom', 'server.js');
    writeFile(script);
    const launch = resolveConfinedLaunch('node', [script], { PATH: '' });
    expect(launch.readPaths).toContain(join(host.base, 'servers', 'custom'));
  });

  it('keeps a command it cannot find, and arguments that are not existing absolute paths', () => {
    const launch = resolveConfinedLaunch('no-such-program-xyz', ['--flag', 'relative/arg', '/no/such/path'], {
      PATH: '/usr/bin',
    });
    expect(launch.command).toBe('no-such-program-xyz');
    expect(launch.args).toEqual(['--flag', 'relative/arg', '/no/such/path']);
  });

  it('puts the real directory of a shell linked from a hidden region first on PATH', () => {
    const store = join(host.base, 'nix', 'store', 'abc-bash-5.2', 'bin');
    writeExecutable(join(store, 'bash'));
    const profileBin = join(host.home, '.nix-profile', 'bin');
    mkdirSync(profileBin, { recursive: true });
    symlinkSync(join(store, 'bash'), join(profileBin, 'bash'));
    const pathEnv = [profileBin, '/usr/bin', '/bin'].join(delimiter);

    const launch = withEnv(hostEnv(host), () => resolveConfinedLaunch('node', [], { PATH: pathEnv }));
    expect(launch.pathEnv).toBe([store, pathEnv].join(delimiter));
    expect(launch.readPaths).toContain(store);
  });

  it('leaves PATH alone when the shell is visible inside the sandbox', () => {
    const shellDir = join(host.base, 'usr', 'bin');
    writeExecutable(join(shellDir, 'bash'));
    const launch = withEnv(hostEnv(host), () => resolveConfinedLaunch('node', [], { PATH: shellDir }));
    expect(launch.pathEnv).toBeUndefined();
    expect(launch.readPaths).toContain(shellDir);
  });
});

// ── Restarts ─────────────────────────────────────────────────────────────

interface FakeServer {
  readonly state: ClientState;
  readonly sendRootsListChanged: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

function fakeServer(): FakeServer {
  const sendRootsListChanged = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const client = { sendRootsListChanged, close } as unknown as Client;
  return { state: { client, roots: [] }, sendRootsListChanged, close };
}

/** A launcher whose launches are resolved (or rejected) by the test. */
function controlledLauncher() {
  const launches: Array<{
    readonly rootDirectories: readonly string[];
    readonly resolve: (server: FakeServer) => void;
    readonly reject: (err: Error) => void;
  }> = [];
  const closed: ClientState[] = [];
  const launcher: ConfinedBackendLauncher = {
    launch: (_serverName, rootDirectories) =>
      new Promise<ClientState>((resolveLaunch, rejectLaunch) => {
        launches.push({
          rootDirectories,
          resolve: (server) => resolveLaunch(server.state),
          reject: rejectLaunch,
        });
      }),
    close: async (state) => {
      closed.push(state);
      await state.client.close();
    },
  };
  return { launcher, launches, closed };
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe('ConfinedBackendSupervisor', () => {
  it('notifies the running server instead of restarting it when the exposed directories are unchanged', async () => {
    const current = fakeServer();
    const clientStates = new Map([['filesystem', current.state]]);
    const { launcher, launches } = controlledLauncher();
    const supervisor = new ConfinedBackendSupervisor(clientStates, launcher);
    supervisor.register('filesystem', ['/a', '/b']);

    expect(await supervisor.applyRoots('filesystem', ['/b', '/a'])).toBe('notified');
    expect(current.sendRootsListChanged).toHaveBeenCalledTimes(1);
    expect(launches).toHaveLength(0);
    expect(clientStates.get('filesystem')).toBe(current.state);
  });

  it('restarts the server with a profile for the new roots, then closes the old one', async () => {
    const current = fakeServer();
    const replacement = fakeServer();
    const clientStates = new Map([['filesystem', current.state]]);
    const { launcher, launches } = controlledLauncher();
    const log = vi.fn();
    const supervisor = new ConfinedBackendSupervisor(clientStates, launcher, log);
    supervisor.register('filesystem', ['/a']);

    const outcome = supervisor.applyRoots('filesystem', ['/a', '/approved']);
    await flush();
    expect(launches.map((l) => l.rootDirectories)).toEqual([['/a', '/approved']]);
    // Until the new server is up, the old one stays in place.
    expect(clientStates.get('filesystem')).toBe(current.state);
    launches[0].resolve(replacement);

    expect(await outcome).toBe('restarted');
    expect(clientStates.get('filesystem')).toBe(replacement.state);
    expect(current.close).toHaveBeenCalledTimes(1);
    expect(current.sendRootsListChanged).not.toHaveBeenCalled();
    expect(supervisor.exposedRoots('filesystem')).toEqual(['/a', '/approved']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restarting "filesystem"'));
  });

  it('stops the server when the restart fails, so its tools fail instead of running unconfined for the new roots', async () => {
    const current = fakeServer();
    const clientStates = new Map([['filesystem', current.state]]);
    const { launcher, launches } = controlledLauncher();
    const supervisor = new ConfinedBackendSupervisor(clientStates, launcher);
    supervisor.register('filesystem', ['/a']);

    const outcome = supervisor.applyRoots('filesystem', ['/a', '/approved']);
    await flush();
    launches[0].reject(new Error('bwrap: setting up uid map: Permission denied'));

    expect(await outcome).toBe('stopped');
    expect(clientStates.has('filesystem')).toBe(false);
    expect(current.close).toHaveBeenCalledTimes(1);
    expect(supervisor.manages('filesystem')).toBe(false);
    // Later root changes no longer reach it.
    expect(await supervisor.applyRoots('filesystem', ['/a'])).toBe('stopped');
  });

  it('makes calls wait for a restart in progress and reach the new server', async () => {
    const current = fakeServer();
    const replacement = fakeServer();
    const clientStates = new Map([['filesystem', current.state]]);
    const { launcher, launches } = controlledLauncher();
    const supervisor = new ConfinedBackendSupervisor(clientStates, launcher);
    supervisor.register('filesystem', ['/a']);

    void supervisor.applyRoots('filesystem', ['/a', '/approved']);
    let reached: ClientState | undefined;
    const call = supervisor.settled('filesystem').then(() => {
      reached = clientStates.get('filesystem');
    });
    await flush();
    expect(reached).toBeUndefined();

    launches[0].resolve(replacement);
    await call;
    expect(reached).toBe(replacement.state);
    // Nothing pending: a later call does not wait.
    await supervisor.settled('filesystem');
    await supervisor.settled('other-server');
  });

  it('serializes restarts and applies each root set in order', async () => {
    const first = fakeServer();
    const second = fakeServer();
    const third = fakeServer();
    const clientStates = new Map([['filesystem', first.state]]);
    const { launcher, launches } = controlledLauncher();
    const supervisor = new ConfinedBackendSupervisor(clientStates, launcher);
    supervisor.register('filesystem', ['/a']);

    const one = supervisor.applyRoots('filesystem', ['/a', '/b']);
    const two = supervisor.applyRoots('filesystem', ['/a', '/b', '/c']);
    await flush();
    expect(launches).toHaveLength(1);
    launches[0].resolve(second);
    expect(await one).toBe('restarted');
    await flush();
    expect(launches).toHaveLength(2);
    expect(launches[1].rootDirectories).toEqual(['/a', '/b', '/c']);
    launches[1].resolve(third);
    expect(await two).toBe('restarted');
    expect(clientStates.get('filesystem')).toBe(third.state);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('closes a server that finishes starting after the relay shut down', async () => {
    const current = fakeServer();
    const replacement = fakeServer();
    const clientStates = new Map([['filesystem', current.state]]);
    const { launcher, launches } = controlledLauncher();
    const supervisor = new ConfinedBackendSupervisor(clientStates, launcher);
    supervisor.register('filesystem', ['/a']);

    const outcome = supervisor.applyRoots('filesystem', ['/a', '/approved']);
    await flush();
    supervisor.close();
    launches[0].resolve(replacement);

    expect(await outcome).toBe('stopped');
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(clientStates.get('filesystem')).toBe(current.state);
  });

  it('does not manage servers it was not told about', async () => {
    const supervisor = new ConfinedBackendSupervisor(new Map(), controlledLauncher().launcher);
    expect(supervisor.manages('git')).toBe(false);
    expect(supervisor.exposedRoots('git')).toBeUndefined();
  });

  it('switches calls to the new server without waiting for the old one to finish closing', async () => {
    const current = fakeServer();
    const replacement = fakeServer();
    const clientStates = new Map([['filesystem', current.state]]);
    const closing: ClientState[] = [];
    const launcher: ConfinedBackendLauncher = {
      launch: async () => replacement.state,
      // The old server is still serving a call: its close never finishes here.
      close: (state) => {
        closing.push(state);
        return new Promise<void>(() => {});
      },
    };
    const supervisor = new ConfinedBackendSupervisor(clientStates, launcher);
    supervisor.register('filesystem', ['/a']);

    expect(await supervisor.applyRoots('filesystem', ['/a', '/approved'])).toBe('restarted');
    await supervisor.settled('filesystem');
    expect(clientStates.get('filesystem')).toBe(replacement.state);
    expect(closing).toEqual([current.state]);
  });
});

describe('InFlightCalls', () => {
  function deferred<T>() {
    const settle: { resolve?: (value: T) => void; reject?: (err: Error) => void } = {};
    const promise = new Promise<T>((res, rej) => {
      settle.resolve = res;
      settle.reject = rej;
    });
    return {
      promise,
      resolve: (value: T) => settle.resolve?.(value),
      reject: (err: Error) => settle.reject?.(err),
    };
  }

  it('lets a replaced backend finish the calls it is serving before it is closed', async () => {
    const calls = new InFlightCalls();
    const state = fakeServer().state;
    const first = deferred<string>();
    const second = deferred<string>();
    void calls.track(state, first.promise);
    void calls.track(state, second.promise).catch(() => undefined);
    expect(calls.count(state)).toBe(2);

    let drained = false;
    const drain = calls.drain(state).then(() => {
      drained = true;
    });
    first.resolve('done');
    await flush();
    expect(drained).toBe(false);
    second.reject(new Error('backend error'));
    await drain;
    expect(drained).toBe(true);
    expect(calls.count(state)).toBe(0);
  });

  it('returns the tracked call unchanged', async () => {
    const calls = new InFlightCalls();
    const state = fakeServer().state;
    await expect(calls.track(state, Promise.resolve(42))).resolves.toBe(42);
    await expect(calls.track(state, Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(calls.count(state)).toBe(0);
  });

  it('stops waiting after the timeout when a call never finishes', async () => {
    const calls = new InFlightCalls();
    const state = fakeServer().state;
    void calls.track(state, new Promise(() => {}));
    const started = Date.now();
    await calls.drain(state, 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(calls.count(state)).toBe(1);
  });

  it('does not wait for a backend that serves no calls', async () => {
    const calls = new InFlightCalls();
    await calls.drain(fakeServer().state, 60_000);
  });
});

// ── macOS: the Seatbelt profile srt generates ────────────────────────────

describe('macOS Seatbelt profile of the confined filesystem server (config level)', () => {
  let host: FakeHost;
  let settingsDir: string;

  beforeEach(() => {
    host = makeFakeHost();
    // The relay keeps srt settings and the server's cwd under os.tmpdir(),
    // which the confinement hides.
    settingsDir = join(host.tmp, 'ironcurtain-srt-test');
    mkdirSync(settingsDir);
  });

  afterEach(() => {
    rmSync(host.base, { recursive: true, force: true });
  });

  /** Writes the settings the relay would write for these roots and returns srt's macOS profile. */
  function profileFor(rootDirectories: readonly string[], readPaths: readonly string[]) {
    const params = resolveSandboxed(loadShippedMcpServers().filesystem, host.sandbox);
    const confined = confinedSandboxParams(params, rootDirectories, readPaths);
    const { settingsPath, cwdPath } = writeServerSettings('filesystem', confined, settingsDir);
    return { profile: macosProfileFor(settingsPath), cwdPath };
  }

  it('reads and writes only its roots, its working directory and its program', () => {
    withEnv(hostEnv(host), () => {
      const nodeModules = join(host.home, 'src', 'ironcurtain', 'node_modules');
      const nodePrefix = join(host.base, 'opt', 'node-v22');
      const roots = confinedRootDirectories([root(host.sandbox), root(host.downloads)], host.sandbox);
      const { profile, cwdPath } = profileFor(roots, [nodeModules, nodePrefix]);

      const read = (path: string) => seatbeltReadDecision(profile, path);
      const write = (path: string) => seatbeltWriteDecision(profile, path);

      expect(read(join(host.sandbox, 'a', 'file.txt'))).toBe('allow');
      expect(write(join(host.sandbox, 'a', 'file.txt'))).toBe('allow');
      expect(read(join(host.downloads, 'dl.txt'))).toBe('allow');
      expect(write(join(host.downloads, 'new.txt'))).toBe('allow');
      expect(read(join(cwdPath, 'server.log'))).toBe('allow');
      expect(write(join(cwdPath, 'server.log'))).toBe('allow');
      expect(read(join(nodeModules, '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js'))).toBe('allow');
      expect(read(join(nodePrefix, 'bin', 'node'))).toBe('allow');

      // What a swapped-in symlink could lead to: everything else in the
      // home, the IronCurtain home, the temp directories.
      for (const target of [
        join(host.home, 'data.txt'),
        join(host.home, '.bashrc'),
        join(host.icHome, 'config.json'),
        join(host.icHome, 'sessions', 'other', 'sandbox', 'x'),
        join(host.home, '.aws', 'credentials'),
        join(host.other, 'private.txt'),
        join(host.approved, 'ok.txt'),
        join(host.tmp, 'ironcurtain-srt-other', 'google-workspace-creds', 'token.json'),
        '/tmp/other-session/file',
        '/var/tmp/other-session/file',
      ]) {
        expect(read(target), target).toBe('deny');
        expect(write(target), target).toBe('deny');
      }
      expect(write(join(nodeModules, 'evil.js'))).toBe('deny');
      expect(write('/etc/hosts')).toBe('deny');
    });
  });

  it('keeps the data beside a Node.js installed into ~/.local hidden', () => {
    withEnv(hostEnv(host), () => {
      const localBin = join(host.home, '.local', 'bin');
      writeExecutable(join(localBin, 'node'));
      const keyring = join(host.home, '.local', 'share', 'keyrings', 'login.keyring');
      writeFile(keyring, 'KEYRING');
      const launch = resolveConfinedLaunch('node', [], { PATH: '/usr/bin:/bin' }, join(localBin, 'node'));
      // The relay also passes discoverNodePaths(), which reports the prefix
      // of a Node.js installed under the home: ~/.local here.
      const { profile } = profileFor([], [...launch.readPaths, join(host.home, '.local')]);

      expect(seatbeltReadDecision(profile, join(localBin, 'node'))).toBe('allow');
      expect(seatbeltReadDecision(profile, keyring)).toBe('deny');
      expect(seatbeltReadDecision(profile, join(host.home, '.local', 'state', 'bash', 'history'))).toBe('deny');
    });
  });

  it('exposes an approved root only in the profile of the restarted server', () => {
    withEnv(hostEnv(host), () => {
      const before = profileFor(confinedRootDirectories([root(host.sandbox)], host.sandbox), []).profile;
      expect(seatbeltReadDecision(before, join(host.approved, 'ok.txt'))).toBe('deny');

      const roots = confinedRootDirectories([root(host.sandbox), root(host.approved)], host.sandbox);
      const after = profileFor(roots, []).profile;
      expect(seatbeltReadDecision(after, join(host.approved, 'ok.txt'))).toBe('allow');
      expect(seatbeltWriteDecision(after, join(host.approved, 'new.txt'))).toBe('allow');
      expect(seatbeltReadDecision(after, join(host.other, 'private.txt'))).toBe('deny');
      expect(seatbeltReadDecision(after, join(host.home, 'data.txt'))).toBe('deny');
    });
  });

  // Why a root that contains the baseline is never exposed: on macOS a read
  // deny inside a write root does not stop writes, and the deny re-emitted
  // after the root's allow also hides the session sandbox beneath it.
  it('never exposes the home as a root, which would make the IronCurtain home writable on macOS (control)', () => {
    withEnv(hostEnv(host), () => {
      expect(confinedRootDirectories([root(host.sandbox), root(host.home)], host.sandbox)).toEqual([]);
      const safe = profileFor([], []).profile;
      expect(seatbeltWriteDecision(safe, join(host.icHome, 'config.json'))).toBe('deny');
      expect(seatbeltReadDecision(safe, join(host.sandbox, 'x'))).toBe('allow');

      const unsafe = profileFor([host.home], []).profile;
      expect(seatbeltWriteDecision(unsafe, join(host.icHome, 'config.json'))).toBe('allow');
      expect(seatbeltWriteDecision(unsafe, join(host.home, '.aws', 'credentials'))).toBe('allow');
      expect(seatbeltReadDecision(unsafe, join(host.sandbox, 'x'))).toBe('deny');
    });
  });
});
