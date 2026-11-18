/**
 * The OS-sandbox policy (`sandboxPolicy`) applies to dynamic-list resolution
 * as it does to a session: under "enforce", a server that asks for an OS
 * sandbox this host cannot provide is never started for list resolution and
 * the user is told, while the server another list names still connects
 * through its own relay.
 *
 * Host availability is mocked as unavailable in this process only, so the
 * test behaves the same with or without bubblewrap/socat/ripgrep. The server
 * that opts out of the sandbox starts through a real relay, which checks
 * availability for itself but has nothing to sandbox.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OsSandboxAvailability } from '../src/trusted-process/sandbox-integration.js';
import {
  connectViaProxy,
  LIST_RESOLUTION_AUDIT_FILENAME,
  type MediatedMcpConnection,
} from '../src/pipeline/proxy-mcp-connections.js';
import type { ListDefinition } from '../src/pipeline/types.js';
import type { MCPServerConfig } from '../src/config/types.js';

const { unavailable } = vi.hoisted(() => {
  const value: OsSandboxAvailability = {
    available: false,
    platformSupported: true,
    problems: ['bubblewrap (bwrap) not installed', 'socat not installed'],
    warnings: [],
  };
  return { unavailable: value };
});

vi.mock('../src/trusted-process/sandbox-integration.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/trusted-process/sandbox-integration.js')>()),
  getOsSandboxAvailability: (): OsSandboxAvailability => unavailable,
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = resolve(__dirname, 'fixtures', 'list-source-mcp-server.mjs');
const bundledGeneratedDir = resolve(__dirname, '..', 'src', 'config', 'generated');

const POLICY_ENV = ['IRONCURTAIN_SANDBOX_POLICY', 'SANDBOX_POLICY'] as const;

function dataBackedList(name: string, server: string): ListDefinition {
  return {
    name,
    type: 'emails',
    principle: `Allow emailing the people recorded in ${server}`,
    generationPrompt: `List the email addresses recorded in ${server}.`,
    requiresMcp: true,
    mcpServerHint: server,
  };
}

/**
 * The two fake backends, each recording to its own call log. The log path
 * travels in the server's own `env` block: a relay hands its backend no
 * other variable of the host's or its own (SERVER_FILTER included), so the
 * log a startup line lands in is what identifies the server.
 */
function fakeServers(workDir: string): Record<string, MCPServerConfig> {
  return {
    // Asks for an OS sandbox (no `sandbox: false`), like the shipped git server.
    git: { command: process.execPath, args: [backendPath], env: { LIST_SOURCE_CALL_LOG: callLogFor(workDir, 'git') } },
    // Opts out, like the shipped github server.
    github: {
      command: process.execPath,
      args: [backendPath],
      env: { LIST_SOURCE_CALL_LOG: callLogFor(workDir, 'github') },
      sandbox: false,
    },
  };
}

function callLogFor(workDir: string, server: string): string {
  return join(workDir, `${server}-calls.jsonl`);
}

/** Startup lines a backend wrote to its call log (none when it never ran). */
function startups(callLogPath: string): unknown[] {
  if (!existsSync(callLogPath)) return [];
  return readFileSync(callLogPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { event: string })
    .filter((record) => record.event === 'startup');
}

describe('dynamic-list resolution under sandboxPolicy "enforce" without an OS sandbox', { timeout: 60_000 }, () => {
  let workDir: string;
  let connection: MediatedMcpConnection | undefined;
  let stderrText = '';
  const saved = Object.fromEntries(POLICY_ENV.map((name) => [name, process.env[name]] as const));

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ironcurtain-list-sandbox-policy-'));
    delete process.env.SANDBOX_POLICY;
    process.env.IRONCURTAIN_SANDBOX_POLICY = 'enforce';

    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      connection = await connectViaProxy(
        [dataBackedList('git-authors', 'git'), dataBackedList('reporters', 'github')],
        {
          mcpServers: fakeServers(workDir),
          toolAnnotationsDir: bundledGeneratedDir,
          protectedPaths: [],
          auditLogPath: join(workDir, LIST_RESOLUTION_AUDIT_FILENAME),
        },
      );
    } finally {
      stderrText = stderr.mock.calls.map((call) => String(call[0])).join('');
      stderr.mockRestore();
    }
  });

  afterAll(async () => {
    await connection?.shutdown();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('never starts the server that needs the unavailable sandbox', () => {
    expect(startups(callLogFor(workDir, 'git'))).toHaveLength(0);
    expect(startups(callLogFor(workDir, 'github'))).toHaveLength(1);
    expect(new Set((connection?.tools ?? []).map((tool) => tool.serverName))).toEqual(new Set(['github']));
  });

  it('tells the user which server was not started and why', () => {
    expect(stderrText).toContain('not starting MCP server(s) that require it: git');
    expect(stderrText).toContain('sandboxPolicy "enforce"');
  });
});
