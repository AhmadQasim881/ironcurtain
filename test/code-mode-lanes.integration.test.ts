/**
 * Circuit-breaker lanes through the real Code Mode path:
 *
 *   [Sandbox.executeCode(code, { lane })]
 *          ↓ chain runner (code-mode-chain.ts), fresh V8 isolate
 *   [V8 isolate, agent code]
 *          ↓ tool stub (bridge into the host)
 *   [runner's host-side tool call, in a withToolCallOptions({ signal, lane }) scope]
 *          ↓ UTCP client.callTool
 *   [IronCurtainCommunicationProtocol.callTool]
 *          ↓ handleToolCall(server, tool, args, { signal, lane })
 *   [ToolCallCoordinator → policy → CallCircuitBreaker → mocked MCP client]
 *
 * Every agent process in a shared workflow container (one per fan-out lane)
 * runs its code under its own lane, so identical calls from several lanes
 * must not share one breaker window, while one lane keeps the single-lane
 * threshold. The lane has to survive the isolate boundary: async context set
 * around the whole chain does not reach the calls (they re-enter the host
 * through native callbacks), so the runner enters the scope per call, on the
 * host side, together with the call's cancellation signal.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  IRONCURTAIN_CALL_TEMPLATE_TYPE,
  bindCoordinatorToManual,
  registerIronCurtainProtocol,
  unbindCoordinatorFromManual,
} from '../src/sandbox/ironcurtain-protocol.js';
import { Sandbox } from '../src/sandbox/index.js';
import { CODE_MODE_PROXY_MAX_CONCURRENT_CHAINS } from '../src/sandbox/chain-limits.js';
import { ToolCallCoordinator } from '../src/trusted-process/tool-call-coordinator.js';
import type { ClientState, ProxiedTool } from '../src/trusted-process/tool-call-pipeline.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
  REAL_TMP,
} from './fixtures/test-policy.js';
import { isIsolatedVmAvailable } from './helpers/isolated-vm-available.js';

const TEST_ROOT = `${REAL_TMP}/ironcurtain-code-mode-lanes-${process.pid}`;
const MANUAL = 'lanes_test';

/** Chain code: `count` identical calls; returns how many succeeded and the first error. */
function callsSnippet(count: number): string {
  return `
    let ok = 0;
    try {
      for (let i = 0; i < ${count}; i++) {
        ${MANUAL}.filesystem_list_allowed_directories({});
        ok++;
      }
      return { ok, error: null };
    } catch (err) {
      return { ok, error: err && err.message ? err.message : String(err) };
    }
  `;
}

interface CallsResult {
  ok: number;
  error: string | null;
}

describe.skipIf(!isIsolatedVmAvailable())('Code Mode circuit-breaker lanes', () => {
  let client: CodeModeUtcpClient;
  let coordinator: ToolCallCoordinator;
  /** One sandbox per test, shared by every lane as the Code Mode proxy shares its own. */
  let sandbox: Sandbox;
  let dispatched = 0;
  let auditCounter = 0;

  beforeAll(async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(TEST_SANDBOX_DIR, { recursive: true });
    registerIronCurtainProtocol();
    client = await CodeModeUtcpClient.create();
  });

  afterAll(async () => {
    await client.close();
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dispatched = 0;
    const mcpClient = {
      callTool: async () => {
        dispatched++;
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
      sendRootsListChanged: async () => undefined,
    } as unknown as Client;
    coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: resolve(TEST_ROOT, `audit-${++auditCounter}.jsonl`),
      maxLanes: 2,
    });
    const tools: ProxiedTool[] = testToolAnnotations.servers.filesystem.tools.map((a) => ({
      serverName: a.serverName,
      name: a.toolName,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }));
    const state: ClientState = { client: mcpClient, roots: [] };
    coordinator.registerTools('filesystem', tools, state);
    bindCoordinatorToManual(MANUAL, coordinator);
    const registration = await client.registerManual({
      name: MANUAL,
      call_template_type: IRONCURTAIN_CALL_TEMPLATE_TYPE,
    });
    expect(registration.success).toBe(true);
    // Wired to this test's client: initialize() would spawn MCP relays, and
    // shutdown() would close the shared client, so neither is called.
    sandbox = new Sandbox({ maxConcurrentChains: CODE_MODE_PROXY_MAX_CONCURRENT_CHAINS });
    Object.assign(sandbox, { client });
  });

  afterEach(async () => {
    await client.deregisterManual(MANUAL);
    unbindCoordinatorFromManual(MANUAL);
    await coordinator.close();
  });

  async function runChain(lane: string | undefined, count: number): Promise<CallsResult> {
    const { result, logs } = await sandbox.executeCode(callsSnippet(count), lane === undefined ? {} : { lane });
    expect(logs.filter((line) => line.startsWith('[ERROR]'))).toEqual([]);
    return result as CallsResult;
  }

  it('gives concurrent chains on different lanes their own windows and keeps the single-lane threshold', async () => {
    const calls = vi.spyOn(coordinator, 'handleToolCall');
    // Two lanes, 20 identical calls each, at the same time on one sandbox:
    // 40 calls, twice the single-lane threshold, none denied.
    const [a, b] = await Promise.all([runChain('connection-1', 20), runChain('connection-2', 20)]);
    expect(a).toEqual({ ok: 20, error: null });
    expect(b).toEqual({ ok: 20, error: null });
    expect(dispatched).toBe(40);

    // Every call reached the coordinator with its own chain's lane, although
    // the two chains' calls interleaved.
    const seen = calls.mock.calls.map((callArgs) => callArgs[3]?.lane);
    expect(seen.filter((lane) => lane === 'connection-1')).toHaveLength(20);
    expect(seen.filter((lane) => lane === 'connection-2')).toHaveLength(20);

    // One lane is still held to the single-lane threshold.
    const again = await runChain('connection-1', 1);
    expect(again.ok).toBe(0);
    expect(again.error).toContain('CIRCUIT BREAKER');
    expect(dispatched).toBe(40);
  });

  it('runs chains without a lane in the shared default lane', async () => {
    const first = await runChain(undefined, 20);
    expect(first).toEqual({ ok: 20, error: null });
    const second = await runChain(undefined, 1);
    expect(second.error).toContain('CIRCUIT BREAKER');
  });

  it("hands every tool call the chain's lane together with the call's cancellation signal", async () => {
    const calls = vi.spyOn(coordinator, 'handleToolCall');
    const result = await runChain('connection-7', 2);
    expect(result).toEqual({ ok: 2, error: null });
    const options = calls.mock.calls.map((callArgs) => callArgs[3]);
    expect(options.map((o) => o?.lane)).toEqual(['connection-7', 'connection-7']);
    // The runner's per-call signal (WP-55) still arrives beside the lane, and
    // it is aborted once the script that made the calls has ended.
    for (const o of options) {
      expect(o?.signal).toBeInstanceOf(AbortSignal);
      expect(o?.signal?.aborted).toBe(true);
    }
  });
});
