/**
 * The session log a relay writes never carries a host credential that a
 * server's `-e NAME` argument forwards (the documented github setup, with
 * GITHUB_PERSONAL_ACCESS_TOKEN exported in the shell), whether the backend
 * echoes it on stderr while it runs or while it fails to start, and even
 * when the relay reads the line in two chunks that split the value. Real
 * hops:
 *
 *   this process --MCPClientManager.connect--> mcp-proxy-server.ts relay
 *     --buildBackendEnv--> backend (test/fixtures/stderr-token-server.mjs)
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
const tokenServerPath = resolve(projectRoot, 'test/fixtures/stderr-token-server.mjs');

/** A host token the server declares with `-e NAME`, exported in the shell only (no stored credential). */
const TOKEN_NAME = 'IRONCURTAIN_TEST_FORWARDED_TOKEN';
const TOKEN_VALUE = 'ghp_relayLogRedactionCanary0123456789';

function tokenServer(behaviour: { exitAtStartup?: boolean; splitWrite?: boolean } = {}): MCPServerConfig {
  return {
    command: 'node',
    // The fixture ignores its arguments; the relay reads the `-e` names.
    args: [tokenServerPath, '-e', TOKEN_NAME],
    env: {
      STDERR_TOKEN_VARIABLE: TOKEN_NAME,
      ...(behaviour.exitAtStartup === true ? { STDERR_TOKEN_EXIT: '1' } : {}),
      ...(behaviour.splitWrite === true ? { STDERR_TOKEN_SPLIT: '1' } : {}),
    },
    sandbox: false,
  };
}

const SERVERS: Record<string, MCPServerConfig> = {
  echoing: tokenServer(),
  failing: tokenServer({ exitAtStartup: true }),
  splitting: tokenServer({ splitWrite: true }),
};

/** srt is never involved: every server opts out, and the plan says it is unavailable. */
const NO_OS_SANDBOX: OsSandboxPlan = {
  policy: 'warn',
  availability: { available: false, platformSupported: true, problems: ['test'], warnings: [] },
  resolved: new Map(),
  refused: [],
  unconfined: [],
};

describe('relay session-log redaction of forwarded host credentials', { timeout: 60_000 }, () => {
  const savedHome = process.env.IRONCURTAIN_HOME;
  let scratch: string;
  let sessionLogPath: string;
  let proxyEnv: Record<string, string>;
  let manager: MCPClientManager;

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-relay-log-redaction-')));
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
    sessionLogPath = join(scratch, 'session.log');
    process.env.IRONCURTAIN_HOME = join(scratch, 'home');

    const config = {
      generatedDir: policyDir,
      toolAnnotationsDir: policyDir,
      allowedDirectory: sandboxDir,
      escalationTimeoutSeconds: 300,
      sessionLogPath,
      mcpServers: SERVERS,
      userConfig: { serverCredentials: {} },
    } as unknown as IronCurtainConfig;
    proxyEnv = buildProxySubprocessEnv(config, NO_OS_SANDBOX);
    manager = new MCPClientManager();
  });

  afterAll(async () => {
    try {
      await manager.closeAll();
    } finally {
      if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = savedHome;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  /** Connects the real relay for `name`; the token reaches it the way the session parent forwards it. */
  async function connectRelay(name: string): Promise<void> {
    const env = buildServerRelayEnv(proxyEnv, name, SERVERS[name], undefined, { [TOKEN_NAME]: TOKEN_VALUE });
    expect(env[TOKEN_NAME]).toBe(TOKEN_VALUE);
    await manager.connect(name, { command: tsxBin, args: [proxyServerPath], env, sandbox: false });
  }

  function sessionLog(): string {
    return existsSync(sessionLogPath) ? readFileSync(sessionLogPath, 'utf-8') : '';
  }

  /** Waits until the session log holds the backend's stderr line for `name`. */
  async function backendLogLine(name: string): Promise<string> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const line = sessionLog()
        .split('\n')
        .find((entry) => entry.includes(`[mcp:${name}] backend saw token=`));
      if (line !== undefined) return line;
      if (Date.now() > deadline) throw new Error(`no stderr line of "${name}" in the session log:\n${sessionLog()}`);
      await new Promise((settle) => setTimeout(settle, 100));
    }
  }

  it('masks the token in stderr lines a running backend writes', async () => {
    await connectRelay('echoing');

    expect(await backendLogLine('echoing')).toContain('backend saw token=***REDACTED***');
    expect(sessionLog()).not.toContain(TOKEN_VALUE);
  });

  it('masks the token in the stderr a backend that fails to start leaves behind', async () => {
    // Its only backend fails, so the relay has nothing to serve and exits.
    await expect(connectRelay('failing')).rejects.toThrow();

    expect(await backendLogLine('failing')).toContain('backend saw token=***REDACTED***');
    expect(sessionLog()).toContain('Skipping MCP server "failing"');
    expect(sessionLog()).not.toContain(TOKEN_VALUE);
  });

  it('masks a token whose line the relay reads in two chunks, split inside the value', async () => {
    await connectRelay('splitting');

    expect(await backendLogLine('splitting')).toContain('backend saw token=***REDACTED***');
    // Neither half of the value reaches the log: redacting each chunk on its
    // own would log both, one entry each.
    const half = Math.floor(TOKEN_VALUE.length / 2);
    expect(sessionLog()).not.toContain(TOKEN_VALUE.slice(0, half));
    expect(sessionLog()).not.toContain(TOKEN_VALUE.slice(half));
  });
});
