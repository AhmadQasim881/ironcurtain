/**
 * Marker test for BLD-2: starting IronCurtain from a hostile working
 * directory must not run anything planted there, and the session must use
 * the packaged, exact-pinned filesystem MCP server.
 *
 * The launch directory plants every lookup the old spawn chain honoured:
 *   - node_modules/@modelcontextprotocol/server-filesystem (+ .bin link),
 *     which `npx -y @modelcontextprotocol/server-filesystem` ran;
 *   - .npmrc with `node-options=--require=<hook>`, which any npm/npx
 *     launch from that directory would load;
 *   - tsconfig.json whose `paths` redirect an import of the relay, which
 *     tsx (the relay launcher in source mode) honours from its cwd.
 * Each planted file writes a MARKER-* file if it ever runs.
 *
 * The same lookups walk UP from a backend's working directory, so a
 * second hostile directory stands in for a shared, world-writable
 * os.tmpdir() (Linux /tmp): a backend's private directory must not sit
 * below it.
 *
 * The spawn chain is the session's: loadConfig() (shipped
 * mcp-servers.json) -> MCPClientManager.connect() spawning the
 * mcp-proxy-server relay the way connectBackendSubprocesses does ->
 * relay -> backend.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import type { MCPServerConfig } from '../src/config/types.js';
import { MCPClientManager } from '../src/trusted-process/mcp-client-manager.js';
import { getOsSandboxAvailability, runOsSandboxSmokeTest } from '../src/trusted-process/sandbox-integration.js';
import { getTrustedSpawnCwd } from '../src/trusted-process/spawn-cwd.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile, ToolAnnotationsFile } from '../src/pipeline/types.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The shipped `filesystem` entry, which srt confines to its MCP roots. Where
 * sandbox-runtime reports itself available but cannot run any sandboxed
 * command (some containers forbid the user namespaces bubblewrap needs), that
 * entry cannot start at all, which is not what this file tests: the same
 * spawn chain then runs the server unconfined, as `sandboxPolicy: "warn"`
 * does on a host without srt. Confinement itself is covered by
 * test/filesystem-toctou.integration.test.ts.
 */
async function launchableShippedFilesystem(): Promise<MCPServerConfig> {
  const { filesystem } = loadConfig().mcpServers;
  if (!getOsSandboxAvailability().available) return filesystem;
  const smoke = await runOsSandboxSmokeTest();
  if (smoke.ok) return filesystem;
  console.warn(`srt cannot run sandboxed commands here (${smoke.detail}); launching the filesystem server unconfined`);
  return { ...filesystem, sandbox: false };
}
const proxyServerPath = resolve(projectRoot, 'src/trusted-process/mcp-proxy-server.ts');
const tsxBin = resolve(projectRoot, 'node_modules/.bin/tsx');
const probeServerPath = resolve(projectRoot, 'test/fixtures/cwd-probe-server.mjs');
const PINNED_PACKAGE = '@modelcontextprotocol/server-filesystem';

/** Plants the hostile launch directory; every hook writes `<dir>/MARKER-<name>` when it runs. */
function plantLaunchDirectory(dir: string): void {
  const marker = (name: string) => JSON.stringify(join(dir, `MARKER-${name}`));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'planted-project', version: '1.0.0', private: true }),
  );

  const pkgDir = join(dir, 'node_modules', '@modelcontextprotocol', 'server-filesystem');
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: PINNED_PACKAGE,
      version: '99.0.0',
      type: 'module',
      bin: { 'mcp-server-filesystem': 'dist/index.js' },
    }),
  );
  const plantedEntry = join(pkgDir, 'dist', 'index.js');
  writeFileSync(
    plantedEntry,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${marker('node_modules')}, 'planted server ran');\nprocess.exit(1);\n`,
  );
  chmodSync(plantedEntry, 0o755);
  mkdirSync(join(dir, 'node_modules', '.bin'));
  symlinkSync(
    join('..', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js'),
    join(dir, 'node_modules', '.bin', 'mcp-server-filesystem'),
  );

  writeFileSync(
    join(dir, 'npmrc-hook.cjs'),
    `require('node:fs').writeFileSync(${marker('npmrc')}, 'npmrc hook ran');\n`,
  );
  writeFileSync(join(dir, '.npmrc'), `node-options=--require=${join(dir, 'npmrc-hook.cjs')}\n`);

  writeFileSync(
    join(dir, 'tsconfig-hook.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${marker('tsconfig')}, 'tsconfig paths hook ran');\nexport class StdioServerTransport {}\n`,
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@modelcontextprotocol/sdk/server/stdio.js': ['./tsconfig-hook.mjs'] },
      },
    }),
  );
}

/** npx spec of the package planted in the shared tmp directory (never published). */
const PLANTED_NPX_SPEC = '@ironcurtain-test/planted-mcp-server@1.0.0';

