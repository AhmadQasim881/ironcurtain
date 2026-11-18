/**
 * Offline drift checks against live MCP servers (WP-27):
 *
 *  - tool discovery (`pipeline/live-tools.ts`, shared by annotate-tools,
 *    compile-policy and `mcp add`) and doctor's probe return each server's
 *    tools and the identity it reports at `initialize`;
 *  - discovery launches each server as its session relay does (FU-02): a
 *    server that asks for an OS sandbox runs under srt with its stored
 *    credentials, one the policy refuses is not started, an OAuth-backed one
 *    is never started, and the filesystem server gets an empty directory;
 *  - the annotation check report behind `annotate-tools --check` and
 *    compile-policy's drift warning;
 *  - compile-policy validates scenarios against the live schemas it
 *    collected, and says so when it could not check (`--no-mcp`).
 *
 * The live server is test/fixtures/cwd-probe-server.mjs, a small stdio MCP
 * server (report_cwd, report_env, report_env_all). The launch tests inject a
 * transport that records the prepared spawn and refuses to start it (srt
 * cannot start sandboxes on every build host); the report-level tests below
 * use synthetic live tools.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { parse as parseShell } from 'shell-quote';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronCurtainConfig, MCPServerConfig } from '../src/config/types.js';
import { createProbeEnvironment, probeConfiguredServer } from '../src/doctor/mcp-liveness.js';
import { buildAnnotationCheckReport, formatAnnotationCheckReport } from '../src/pipeline/annotation-check.js';
import { checkLiveAnnotationDrift } from '../src/pipeline/compile.js';
import {
  buildLiveSchemaIndex,
  connectForToolDiscovery,
  disconnectAll,
  discoverLiveTools,
  type LiveServerConnection,
  type LiveServerTools,
  type LiveToolDiscovery,
} from '../src/pipeline/live-tools.js';
import { filterInvalidSchemaScenarios, liveSchemaKey } from '../src/pipeline/scenario-schema-validator.js';
import type { StoredToolAnnotation, StoredToolAnnotationsFile, TestScenario } from '../src/pipeline/types.js';
import {
  formatSandboxRefusal,
  withOsSandboxSmokeResult,
  type OsSandboxAvailability,
} from '../src/trusted-process/sandbox-integration.js';
import { getPrivateScratchRoot } from '../src/trusted-process/spawn-cwd.js';
import type { ToolListingSpawn } from '../src/trusted-process/tool-listing-launch.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_PATH = resolve(projectRoot, 'test/fixtures/cwd-probe-server.mjs');
const PROBE_SERVER: MCPServerConfig = {
  command: process.execPath,
  args: [PROBE_PATH],
  sandbox: false,
};

const REPORT_ENV_SCHEMA = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

function stored(toolName: string, args: StoredToolAnnotation['args'], inputSchema: Record<string, unknown>) {
  return { toolName, serverName: 'probe', comment: toolName, args, inputSchema };
}

/** Annotations that describe the probe server exactly. */
const MATCHING: StoredToolAnnotationsFile = {
  generatedAt: '',
  servers: {
    probe: {
      inputHash: 'h',
      serverInfo: { name: 'cwd-probe', version: '0.0.0' },
      tools: [
        stored('report_cwd', {}, { type: 'object', properties: {} }),
        stored('report_env', { name: ['none'] }, REPORT_ENV_SCHEMA),
      ],
    },
  },
};

/** The tools test/fixtures/cwd-probe-server.mjs lists. */
const PROBE_TOOL_NAMES = ['report_cwd', 'report_env', 'report_env_all'];

