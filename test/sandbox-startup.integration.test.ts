/**
 * Sandbox start-up: relays start concurrently and are registered in
 * configuration order, a relay that fails is skipped and stopped, and a
 * start that fails leaves no relay, backend or coordinator behind.
 *
 * The concurrency test drives `Sandbox.initialize()` with the relay
 * connections faked. The cleanup tests spawn real relays (and their
 * filesystem backends) and check, through /proc, that every one of those
 * processes is gone afterwards; they need Linux.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { RELAY_CONNECT_CONCURRENCY, Sandbox } from '../src/sandbox/index.js';
import { MCPClientManager, type ClientState } from '../src/trusted-process/mcp-client-manager.js';
import type { IronCurtainConfig, MCPServerConfig } from '../src/config/types.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from './fixtures/test-policy.js';
import { packagedFilesystemServer } from './helpers/filesystem-server.js';

const ROOT = `${REAL_TMP}/ironcurtain-sandbox-startup-${process.pid}`;
const GENERATED_DIR = `${ROOT}/generated`;
const AUDIT_LOG_PATH = `${ROOT}/audit.jsonl`;

function makeConfig(mcpServers: Record<string, MCPServerConfig>): IronCurtainConfig {
  return {
    auditLogPath: AUDIT_LOG_PATH,
    allowedDirectory: `${ROOT}/sandbox`,
    mcpServers,
    protectedPaths: [],
    generatedDir: GENERATED_DIR,
    constitutionPath: `${ROOT}/constitution.md`,
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: '',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
        warnThresholdPercent: 80,
      },
      autoCompact: { enabled: false, thresholdTokens: 80_000, keepRecentMessages: 10, summaryModelId: 'x:y' },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      serverCredentials: {},
    },
  } as unknown as IronCurtainConfig;
}

/** A filesystem backend serving its own directory, whose path marks its processes. */
function filesystemServer(name: string): MCPServerConfig {
  const dir = `${ROOT}/served-${name}`;
  mkdirSync(dir, { recursive: true });
  return { ...packagedFilesystemServer(dir), sandbox: false };
}

// --- Processes (Linux /proc) ---

interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly cmdline: string;
}

function listProcesses(): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').split('\0').join(' ').trim();
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf-8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      // A zombie has an empty command line: it has exited.
      if (cmdline.length > 0) processes.push({ pid: Number(entry), ppid, cmdline });
    } catch {
      // Exited while being read.
    }
  }
  return processes;
}

/** `pid` and every live process below it. */
function processTree(pid: number | null | undefined): number[] {
  if (pid === null || pid === undefined) return [];
  const all = listProcesses();
  const tree = new Set<number>([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of all) {
      if (!tree.has(proc.pid) && tree.has(proc.ppid)) {
        tree.add(proc.pid);
        grew = true;
      }
    }
  }
  return [...tree];
}

function alive(pids: readonly number[]): number[] {
  const live = new Set(listProcesses().map((proc) => proc.pid));
  return pids.filter((pid) => live.has(pid));
}

/** Processes anywhere on the host whose command line mentions `marker` (a backend's directory). */
function processesMentioning(marker: string): number[] {
  return listProcesses()
    .filter((proc) => proc.cmdline.includes(marker))
    .map((proc) => proc.pid);
}

async function waitUntilGone(pids: readonly number[], timeoutMs = 15_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let left = alive(pids);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    left = alive(pids);
  }
  return left;
}

/** The pid of a connected server's relay (its stdio transport's child). */
function relayPid(manager: MCPClientManager, serverName: string): number | null {
  const servers = (manager as unknown as { servers: Map<string, { transport: { pid: number | null } }> }).servers;
  return servers.get(serverName)?.transport.pid ?? null;
}