/**
 * Plants, in a stand-in for a world-writable os.tmpdir(), the files that
 * launchers find by walking up from their cwd: a tsconfig.json `paths`
 * hijack (tsx), a package.json that claims every directory below it as
 * an npm workspace, an .npmrc hook, and a package satisfying
 * PLANTED_NPX_SPEC (npx). Every hook writes `<dir>/MARKER-<name>`.
 */
function plantSharedTmp(dir: string): void {
  const marker = (name: string) => JSON.stringify(join(dir, `MARKER-${name}`));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'shared-tmp', private: true, workspaces: ['*', '*/*', '*/*/*'] }),
  );
  writeFileSync(join(dir, 'npmrc-hook.cjs'), `require('node:fs').writeFileSync(${marker('npmrc')}, 'ran');\n`);
  writeFileSync(join(dir, '.npmrc'), `node-options=--require=${join(dir, 'npmrc-hook.cjs')}\n`);

  const pkgDir = join(dir, 'node_modules', '@ironcurtain-test', 'planted-mcp-server');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@ironcurtain-test/planted-mcp-server',
      version: '1.0.0',
      bin: { 'planted-mcp-server': 'index.js' },
    }),
  );
  writeFileSync(
    join(pkgDir, 'index.js'),
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${marker('npx-package')}, 'ran');\nprocess.exit(1);\n`,
  );
  chmodSync(join(pkgDir, 'index.js'), 0o755);
  mkdirSync(join(dir, 'node_modules', '.bin'));
  symlinkSync(
    join('..', '@ironcurtain-test', 'planted-mcp-server', 'index.js'),
    join(dir, 'node_modules', '.bin', 'planted-mcp-server'),
  );

  writeFileSync(
    join(dir, 'tsconfig-hook.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${marker('tsconfig')}, 'ran');\nexport class StdioServerTransport {}\n`,
  );
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@modelcontextprotocol/sdk/server/stdio.js': ['./tsconfig-hook.mjs'] },
      },
    }),
  );
}

function markersIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('MARKER-'));
}

/** First text block of an MCP tool result. */
function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const block = content.find((c) => c.type === 'text');
  return block?.text ?? '';
}

