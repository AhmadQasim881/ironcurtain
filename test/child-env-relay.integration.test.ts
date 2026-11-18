/**
 * End-to-end check of the environment an MCP backend receives through a
 * session relay, over the real two hops and with the session parent's own
 * environment builders:
 *
 *   this process --MCPClientManager.connect--> mcp-proxy-server.ts relay
 *     --buildBackendEnv--> backend (test/fixtures/cwd-probe-server.mjs)
 *
 * The parent holds a canary and a provider key in its environment, a
 * NODE_OPTIONS preload, and two servers' configuration and credentials. A
 * backend must see none of the host's secrets and nothing of the other
 * server (TPM-8, SES-10, CFG-10); no Node.js child may load the preload;
 * the host token a server's own `-e NAME` argument forwards must still
 * arrive (the documented github setup); and a server whose credential
 * exists only in config.json's serverCredentials must start (TPM-10).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPClientManager } from '../src/trusted-process/mcp-client-manager.js';
import { resolveNodeModulesBin, type OsSandboxPlan } from '../src/trusted-process/sandbox-integration.js';
import { buildProxySubprocessEnv, buildServerRelayEnv } from '../src/sandbox/index.js';
import type { IronCurtainConfig, MCPServerConfig } from '../src/config/types.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const proxyServerPath = resolve(projectRoot, 'src/trusted-process/mcp-proxy-server.ts');
const tsxBin = resolveNodeModulesBin('tsx', projectRoot);
const probeServerPath = resolve(projectRoot, 'test/fixtures/cwd-probe-server.mjs');

/** A secret only the parent holds: must never reach a relay or backend. */
const CANARY = 'IRONCURTAIN_TEST_HOST_CANARY';
const CANARY_VALUE = 'host-canary-value-3f9a';
const PROVIDER_KEY_VALUE = 'sk-ant-host-secret-77c1';
/** A host token one server declares with `-e NAME` (the github pattern). */
const PASSTHROUGH = 'IRONCURTAIN_TEST_PASSTHROUGH_TOKEN';
/** A credential that exists only in config.json's serverCredentials. */
const CREDENTIAL_ONLY = 'IRONCURTAIN_TEST_CREDENTIAL_ONLY';
/** The other server's configuration and credential: never visible to the probe. */
const OTHER_CONFIG_SECRET = 'other-server-config-secret-5d2e';
const OTHER_CREDENTIAL_SECRET = 'other-server-credential-secret-81b0';

/** Where the user moved the credential stores: for the relay alone (its srt deny baseline). */
const MOVED_STORES = { ANTHROPIC_CONFIG_DIR: '/data/anthropic-cli', CODEX_HOME: '/data/codex' } as const;
/** The user's own git configuration file: every git a child runs must read it. */
const GIT_CONFIG_GLOBAL_VALUE = '/data/dotfiles/gitconfig';

const TOUCHED = [
  CANARY,
  PASSTHROUGH,
  CREDENTIAL_ONLY,
  'ANTHROPIC_API_KEY',
  'NODE_OPTIONS',
  'IRONCURTAIN_HOME',
  'ANTHROPIC_CONFIG_DIR',
  'CODEX_HOME',
  'GIT_CONFIG_GLOBAL',
] as const;

/** First text block of an MCP tool result. */
function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.find((c) => c.type === 'text')?.text ?? '';
}

const SERVERS: Record<string, MCPServerConfig> = {
  probe: { command: 'node', args: [probeServerPath], env: { PROBE_OWN_SETTING: 'own' }, sandbox: false },
  other: {
    command: 'node',
    args: [probeServerPath],
    env: { OTHER_CONFIG_SETTING: OTHER_CONFIG_SECRET },
    sandbox: false,
  },
  'github-like': {
    command: 'node',
    // The probe ignores its arguments; the relay reads the `-e` names.
    args: [probeServerPath, '-e', PASSTHROUGH, '-e', CREDENTIAL_ONLY],
    sandbox: false,
  },
  unconfigured: {
    command: 'node',
    args: [probeServerPath, '-e', 'IRONCURTAIN_TEST_UNSET_ANYWHERE'],
    sandbox: false,
  },
};

const CREDENTIALS: Record<string, Record<string, string>> = {
  other: { OTHER_CREDENTIAL: OTHER_CREDENTIAL_SECRET },
  'github-like': { [CREDENTIAL_ONLY]: 'from-config' },
};