beforeEach(() => {
  mkdirSync(`${ROOT}/sandbox`, { recursive: true });
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(resolve(GENERATED_DIR, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
  writeFileSync(resolve(GENERATED_DIR, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});

describe('Sandbox relay start-up (faked connections)', () => {
  it('starts relays concurrently, bounded, and registers them in configuration order', async () => {
    const names = ['s1', 's2', 's3', 's4', 's5', 's6'];
    // s3's tool listing fails; completion order differs from configuration order.
    const delayMs: Record<string, number> = { s1: 80, s2: 10, s3: 30, s4: 5, s5: 40, s6: 1 };
    const states = new Map<string, ClientState>();
    let inFlight = 0;
    let maxInFlight = 0;
    const finished: string[] = [];
    vi.spyOn(MCPClientManager.prototype, 'connect').mockImplementation(async (name: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs[name]));
      inFlight--;
      finished.push(name);
      states.set(name, { client: {} as ClientState['client'], roots: [] });
    });
    vi.spyOn(MCPClientManager.prototype, 'getClientState').mockImplementation((name: string) => states.get(name));
    vi.spyOn(MCPClientManager.prototype, 'listTools').mockImplementation(async (name: string) => {
      if (name === 's3') throw new Error('tool listing failed\nsecond line');
      return [
        { name: `${name}_tool`, description: `tool of ${name}`, inputSchema: { type: 'object', properties: {} } },
      ];
    });
    const close = vi.spyOn(MCPClientManager.prototype, 'close').mockResolvedValue(undefined);

    const sandbox = new Sandbox();
    const servers = Object.fromEntries(
      names.map((name): [string, MCPServerConfig] => [name, { command: 'node', args: ['unused.js'], sandbox: false }]),
    );
    try {
      await sandbox.initialize(makeConfig(servers));

      expect(maxInFlight).toBe(RELAY_CONNECT_CONCURRENCY);
      expect(finished).not.toEqual(names);
      // Registration (and so the catalog and the system prompt built from
      // it) follows the configuration, whichever relay answered first.
      expect(Object.keys(sandbox.getHelpData().toolsByServer)).toEqual(['s1', 's2', 's4', 's5', 's6']);
      expect(sandbox.getUnavailableServers()).toEqual([{ serverName: 's3', reason: 'tool listing failed' }]);
      expect(close).toHaveBeenCalledWith('s3');
    } finally {
      await sandbox.shutdown();
    }
  });
});

describe.skipIf(process.platform !== 'linux')('Sandbox start-up cleanup (real relays)', () => {
  it('stops a relay whose tool listing fails, with its backend, and keeps the others', async () => {
    const brokenTree: number[] = [];
    const healthy: { relay: number | null } = { relay: null };
    const listTools = MCPClientManager.prototype.listTools;
    vi.spyOn(MCPClientManager.prototype, 'listTools').mockImplementation(async function (
      this: MCPClientManager,
      serverName: string,
      options?: { readonly timeoutMs?: number },
    ) {
      if (serverName === 'broken') {
        brokenTree.push(...processTree(relayPid(this, serverName)));
        throw new Error('relay died after its handshake');
      }
      healthy.relay = relayPid(this, serverName);
      return listTools.call(this, serverName, options);
    });

    const sandbox = new Sandbox();
    try {
      await sandbox.initialize(makeConfig({ filesystem: filesystemServer('fs'), broken: filesystemServer('broken') }));

      expect(sandbox.getUnavailableServers()).toEqual([
        { serverName: 'broken', reason: 'relay died after its handshake' },
      ]);
      expect(Object.keys(sandbox.getHelpData().toolsByServer)).toEqual(['filesystem']);
      // The relay, its node process and the filesystem backend it started.
      expect(brokenTree.length).toBeGreaterThanOrEqual(2);
      expect(await waitUntilGone(brokenTree)).toEqual([]);
      expect(processesMentioning(`${ROOT}/served-broken`)).toEqual([]);
      // The healthy relay keeps serving.
      expect(alive([healthy.relay ?? -1])).toHaveLength(1);
      expect(processesMentioning(`${ROOT}/served-fs`).length).toBeGreaterThan(0);
    } finally {
      await sandbox.shutdown();
    }
    expect(await waitUntilGone(processesMentioning(ROOT))).toEqual([]);
  }, 60_000);

  it('leaves no relay, backend or coordinator behind when the start fails after the relays are up', async () => {
    const started: number[] = [];
    const connect = MCPClientManager.prototype.connect;
    vi.spyOn(MCPClientManager.prototype, 'connect').mockImplementation(async function (
      this: MCPClientManager,
      ...args: Parameters<MCPClientManager['connect']>
    ) {
      await connect.apply(this, args);
      started.push(...processTree(relayPid(this, args[0])));
    });
    // A deterministic late failure: UTCP rejecting the manual (for example
    // a backend tool schema it does not accept).
    vi.spyOn(CodeModeUtcpClient.prototype, 'registerManual').mockResolvedValue({
      success: false,
      errors: ['manual rejected'],
    } as unknown as Awaited<ReturnType<CodeModeUtcpClient['registerManual']>>);

    const sandbox = new Sandbox();
    const initialize = sandbox.initialize(makeConfig({ one: filesystemServer('one'), two: filesystemServer('two') }));
    await expect(initialize).rejects.toThrow('Failed to register IronCurtain manual: manual rejected');

    expect(started.length).toBeGreaterThanOrEqual(4); // two relays, each with its backend
    expect(sandbox.getCoordinator()).toBeNull();
    expect(await waitUntilGone(started)).toEqual([]);
    expect(processesMentioning(ROOT)).toEqual([]);
  }, 60_000);

  it('closes the coordinator, and with it the relays, even when closing the UTCP client fails', async () => {
    const started: number[] = [];
    const connect = MCPClientManager.prototype.connect;
    vi.spyOn(MCPClientManager.prototype, 'connect').mockImplementation(async function (
      this: MCPClientManager,
      ...args: Parameters<MCPClientManager['connect']>
    ) {
      await connect.apply(this, args);
      started.push(...processTree(relayPid(this, args[0])));
    });

    const sandbox = new Sandbox();
    await sandbox.initialize(makeConfig({ filesystem: filesystemServer('fs') }));
    expect(started.length).toBeGreaterThanOrEqual(2);
    vi.spyOn(CodeModeUtcpClient.prototype, 'close').mockRejectedValue(new Error('client close failed'));

    await expect(sandbox.shutdown()).rejects.toThrow('client close failed');
    expect(sandbox.getCoordinator()).toBeNull();
    expect(await waitUntilGone(started)).toEqual([]);
  }, 60_000);
});
