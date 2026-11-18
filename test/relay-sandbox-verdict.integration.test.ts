/**
 * A relay plans its server with the OS-sandbox availability its session
 * parent handed it (OS_SANDBOX_AVAILABILITY: the dependency check and the
 * srt smoke run), not with its own dependency check alone (FU-02, 01-08).
 * Real hops:
 *
 *   this process --MCPClientManager.connect--> mcp-proxy-server.ts relay
 *     --> backend (test/fixtures/cwd-probe-server.mjs)
 *
 * The parent's verdict here is "srt cannot start a sandbox on this host"
 * under sandboxPolicy "warn": the relay must start the server without srt, in
 * its unsandboxed private directory under the IronCurtain home, as the
 * parent's plan (and its `sandboxed: false` audit stamp) says. Before, a relay
 * on a host with bubblewrap, socat and ripgrep installed decided from that
 * check alone and wrapped the server in an srt that could not start.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPClientManager } from '../src/trusted-process/mcp-client-manager.js';
import { resolveNodeModulesBin, withOsSandboxSmokeResult } from '../src/trusted-process/sandbox-integration.js';
import { buildProxySubprocessEnv, buildServerRelayEnv, planSessionOsSandbox } from '../src/sandbox/index.js';
import type { IronCurtainConfig, MCPServerConfig } from '../src/config/types.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const proxyServerPath = resolve(projectRoot, 'src/trusted-process/mcp-proxy-server.ts');
const tsxBin = resolveNodeModulesBin('tsx', projectRoot);
const probeServerPath = resolve(projectRoot, 'test/fixtures/cwd-probe-server.mjs');

/** Asks for an OS sandbox, like the shipped git server. */
const PROBE: MCPServerConfig = { command: 'node', args: [probeServerPath], sandbox: { network: false } };

/** What a session parent concludes on a host where the helpers exist but srt cannot start a sandbox. */
const SRT_BROKEN = withOsSandboxSmokeResult(
  { available: true, platformSupported: true, problems: [], warnings: [] },
  { ok: false, elapsedMs: 3, detail: 'apply-seccomp: Permission denied' },
);

describe("a relay follows its parent's OS-sandbox verdict", { timeout: 60_000 }, () => {
  const savedHome = process.env.IRONCURTAIN_HOME;
  let scratch: string;
  let home: string;
  let manager: MCPClientManager;

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-relay-verdict-')));
    const policyDir = join(scratch, 'policy');
    home = join(scratch, 'home');
    mkdirSync(policyDir);
    mkdirSync(join(scratch, 'sandbox'));
    mkdirSync(home);
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
    process.env.IRONCURTAIN_HOME = home;
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

  it('runs the server unconfined under "warn" when the parent found that srt cannot start', async () => {
    const config = {
      generatedDir: join(scratch, 'policy'),
      toolAnnotationsDir: join(scratch, 'policy'),
      allowedDirectory: join(scratch, 'sandbox'),
      escalationTimeoutSeconds: 300,
      sandboxPolicy: 'warn',
      mcpServers: { probe: PROBE },
      userConfig: { serverCredentials: {} },
    } as unknown as IronCurtainConfig;
    const plan = planSessionOsSandbox(config, SRT_BROKEN);
    expect(plan.unconfined).toEqual(['probe']);
    const proxyEnv = buildProxySubprocessEnv(config, plan);
    const env = buildServerRelayEnv(proxyEnv, 'probe', PROBE, undefined, {});

    await manager.connect('probe', { command: tsxBin, args: [proxyServerPath], env, sandbox: false });
    const result = (await manager.callTool('probe', 'report_cwd', {})) as {
      content: Array<{ type: string; text: string }>;
    };

    // The unsandboxed private directory (spawn-cwd.ts), not an srt one in
    // the per-user scratch root.
    const cwd = result.content[0].text;
    expect(cwd.startsWith(join(home, 'run', 'mcp-cwd') + sep)).toBe(true);
    expect(cwd.endsWith(`${sep}probe.cwd`)).toBe(true);
  });
});