describe('Filesystem MCP server launch from a hostile working directory', () => {
  const originalCwd = process.cwd();
  const savedEnv = {
    IRONCURTAIN_HOME: process.env.IRONCURTAIN_HOME,
    ALLOWED_DIRECTORY: process.env.ALLOWED_DIRECTORY,
  };
  let scratch: string;
  let launchDir: string;
  let sandboxDir: string;
  let policyDir: string;
  let manager: MCPClientManager;

  /** Relay subprocess config, built the way connectBackendSubprocesses builds it in source mode. */
  function relayConfig(
    serverName: string,
    backends: Record<string, MCPServerConfig>,
    extraEnv: Record<string, string> = {},
  ): MCPServerConfig {
    return {
      command: tsxBin,
      args: [proxyServerPath],
      env: {
        MCP_SERVERS_CONFIG: JSON.stringify(backends),
        GENERATED_DIR: policyDir,
        ALLOWED_DIRECTORY: sandboxDir,
        SERVER_FILTER: serverName,
        SANDBOX_POLICY: 'warn',
        ...extraEnv,
      },
      sandbox: false,
    };
  }

  /** Where the relay creates its backends' private directories (IRONCURTAIN_HOME is `<scratch>/home`). */
  function backendCwdRoot(): string {
    return join(scratch, 'home', 'run', 'mcp-cwd');
  }

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-fs-launch-')));
    launchDir = join(scratch, 'untrusted-checkout');
    sandboxDir = join(scratch, 'sandbox');
    policyDir = join(scratch, 'policy');
    mkdirSync(launchDir);
    mkdirSync(sandboxDir);
    mkdirSync(policyDir);
    writeFileSync(join(sandboxDir, 'hello.txt'), 'hello from the sandbox');
    plantLaunchDirectory(launchDir);

    // Minimal policy for the relay's root derivation: roots = [sandbox].
    const compiledPolicy: CompiledPolicyFile = {
      generatedAt: 'test-fixture',
      constitutionHash: 'test-fixture',
      inputHash: 'test-fixture',
      rules: [],
    };
    const toolAnnotations: ToolAnnotationsFile = { generatedAt: 'test-fixture', servers: {} };
    writeFileSync(join(policyDir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
    writeFileSync(join(policyDir, 'tool-annotations.json'), JSON.stringify(toolAnnotations));

    process.env.IRONCURTAIN_HOME = join(scratch, 'home');
    process.env.ALLOWED_DIRECTORY = sandboxDir;
    process.chdir(launchDir);
    manager = new MCPClientManager();
  });

  afterAll(async () => {
    try {
      await manager.closeAll();
    } finally {
      process.chdir(originalCwd);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('ships the exact-pinned server, launched with node from the package root (never npx)', () => {
    const { filesystem } = loadConfig().mcpServers;
    const entry = resolve(projectRoot, 'node_modules', PINNED_PACKAGE, 'dist', 'index.js');
    expect(filesystem.command).toBe('node');
    expect(filesystem.args).toEqual([entry, sandboxDir]);

    const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    const installed = JSON.parse(readFileSync(resolve(entry, '..', '..', 'package.json'), 'utf-8')) as {
      version: string;
    };
    expect(installed.version).toBe(manifest.dependencies[PINNED_PACKAGE]);
  });

  it('runs the packaged server through the relay and never executes the planted files', async () => {
    const filesystem = await launchableShippedFilesystem();
    await manager.connect('filesystem', relayConfig('filesystem', { filesystem }), [
      { uri: `file://${sandboxDir}`, name: 'sandbox' },
    ]);

    // Exactly the tool surface the shipped annotations describe: the
    // planted package (exit 1) would have failed the connect, and a newer
    // upstream release adds tools (append_file, copy_file) that are absent.
    const shipped = JSON.parse(
      readFileSync(resolve(projectRoot, 'src/config/generated/tool-annotations.json'), 'utf-8'),
    ) as StoredToolAnnotationsFile;
    const annotated = shipped.servers.filesystem.tools.map((t) => t.toolName).sort();
    const tools = (await manager.listTools('filesystem')).map((t) => t.name).sort();
    expect(tools).toEqual(annotated);

    const read = await manager.callTool('filesystem', 'read_text_file', { path: join(sandboxDir, 'hello.txt') });
    expect(resultText(read)).toBe('hello from the sandbox');

    expect(process.cwd()).toBe(launchDir);
    expect(markersIn(launchDir)).toEqual([]);
  }, 30_000);

  it('runs every relay-spawned backend in its own private directory', async () => {
    await manager.connect(
      'probe',
      relayConfig('probe', { probe: { command: 'node', args: [probeServerPath], sandbox: false } }),
    );
    const cwd = resultText(await manager.callTool('probe', 'report_cwd', {}));

    expect(basename(cwd)).toBe('probe.cwd');
    expect(basename(dirname(cwd))).toMatch(/^relay-/);
    expect(dirname(dirname(cwd))).toBe(backendCwdRoot());
    expect(statSync(cwd).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(cwd)).mode & 0o777).toBe(0o700);
    expect(cwd.startsWith(launchDir)).toBe(false);
    expect(markersIn(launchDir)).toEqual([]);
  }, 30_000);

  it("keeps every backend's private directory out of a shared, world-writable os.tmpdir()", async () => {
    // Launchers walk UP from their cwd (npm's project and workspace root,
    // .npmrc and local packages; tsx's tsconfig.json), so a private
    // directory below a world-writable TMPDIR would still run what any
    // local user planted there.
    const sharedTmp = join(scratch, 'shared-tmp');
    mkdirSync(sharedTmp);
    chmodSync(sharedTmp, 0o1777);
    plantSharedTmp(sharedTmp);
    const relayEnv = {
      TMPDIR: sharedTmp,
      // Keep npm off the network and out of the user's cache.
      npm_config_offline: 'true',
      npm_config_cache: join(scratch, 'npm-cache'),
      npm_config_update_notifier: 'false',
    };

    // A tsx-launched backend (fetch runs this way in source mode).
    await manager.connect(
      'probe-tsx',
      relayConfig('probe-tsx', { 'probe-tsx': { command: tsxBin, args: [probeServerPath], sandbox: false } }, relayEnv),
    );
    const cwd = resultText(await manager.callTool('probe-tsx', 'report_cwd', {}));
    expect(dirname(dirname(cwd))).toBe(backendCwdRoot());
    expect(cwd.startsWith(sharedTmp)).toBe(false);

    // git must not adopt a repository above the private directory.
    const ceiling = resultText(await manager.callTool('probe-tsx', 'report_env', { name: 'GIT_CEILING_DIRECTORIES' }));
    expect(ceiling.split(delimiter)[0]).toBe(dirname(cwd));

    // An npx-launched backend (google-workspace runs this way when srt is
    // unavailable). With npm offline and the spec published nowhere, it can
    // only start by resolving the package planted in the shared directory.
    await expect(
      manager.connect(
        'planted-npx',
        relayConfig(
          'planted-npx',
          { 'planted-npx': { command: 'npx', args: ['-y', PLANTED_NPX_SPEC], sandbox: false } },
          relayEnv,
        ),
      ),
    ).rejects.toThrow();

    expect(markersIn(sharedTmp)).toEqual([]);
  }, 60_000);

  it('spawns directly-connected servers from the package root', async () => {
    await manager.connect('probe-direct', { command: 'node', args: [probeServerPath] });
    const cwd = resultText(await manager.callTool('probe-direct', 'report_cwd', {}));
    expect(realpathSync(cwd)).toBe(realpathSync(getTrustedSpawnCwd()));
    expect(markersIn(launchDir)).toEqual([]);
  }, 30_000);
});