describe('live tool discovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists the tools and the reported identity of a server', async () => {
    const connection = await connectForToolDiscovery('probe', PROBE_SERVER);
    try {
      expect(connection.tools.map((t) => t.name)).toEqual(PROBE_TOOL_NAMES);
      expect(connection.tools[1].inputSchema).toEqual(REPORT_ENV_SCHEMA);
      expect(connection.serverInfo).toEqual({ name: 'cwd-probe', version: '0.0.0' });
    } finally {
      await disconnectAll([connection]);
    }
  }, 30_000);

  // annotate-tools and compile-policy spawn the configured servers through
  // connectForToolDiscovery: they get the allowlisted child environment
  // (trusted-process/child-env.ts) with the server's `-e NAME` passthroughs
  // and its `env` block, never the host's provider keys.
  it('spawns the server with the allowlisted environment, not the host one', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-host-secret');
    vi.stubEnv('IC_PROBE_FORWARDED', 'forwarded-value');
    vi.stubEnv('IC_PROBE_UNLISTED', 'unlisted-value');
    const connection = await connectForToolDiscovery('probe', {
      ...PROBE_SERVER,
      args: [...PROBE_SERVER.args, '-e', 'IC_PROBE_FORWARDED'],
      env: { IC_PROBE_CONFIGURED: 'configured-value' },
    });
    try {
      const result = await connection.client.callTool({ name: 'report_env_all', arguments: {} });
      const [first] = result.content as Array<{ type: string; text: string }>;
      const childEnv = JSON.parse(first.text) as Record<string, string>;
      expect(childEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(childEnv).not.toHaveProperty('IC_PROBE_UNLISTED');
      expect(childEnv.IC_PROBE_FORWARDED).toBe('forwarded-value');
      expect(childEnv.IC_PROBE_CONFIGURED).toBe('configured-value');
    } finally {
      await disconnectAll([connection]);
    }
  }, 30_000);

  it('reports a server that cannot be started as skipped, never fatal', async () => {
    const discovery = await discoverLiveTools({
      probe: PROBE_SERVER,
      broken: { command: resolve(projectRoot, 'no-such-binary'), args: [], sandbox: false },
    });
    try {
      expect([...discovery.connections.keys()]).toEqual(['probe']);
      expect(discovery.skipped.map((s) => s.name)).toEqual(['broken']);
      expect(discovery.skipped[0].reason.length).toBeGreaterThan(0);
      const index = buildLiveSchemaIndex(discovery.connections);
      expect(index.get(liveSchemaKey('probe', 'report_env'))).toEqual(REPORT_ENV_SCHEMA);
    } finally {
      await discovery.close();
    }
  }, 30_000);

  it('hands a server the credentials stored for it in config.json', async () => {
    const connection = await connectForToolDiscovery(
      'probe',
      { ...PROBE_SERVER, args: [...PROBE_SERVER.args, '-e', 'IC_PROBE_STORED'] },
      { serverCredentials: { probe: { IC_PROBE_STORED: 'stored-value' }, other: { IC_PROBE_OTHER: 'x' } } },
    );
    try {
      const result = await connection.client.callTool({ name: 'report_env_all', arguments: {} });
      const [first] = result.content as Array<{ type: string; text: string }>;
      const childEnv = JSON.parse(first.text) as Record<string, string>;
      expect(childEnv.IC_PROBE_STORED).toBe('stored-value');
      // Only its own: another server's credentials never reach it.
      expect(childEnv).not.toHaveProperty('IC_PROBE_OTHER');
    } finally {
      await disconnectAll([connection]);
    }
  }, 30_000);

  it("doctor's probe returns the tools and identity for the drift check", async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'ironcurtain-doctor-probe-'));
    const environment = createProbeEnvironment({
      config: {
        mcpServers: { probe: PROBE_SERVER },
        allowedDirectory: allowed,
        userConfig: { serverCredentials: {} },
      } as unknown as IronCurtainConfig,
      availability: { available: false, platformSupported: true, problems: ['bwrap missing'], warnings: [] },
      policy: 'warn',
    });
    const result = await probeConfiguredServer('probe', PROBE_SERVER, {
      credentials: {},
      environment: () => environment,
    }).finally(() => {
      environment.dispose();
      rmSync(allowed, { recursive: true, force: true });
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.toolCount).toBe(PROBE_TOOL_NAMES.length);
    expect(result.tools?.map((t) => t.name)).toEqual(PROBE_TOOL_NAMES);
    expect(result.serverInfo).toEqual({ name: 'cwd-probe', version: '0.0.0' });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// FU-02 (09-02, 01-01): discovery launches servers as their relays do
// ---------------------------------------------------------------------------

const DEPS_PRESENT: OsSandboxAvailability = { available: true, platformSupported: true, problems: [], warnings: [] };

/** A host whose helpers are installed but where srt cannot start a sandbox (as a session sees it). */
const SRT_BROKEN = withOsSandboxSmokeResult(DEPS_PRESENT, {
  ok: false,
  elapsedMs: 3,
  detail: 'apply-seccomp: Permission denied',
});

describe('tool discovery launches each server as its session relay does', () => {
  let spawns: ToolListingSpawn[];
  let home: string;

  beforeEach(() => {
    spawns = [];
    home = mkdtempSync(join(tmpdir(), 'ic-discovery-home-'));
    vi.stubEnv('IRONCURTAIN_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  /** Records each prepared spawn and refuses to start it, so no server (and no srt) runs. */
  function recordingTransport(spawn: ToolListingSpawn): Transport {
    spawns.push(spawn);
    return {
      start: () => Promise.reject(new Error('spawn blocked by test')),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
  }

  /** The spawn recorded for the server whose command line names `marker`. */
  function spawnNaming(marker: string): ToolListingSpawn {
    const spawn = spawns.find((s) => [...s.args, s.command].some((part) => part.includes(marker)));
    if (spawn === undefined) throw new Error(`no spawn names ${marker}: ${JSON.stringify(spawns)}`);
    return spawn;
  }

  it('wraps a server that asks for an OS sandbox in srt and gives it its stored credentials', async () => {
    const discovery = await discoverLiveTools(
      { svc: { command: process.execPath, args: [PROBE_PATH, 'svc-marker'], sandbox: { network: false } } },
      {
        availability: DEPS_PRESENT,
        sandboxPolicy: 'enforce',
        serverCredentials: { svc: { SVC_TOKEN: 'stored-secret-value' } },
        credentialProtection: { extraPaths: [join(home, 'additional-store')] },
        transport: recordingTransport,
      },
    );
    try {
      expect(discovery.skipped.map((s) => s.reason)).toEqual(['spawn blocked by test']);
      const spawn = spawnNaming('svc-marker');
      // At the base this was the raw command: process.execPath, unconfined,
      // with no credentials.
      expect(spawn.sandboxed).toBe(true);
      expect(spawn.command).toMatch(/srt$/);
      expect(spawn.args[0]).toBe('-s');
      expect(spawn.args[2]).toBe('-c');
      expect(parseShell(spawn.args[3])).toEqual([process.execPath, PROBE_PATH, 'svc-marker']);
      // The relay's layout: settings and the server's cwd below the per-user
      // scratch root, never in the IronCurtain home.
      const settingsPath = spawn.args[1];
      expect(settingsPath.startsWith(getPrivateScratchRoot())).toBe(true);
      expect(spawn.cwd.startsWith(getPrivateScratchRoot())).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { filesystem: { denyRead: string[] } };
      expect(settings.filesystem.denyRead).toContain(resolve(home));
      expect(settings.filesystem.denyRead).toContain(join(home, 'additional-store'));
      expect(spawn.env.SVC_TOKEN).toBe('stored-secret-value');
      expect(spawn.secrets).toContain('stored-secret-value');
      expect(discovery.sandboxWarning).toBeUndefined();
    } finally {
      await discovery.close();
    }
    // The run's scratch directories go with it.
    expect(existsSync(spawnNaming('svc-marker').args[1])).toBe(false);
  });

  it('does not start a sandbox-declaring server under "enforce" when srt cannot start, with the session refusal', async () => {
    const discovery = await discoverLiveTools(
      {
        svc: { command: process.execPath, args: [PROBE_PATH, 'svc-marker'], sandbox: { network: false } },
        open: { command: process.execPath, args: [PROBE_PATH, 'open-marker'], sandbox: false },
      },
      { availability: SRT_BROKEN, sandboxPolicy: 'enforce', serverCredentials: {}, transport: recordingTransport },
    );
    try {
      const refusal = discovery.skipped.find((s) => s.name === 'svc')?.reason;
      expect(refusal).toBe(formatSandboxRefusal('svc', SRT_BROKEN));
      expect(refusal).toContain('srt cannot start a sandbox on this host: apply-seccomp: Permission denied');
      expect(refusal).toContain('sandboxPolicy is "enforce"');
      // Only the server that opts out was ever spawned.
      expect(spawns.map((s) => s.args.at(-1))).toEqual(['open-marker']);
      expect(discovery.sandboxWarning).toBeUndefined();
    } finally {
      await discovery.close();
    }
  });

  it('runs it unconfined under "warn", with the warning naming it', async () => {
    const discovery = await discoverLiveTools(
      { svc: { command: process.execPath, args: [PROBE_PATH, 'svc-marker'], sandbox: { network: false } } },
      { availability: SRT_BROKEN, sandboxPolicy: 'warn', serverCredentials: {}, transport: recordingTransport },
    );
    try {
      const spawn = spawnNaming('svc-marker');
      expect(spawn.sandboxed).toBe(false);
      expect(spawn.command).toBe(process.execPath);
      expect(discovery.sandboxWarning).toContain('WITHOUT OS containment: svc');
      expect(discovery.sandboxWarning).toContain('srt cannot start a sandbox on this host');
    } finally {
      await discovery.close();
    }
  });

  // The plan lists google-workspace as unconfined under "warn" (a session
  // does start it), but a tool listing never starts it, so the warning that
  // names the servers running WITHOUT OS containment must not name it.
  it('does not name an OAuth-backed server it never starts in the "warn" warning', async () => {
    const oauthBacked = { command: 'npx', args: ['-y', '@alanse/mcp-server-google-workspace@1.0.2'] };
    const both = await discoverLiveTools(
      {
        svc: { command: process.execPath, args: [PROBE_PATH, 'svc-marker'], sandbox: { network: false } },
        'google-workspace': oauthBacked,
      },
      { availability: SRT_BROKEN, sandboxPolicy: 'warn', serverCredentials: {}, transport: recordingTransport },
    );
    try {
      expect(spawns.map((s) => s.args.at(-1))).toEqual(['svc-marker']);
      expect(both.sandboxWarning).toContain('WITHOUT OS containment: svc (sandboxPolicy "warn")');
      expect(both.sandboxWarning).not.toContain('google-workspace');
    } finally {
      await both.close();
    }

    const alone = await discoverLiveTools(
      { 'google-workspace': oauthBacked },
      { availability: SRT_BROKEN, sandboxPolicy: 'warn', serverCredentials: {}, transport: recordingTransport },
    );
    try {
      expect(alone.sandboxWarning).toBeUndefined();
    } finally {
      await alone.close();
    }
  });

  it('never starts an OAuth-backed server (google-workspace)', async () => {
    const discovery = await discoverLiveTools(
      { 'google-workspace': { command: 'npx', args: ['-y', '@alanse/mcp-server-google-workspace@1.0.2'] } },
      { availability: DEPS_PRESENT, sandboxPolicy: 'enforce', serverCredentials: {}, transport: recordingTransport },
    );
    try {
      expect(spawns).toEqual([]);
      expect(discovery.skipped).toHaveLength(1);
      expect(discovery.skipped[0].reason).toContain('OAuth token');
    } finally {
      await discovery.close();
    }
  });

  it('points the filesystem server at an empty temporary directory, removed with the run', async () => {
    const configured = mkdtempSync(join(tmpdir(), 'ic-discovery-configured-'));
    try {
      const discovery = await discoverLiveTools(
        { filesystem: { command: process.execPath, args: [PROBE_PATH, configured], sandbox: false } },
        { availability: DEPS_PRESENT, sandboxPolicy: 'enforce', serverCredentials: {}, transport: recordingTransport },
      );
      let standIn = '';
      try {
        standIn = spawns[0].args.at(-1) ?? '';
        expect(standIn).not.toBe(configured);
        expect(realpathSync(dirname(standIn))).toBe(realpathSync(tmpdir()));
        expect(readdirSync(standIn)).toEqual([]);
      } finally {
        await discovery.close();
      }
      expect(existsSync(standIn)).toBe(false);
      expect(existsSync(configured)).toBe(true);
    } finally {
      rmSync(configured, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The annotation check report (annotate-tools --check, compile-policy)
// ---------------------------------------------------------------------------

function liveServer(tools: LiveServerTools['tools'], serverInfo?: LiveServerTools['serverInfo']): LiveServerTools {
  return { tools, ...(serverInfo ? { serverInfo } : {}) };
}

const LIVE_PROBE = liveServer(
  [
    { name: 'report_cwd', inputSchema: { type: 'object', properties: {} } },
    { name: 'report_env', inputSchema: REPORT_ENV_SCHEMA },
  ],
  { name: 'cwd-probe', version: '0.0.0' },
);

describe('buildAnnotationCheckReport', () => {
  it('passes a server whose annotations match its live tools', () => {
    const report = buildAnnotationCheckReport(MATCHING, new Map([['probe', LIVE_PROBE]]));
    expect(report).toMatchObject({ hasDrift: false, affectsPolicy: false });
    expect(formatAnnotationCheckReport(report)).toEqual([
      { level: 'info', text: '"probe": 2 tool(s) (cwd-probe 0.0.0); annotations match the live tools' },
    ]);
  });

  it('reports argument drift with the release the annotations were written for', () => {
    const live = liveServer(
      [
        { name: 'report_cwd', inputSchema: { type: 'object', properties: {} } },
        {
          name: 'report_env',
          inputSchema: { type: 'object', properties: { name: { type: 'string' }, scope: { type: 'string' } } },
        },
      ],
      { name: 'cwd-probe', version: '1.0.0' },
    );
    const report = buildAnnotationCheckReport(MATCHING, new Map([['probe', live]]));
    expect(report).toMatchObject({ hasDrift: true, affectsPolicy: true });
    const lines = formatAnnotationCheckReport(report);
    expect(lines[0]).toEqual({
      level: 'warn',
      text: '"probe": 2 tool(s) (cwd-probe 1.0.0); annotated for cwd-probe 0.0.0',
    });
    const text = lines.map((l) => l.text).join('\n');
    expect(text).toContain('report_env (unannotated: scope; required: -name)');
    expect(text).toContain('ironcurtain annotate-tools --server probe');
  });

  it('reports a live server without annotations and servers that could not be started', () => {
    const report = buildAnnotationCheckReport(MATCHING, new Map([['other', LIVE_PROBE]]), [
      { name: 'github', reason: 'docker: not found\u001b[2J' },
    ]);
    expect(report).toMatchObject({ hasDrift: true, affectsPolicy: true });
    const lines = formatAnnotationCheckReport(report);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].text).toContain('no tool annotations, every call is denied');
    expect(lines[1]).toEqual({
      level: 'info',
      text: '"github": not checked, the server could not be started: docker: not found\\u001b[2J',
    });
  });

  it('separates schema text drift from drift that changes policy', () => {
    const live = liveServer([
      { name: 'report_cwd', inputSchema: { type: 'object', properties: {}, description: 'reworded' } },
      { name: 'report_env', inputSchema: REPORT_ENV_SCHEMA },
    ]);
    const report = buildAnnotationCheckReport(MATCHING, new Map([['probe', live]]));
    expect(report).toMatchObject({ hasDrift: true, affectsPolicy: false });
  });
});

// ---------------------------------------------------------------------------
// compile-policy
// ---------------------------------------------------------------------------

function connectionOf(tools: LiveServerTools): LiveServerConnection {
  const close = vi.fn(() => Promise.resolve());
  return { ...tools, client: { close } as unknown as LiveServerConnection['client'], close };
}

describe('compile-policy live drift check', () => {
  it('checks only the annotated servers being compiled, warns on drift and returns the live schemas', async () => {
    const drifted = connectionOf(
      liveServer([
        { name: 'report_cwd', inputSchema: { type: 'object', properties: {} } },
        {
          name: 'report_env',
          inputSchema: { type: 'object', properties: { name: { type: 'string' }, scope: { type: 'string' } } },
        },
      ]),
    );
    const close = vi.fn(() => Promise.resolve());
    const discover = vi.fn((servers: Record<string, MCPServerConfig>): Promise<LiveToolDiscovery> =>
      Promise.resolve({
        connections: new Map(Object.keys(servers).map((name) => [name, drifted])),
        skipped: [],
        close,
      }),
    );
    const lines: string[] = [];
    const index = await checkLiveAnnotationDrift(
      { probe: PROBE_SERVER, unannotated: PROBE_SERVER, other: PROBE_SERVER },
      MATCHING,
      undefined,
      (line) => lines.push(line),
      discover,
    );

    expect(Object.keys(discover.mock.calls[0][0])).toEqual(['probe']);
    const output = lines.join('\n');
    expect(output).toContain('report_env (unannotated: scope');
    expect(output).toContain('until the server is re-annotated and the policy recompiled');
    expect(index.get(liveSchemaKey('probe', 'report_env'))).toEqual(drifted.tools[1].inputSchema);
    // The run is closed: its connections and its scratch directories.
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a server the OS-sandbox policy refused as not checked and prints the unconfined warning', async () => {
    const refusal = formatSandboxRefusal('probe', SRT_BROKEN);
    const discover = vi.fn((): Promise<LiveToolDiscovery> =>
      Promise.resolve({
        connections: new Map(),
        skipped: [{ name: 'probe', reason: refusal }],
        sandboxWarning:
          'IronCurtain: WARNING: OS sandbox unavailable (x); MCP server(s) running WITHOUT OS containment: y',
        close: () => Promise.resolve(),
      }),
    );
    const lines: string[] = [];
    const index = await checkLiveAnnotationDrift(
      { probe: PROBE_SERVER },
      MATCHING,
      undefined,
      (line) => {
        lines.push(line);
      },
      discover,
    );
    const output = lines.join('\n');
    expect(output).toContain('"probe": not checked');
    expect(output).toContain('Not starting MCP server');
    expect(output).toContain('WITHOUT OS containment');
    expect(index.size).toBe(0);
  });

  it('honours the --server filter and skips the check when nothing is annotated', async () => {
    const discover = vi.fn((): Promise<LiveToolDiscovery> =>
      Promise.resolve({ connections: new Map(), skipped: [], close: () => Promise.resolve() }),
    );
    const index = await checkLiveAnnotationDrift({ probe: PROBE_SERVER }, MATCHING, 'other', () => {}, discover);
    expect(discover).not.toHaveBeenCalled();
    expect(index.size).toBe(0);
  });
});

describe('scenario schema validation', () => {
  const annotations = MATCHING.servers.probe.tools;
  function scenario(args: Record<string, unknown>): TestScenario {
    return {
      description: 'read an env var',
      request: { serverName: 'probe', toolName: 'report_env', arguments: args },
      expectedDecision: 'allow',
      reasoning: 'r',
      source: 'generated',
    };
  }

  it('validates against the live schema when the server was reached', () => {
    // The live server renamed `name` to `variable`: a scenario using the old
    // name passes the stored schema but is a call the server rejects.
    const live = new Map([
      [
        liveSchemaKey('probe', 'report_env'),
        { type: 'object', properties: { variable: { type: 'string' } }, required: ['variable'] },
      ],
    ]);
    const stale = scenario({ name: 'HOME' });
    expect(filterInvalidSchemaScenarios([stale], annotations).valid).toEqual([stale]);
    const result = filterInvalidSchemaScenarios([stale, scenario({ variable: 'HOME' })], annotations, live);
    expect(result.valid.map((s) => s.request.arguments)).toEqual([{ variable: 'HOME' }]);
    expect(result.discarded.map((d) => d.scenario)).toEqual([stale]);
  });

  it('falls back to the stored schema for tools the live index does not cover', () => {
    const other = new Map([[liveSchemaKey('probe', 'report_cwd'), { type: 'object', properties: {} }]]);
    const result = filterInvalidSchemaScenarios([scenario({ unknown: 1 })], annotations, other);
    expect(result.discarded).toHaveLength(1);
  });
});
