/**
 * Tests for the doctor's MCP liveness probes (src/doctor/mcp-liveness.ts):
 * servers are prepared the way a session's relay prepares them (srt
 * wrapping included), nothing is written in the IronCurtain home, and
 * servers that would download an image or a package are skipped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProbeEnvironment,
  findContainerRunImage,
  isNpxPackageCached,
  parseNpxPackageSpec,
  prepareProbeSpawn,
  probeConfiguredServer,
  type ProbeEnvironment,
  type ProbeSpawn,
} from '../src/doctor/mcp-liveness.js';
import { checkMcpServerLiveness } from '../src/doctor/checks.js';
import type { IronCurtainConfig, MCPServerConfig } from '../src/config/types.js';
import type { OsSandboxAvailability } from '../src/trusted-process/sandbox-integration.js';
import { getPrivateScratchRoot, getTrustedSpawnCwd } from '../src/trusted-process/spawn-cwd.js';

const PROBE_SERVER = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'cwd-probe-server.mjs');

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

const available: OsSandboxAvailability = { available: true, platformSupported: true, problems: [], warnings: [] };
const unavailable: OsSandboxAvailability = {
  available: false,
  platformSupported: true,
  problems: ['bubblewrap (bwrap) not installed'],
  warnings: [],
};

function makeConfig(overrides: Partial<IronCurtainConfig>, home: string): IronCurtainConfig {
  return {
    auditLogPath: join(home, 'audit.jsonl'),
    allowedDirectory: join(home, 'sandbox'),
    mcpServers: {},
    protectedPaths: [],
    generatedDir: join(home, 'generated'),
    constitutionPath: join(home, 'constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: { serverCredentials: {} } as unknown as IronCurtainConfig['userConfig'],
    ...overrides,
  };
}

describe('doctor MCP probes', () => {
  let root: string;
  let home: string;
  const savedHome = process.env.IRONCURTAIN_HOME;
  const environments: ProbeEnvironment[] = [];

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-probes-'));
    home = join(root, 'home');
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    for (const environment of environments.splice(0)) environment.dispose();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  function environmentFor(
    servers: Record<string, MCPServerConfig>,
    availability: OsSandboxAvailability = available,
    extra: Partial<IronCurtainConfig> = {},
  ): ProbeEnvironment {
    const allowed = join(root, 'allowed');
    mkdirSync(allowed, { recursive: true });
    const environment = createProbeEnvironment({
      config: makeConfig({ mcpServers: servers, allowedDirectory: allowed, ...extra }, home),
      availability,
      policy: 'enforce',
      isImageCached: async () => false,
      isNpxPackageCached: () => false,
    });
    environments.push(environment);
    return environment;
  }

  it('wraps a server that asks for a sandbox in srt with settings outside the IronCurtain home', () => {
    const servers: Record<string, MCPServerConfig> = {
      svc: { command: 'node', args: [PROBE_SERVER], sandbox: { network: false } },
    };
    const environment = environmentFor(servers, available, {
      userConfig: {
        serverCredentials: {},
        credentialProtection: { extraPaths: [join(root, 'additional-store')] },
      } as unknown as IronCurtainConfig['userConfig'],
    });
    const spawn = prepareProbeSpawn('svc', environment.servers.svc, environment, { TOKEN_X: 'secret-value-1' });
    expect('status' in spawn).toBe(false);
    const prepared = spawn as ProbeSpawn;

    expect(prepared.sandboxed).toBe(true);
    expect(prepared.command).toMatch(/srt$/);
    expect(prepared.args[0]).toBe('-s');
    const settingsPath = prepared.args[1];
    // The relay's layout: settings and the server's cwd in a private
    // directory below the per-user scratch root, never in the home.
    expect(settingsPath.startsWith(getPrivateScratchRoot())).toBe(true);
    expect(prepared.cwd.startsWith(getPrivateScratchRoot())).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      filesystem: { denyRead: string[]; allowWrite: string[] };
    };
    expect(settings.filesystem.denyRead).toContain(resolve(home));
    expect(settings.filesystem.denyRead).toContain(join(root, 'additional-store'));
    expect(settings.filesystem.allowWrite).toContain(environment.allowedDirectory);
    // The relay's backend environment: credentials in, no git ceiling above the cwd.
    expect(prepared.env.TOKEN_X).toBe('secret-value-1');
    expect(prepared.env.GIT_CEILING_DIRECTORIES).toBeDefined();
    expect(prepared.secrets).toContain('secret-value-1');
    expect(existsSync(home)).toBe(false);

    environment.dispose();
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('runs a server confined to its roots through the confined launch profile', () => {
    const servers = {
      filesystem: {
        command: 'node',
        args: [PROBE_SERVER, join(root, 'allowed')],
        sandbox: { filesystem: { confineToRoots: true }, network: false as const },
      },
    };
    const environment = environmentFor(servers);
    const prepared = prepareProbeSpawn('filesystem', environment.servers.filesystem, environment, {}) as ProbeSpawn;
    expect(prepared.sandboxed).toBe(true);
    const settings = JSON.parse(readFileSync(prepared.args[1], 'utf-8')) as { filesystem: { allowRead: string[] } };
    // The program (Node.js) is re-exposed read-only; the allowed directory is exposed.
    expect(settings.filesystem.allowRead.some((path) => process.execPath.startsWith(path))).toBe(true);
    expect(settings.filesystem.allowRead).toContain(environment.allowedDirectory);
  });

  // The git backend's hardened environment reads the user's git configuration.
  it.skipIf(!gitAvailable)('grants the ssh-agent socket to the git server only, as its relay does', () => {
    const networked = { network: { allowedDomains: ['example.com'] } };
    const servers: Record<string, MCPServerConfig> = {
      git: { command: 'node', args: [PROBE_SERVER], sandbox: networked },
      svc: { command: 'node', args: [PROBE_SERVER], sandbox: networked },
    };
    const environment = environmentFor(servers);
    const savedSock = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/private/tmp/com.apple.launchd.abc123/Listeners';
    try {
      const socketsOf = (name: string): unknown => {
        const prepared = prepareProbeSpawn(name, environment.servers[name], environment, {});
        if ('status' in prepared) throw new Error(`${name} was not prepared: ${JSON.stringify(prepared)}`);
        const settings = JSON.parse(readFileSync(prepared.args[1], 'utf-8')) as {
          network: { allowUnixSockets?: unknown };
        };
        return settings.network.allowUnixSockets;
      };
      expect(socketsOf('git')).toEqual(['/private/tmp/com.apple.launchd.abc123/Listeners']);
      expect(socketsOf('svc')).toBeUndefined();
    } finally {
      if (savedSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = savedSock;
    }
  });

  it('runs an opted-out server unwrapped from the package root', () => {
    const environment = environmentFor({ svc: { command: 'node', args: [PROBE_SERVER], sandbox: false } });
    const prepared = prepareProbeSpawn('svc', environment.servers.svc, environment, {}) as ProbeSpawn;
    expect(prepared).toMatchObject({ command: 'node', args: [PROBE_SERVER], sandboxed: false });
    expect(prepared.cwd).toBe(getTrustedSpawnCwd());
  });

  it('skips a server the sandbox plan refuses and fails one sessions cannot plan', () => {
    const refused = environmentFor({ svc: { command: 'node', args: [PROBE_SERVER] } }, unavailable);
    expect(prepareProbeSpawn('svc', refused.servers.svc, refused, {})).toMatchObject({ status: 'skip' });

    // A config that would re-expose the IronCurtain home: sessions fail closed.
    const exposing = environmentFor({
      svc: { command: 'node', args: [PROBE_SERVER], sandbox: { filesystem: { allowRead: [home] } } },
    });
    const result = prepareProbeSpawn('svc', exposing.servers.svc, exposing, {});
    expect(result).toMatchObject({ status: 'fail' });
    expect((result as { reason: string }).reason).toContain('sessions refuse this sandbox configuration');
  });

  it('probes against a temporary stand-in when the allowed directory does not exist, creating nothing in the home', () => {
    const missing = join(home, 'sandbox');
    const environment = createProbeEnvironment({
      config: makeConfig(
        { mcpServers: { filesystem: { command: 'node', args: [PROBE_SERVER, missing], sandbox: false } } },
        home,
      ),
      availability: available,
      policy: 'enforce',
    });
    environments.push(environment);
    expect(environment.allowedDirectory).not.toBe(missing);
    expect(existsSync(environment.allowedDirectory)).toBe(true);
    // The filesystem server is pointed at the stand-in (always its last argument).
    expect(environment.servers.filesystem.args.at(-1)).toBe(environment.allowedDirectory);
    expect(existsSync(home)).toBe(false);
    const standIn = environment.allowedDirectory;
    environment.dispose();
    expect(existsSync(standIn)).toBe(false);
  });

  it('lists the tools of a real server end to end, writing nothing in the home', async () => {
    const config = makeConfig(
      { mcpServers: { probe: { command: 'node', args: [PROBE_SERVER], sandbox: false } }, allowedDirectory: root },
      home,
    );
    const [result] = await checkMcpServerLiveness(config, { sandbox: { availability: unavailable, policy: 'warn' } });
    expect(result).toMatchObject({ name: 'probe', status: 'ok' });
    expect(result.message).toMatch(/^3 tools, /);
    expect(existsSync(home)).toBe(false);
  }, 30_000);

  it('reports a server that cannot start with its stderr, credentials blanked', async () => {
    const script = join(root, 'crash.mjs');
    writeFileSync(script, "process.stderr.write('boom token=' + process.env.MY_TOKEN + '\\n'); process.exit(3);\n");
    const config = makeConfig(
      {
        mcpServers: { crash: { command: 'node', args: [script], sandbox: false } },
        allowedDirectory: root,
        userConfig: { serverCredentials: { crash: { MY_TOKEN: 'super-secret-token' } } } as never,
      },
      home,
    );
    const [result] = await checkMcpServerLiveness(config, { sandbox: { availability: unavailable, policy: 'warn' } });
    expect(result.status).toBe('fail');
    expect(result.hint).toContain('boom token=***');
    expect(result.hint).not.toContain('super-secret-token');
  }, 30_000);

  it('blanks a token its `-e NAME` argument forwards from the shell, too', async () => {
    const script = join(root, 'crash-env.mjs');
    writeFileSync(
      script,
      "process.stderr.write('boom host=' + process.env.DOCTOR_HOST_TOKEN + '\\n'); process.exit(3);\n",
    );
    const saved = process.env.DOCTOR_HOST_TOKEN;
    process.env.DOCTOR_HOST_TOKEN = 'host-shell-secret';
    try {
      const config = makeConfig(
        {
          mcpServers: { crash: { command: 'node', args: [script, '-e', 'DOCTOR_HOST_TOKEN'], sandbox: false } },
          allowedDirectory: root,
        },
        home,
      );
      const [result] = await checkMcpServerLiveness(config, { sandbox: { availability: unavailable, policy: 'warn' } });
      expect(result.status).toBe('fail');
      expect(result.hint).toContain('boom host=***');
      expect(result.hint).not.toContain('host-shell-secret');
    } finally {
      if (saved === undefined) delete process.env.DOCTOR_HOST_TOKEN;
      else process.env.DOCTOR_HOST_TOKEN = saved;
    }
  }, 30_000);

  it('reports a probe environment that cannot be created as a failure, not a crash', async () => {
    const result = await probeConfiguredServer(
      'svc',
      { command: 'node', args: [PROBE_SERVER] },
      {
        credentials: {},
        environment: () => {
          throw new Error('no space left on device');
        },
      },
    );
    expect(result).toMatchObject({ status: 'fail' });
    expect((result as { reason: string }).reason).toContain('no space left on device');
  });

  describe('download gates', () => {
    it('skips a docker server whose image is not pulled, and an OAuth-backed server, without spawning', async () => {
      const environment = environmentFor({
        github: {
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/x/y@sha256:abc'],
          sandbox: false,
        },
        'google-workspace': { command: 'npx', args: ['-y', '@alanse/mcp-server-google-workspace@1.0.2'] },
      });
      const context = { credentials: {}, environment: () => environment };
      const github = await probeConfiguredServer('github', environment.servers.github, context);
      expect(github).toMatchObject({ status: 'skip' });
      expect((github as { message: string }).message).toContain('not pulled yet');
      const google = await probeConfiguredServer('google-workspace', environment.servers['google-workspace'], context);
      expect(google).toMatchObject({ status: 'skip' });
      expect((google as { message: string }).message).toContain('OAuth token');
    });

    it('skips a docker server whose image it cannot tell, since `docker run` would pull a missing one', async () => {
      const isImageCached = vi.fn(async () => true);
      const environment = createProbeEnvironment({
        config: makeConfig(
          {
            mcpServers: {
              custom: { command: 'docker', args: ['run', '-i', '--some-new-flag', 'value', 'img:1'], sandbox: false },
            },
            allowedDirectory: root,
          },
          home,
        ),
        availability: available,
        policy: 'enforce',
        isImageCached,
      });
      environments.push(environment);
      const result = await probeConfiguredServer('custom', environment.servers.custom, {
        credentials: {},
        environment: () => environment,
      });
      expect(result).toMatchObject({ status: 'skip' });
      expect((result as { message: string }).message).toContain('cannot tell which image `docker run` starts');
      expect(isImageCached).not.toHaveBeenCalled();
    });

    it('skips npx servers that are unpinned or not in the npx cache', async () => {
      const environment = environmentFor({
        pinned: { command: 'npx', args: ['-y', 'some-mcp-server@1.2.3'], sandbox: false },
        loose: { command: 'npx', args: ['-y', 'some-mcp-server'], sandbox: false },
      });
      const context = { credentials: {}, environment: () => environment };
      const pinned = await probeConfiguredServer('pinned', environment.servers.pinned, context);
      expect((pinned as { message: string }).message).toContain('not in the npx cache');
      const loose = await probeConfiguredServer('loose', environment.servers.loose, context);
      expect((loose as { message: string }).message).toContain('unpinned');
    });

    it('finds the image of a docker run command', () => {
      expect(findContainerRunImage(['run', '-i', '--rm', '-e', 'TOKEN', 'img:1'])).toBe('img:1');
      expect(findContainerRunImage(['run', '-it', '--name', 'x', '--env=A=B', '-ie', 'V', 'img@sha256:aa'])).toBe(
        'img@sha256:aa',
      );
      expect(findContainerRunImage(['run', '-eTOKEN', 'img'])).toBe('img');
      expect(findContainerRunImage(['run', '--some-unknown-flag', 'value', 'img'])).toBeUndefined();
      expect(findContainerRunImage(['ps'])).toBeUndefined();
    });

    it('parses the package of an npx command', () => {
      expect(parseNpxPackageSpec(['-y', '@scope/pkg@1.0.2'])).toEqual({ name: '@scope/pkg', version: '1.0.2' });
      expect(parseNpxPackageSpec(['--yes', 'pkg'])).toEqual({ name: 'pkg' });
      expect(parseNpxPackageSpec(['-y', 'pkg@latest'])).toEqual({ name: 'pkg' });
      expect(parseNpxPackageSpec(['-p', 'pkg', 'bin'])).toBeUndefined();
    });

    it('looks the pinned version up in the npx cache', () => {
      const cache = join(root, 'npm-cache');
      const installed = join(cache, '_npx', 'abc123', 'node_modules', '@scope', 'pkg');
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '1.0.2' }));
      const env = { npm_config_cache: cache };
      expect(isNpxPackageCached({ name: '@scope/pkg', version: '1.0.2' }, env)).toBe(true);
      expect(isNpxPackageCached({ name: '@scope/pkg', version: '1.0.3' }, env)).toBe(false);
      expect(isNpxPackageCached({ name: '@scope/pkg' }, env)).toBe(false);
      expect(readdirSync(join(cache, '_npx'))).toEqual(['abc123']);
    });
  });
});
