/**
 * Spawn specs for MCP relays and backends (BLD-2): no spawn may inherit
 * IronCurtain's working directory, which can be an agent-writable
 * workspace or an untrusted checkout (npx reads its node_modules/.bin and
 * .npmrc, tsx its tsconfig.json, git-mcp-server its .env).
 *
 * StdioClientTransport is replaced by a recorder that refuses to start,
 * so these tests inspect the exact parameters each spawn site would pass
 * without running any process. The end-to-end marker test lives in
 * filesystem-server-launch.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  chownSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseShell } from 'shell-quote';
import type { IronCurtainConfig, MCPServerConfig } from '../src/config/types.js';
import type { OsSandboxAvailability } from '../src/trusted-process/sandbox-integration.js';
import type { ListDefinition } from '../src/pipeline/types.js';

const { spawnSpecs } = vi.hoisted(() => ({ spawnSpecs: [] as StdioServerParameters[] }));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    readonly stderr = null;
    constructor(params: StdioServerParameters) {
      spawnSpecs.push(params);
    }
    start(): Promise<void> {
      return Promise.reject(new Error('spawn blocked by test'));
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
    send(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import {
  createPrivateRunDir,
  createServerCwd,
  ensurePrivateScratchRoot,
  getPrivateScratchRoot,
  getTrustedSpawnCwd,
  gitCeilingDirectories,
} from '../src/trusted-process/spawn-cwd.js';
import { MCPClientManager } from '../src/trusted-process/mcp-client-manager.js';
import { TrustedProcess } from '../src/trusted-process/index.js';
import { resolveServerSandboxConfigs } from '../src/trusted-process/mcp-proxy-server.js';
import { createProbeEnvironment, probeConfiguredServer } from '../src/doctor/mcp-liveness.js';
import { connectViaProxy } from '../src/pipeline/proxy-mcp-connections.js';
import { applyAllowedDirectoryToMcpArgs, loadConfig } from '../src/config/index.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SANDBOX_AVAILABLE: OsSandboxAvailability = {
  available: true,
  platformSupported: true,
  problems: [],
  warnings: [],
};

/** srt cannot run (missing helpers): servers that ask for it run unconfined under "warn". */
const SANDBOX_UNAVAILABLE: OsSandboxAvailability = {
  available: false,
  platformSupported: true,
  problems: ['bubblewrap (bwrap) not installed'],
  warnings: [],
};

/** Last recorded spawn spec; fails the test if nothing was spawned. */
function lastSpawn(): StdioServerParameters {
  const spec = spawnSpecs.at(-1);
  if (!spec) throw new Error('no StdioClientTransport was constructed');
  return spec;
}