/** srt is never involved: every server opts out, and the plan says it is unavailable. */
const NO_OS_SANDBOX: OsSandboxPlan = {
  policy: 'warn',
  availability: { available: false, platformSupported: true, problems: ['test'], warnings: [] },
  resolved: new Map(),
  refused: [],
  unconfined: [],
};

describe('backend environment through a session relay', { timeout: 60_000 }, () => {
  const saved = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
  let scratch: string;
  let preloadMarker: string;
  let proxyEnv: Record<string, string>;
  let manager: MCPClientManager;

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-child-env-relay-')));
    const policyDir = join(scratch, 'policy');
    const sandboxDir = join(scratch, 'sandbox');
    mkdirSync(policyDir);
    mkdirSync(sandboxDir);
    mkdirSync(join(scratch, 'home'));
    // Minimal artifacts for the relay's root derivation.
    const compiledPolicy: CompiledPolicyFile = {
      generatedAt: 'test-fixture',
      constitutionHash: 'test-fixture',
      inputHash: 'test-fixture',
      rules: [],
    };
    const toolAnnotations: StoredToolAnnotationsFile = { generatedAt: 'test-fixture', servers: {} };
    writeFileSync(join(policyDir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
    writeFileSync(join(policyDir, 'tool-annotations.json'), JSON.stringify(toolAnnotations));

    // Any Node.js process that inherits NODE_OPTIONS runs this and leaves a mark.
    preloadMarker = join(scratch, 'preload-ran');
    const preload = join(scratch, 'preload.cjs');
    writeFileSync(
      preload,
      `require('node:fs').appendFileSync(${JSON.stringify(preloadMarker)}, process.pid + '\\n');\n`,
    );

    process.env.IRONCURTAIN_HOME = join(scratch, 'home');
    process.env[CANARY] = CANARY_VALUE;
    process.env[PASSTHROUGH] = 'host-token';
    process.env.ANTHROPIC_API_KEY = PROVIDER_KEY_VALUE;
    process.env.NODE_OPTIONS = `--require ${preload}`;
    Object.assign(process.env, MOVED_STORES);
    process.env.GIT_CONFIG_GLOBAL = GIT_CONFIG_GLOBAL_VALUE;
    delete process.env[CREDENTIAL_ONLY];

    // The block every relay of the session shares, built the way the
    // session parent builds it (connectBackendSubprocesses).
    const config = {
      generatedDir: policyDir,
      toolAnnotationsDir: policyDir,
      allowedDirectory: sandboxDir,
      escalationTimeoutSeconds: 300,
      mcpServers: SERVERS,
      userConfig: { serverCredentials: CREDENTIALS },
    } as unknown as IronCurtainConfig;
    proxyEnv = buildProxySubprocessEnv(config, NO_OS_SANDBOX);
    manager = new MCPClientManager();
  });

  afterAll(async () => {
    try {
      await manager.closeAll();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  /** The environment block of `name`'s relay, as connectBackendSubprocesses builds it. */
  function relayEnv(name: string): Record<string, string> {
    return buildServerRelayEnv(proxyEnv, name, SERVERS[name], CREDENTIALS[name]);
  }

  /** Connects the real relay for `name`, the way connectBackendSubprocesses does in source mode. */
  async function connectRelay(name: string): Promise<void> {
    await manager.connect(name, { command: tsxBin, args: [proxyServerPath], env: relayEnv(name), sandbox: false });
  }

  async function backendEnv(server: string, name: string): Promise<string> {
    return resultText(await manager.callTool(server, 'report_env', { name }));
  }

  async function wholeEnv(server: string): Promise<Record<string, string>> {
    return JSON.parse(resultText(await manager.callTool(server, 'report_env_all', {}))) as Record<string, string>;
  }

  it("gives a relay the allowlist and its own server's block only", async () => {
    // The probe stands in for the relay program: MCPClientManager.connect
    // hands it exactly the environment a relay for "probe" gets.
    await manager.connect('relay-env', {
      command: 'node',
      args: [probeServerPath],
      env: relayEnv('probe'),
      sandbox: false,
    });
    const env = await wholeEnv('relay-env');

    expect(env).not.toHaveProperty(CANARY);
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty(PASSTHROUGH);
    expect(JSON.parse(env.MCP_SERVERS_CONFIG)).toEqual({ probe: SERVERS.probe });
    expect(env.SERVER_FILTER).toBe('probe');
    expect(env).not.toHaveProperty('SERVER_CREDENTIALS');
    const serialized = JSON.stringify(env);
    for (const secret of [CANARY_VALUE, PROVIDER_KEY_VALUE, OTHER_CONFIG_SECRET, OTHER_CREDENTIAL_SECRET]) {
      expect(serialized).not.toContain(secret);
    }
    expect(env.PATH).toBe(process.env.PATH);
    // The relay hides the credential stores from its sandboxed backends
    // where the user moved them, so it must be told where that is.
    expect(env.ANTHROPIC_CONFIG_DIR).toBe(MOVED_STORES.ANTHROPIC_CONFIG_DIR);
    expect(env.CODEX_HOME).toBe(MOVED_STORES.CODEX_HOME);
    expect(env.GIT_CONFIG_GLOBAL).toBe(GIT_CONFIG_GLOBAL_VALUE);
  });

  it('hides the host environment, the relay configuration and the other server from the backend', async () => {
    await connectRelay('other');
    await connectRelay('probe');

    const env = await wholeEnv('probe');
    for (const name of [
      CANARY,
      'ANTHROPIC_API_KEY',
      'NODE_OPTIONS',
      // A token the host holds but this server does not declare.
      PASSTHROUGH,
      // The relay's own configuration.
      'MCP_SERVERS_CONFIG',
      'SERVER_CREDENTIALS',
      'GENERATED_DIR',
      'TOOL_ANNOTATIONS_DIR',
      'SERVER_FILTER',
      'ALLOWED_DIRECTORY',
      'SANDBOX_POLICY',
      'IRONCURTAIN_SANDBOX_POLICY',
      'ESCALATION_TIMEOUT_SECONDS',
      'CONTAINER_WORKSPACE_DIR',
      // The other server's env block and credential.
      'OTHER_CONFIG_SETTING',
      'OTHER_CREDENTIAL',
      // Relay-only: where the credential stores are.
      'ANTHROPIC_CONFIG_DIR',
      'CODEX_HOME',
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
    const serialized = JSON.stringify(env);
    for (const secret of [CANARY_VALUE, PROVIDER_KEY_VALUE, OTHER_CONFIG_SECRET, OTHER_CREDENTIAL_SECRET]) {
      expect(serialized).not.toContain(secret);
    }

    // What a server needs still arrives: the SDK defaults, its own env
    // block, and the IronCurtain home the parent resolved.
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.PROBE_OWN_SETTING).toBe('own');
    expect(env.IRONCURTAIN_HOME).toBe(join(scratch, 'home'));
    expect(env.GIT_CONFIG_GLOBAL).toBe(GIT_CONFIG_GLOBAL_VALUE);

    // The other server does get its own configuration and credential.
    expect(await backendEnv('other', 'OTHER_CONFIG_SETTING')).toBe(OTHER_CONFIG_SECRET);
    expect(await backendEnv('other', 'OTHER_CREDENTIAL')).toBe(OTHER_CREDENTIAL_SECRET);
  });

  it('forwards a host token the server declares with -e, and starts a server whose credential exists only in serverCredentials', async () => {
    // Before, the relay skipped this server: it checked only its process.env
    // for CREDENTIAL_ONLY, never the SERVER_CREDENTIALS it was about to inject.
    await connectRelay('github-like');

    expect(await backendEnv('github-like', PASSTHROUGH)).toBe('host-token');
    expect(await backendEnv('github-like', CREDENTIAL_ONLY)).toBe('from-config');
    expect(await backendEnv('github-like', CANARY)).toBe('');
    expect(await backendEnv('github-like', 'ANTHROPIC_API_KEY')).toBe('');
    // The relay scrubbed its own copy before spawning.
    expect(await backendEnv('github-like', 'SERVER_CREDENTIALS')).toBe('');
  });

  it('still skips a server whose `-e` variable is set nowhere', async () => {
    // Its only backend is skipped, so the relay has nothing to serve and exits.
    await expect(connectRelay('unconfigured')).rejects.toThrow();
  });

  it('never runs the NODE_OPTIONS preload in a relay or a backend', () => {
    expect(existsSync(preloadMarker) ? readFileSync(preloadMarker, 'utf-8') : '').toBe('');
  });
});