describe('trusted spawn working directories', () => {
  const originalCwd = process.cwd();
  const savedEnv = {
    IRONCURTAIN_HOME: process.env.IRONCURTAIN_HOME,
    ALLOWED_DIRECTORY: process.env.ALLOWED_DIRECTORY,
  };
  let scratch: string;
  /** Stand-in for an untrusted directory the user started IronCurtain from. */
  let launchDir: string;

  beforeEach(() => {
    spawnSpecs.length = 0;
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-spawn-cwd-')));
    launchDir = join(scratch, 'untrusted-checkout');
    mkdirSync(launchDir);
    process.env.IRONCURTAIN_HOME = join(scratch, 'home');
    process.chdir(launchDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  describe('getTrustedSpawnCwd', () => {
    it("is IronCurtain's package root, independent of process.cwd()", () => {
      const root = getTrustedSpawnCwd();
      expect(isAbsolute(root)).toBe(true);
      expect(root).toBe(projectRoot);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name: string };
      expect(manifest.name).toBe('@provos/ironcurtain');
      expect(process.cwd()).toBe(launchDir);
      expect(getTrustedSpawnCwd()).toBe(root);
    });
  });

  describe('createServerCwd', () => {
    it('creates an empty <parent>/<server>.cwd directory with mode 0700, idempotently', () => {
      const cwd = createServerCwd(scratch, 'filesystem');
      expect(cwd).toBe(join(scratch, 'filesystem.cwd'));
      expect(statSync(cwd).isDirectory()).toBe(true);
      expect(statSync(cwd).mode & 0o777).toBe(0o700);
      expect(readdirSync(cwd)).toEqual([]);
      expect(createServerCwd(scratch, 'filesystem')).toBe(cwd);
    });

    it.each(['', '.', '..', 'a/b', '../escape', 'a\\b', 'nul\0byte'])('rejects the unsafe server name %j', (name) => {
      expect(() => createServerCwd(scratch, name)).toThrow(/Invalid MCP server name/);
    });
  });

  describe('createPrivateRunDir', () => {
    it('creates a fresh 0700 directory under <home>/run/mcp-cwd for every call', () => {
      const home = join(scratch, 'home');
      const first = createPrivateRunDir(home);
      const second = createPrivateRunDir(home);
      expect(dirname(first)).toBe(join(home, 'run', 'mcp-cwd'));
      expect(basename(first)).toMatch(/^relay-/);
      expect(second).not.toBe(first);
      expect(statSync(first).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, 'run', 'mcp-cwd')).mode & 0o077).toBe(0);
      expect(readdirSync(first)).toEqual([]);
    });

    it('refuses a relative IronCurtain home instead of resolving it against the cwd', () => {
      expect(() => createPrivateRunDir('relative-home')).toThrow(/must be an absolute path/);
      expect(readdirSync(launchDir)).toEqual([]);
    });
  });

  describe('gitCeilingDirectories', () => {
    it('stops git at the directory holding the private cwd, ahead of inherited entries', () => {
      expect(gitCeilingDirectories('/home/u/.ironcurtain/run/mcp-cwd/relay-x/git.cwd')).toBe(
        '/home/u/.ironcurtain/run/mcp-cwd/relay-x',
      );
      expect(gitCeilingDirectories('/r/relay-x/git.cwd', `/net${delimiter}${delimiter}/mnt`)).toBe(
        ['/r/relay-x', '/net', '/mnt'].join(delimiter),
      );
      expect(gitCeilingDirectories('/r/relay-x/git.cwd', '/r/relay-x')).toBe('/r/relay-x');
      expect(gitCeilingDirectories('/r/relay-x/git.cwd', '')).toBe('/r/relay-x');
    });

    it('refuses a directory git cannot take as a ceiling instead of passing a broken list', () => {
      expect(() => gitCeilingDirectories('relative/git.cwd')).toThrow(/must be absolute/);
      expect(() => gitCeilingDirectories(`/a${delimiter}b/git.cwd`)).toThrow(/must be absolute/);
    });
  });

  describe('relay backends (resolveServerSandboxConfigs)', () => {
    it('gives unsandboxed backends -- opt-out and the srt-unavailable fallback -- a private cwd under the IronCurtain home, not os.tmpdir()', () => {
      const servers: Record<string, MCPServerConfig> = {
        optout: { command: 'node', args: ['optout.js'], sandbox: false },
        // No `sandbox` field: wants the default sandbox, but srt is
        // unavailable and the policy is "warn", so it runs unsandboxed.
        fallback: { command: 'npx', args: ['-y', 'some-server@1.0.0'] },
      };
      const home = join(scratch, 'home');
      const { resolvedSandboxConfigs, settingsDir, serverCwdPaths, scratchDirs } = resolveServerSandboxConfigs(
        servers,
        join(scratch, 'sandbox'),
        SANDBOX_UNAVAILABLE,
        'warn',
        home,
      );
      try {
        expect(resolvedSandboxConfigs.get('optout')).toEqual({ sandboxed: false, reason: 'opt-out' });
        expect(resolvedSandboxConfigs.get('fallback')).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
        expect(statSync(settingsDir).mode & 0o077).toBe(0);
        // One private run directory for the relay, removed with the settings dir.
        expect(scratchDirs).toHaveLength(2);
        expect(scratchDirs[0]).toBe(settingsDir);
        const runDir = scratchDirs[1];
        expect(dirname(runDir)).toBe(join(home, 'run', 'mcp-cwd'));
        expect(statSync(runDir).mode & 0o777).toBe(0o700);
        for (const name of Object.keys(servers)) {
          const cwd = serverCwdPaths.get(name);
          expect(cwd).toBe(join(runDir, `${name}.cwd`));
          if (!cwd) continue;
          // Launchers walk up from the cwd, so it must not sit below the
          // relay's os.tmpdir() scratch directory (the shared /tmp on Linux).
          expect(cwd.startsWith(settingsDir + sep)).toBe(false);
          expect(settingsDir.startsWith(realpathSync(tmpdir()) + sep) || settingsDir.startsWith(tmpdir() + sep)).toBe(
            true,
          );
          expect(statSync(cwd).isDirectory()).toBe(true);
          expect(statSync(cwd).mode & 0o777).toBe(0o700);
          expect(readdirSync(cwd)).toEqual([]);
          expect(cwd.startsWith(launchDir)).toBe(false);
        }
      } finally {
        for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
      }
    });

    it('keeps the srt cwd for sandboxed backends, lists it in allowWrite and allowRead, and creates no run directory', () => {
      const home = join(scratch, 'home');
      const { resolvedSandboxConfigs, settingsDir, serverCwdPaths, scratchDirs } = resolveServerSandboxConfigs(
        { git: { command: 'node', args: ['git.js'] } },
        join(scratch, 'sandbox'),
        SANDBOX_AVAILABLE,
        'warn',
        home,
      );
      try {
        expect(resolvedSandboxConfigs.get('git')?.sandboxed).toBe(true);
        // The settings directory sits inside the per-user scratch root, which
        // every sandboxed server has in denyRead (sandbox-integration.ts).
        expect(dirname(settingsDir)).toBe(getPrivateScratchRoot());
        expect(basename(settingsDir)).toMatch(/^srt-/);
        expect(statSync(getPrivateScratchRoot()).mode & 0o777).toBe(0o700);
        const cwd = serverCwdPaths.get('git');
        expect(cwd).toBe(join(settingsDir, 'git.cwd'));
        if (!cwd) return;
        expect(statSync(cwd).mode & 0o777).toBe(0o700);
        const settings = JSON.parse(readFileSync(join(settingsDir, 'git.srt-settings.json'), 'utf-8')) as {
          filesystem: { allowWrite: string[]; allowRead: string[] };
        };
        expect(settings.filesystem.allowWrite).toContain(cwd);
        expect(settings.filesystem.allowRead).toContain(cwd);
        expect(scratchDirs).toEqual([settingsDir]);
        expect(existsSync(join(home, 'run'))).toBe(false);
      } finally {
        for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
      }
    });

    it('creates no working directory for a server refused under "enforce"', () => {
      const home = join(scratch, 'home');
      const { refusedServers, serverCwdPaths, scratchDirs } = resolveServerSandboxConfigs(
        {
          git: { command: 'node', args: ['git.js'] },
          optout: { command: 'node', args: ['optout.js'], sandbox: false },
        },
        join(scratch, 'sandbox'),
        SANDBOX_UNAVAILABLE,
        'enforce',
        home,
      );
      try {
        expect([...refusedServers.keys()]).toEqual(['git']);
        expect(serverCwdPaths.has('git')).toBe(false);
        expect(scratchDirs).toHaveLength(2);
        expect(serverCwdPaths.get('optout')).toBe(join(scratchDirs[1], 'optout.cwd'));
      } finally {
        for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
      }
    });

    it('removes what it created when a working directory cannot be made', () => {
      // A file where the IronCurtain home should be: the run directory
      // cannot be created after the srt settings directory was.
      const home = join(scratch, 'home-is-a-file');
      writeFileSync(home, '');
      const privateTmp = join(scratch, 'tmp');
      mkdirSync(privateTmp);
      const savedTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = privateTmp; // os.tmpdir() reads it on every call
      try {
        expect(() =>
          resolveServerSandboxConfigs(
            { optout: { command: 'node', args: ['optout.js'], sandbox: false } },
            join(scratch, 'sandbox'),
            SANDBOX_AVAILABLE,
            'warn',
            home,
          ),
        ).toThrow();
        // The per-user scratch root persists (every relay of this user shares
        // it); nothing of this relay's may remain inside it.
        expect(readdirSync(privateTmp)).toEqual([basename(getPrivateScratchRoot())]);
        expect(readdirSync(getPrivateScratchRoot())).toEqual([]);
      } finally {
        if (savedTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = savedTmpdir;
      }
    });
  });

  describe('ensurePrivateScratchRoot', () => {
    let privateTmp: string;
    let savedTmpdir: string | undefined;

    beforeEach(() => {
      privateTmp = join(scratch, 'tmp');
      mkdirSync(privateTmp);
      savedTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = privateTmp; // os.tmpdir() reads it on every call
    });

    afterEach(() => {
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
    });

    it('creates <tmpdir>/ironcurtain-<uid> with mode 0700, idempotently', () => {
      const root = ensurePrivateScratchRoot();
      expect(root).toBe(getPrivateScratchRoot());
      expect(dirname(root)).toBe(privateTmp);
      expect(basename(root)).toMatch(/^ironcurtain-/);
      expect(statSync(root).isDirectory()).toBe(true);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(ensurePrivateScratchRoot()).toBe(root);
    });

    it('refuses a symlink or a file planted at that name', () => {
      const root = getPrivateScratchRoot();
      const elsewhere = join(scratch, 'elsewhere');
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, root);
      expect(() => ensurePrivateScratchRoot()).toThrow(/not a directory/);
      rmSync(root);
      writeFileSync(root, '');
      expect(() => ensurePrivateScratchRoot()).toThrow(/not a directory/);
    });

    it.skipIf(process.getuid === undefined)('refuses a directory other users can enter', () => {
      const root = getPrivateScratchRoot();
      mkdirSync(root, { mode: 0o755 });
      expect(() => ensurePrivateScratchRoot()).toThrow(/chmod 700/);
    });

    it.skipIf(process.getuid?.() !== 0)('refuses a directory owned by another user', () => {
      const root = getPrivateScratchRoot();
      mkdirSync(root, { mode: 0o700 });
      chownSync(root, 1, 1);
      expect(() => ensurePrivateScratchRoot()).toThrow(/owned by uid 1/);
    });
  });

  describe('spawn sites', () => {
    /** Host-only variables no spawn site may hand a child, and one a `-e` argument forwards. */
    const CANARY = 'IRONCURTAIN_SPAWN_TEST_CANARY';
    const HOST_TOKEN = 'IRONCURTAIN_SPAWN_TEST_TOKEN';
    const savedHostEnv = Object.fromEntries(
      [CANARY, HOST_TOKEN, 'NODE_OPTIONS'].map((name) => [name, process.env[name]]),
    );

    beforeEach(() => {
      process.env[CANARY] = 'host-secret';
      process.env[HOST_TOKEN] = 'host-token';
      process.env.NODE_OPTIONS = '--require /tmp/evil.js';
    });

    afterEach(() => {
      for (const [name, value] of Object.entries(savedHostEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it('MCPClientManager.connect spawns from the package root, not the caller cwd', async () => {
      await expect(
        new MCPClientManager().connect('filesystem', { command: 'node', args: ['relay.js'] }),
      ).rejects.toThrow('spawn blocked by test');
      expect(lastSpawn().cwd).toBe(getTrustedSpawnCwd());
    });

    it('MCPClientManager.connect gives the child the allowlist, its `-e` passthroughs and its env block only', async () => {
      await expect(
        new MCPClientManager().connect('github', {
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', HOST_TOKEN, 'ghcr.io/example/server'],
          env: { OWN_SETTING: 'own' },
        }),
      ).rejects.toThrow('spawn blocked by test');
      const env = lastSpawn().env ?? {};
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.OWN_SETTING).toBe('own');
      expect(env[HOST_TOKEN]).toBe('host-token');
      expect(env).not.toHaveProperty(CANARY);
      expect(env).not.toHaveProperty('NODE_OPTIONS');
      expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
    });

    /** The probes of one doctor run over `servers`, planned as `doctor` plans them. */
    function doctorProbes(servers: Record<string, MCPServerConfig>, availability: OsSandboxAvailability) {
      const allowed = join(scratch, 'allowed');
      mkdirSync(allowed, { recursive: true });
      const environment = createProbeEnvironment({
        config: {
          mcpServers: servers,
          allowedDirectory: allowed,
          userConfig: { serverCredentials: {} },
        } as unknown as IronCurtainConfig,
        availability,
        policy: 'warn',
        isImageCached: () => Promise.resolve(true),
      });
      return {
        probe: (name: string, credentials: Record<string, string> = {}) =>
          probeConfiguredServer(name, environment.servers[name], { credentials, environment: () => environment }),
        dispose: () => environment.dispose(),
      };
    }

    it("doctor's liveness probe spawns an unsandboxed server from the package root", async () => {
      const probes = doctorProbes(
        { server: { command: 'node', args: ['server.js'], sandbox: false } },
        SANDBOX_AVAILABLE,
      );
      try {
        const result = await probes.probe('server');
        expect(result.status).toBe('fail');
        expect(lastSpawn().cwd).toBe(getTrustedSpawnCwd());
      } finally {
        probes.dispose();
      }
    });

    it("doctor's liveness probe runs a sandboxed server under srt from its own private directory, as the relay does", async () => {
      const probes = doctorProbes({ server: { command: 'node', args: ['server.js'] } }, SANDBOX_AVAILABLE);
      try {
        const result = await probes.probe('server');
        expect(result.status).toBe('fail');
        const spec = lastSpawn();
        expect(spec.command).toMatch(/srt$/);
        expect(spec.cwd?.startsWith(getPrivateScratchRoot() + sep)).toBe(true);
        expect(basename(spec.cwd ?? '')).toBe('server.cwd');
      } finally {
        probes.dispose();
      }
    });

    it("doctor's sandboxed probe resolves relative arguments against the package root, as the relay does, never the launch directory", async () => {
      // Planted in the untrusted directory doctor was started from: a file
      // the package also has, and one only the launch directory has.
      mkdirSync(join(launchDir, 'test', 'fixtures'), { recursive: true });
      writeFileSync(join(launchDir, 'test', 'fixtures', 'cwd-probe-server.mjs'), 'planted\n');
      mkdirSync(join(launchDir, 'planted'));
      writeFileSync(join(launchDir, 'planted', 'evil.mjs'), 'planted\n');
      const probes = doctorProbes(
        { server: { command: 'node', args: ['test/fixtures/cwd-probe-server.mjs', 'planted/evil.mjs'] } },
        SANDBOX_AVAILABLE,
      );
      try {
        await probes.probe('server');
        expect(lastSpawn().args?.[0]).toBe('-s');
        const argv = parseShell(lastSpawn().args?.[3] ?? '');
        expect(argv).toEqual([
          'node',
          join(projectRoot, 'test', 'fixtures', 'cwd-probe-server.mjs'),
          // Not a path under the package root, so left as the relay leaves it.
          'planted/evil.mjs',
        ]);
      } finally {
        probes.dispose();
      }
    });

    it("doctor's liveness probe gives the server the allowlist, its passthroughs and its stored credentials", async () => {
      const probes = doctorProbes(
        {
          github: {
            command: 'docker',
            args: ['run', '-e', HOST_TOKEN, 'ghcr.io/example/server'],
            env: { OWN_SETTING: 'own' },
          },
        },
        SANDBOX_UNAVAILABLE,
      );
      const result = await probes.probe('github', { STORED_TOKEN: 'from-config' }).finally(() => probes.dispose());
      expect(result.status).toBe('fail');
      const env = lastSpawn().env ?? {};
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.OWN_SETTING).toBe('own');
      expect(env[HOST_TOKEN]).toBe('host-token');
      expect(env.STORED_TOKEN).toBe('from-config');
      expect(env).not.toHaveProperty(CANARY);
      expect(env).not.toHaveProperty('NODE_OPTIONS');
    });

    it("the pipeline's list-resolution relay spawns from the package root and gets absolute paths", async () => {
      // An inherited relative value must not reach the relay (it is
      // replaced by an absolute throwaway directory).
      process.env.ALLOWED_DIRECTORY = 'relative/sandbox';
      const issueReporters: ListDefinition = {
        name: 'issue-reporters',
        type: 'emails',
        principle: 'Allow emailing people who reported issues',
        generationPrompt: 'List the email addresses of everyone who reported an issue.',
        requiresMcp: true,
        mcpServerHint: 'github',
      };
      // The relay never starts (the transport refuses), so the server is
      // skipped with a warning and the connection holds no tools.
      const connection = await connectViaProxy([issueReporters], {
        mcpServers: { github: { command: 'node', args: ['github.js'], sandbox: false } },
        toolAnnotationsDir: 'relative/annotations',
        protectedPaths: [],
        auditLogPath: join(scratch, 'list-resolution-audit.jsonl'),
      });
      await connection.shutdown();
      const spec = lastSpawn();
      expect(spec.cwd).toBe(getTrustedSpawnCwd());
      expect(spec.env?.IRONCURTAIN_HOME).toBe(join(scratch, 'home'));
      expect(spec.env?.TOOL_ANNOTATIONS_DIR).toBe(join(launchDir, 'relative/annotations'));
      const allowedDirectory = spec.env?.ALLOWED_DIRECTORY ?? '';
      expect(isAbsolute(allowedDirectory)).toBe(true);
      expect(allowedDirectory.startsWith(launchDir)).toBe(false);
      // The relay inherits the allowlist, never the host's secrets or NODE_OPTIONS.
      expect(spec.env).not.toHaveProperty(CANARY);
      expect(spec.env).not.toHaveProperty('NODE_OPTIONS');
    });

    it('the in-process TrustedProcess starts a server whose `-e` credential exists only in serverCredentials', async () => {
      const generatedDir = join(scratch, 'generated');
      mkdirSync(generatedDir);
      writeFileSync(
        join(generatedDir, 'compiled-policy.json'),
        JSON.stringify({ generatedAt: 'test', constitutionHash: 'test', inputHash: 'test', rules: [] }),
      );
      writeFileSync(join(generatedDir, 'tool-annotations.json'), JSON.stringify({ generatedAt: 'test', servers: {} }));
      const config = {
        auditLogPath: join(scratch, 'audit.jsonl'),
        allowedDirectory: join(scratch, 'sandbox'),
        mcpServers: {
          // GitHub's shape: one token stored in config.json, one exported in the shell.
          'stored-credential': {
            command: 'docker',
            args: ['run', '-i', '--rm', '-e', 'STORED_ONLY_TOKEN', '-e', HOST_TOKEN, 'ghcr.io/example/server'],
            sandbox: false,
          },
          // Set nowhere: skipped before any spawn.
          unconfigured: { command: 'docker', args: ['run', '-e', 'UNSET_ANYWHERE_TOKEN', 'img'], sandbox: false },
        },
        protectedPaths: [],
        generatedDir,
        constitutionPath: resolve(projectRoot, 'src/config/constitution.md'),
        agentModelId: 'anthropic:claude-sonnet-4-6',
        escalationTimeoutSeconds: 300,
        userConfig: {
          autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
          auditRedaction: { enabled: true },
          sandboxPolicy: 'warn',
          serverCredentials: { 'stored-credential': { STORED_ONLY_TOKEN: 'from-config' } },
        },
      } as unknown as IronCurtainConfig;

      const trustedProcess = new TrustedProcess(config);
      try {
        await trustedProcess.initialize();
        // Attempted (the recorder refused the spawn), not skipped.
        const spawned = spawnSpecs.filter((spec) => spec.args?.includes('STORED_ONLY_TOKEN'));
        expect(spawned).toHaveLength(1);
        const env = spawned[0].env ?? {};
        expect(env.STORED_ONLY_TOKEN).toBe('from-config');
        expect(env[HOST_TOKEN]).toBe('host-token');
        expect(env.PATH).toBe(process.env.PATH);
        expect(env).not.toHaveProperty(CANARY);
        expect(env).not.toHaveProperty('NODE_OPTIONS');
        expect(spawnSpecs.some((spec) => spec.args?.includes('UNSET_ANYWHERE_TOKEN'))).toBe(false);
      } finally {
        await trustedProcess.shutdown();
      }
    });
  });

  describe('loadConfig', () => {
    it('resolves a relative ALLOWED_DIRECTORY against the launch directory before it reaches any spawn', () => {
      process.env.ALLOWED_DIRECTORY = 'relative/sandbox';
      const config = loadConfig();
      expect(config.allowedDirectory).toBe(join(launchDir, 'relative/sandbox'));
      expect(config.mcpServers.filesystem.args.at(-1)).toBe(join(launchDir, 'relative/sandbox'));
    });
  });

  describe('applyAllowedDirectoryToMcpArgs', () => {
    it('writes an absolute directory even when the session/workflow passes a relative one', () => {
      // e.g. a workflow workspace typed into the web UI, which reaches
      // createSession() without passing through loadConfig().
      const servers = { filesystem: { args: ['/pkg/server-filesystem/dist/index.js', '/old/sandbox'] } };
      applyAllowedDirectoryToMcpArgs(servers, 'my-workspace');
      expect(servers.filesystem.args).toEqual([
        '/pkg/server-filesystem/dist/index.js',
        join(launchDir, 'my-workspace'),
      ]);

      applyAllowedDirectoryToMcpArgs(servers, '/abs/workspace');
      expect(servers.filesystem.args.at(-1)).toBe('/abs/workspace');
    });
  });
});
