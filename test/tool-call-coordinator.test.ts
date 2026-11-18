/**
 * Unit tests for ToolCallCoordinator.
 *
 * The coordinator owns policy + audit + circuit breaker + whitelist
 * + server-context + auto-approver. These tests exercise the
 * pipeline around a mocked MCP client so we can verify:
 *   - allow path (policy → dispatch → audit success)
 *   - deny path (policy deny → audit deny, no dispatch)
 *   - invalid-arguments path
 *   - escalation path via in-process callback
 *   - post-success ServerContext update
 *   - post-call bookkeeping skipped on error results
 *   - tool-call mutex serializes concurrent invocations
 *   - audit fails closed: write-ahead `dispatching` record before every
 *     dispatch, no dispatch once the audit log cannot be written
 *
 * The coordinator threads through the existing `handleCallTool`
 * implementation (which has its own exhaustive unit tests in
 * `test/mcp-proxy-server.test.ts`), so these tests focus on the
 * coordinator-specific wiring rather than duplicating per-path
 * coverage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ToolCallCoordinator,
  type EscalationPromptDetails,
  type EscalationPromptFn,
} from '../src/trusted-process/tool-call-coordinator.js';
import { RULE_CALL_CANCELLED, type ClientState, type ProxiedTool } from '../src/trusted-process/tool-call-pipeline.js';
import { escalationTimeoutMsFromConfig } from '../src/trusted-process/call-timeouts.js';
import { EscalationWithdrawnError } from '../src/trusted-process/escalation-wait.js';
import { isAuditLogUnavailableError } from '../src/trusted-process/audit-log.js';
import { isDispatchingAuditEntry } from '../src/types/audit.js';
import {
  proxyAnnotations,
  proxyPolicyRules,
  proxyToolDefinitions,
  type ControlApiClient,
} from '../src/docker/proxy-tools.js';
import {
  WORKFLOW_COMMIT_SERVER,
  WORKFLOW_COMMIT_TOOL,
  type WorkflowCommitHandler,
  type WorkflowCommitRequest,
} from '../src/trusted-process/workflow-commit-tool.js';
import { TASK_SCOPE_ESCALATE_RULE } from '../src/trusted-process/policy-engine.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
} from './fixtures/test-policy.js';
import { scopeRule, taskScopePolicy } from './fixtures/task-scope.js';
import type { ToolCallRequest } from '../src/types/mcp.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const TEST_ROOT = `/tmp/coordinator-test-${process.pid}`;

function makeAuditPath(suffix: string): string {
  return resolve(TEST_ROOT, `audit-${suffix}.jsonl`);
}

function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: uuidv4(),
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: `${TEST_SANDBOX_DIR}/hello.txt` },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Builds a mock client that returns a successful read_file result. */
function mockSuccessClient(): Client {
  return {
    callTool: async () => ({
      content: [{ type: 'text', text: 'file content' }],
      isError: false,
    }),
    sendRootsListChanged: async () => undefined,
  } as unknown as Client;
}

/** Builds a mock client that returns an MCP error result. */
function mockErrorClient(): Client {
  return {
    callTool: async () => ({
      content: [{ type: 'text', text: 'Permission denied' }],
      isError: true,
    }),
    sendRootsListChanged: async () => undefined,
  } as unknown as Client;
}

/**
 * Builds a mock backend for approved escalations. It acknowledges each
 * roots refresh at once and answers `list_allowed_directories` from the
 * client's current roots, as server-filesystem does, so the pipeline's
 * post-refresh roots verification passes. Every other tool returns `text`
 * and is reported to `onToolCall` (the roots verification is not).
 */
function rootsAwareClient(state: ClientState, text: string, onToolCall?: (name: string) => void): Client {
  return {
    callTool: async (params: { name: string }) => {
      if (params.name === 'list_allowed_directories') {
        const directories = state.roots.map((root) => fileURLToPath(root.uri));
        return { content: [{ type: 'text', text: `Allowed directories:\n${directories.join('\n')}` }], isError: false };
      }
      onToolCall?.(params.name);
      return { content: [{ type: 'text', text }], isError: false };
    },
    sendRootsListChanged: async () => {
      state.rootsRefreshed?.();
      state.rootsRefreshed = undefined;
    },
  } as unknown as Client;
}

/**
 * Reads and parses every audit record (newline-delimited JSON), the
 * write-ahead `dispatching` record of each dispatched call included.
 */
function readAudit(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Outcome records only: one per tool call. */
function readOutcomes(path: string): Record<string, unknown>[] {
  return readAudit(path).filter((entry) => !isDispatchingAuditEntry(entry));
}

/** Resolves with the rejection reason of `promise`; fails if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the tool call to be refused');
}

/**
 * Replaces the audit file with a directory, so the next append fails
 * (EISDIR) -- the "audit path removed mid-session" condition.
 */
function breakAuditPath(auditPath: string): void {
  rmSync(auditPath, { force: true });
  mkdirSync(auditPath);
}

/** Registers the standard filesystem toolset from `testToolAnnotations`. */
function registerFilesystemTools(coordinator: ToolCallCoordinator, client: Client): void {
  const fsServer = testToolAnnotations.servers.filesystem;
  const fsTools: ProxiedTool[] = fsServer.tools.map((a) => ({
    serverName: a.serverName,
    name: a.toolName,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  }));
  const state: ClientState = { client, roots: [] };
  coordinator.registerTools('filesystem', fsTools, state);
}

/** Builds a coordinator with the deterministic test policy + a mock client. */
function makeCoordinator(auditSuffix: string): {
  coordinator: ToolCallCoordinator;
  auditPath: string;
  client: Client;
} {
  const auditPath = makeAuditPath(auditSuffix);
  const client = mockSuccessClient();
  const coordinator = new ToolCallCoordinator({
    compiledPolicy: testCompiledPolicy,
    toolAnnotations: testToolAnnotations,
    protectedPaths: TEST_PROTECTED_PATHS,
    allowedDirectory: TEST_SANDBOX_DIR,
    auditLogPath: auditPath,
  });
  registerFilesystemTools(coordinator, client);
  return { coordinator, auditPath, client };
}

// ---------------------------------------------------------------------------
// Setup/teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_SANDBOX_DIR, { recursive: true });
  // Treat TEST_ROOT as this run's IronCurtain home so persona policy dirs
  // written inside it pass the coordinator's `validatePolicyDir` containment
  // check (needed by the loadPolicy drain test below).
  process.env.IRONCURTAIN_HOME = TEST_ROOT;
});

afterEach(() => {
  delete process.env.IRONCURTAIN_HOME;
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/**
 * Writes a persona-style policy directory containing only
 * `compiled-policy.json` (annotations are globally scoped and retained at
 * coordinator construction). Mirrors `coordinator-control-server.test.ts`.
 */
function writePersonaPolicy(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'compiled-policy.json'), JSON.stringify({ ...testCompiledPolicy, rules: [] }));
}

/**
 * Builds a held-open `onEscalation` handler: returns a promise that
 * resolves `entered` when the escalation wait begins, and only settles the
 * decision once `release` is called. The escalation wait runs OUTSIDE the
 * coordinator's call mutex, so a call parked here is the precise condition
 * that `withToolCallsQuiesced` (loadPolicy/close) must cancel rather than
 * wait out. `signal` / `details` capture what the coordinator handed the
 * handler so tests can assert the abort reason it saw.
 */
function makeHeldEscalation(): {
  onEscalation: EscalationPromptFn;
  entered: Promise<void>;
  release: (decision: 'approved' | 'denied') => void;
  signal?: AbortSignal;
  details?: EscalationPromptDetails;
} {
  const entered = deferred<undefined>();
  const decision = deferred<{ decision: 'approved' | 'denied' }>();
  const held: ReturnType<typeof makeHeldEscalation> = {
    onEscalation: (_request, _reason, _context, _candidates, details) => {
      held.signal = details.signal;
      held.details = details;
      entered.resolve(undefined);
      return decision.promise;
    },
    entered: entered.promise.then(() => undefined),
    release: (d) => decision.resolve({ decision: d }),
  };
  return held;
}

/** Polls `dir` until a file whose name starts with `prefix` appears (or 5 s pass). */
async function waitForFile(dir: string, prefix: string): Promise<string | undefined> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith('.json'));
    if (match) return match;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

/**
 * A `LanguageModelV3` whose auto-approval generate call is gated: every
 * invocation blocks until `release()` fires, then returns an `approve`
 * decision. `concurrentReached(n)` resolves once `n` invocations are
 * simultaneously parked inside `doGenerate` -- the signal that the
 * auto-approval branch is NOT serializing on the coordinator's call mutex.
 */
function makeGatedAutoApproveModel(): {
  model: LanguageModelV3;
  concurrentReached: (n: number) => Promise<void>;
  release: () => void;
} {
  const gate = deferred<undefined>();
  let inFlight = 0;
  const thresholdWaiters: Array<{ n: number; resolve: () => void }> = [];
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      inFlight++;
      for (const w of thresholdWaiters) {
        if (inFlight >= w.n) w.resolve();
      }
      try {
        await gate.promise;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ decision: 'approve', reasoning: 'authorized by user message' }),
            },
          ],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: undefined, reasoning: undefined },
          },
          warnings: [],
          request: {},
          response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
        };
      } finally {
        inFlight--;
      }
    },
  }) as unknown as LanguageModelV3;
  return {
    model,
    concurrentReached: (n) => {
      if (inFlight >= n) return Promise.resolve();
      return new Promise<void>((resolve) => thresholdWaiters.push({ n, resolve }));
    },
    release: () => gate.resolve(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolCallCoordinator', () => {
  describe('allow path', () => {
    it('dispatches allowed calls and writes a success audit entry', async () => {
      const { coordinator, auditPath } = makeCoordinator('allow');
      try {
        const req = makeRequest({ toolName: 'list_allowed_directories', arguments: {} });
        const result = await coordinator.handleStructuredToolCall(req);

        expect(result.status).toBe('success');
        expect(result.policyDecision.status).toBe('allow');
        // Side-effect-free introspection is resolved by the engine's
        // structural-invariant layer before compiled rules run.
        expect(result.policyDecision.rule).toBe('structural-introspection-allow');
      } finally {
        await coordinator.close();
      }

      // A dispatched call leaves two records: the write-ahead `dispatching`
      // record appended before the backend saw the call, then its outcome.
      const entries = readAudit(auditPath);
      expect(entries.length).toBe(2);
      expect(entries[0]).toMatchObject({
        result: { status: 'dispatching' },
        policyDecision: { status: 'allow', rule: 'structural-introspection-allow' },
        durationMs: 0,
      });
      expect(entries[1]).toMatchObject({ result: { status: 'success' } });
      expect(entries[0].requestId).toBe(entries[1].requestId);
      expect(readOutcomes(auditPath)).toHaveLength(1);
    });
  });

  describe('deny path', () => {
    it('denies protected-path access without dispatching', async () => {
      // Build a tracked client so we can assert the dispatch never happens.
      let callCount = 0;
      const auditPath = makeAuditPath('deny-protected');
      const client: Client = {
        callTool: async () => {
          callCount++;
          return { content: [{ type: 'text', text: 'ok' }], isError: false };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);
      try {
        const req = makeRequest({
          toolName: 'read_file',
          arguments: { path: TEST_PROTECTED_PATHS[0] },
        });
        const result = await coordinator.handleStructuredToolCall(req);

        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
        expect(result.policyDecision.rule).toBe('structural-protected-path');
        expect(callCount).toBe(0);
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
      expect((entries[0] as { result: { status: string } }).result.status).toBe('denied');
    });
  });

  describe('invalid-arguments path', () => {
    it('denies requests with unknown argument keys', async () => {
      const { coordinator, auditPath } = makeCoordinator('invalid-args');
      try {
        const req = makeRequest({
          toolName: 'read_file',
          // `not_path` is not in the tool's inputSchema properties
          arguments: { not_path: '/tmp/foo' },
        });
        const result = await coordinator.handleStructuredToolCall(req);

        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
        expect(result.policyDecision.rule).toBe('invalid-arguments');
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
      const entry = entries[0] as { policyDecision: { rule: string } };
      expect(entry.policyDecision.rule).toBe('invalid-arguments');
    });
  });

  describe('escalation path (in-process callback)', () => {
    it('invokes the callback when policy escalates and honors "denied"', async () => {
      const auditPath = makeAuditPath('escalate-denied');
      let calledBack = false;
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => {
          calledBack = true;
          return { decision: 'denied' };
        },
      });
      registerFilesystemTools(coordinator, client);

      try {
        const req = makeRequest({
          toolName: 'write_file',
          // Writing outside the sandbox → `escalate-write-outside-permitted-areas`
          arguments: { path: '/tmp/outside-sandbox/f.txt' },
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(calledBack).toBe(true);
        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
        expect(result.policyDecision.reason).toContain('Denied by human');
      } finally {
        await coordinator.close();
      }
    });

    it('does not hold the call mutex while waiting for human escalation', async () => {
      const auditPath = makeAuditPath('escalate-releases-mutex');
      const enteredEscalation = deferred<undefined>();
      const escalationDecision = deferred<{ decision: 'approved' | 'denied' }>();
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => {
          enteredEscalation.resolve(undefined);
          return escalationDecision.promise;
        },
      });
      registerFilesystemTools(coordinator, client);

      try {
        const escalating = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'escalating-call',
            toolName: 'write_file',
            arguments: { path: '/tmp/outside-sandbox/f.txt' },
          }),
        );
        await enteredEscalation.promise;

        const allowed = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'allowed-while-escalating',
            toolName: 'list_allowed_directories',
            arguments: {},
          }),
        );
        const race = await Promise.race([
          allowed.then((result) => result.status),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
        ]);
        expect(race).toBe('success');

        escalationDecision.resolve({ decision: 'denied' });
        const escalatingResult = await escalating;
        expect(escalatingResult.status).toBe('denied');
      } finally {
        await coordinator.close();
      }

      const entries = readOutcomes(auditPath);
      expect(entries.map((entry) => entry.requestId)).toEqual(['allowed-while-escalating', 'escalating-call']);
    });

    it('invokes the callback and honors "approved"', async () => {
      const auditPath = makeAuditPath('escalate-approved');
      // Build a client whose `sendRootsListChanged` immediately fires
      // the `rootsRefreshed` callback so the post-escalation root
      // expansion doesn't block on the timeout, and which reports its
      // roots back for the post-refresh verification.
      const state: ClientState = {
        client: null as unknown as Client,
        roots: [],
      };
      state.client = rootsAwareClient(state, 'file content');

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => ({ decision: 'approved' }),
      });
      // Directly register with the prepared ClientState so rootsRefreshed wiring is used.
      const fsServer = testToolAnnotations.servers.filesystem;
      const fsTools: ProxiedTool[] = fsServer.tools.map((a) => ({
        serverName: a.serverName,
        name: a.toolName,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      }));
      coordinator.registerTools('filesystem', fsTools, state);

      try {
        const req = makeRequest({
          toolName: 'read_file',
          arguments: { path: '/etc/hostname' },
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(result.status).toBe('success');
        expect(result.policyDecision.status).toBe('allow');
        expect(result.policyDecision.reason).toContain('Approved by human');
      } finally {
        await coordinator.close();
      }
    });
  });

  describe('post-call bookkeeping', () => {
    it('writes a success audit entry for allowed calls (exercises post-call path)', async () => {
      // The post-call band of handleToolCall runs `updateServerContext`
      // for git tools and then logAudit(status:success). We verify the
      // audit-success half directly; the git-context half is covered
      // by existing `mcp-proxy-server.test.ts` tests which exercise the
      // same underlying `handleCallTool` code path.
      const { coordinator, auditPath } = makeCoordinator('post-call-success');

      try {
        const result = await coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
        );
        expect(result.status).toBe('success');
      } finally {
        await coordinator.close();
      }

      const entries = readOutcomes(auditPath);
      expect(entries.length).toBe(1);
      expect((entries[0] as { result: { status: string } }).result.status).toBe('success');
    });

    it('does NOT run post-call bookkeeping on error results', async () => {
      const auditPath = makeAuditPath('error-no-context');
      const client = mockErrorClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);

      try {
        const req = makeRequest({
          toolName: 'list_allowed_directories',
          arguments: {},
        });
        const result = await coordinator.handleStructuredToolCall(req);
        // Despite the MCP error, the coordinator returns an error
        // status without updating context -- audit entry records
        // status=error, not success.
        expect(result.status).toBe('error');
      } finally {
        await coordinator.close();
      }

      const entries = readOutcomes(auditPath);
      const resultEntries = entries.filter((e) => (e as { result?: { status?: string } }).result !== undefined);
      expect(resultEntries.length).toBe(1);
      expect((resultEntries[0] as { result: { status: string } }).result.status).toBe('error');
    });
  });

  describe('tool-call mutex', () => {
    it('serializes concurrent handleToolCall invocations', async () => {
      const auditPath = makeAuditPath('mutex');
      let concurrentCount = 0;
      let maxConcurrent = 0;
      const client: Client = {
        callTool: async () => {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          // Yield to the event loop so any non-serialized caller could
          // race past us while we're "in flight".
          await new Promise((r) => setTimeout(r, 10));
          concurrentCount--;
          return {
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
          };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);

      try {
        const calls = Array.from({ length: 5 }, () =>
          coordinator.handleStructuredToolCall(makeRequest({ toolName: 'list_allowed_directories', arguments: {} })),
        );
        await Promise.all(calls);
      } finally {
        await coordinator.close();
      }

      // The mutex guarantees max concurrency of 1 inside the dispatch.
      expect(maxConcurrent).toBe(1);
    });

    it('preserves FIFO audit order and per-lane breaker counts under concurrent structured streams', async () => {
      const auditPath = makeAuditPath('concurrent-streams');
      let concurrentCount = 0;
      let maxConcurrent = 0;
      let dispatchCount = 0;
      const client: Client = {
        callTool: async () => {
          concurrentCount++;
          dispatchCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          await new Promise((r) => setTimeout(r, 1));
          concurrentCount--;
          return {
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
          };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        maxLanes: 2,
      });
      registerFilesystemTools(coordinator, client);

      const requests = Array.from({ length: 41 }, (_, i) =>
        makeRequest({
          requestId: `fifo-${String(i).padStart(2, '0')}`,
          toolName: 'list_allowed_directories',
          arguments: {},
        }),
      );

      // Two lanes alternate: lane-a makes calls 0, 2, ..., 40 (21 calls) and
      // lane-b calls 1, 3, ..., 39 (20). Each lane keeps the single-lane
      // threshold (20), so only lane-a's 21st call is denied.
      let results;
      try {
        results = await Promise.all(
          requests.map((req, i) =>
            coordinator.handleStructuredToolCall(req, { lane: i % 2 === 0 ? 'lane-a' : 'lane-b' }),
          ),
        );
      } finally {
        await coordinator.close();
      }

      expect(maxConcurrent).toBe(1);
      expect(dispatchCount).toBe(40);
      expect(results.slice(0, 40).every((result) => result.status === 'success')).toBe(true);
      expect(results[40].status).toBe('denied');
      expect(results[40].policyDecision.rule).toBe('circuit-breaker');

      const entries = readOutcomes(auditPath);
      expect(entries.length).toBe(41);
      expect(entries.map((entry) => entry.requestId)).toEqual(requests.map((req) => req.requestId));
      // The 40 dispatched calls each left a write-ahead record as well; the
      // breaker denial was never dispatched and left none.
      expect(readAudit(auditPath)).toHaveLength(81);
      expect(entries.slice(0, 40).every((entry) => (entry.result as { status: string }).status === 'success')).toBe(
        true,
      );
      expect((entries[40].result as { status: string }).status).toBe('denied');
      expect(JSON.stringify(entries[40])).toContain('20 times');
    });
  });

  describe('per-lane circuit breaking', () => {
    function makeLaneCoordinator(
      suffix: string,
      maxLanes?: number,
    ): { coordinator: ToolCallCoordinator; dispatched: () => number } {
      let dispatchCount = 0;
      const client = {
        callTool: async () => {
          dispatchCount++;
          return { content: [{ type: 'text', text: 'ok' }], isError: false };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: makeAuditPath(suffix),
        ...(maxLanes === undefined ? {} : { maxLanes }),
      });
      registerFilesystemTools(coordinator, client);
      return { coordinator, dispatched: () => dispatchCount };
    }

    const call = (coordinator: ToolCallCoordinator, lane: string | undefined) =>
      coordinator.handleToolCall(
        'filesystem',
        'list_allowed_directories',
        {},
        lane === undefined ? undefined : { lane },
      );

    it('identical calls from 4 lanes do not trip a shared 20-per-60 s window', async () => {
      const { coordinator, dispatched } = makeLaneCoordinator('lanes-four', 4);
      try {
        // 4 fan-out lanes each make the same call 20 times, interleaved: 80
        // identical calls in one window, 4x the single-lane threshold.
        const lanes = ['connection-1', 'connection-2', 'connection-3', 'connection-4'];
        const results = await Promise.all(
          Array.from({ length: 80 }, (_, i) => call(coordinator, lanes[i % lanes.length])),
        );
        expect(results.every((result) => result.isError !== true)).toBe(true);
        expect(dispatched()).toBe(80);

        // Every lane keeps the single-lane threshold: its 21st call is denied.
        const extra = await call(coordinator, 'connection-1');
        expect(extra.isError).toBe(true);
        expect(extra._policyDecision?.rule).toBe('circuit-breaker');
        expect(dispatched()).toBe(80);
      } finally {
        await coordinator.close();
      }
    });

    it('holds one runaway lane to the single-lane threshold however wide the bundle is', async () => {
      const { coordinator, dispatched } = makeLaneCoordinator('lanes-runaway', 8);
      try {
        const results = [];
        for (let i = 0; i < 21; i++) results.push(await call(coordinator, 'connection-1'));
        expect(results.slice(0, 20).every((result) => result.isError !== true)).toBe(true);
        expect(results[20].isError).toBe(true);
        expect(results[20]._policyDecision?.rule).toBe('circuit-breaker');
        expect(dispatched()).toBe(20);
      } finally {
        await coordinator.close();
      }
    });

    it('caps every lane together at the single-lane threshold without maxLanes (standalone sessions)', async () => {
      // A standalone session's agent may reconnect, getting a new lane key;
      // with the default maxLanes (1) the all-lanes window still caps the
      // total at 20, exactly as before lanes existed.
      const { coordinator, dispatched } = makeLaneCoordinator('lanes-standalone');
      try {
        for (let i = 0; i < 20; i++) {
          const result = await call(coordinator, `connection-${i}`);
          expect(result.isError).not.toBe(true);
        }
        const denied = await call(coordinator, 'connection-99');
        expect(denied.isError).toBe(true);
        expect(denied._policyDecision?.rule).toBe('circuit-breaker');
        const unlabeled = await call(coordinator, undefined);
        expect(unlabeled.isError).toBe(true);
        expect(dispatched()).toBe(20);
      } finally {
        await coordinator.close();
      }
    });
  });

  describe('close() flushes the audit log', () => {
    it('emits pending entries before resolving', async () => {
      const { coordinator, auditPath } = makeCoordinator('close-flush');
      await coordinator.handleStructuredToolCall(makeRequest({ toolName: 'list_allowed_directories', arguments: {} }));
      await coordinator.close();

      const entries = readOutcomes(auditPath);
      expect(entries.length).toBe(1);
    });
  });

  describe('loadPolicy (missing policyDir)', () => {
    it('rejects with a filesystem error when the policy dir does not exist', async () => {
      // Covered in depth by `coordinator-control-server.test.ts`; this
      // spot check exercises the same code path from the coordinator's
      // public surface to guard against regression.
      const { coordinator } = makeCoordinator('load-policy-missing');
      try {
        await expect(
          coordinator.loadPolicy({
            persona: 'global',
            policyDir: `/tmp/does-not-exist-${process.pid}-${Date.now()}`,
          }),
        ).rejects.toThrow();
      } finally {
        await coordinator.close();
      }
    });
  });

  describe('read-only workspace (WP-131)', () => {
    it('denies changes outside the writable directories under every policy loadPolicy installs', async () => {
      // A workflow bundle's coordinator outlives its personas. The read-only
      // workspace belongs to the bundle, so a persona whose policy allows
      // every filesystem write must not lift it.
      const auditPath = makeAuditPath('read-only-workspace');
      // A persona's compiled-policy directory: loadPolicy accepts only those.
      const permissiveDir = join(TEST_ROOT, 'personas', 'permissive', 'generated');
      mkdirSync(permissiveDir, { recursive: true });
      writeFileSync(
        join(permissiveDir, 'compiled-policy.json'),
        JSON.stringify({
          ...testCompiledPolicy,
          rules: [
            {
              name: 'allow-every-filesystem-call',
              description: 'test',
              principle: 'test',
              if: { server: ['filesystem'] },
              then: 'allow',
              reason: 'test',
            },
          ],
        }),
      );

      const dispatched: string[] = [];
      const client = {
        callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
          dispatched.push(String(params.arguments?.path));
          return { content: [{ type: 'text', text: 'ok' }], isError: false };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        readOnlyWorkspace: { writablePaths: ['.workflow/reviews'] },
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);
      const write = (path: string) =>
        coordinator.handleStructuredToolCall(makeRequest({ toolName: 'write_file', arguments: { path } }));
      const codePath = `${TEST_SANDBOX_DIR}/src/app.ts`;
      const reviewPath = `${TEST_SANDBOX_DIR}/.workflow/reviews/review.md`;

      try {
        const before = await write(codePath);
        expect(before.status).toBe('denied');
        expect(before.policyDecision.rule).toBe('structural-read-only-workspace');

        await coordinator.loadPolicy({ persona: 'permissive', policyDir: permissiveDir });
        const after = await write(codePath);
        expect(after.status).toBe('denied');
        expect(after.policyDecision.rule).toBe('structural-read-only-workspace');

        // The declared output directory stays writable.
        expect((await write(reviewPath)).status).toBe('success');
      } finally {
        await coordinator.close();
      }

      // Only the output write reached the backend; both denials are audited.
      expect(dispatched).toEqual([reviewPath]);
      const denials = readOutcomes(auditPath).filter(
        (entry) =>
          (entry as { policyDecision?: { rule?: string } }).policyDecision?.rule === 'structural-read-only-workspace',
      );
      expect(denials).toHaveLength(2);
    });

    it('keeps the task scope and the workflow_commit tool beside it across loadPolicy', async () => {
      // A read-only scope of a `--task-scoped` workflow run (WP-119) whose
      // states commit through `workflow_commit` (WP-133): one coordinator
      // carries all three, and a persona hot-swap drops none of them.
      const auditPath = makeAuditPath('read-only-task-scope-commit');
      const personaDir = join(TEST_ROOT, 'personas', 'permissive-scoped', 'generated');
      mkdirSync(personaDir, { recursive: true });
      writeFileSync(
        join(personaDir, 'compiled-policy.json'),
        JSON.stringify({
          ...testCompiledPolicy,
          rules: [
            {
              name: 'allow-every-filesystem-call',
              description: 'test',
              principle: 'test',
              if: { server: ['filesystem'] },
              then: 'allow',
              reason: 'test',
            },
          ],
        }),
      );
      const commits: WorkflowCommitRequest[] = [];
      const workflowCommit: WorkflowCommitHandler = {
        attach: () => {},
        commit: (request) => {
          commits.push(request);
          return { accepted: true, message: 'recorded' };
        },
      };
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        readOnlyWorkspace: { writablePaths: ['.workflow/reviews'] },
        taskScope: {
          compiledPolicy: taskScopePolicy('Review the code against the docs.', [
            scopeRule('scope-read-docs', 'filesystem', {
              paths: { roles: ['read-path'], within: join(TEST_ROOT, 'docs') },
            }),
          ]),
        },
        workflowCommit,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, mockSuccessClient());
      const writeCode = makeRequest({ toolName: 'write_file', arguments: { path: `${TEST_SANDBOX_DIR}/src/app.ts` } });
      const readOutOfScope = makeRequest({ arguments: { path: join(TEST_ROOT, 'elsewhere', 'notes.md') } });

      try {
        await coordinator.loadPolicy({ persona: 'permissive-scoped', policyDir: personaDir });
        const engine = coordinator.getPolicyEngine();
        // The read-only workspace: the persona's allow-everything rule
        // cannot lift it ...
        expect(engine.evaluate(writeCode)).toMatchObject({ decision: 'deny', rule: 'structural-read-only-workspace' });
        // ... the task scope still narrows what the persona allows ...
        expect(coordinator.hasTaskScope()).toBe(true);
        expect(engine.evaluate(readOutOfScope)).toMatchObject({ decision: 'escalate', rule: TASK_SCOPE_ESCALATE_RULE });
        // ... and the state can still commit its result, which writes nothing.
        const response = await coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, {
          invocation: 'abc-123',
          verdict: 'approved',
        });
        expect(response.isError).toBeFalsy();
        expect(response._policyDecision).toMatchObject({ status: 'allow', rule: 'workflow-commit-allow' });
        expect(commits).toEqual([{ invocation: 'abc-123', verdict: 'approved' }]);
      } finally {
        await coordinator.close();
      }
    });
  });

  describe('requestId/timestamp correlation', () => {
    it('preserves the caller-supplied requestId and timestamp in the audit entry', async () => {
      // Structured callers (coordinator handleStructuredToolCall) carry
      // their own requestId/timestamp. Pre-fix, handleCallTool synthesized
      // fresh values and dropped the caller's -- breaking correlation
      // between caller-side tracing and the audit log.
      const { coordinator, auditPath } = makeCoordinator('requestid-correlation');
      const callerRequestId = 'caller-trace-0000-aaaa-bbbb-cccc';
      const callerTimestamp = '2025-01-15T12:34:56.789Z';
      try {
        const req = makeRequest({
          requestId: callerRequestId,
          timestamp: callerTimestamp,
          toolName: 'list_allowed_directories',
          arguments: {},
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(result.status).toBe('success');
        // The coordinator echoes the caller's requestId on the result.
        expect(result.requestId).toBe(callerRequestId);
      } finally {
        await coordinator.close();
      }

      // Both the write-ahead record and the outcome carry the caller's identity.
      const entries = readAudit(auditPath);
      expect(entries.length).toBe(2);
      for (const entry of entries as Array<{ requestId: string; timestamp: string }>) {
        expect(entry.requestId).toBe(callerRequestId);
        expect(entry.timestamp).toBe(callerTimestamp);
      }
    });
  });

  describe('escalation with no handler configured', () => {
    it('returns status:denied (not error) when no escalation handler is available', async () => {
      // Pre-fix the `_policyDecision.status` on this branch carried the
      // original 'escalate' value, causing the coordinator's classifier
      // to report `status:'error'` instead of `'denied'`. The outcome
      // IS a denial (we have no way to escalate), so it must be labeled
      // as such.
      const auditPath = makeAuditPath('escalate-no-handler');
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        // Deliberately leave `onEscalation` and `escalationDir` unset.
      });
      registerFilesystemTools(coordinator, client);

      try {
        const req = makeRequest({
          toolName: 'write_file',
          arguments: { path: '/tmp/outside-sandbox/f.txt' },
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
      } finally {
        await coordinator.close();
      }
    });
  });

  describe('human-denied escalation: audit and returned decision agree', () => {
    it('writes a deny-status audit entry that matches the returned PolicyDecision', async () => {
      // Pre-fix the outer `policyDecision` (captured by the audit
      // closure) still had status:'escalate' and the original
      // evaluation reason, while the returned `_policyDecision`
      // reported status:'deny' with 'Denied by human during escalation'.
      // Audit and returned decision must agree.
      const auditPath = makeAuditPath('escalate-denied-audit-agrees');
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => ({ decision: 'denied' }),
      });
      registerFilesystemTools(coordinator, client);

      try {
        const req = makeRequest({
          toolName: 'write_file',
          arguments: { path: '/tmp/outside-sandbox/f.txt' },
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
        expect(result.policyDecision.reason).toBe('Denied by human during escalation');
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
      const entry = entries[0] as {
        policyDecision: { status: string; reason: string };
        result: { status: string; error?: string };
        escalationResult?: string;
      };
      // Audit must reflect the human-denial outcome, not the original
      // 'escalate' decision from the policy engine.
      expect(entry.policyDecision.status).toBe('deny');
      expect(entry.policyDecision.reason).toBe('Denied by human during escalation');
      expect(entry.result.status).toBe('denied');
      expect(entry.result.error).toBe('Denied by human during escalation');
      expect(entry.escalationResult).toBe('denied');
    });
  });

  describe('handleStructuredToolCall: synthetic entries are not leaked', () => {
    it('does not mutate toolMap for unregistered tools', async () => {
      const { coordinator } = makeCoordinator('synth-no-leak');
      try {
        // Call into an unregistered (server, tool) pair. Pre-fix, this
        // would persist a synthetic entry in `this.toolMap` keyed by
        // toolName, so a subsequent call to the same name on a
        // different server would see the wrong serverName.
        await coordinator.handleStructuredToolCall(
          makeRequest({
            serverName: 'unknown-server',
            toolName: 'nonexistent_tool',
            arguments: {},
          }),
        );

        const registered = coordinator.getRegisteredTools();
        expect(registered.some((t) => t.name === 'nonexistent_tool')).toBe(false);
      } finally {
        await coordinator.close();
      }
    });

    it('does not cross-route tools with the same name across different servers', async () => {
      // Two unregistered (server, tool) requests sharing a tool name.
      // Pre-fix, the second request would reuse the synthetic entry
      // from the first and report serverName=server-A even when the
      // caller supplied server-B. Post-fix, each call builds its own
      // synthetic entry scoped to that invocation.
      const { coordinator } = makeCoordinator('synth-no-cross');
      try {
        const first = await coordinator.handleStructuredToolCall(
          makeRequest({
            serverName: 'server-A',
            toolName: 'shared_tool',
            arguments: {},
          }),
        );
        const second = await coordinator.handleStructuredToolCall(
          makeRequest({
            serverName: 'server-B',
            toolName: 'shared_tool',
            arguments: {},
          }),
        );

        // Both calls route through the engine and land on
        // `missing-annotation`. The reason text carries the server
        // name, which must match the caller's request in each case.
        expect(first.policyDecision.rule).toBe('missing-annotation');
        expect(second.policyDecision.rule).toBe('missing-annotation');
        expect(first.policyDecision.reason).toContain('server-A');
        expect(second.policyDecision.reason).toContain('server-B');

        // Neither call should leak into the registry.
        expect(coordinator.getRegisteredTools().some((t) => t.name === 'shared_tool')).toBe(false);
      } finally {
        await coordinator.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Quiesce vs. a held-open escalation. The escalation wait releases the
  // call mutex, so `withToolCallsQuiesced` (close / loadPolicy) is what
  // keeps the swap from landing under a parked call. It must not wait out
  // the escalation timeout to get there: it cancels the pending escalation
  // (denied at once, audited as `cancelled`, request file removed), drains,
  // and only then proceeds. The call never settles as a human denial.
  // -------------------------------------------------------------------------

  describe('quiesce cancels a held-open escalation', () => {
    it('close() cancels a pending in-process escalation and returns within a second', async () => {
      const auditPath = makeAuditPath('close-cancels-escalation');
      const escalation = makeHeldEscalation();
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: escalation.onEscalation,
        // Long enough that a close() that waited for the deadline would fail
        // the timing assertion below.
        escalationTimeoutMs: 30_000,
      });
      registerFilesystemTools(coordinator, client);

      // 1. Park a call inside the escalation wait (mutex released here).
      const escalating = coordinator.handleStructuredToolCall(
        makeRequest({
          requestId: 'held-escalation',
          toolName: 'write_file',
          arguments: { path: '/tmp/outside-sandbox/f.txt' },
        }),
      );
      await escalation.entered;
      expect(coordinator.getPendingEscalationCount()).toBe(1);

      // 2. close() must not wait for the handler (never released here) nor
      //    for the 30 s deadline: it cancels the wait and drains.
      const started = Date.now();
      await coordinator.close();
      expect(Date.now() - started).toBeLessThan(1_000);

      const escalatingResult = await escalating;
      expect(escalatingResult.status).toBe('denied');
      expect(escalatingResult.policyDecision.status).toBe('deny');
      expect(escalatingResult.policyDecision.reason).toContain('Escalation cancelled');
      expect(escalatingResult.policyDecision.reason).not.toContain('Denied by human');

      // 3. The handler saw the abort through its signal, with the reason.
      expect(escalation.signal?.aborted).toBe(true);
      expect(escalation.signal?.reason).toMatchObject({ kind: 'cancelled' });

      // 4. Audited as cancelled -- not as a human denial.
      const entries = readAudit(auditPath);
      expect(entries).toHaveLength(1);
      const entry = entries[0] as { escalationResult?: string; result: { status: string; error?: string } };
      expect(entry.escalationResult).toBe('cancelled');
      expect(entry.result.status).toBe('denied');
      expect(entry.result.error).toContain('cancelled');
    });

    it('close() cancels a pending file-IPC escalation and removes its request file', async () => {
      const auditPath = makeAuditPath('close-cancels-file-escalation');
      const escalationDir = join(TEST_ROOT, 'esc-close');
      mkdirSync(escalationDir, { recursive: true });
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        escalationDir,
        escalationTimeoutMs: 30_000,
      });
      registerFilesystemTools(coordinator, client);

      const escalating = coordinator.handleStructuredToolCall(
        makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/f.txt' } }),
      );
      const requestFile = await waitForFile(escalationDir, 'request-');
      expect(requestFile).toBeDefined();

      const started = Date.now();
      await coordinator.close();
      expect(Date.now() - started).toBeLessThan(1_000);

      const result = await escalating;
      expect(result.status).toBe('denied');
      expect(result.policyDecision.reason).toContain('Escalation cancelled');
      // The session side sees "request gone, no response" and reports expiry.
      expect(readdirSync(escalationDir).filter((f) => f.startsWith('request-'))).toEqual([]);
      const entries = readAudit(auditPath);
      expect((entries[0] as { escalationResult?: string }).escalationResult).toBe('cancelled');
    });

    it('loadPolicy() cancels a pending escalation, then swaps the engine', async () => {
      const auditPath = makeAuditPath('loadpolicy-cancels-escalation');
      const newPolicyDir = join(TEST_ROOT, 'personas', 'policy-quiesce', 'generated');
      writePersonaPolicy(newPolicyDir);
      const escalation = makeHeldEscalation();
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: escalation.onEscalation,
        escalationTimeoutMs: 30_000,
      });
      registerFilesystemTools(coordinator, client);
      const oldEngine = coordinator.getPolicyEngine();

      try {
        // 1. Park a call inside the escalation wait (mutex released).
        const escalating = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'held-escalation',
            toolName: 'write_file',
            arguments: { path: '/tmp/outside-sandbox/f.txt' },
          }),
        );
        await escalation.entered;

        // 2. loadPolicy with a VALID (containment-passing) dir. The parked
        //    call is cancelled and settles BEFORE the swap: the engine
        //    reference changes only after the escalating call has returned.
        const order: string[] = [];
        const started = Date.now();
        const escalatingDone = escalating.then((result) => {
          order.push('escalation-settled');
          return result;
        });
        await coordinator.loadPolicy({ persona: 'reviewer', policyDir: newPolicyDir });
        order.push('policy-loaded');
        expect(Date.now() - started).toBeLessThan(1_000);

        const escalatingResult = await escalatingDone;
        expect(order).toEqual(['escalation-settled', 'policy-loaded']);
        expect(escalatingResult.status).toBe('denied');
        expect(escalatingResult.policyDecision.reason).toContain('policy hot-swap');
        expect(coordinator.getPolicyEngine()).not.toBe(oldEngine);

        // The cancelled call was audited under the OLD persona (none here),
        // as cancelled, not as a human denial.
        const entries = readAudit(auditPath);
        expect(entries).toHaveLength(1);
        expect((entries[0] as { escalationResult?: string }).escalationResult).toBe('cancelled');
        expect((entries[0] as { persona?: string }).persona).toBeUndefined();

        // 3. The coordinator keeps serving calls under the new engine.
        const next = await coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
        );
        expect(next.status).toBe('success');
        expect(coordinator.getPendingEscalationCount()).toBe(0);
      } finally {
        await coordinator.close();
      }
    });

    it('an escalation that starts while a quiesce is in progress is cancelled at once', async () => {
      const auditPath = makeAuditPath('quiesce-late-escalation');
      let escalationCalls = 0;
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: () => {
          escalationCalls++;
          return new Promise(() => {});
        },
        escalationTimeoutMs: 30_000,
      });

      // Admit the escalating call first (so the quiesce has to drain it), but
      // make it reach its escalation wait only after close() has swept the
      // pending set: an allowed call holds the call mutex inside a dispatch
      // the test controls, and the escalating call queues behind it.
      const dispatchGate = deferred<undefined>();
      const slowClient = {
        callTool: async () => {
          await dispatchGate.promise;
          return { content: [{ type: 'text', text: 'ok' }], isError: false };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;
      registerFilesystemTools(coordinator, slowClient);
      const releaseAllowed = (): void => dispatchGate.resolve(undefined);

      // The first call holds the call mutex inside dispatch; the second is
      // admitted but queued on the mutex, so its escalation wait begins only
      // after close() has already run its cancel sweep.
      const allowed = coordinator.handleStructuredToolCall(
        makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
      );
      await new Promise((r) => setTimeout(r, 20));
      const escalating = coordinator.handleStructuredToolCall(
        makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/f.txt' } }),
      );
      await new Promise((r) => setTimeout(r, 20));

      const closePromise = coordinator.close();
      await new Promise((r) => setTimeout(r, 20));
      releaseAllowed();

      const started = Date.now();
      await closePromise;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect((await allowed).status).toBe('success');
      const result = await escalating;
      expect(result.status).toBe('denied');
      expect(result.policyDecision.reason).toContain('Escalation cancelled');
      // The wait was aborted before the handler was consulted at all.
      expect(escalationCalls).toBe(0);
    });

    it('loadPolicy() drops whitelist patterns approved under the previous persona', async () => {
      // A shared-container workflow coordinator outlives its personas. A
      // pattern a human whitelisted while persona A's policy was loaded must
      // not discharge persona B's escalations: B's policy escalated the call,
      // and nobody approved it for B.
      const auditPath = makeAuditPath('loadpolicy-resets-whitelist');
      const personaBDir = join(TEST_ROOT, 'personas', 'policy-whitelist-reset', 'generated');
      mkdirSync(personaBDir, { recursive: true });
      // Same rules as the base policy: persona B escalates the same write.
      writeFileSync(join(personaBDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));

      const asked: string[] = [];
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async (_request, _reason, _context, candidates, details) => {
          asked.push(details.persona ?? '(none)');
          // Approve, and whitelist the first candidate when there is one.
          return candidates && candidates.length > 0
            ? { decision: 'approved', whitelistSelection: 0 }
            : { decision: 'approved' };
        },
        escalationTimeoutMs: 30_000,
      });
      registerFilesystemTools(coordinator, mockSuccessClient());
      const write = () =>
        coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/w.txt' } }),
        );

      try {
        await coordinator.loadPolicy({ persona: 'coder', policyDir: personaBDir });

        // 1. Approved and whitelisted under persona "coder".
        expect((await write()).status).toBe('success');
        expect(asked).toEqual(['coder']);
        // 2. The pattern discharges the next identical escalation (no prompt).
        const whitelisted = await write();
        expect(whitelisted.status).toBe('success');
        expect(whitelisted.policyDecision.reason).toContain('Whitelist-approved');
        expect(asked).toEqual(['coder']);

        // 3. Swap to persona "reviewer": the same call must reach a human again.
        await coordinator.loadPolicy({ persona: 'reviewer', policyDir: personaBDir });
        const afterSwap = await write();
        expect(afterSwap.policyDecision.reason).not.toContain('Whitelist-approved');
        expect(afterSwap.policyDecision.reason).toBe('Approved by human during escalation');
        expect(asked).toEqual(['coder', 'reviewer']);
      } finally {
        await coordinator.close();
      }

      const reviewerOutcomes = readOutcomes(auditPath).filter(
        (e) => (e as { persona?: string }).persona === 'reviewer',
      ) as Array<{ whitelistApproved?: boolean; escalationResult?: string }>;
      expect(reviewerOutcomes).toHaveLength(1);
      expect(reviewerOutcomes[0].whitelistApproved).toBeUndefined();
      expect(reviewerOutcomes[0].escalationResult).toBe('approved');
    });
  });

  // -------------------------------------------------------------------------
  // Escalation timeout: the coordinator's configured deadline (from the
  // user's escalationTimeoutSeconds) bounds both the in-process handler and
  // the file-IPC wait. A deadline hit is audited as `timed-out`, never as a
  // human denial, and the handler is told through its signal.
  // -------------------------------------------------------------------------

  describe('escalation timeout', () => {
    it('denies an unanswered in-process escalation at the configured timeout, audited as timed-out', async () => {
      const auditPath = makeAuditPath('escalation-timeout-in-process');
      const escalation = makeHeldEscalation();
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: escalation.onEscalation,
        escalationTimeoutMs: 300,
      });
      registerFilesystemTools(coordinator, client);

      try {
        const started = Date.now();
        const result = await coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/f.txt' } }),
        );
        const elapsed = Date.now() - started;
        // Settles at the deadline: not before it, and well before the 300 s default.
        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(elapsed).toBeLessThan(5_000);

        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
        expect(result.policyDecision.reason).toContain('Escalation timed out');
        expect(result.policyDecision.reason).not.toContain('Denied by human');
        expect(escalation.signal?.aborted).toBe(true);
        expect(escalation.signal?.reason).toMatchObject({ kind: 'timed-out' });
        expect(coordinator.getPendingEscalationCount()).toBe(0);
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries).toHaveLength(1);
      const entry = entries[0] as { escalationResult?: string; result: { status: string; error?: string } };
      expect(entry.escalationResult).toBe('timed-out');
      expect(entry.result.status).toBe('denied');
      expect(entry.result.error).toContain('timed out');
    });

    it('denies an unanswered file-IPC escalation at the configured timeout and removes the request file', async () => {
      const auditPath = makeAuditPath('escalation-timeout-file');
      const escalationDir = join(TEST_ROOT, 'esc-timeout');
      mkdirSync(escalationDir, { recursive: true });
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        escalationDir,
        escalationTimeoutMs: 300,
      });
      registerFilesystemTools(coordinator, client);

      try {
        const started = Date.now();
        const escalating = coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/f.txt' } }),
        );
        expect(await waitForFile(escalationDir, 'request-')).toBeDefined();
        const result = await escalating;
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(elapsed).toBeLessThan(5_000);
        expect(result.status).toBe('denied');
        expect(result.policyDecision.reason).toContain('Escalation timed out');
        expect(readdirSync(escalationDir).filter((f) => f.startsWith('request-'))).toEqual([]);
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect((entries[0] as { escalationResult?: string }).escalationResult).toBe('timed-out');
    });

    it('honours a late human response that lands before the deadline', async () => {
      const auditPath = makeAuditPath('escalation-answered-before-timeout');
      const escalation = makeHeldEscalation();
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: escalation.onEscalation,
        escalationTimeoutMs: 30_000,
      });
      registerFilesystemTools(coordinator, client);

      try {
        const escalating = coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/f.txt' } }),
        );
        await escalation.entered;
        expect(escalation.details?.escalationId).toMatch(/^[0-9a-f-]{36}$/);
        escalation.release('denied');
        const result = await escalating;
        expect(result.policyDecision.reason).toBe('Denied by human during escalation');
        expect(escalation.signal?.aborted).toBe(false);
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect((entries[0] as { escalationResult?: string }).escalationResult).toBe('denied');
    });

    it('honours a configured 30 s escalationTimeoutSeconds: still pending at 29.9 s, timed out at 30 s', async () => {
      // The value the session layer derives from the user's config. Before
      // the fix the in-process wait read process.env (set only for relays)
      // and always waited 300 s.
      const escalationTimeoutMs = escalationTimeoutMsFromConfig({ escalationTimeoutSeconds: 30 });
      expect(escalationTimeoutMs).toBe(30_000);

      const auditPath = makeAuditPath('escalation-timeout-configured-30s');
      const escalation = makeHeldEscalation();
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: escalation.onEscalation,
        escalationTimeoutMs,
      });
      registerFilesystemTools(coordinator, mockSuccessClient());

      try {
        // Only the timers are faked, so the deadline the wait arms is virtual.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let settled = false;
        let escalating: Promise<Awaited<ReturnType<ToolCallCoordinator['handleStructuredToolCall']>>>;
        try {
          escalating = coordinator
            .handleStructuredToolCall(
              makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/f.txt' } }),
            )
            .finally(() => {
              settled = true;
            });
          await escalation.entered;
          await vi.advanceTimersByTimeAsync(29_900);
          expect(settled).toBe(false);
          expect(escalation.signal?.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(100);
        } finally {
          vi.useRealTimers();
        }

        const result = await escalating;
        expect(result.status).toBe('denied');
        expect(result.policyDecision.reason).toBe(
          'Escalation timed out: no decision within the 30s escalation timeout',
        );
        expect(escalation.signal?.reason).toMatchObject({ kind: 'timed-out' });
      } finally {
        await coordinator.close();
      }
      expect((readAudit(auditPath)[0] as { escalationResult?: string }).escalationResult).toBe('timed-out');
    });

    it('denies a call whose in-process handler withdraws the escalation as cancelled, not as a human denial', async () => {
      const auditPath = makeAuditPath('escalation-withdrawn');
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: () => Promise.reject(new EscalationWithdrawnError('the agent turn that raised it has ended')),
        escalationTimeoutMs: 30_000,
      });
      registerFilesystemTools(coordinator, mockSuccessClient());

      try {
        const result = await coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/f.txt' } }),
        );
        expect(result.status).toBe('denied');
        expect(result.policyDecision.reason).toBe('Escalation cancelled: the agent turn that raised it has ended');
        // The coordinator keeps serving: a withdrawal is not a hook failure.
        const next = await coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
        );
        expect(next.status).toBe('success');
      } finally {
        await coordinator.close();
      }
      const outcome = readOutcomes(auditPath)[0] as { escalationResult?: string; result: { status: string } };
      expect(outcome.escalationResult).toBe('cancelled');
      expect(outcome.result.status).toBe('denied');
    });

    it('close() during auto-approval aborts the model call and denies the call as cancelled', async () => {
      const auditPath = makeAuditPath('close-during-auto-approve');
      let entered: (() => void) | undefined;
      const modelEntered = new Promise<void>((r) => {
        entered = r;
      });
      let sawAbortSignal = false;
      const model = new MockLanguageModelV3({
        doGenerate: (options) =>
          new Promise((_resolve, reject) => {
            sawAbortSignal = options.abortSignal !== undefined;
            entered?.();
            options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      }) as unknown as LanguageModelV3;
      let humanAsked = false;
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        autoApproveModel: model,
        onEscalation: () => {
          humanAsked = true;
          return new Promise(() => {});
        },
        escalationTimeoutMs: 30_000,
      });
      coordinator.setLastUserMessage('please write /tmp/outside-sandbox/f.txt');
      registerFilesystemTools(coordinator, mockSuccessClient());

      const escalating = coordinator.handleStructuredToolCall(
        makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/f.txt' } }),
      );
      await modelEntered;
      expect(sawAbortSignal).toBe(true);

      const started = Date.now();
      await coordinator.close();
      expect(Date.now() - started).toBeLessThan(1_000);
      const result = await escalating;
      expect(result.status).toBe('denied');
      expect(result.policyDecision.reason).toBe('Escalation cancelled: coordinator shutting down');
      expect(humanAsked).toBe(false);
      expect((readOutcomes(auditPath)[0] as { escalationResult?: string }).escalationResult).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // Escalation-hook-throws cleanup: a throwing onEscalation must not leak the
  // call mutex or the admission slot. `runSerializedToolCall`'s outer finally
  // releases the mutex even on throw, and `handleStructuredToolCall`'s finally
  // calls `leaveToolCall` (draining `activeToolCalls` back to 0). The two
  // observable consequences: the NEXT call still acquires the mutex and
  // succeeds, and `close()` still drains (it never hangs waiting on a leaked
  // active-call counter). Disabling either cleanup deadlocks one of these.
  // -------------------------------------------------------------------------

  describe('escalation hook throws', () => {
    it('leaks no mutex or admission slot: the next call succeeds and close() drains', async () => {
      const auditPath = makeAuditPath('escalation-hook-throws');
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => {
          throw new Error('escalation hook boom');
        },
      });
      registerFilesystemTools(coordinator, client);

      try {
        // 1. The throwing escalation hook must reject the call -- but the
        //    mutex must be reacquired+released and the admission slot
        //    returned (leaveToolCall in finally).
        await expect(
          coordinator.handleStructuredToolCall(
            makeRequest({
              toolName: 'write_file',
              arguments: { path: '/tmp/outside-sandbox/f.txt' },
            }),
          ),
        ).rejects.toThrow('escalation hook boom');

        // 2. Exactly ONE audit entry is written for the attempted call: the
        //    escalation-wait throw is now audited (denied) before re-raising,
        //    so the call is no longer silently unaudited. No double-audit (the
        //    settled-decision branch never ran).
        const afterThrow = readAudit(auditPath);
        expect(afterThrow).toHaveLength(1);
        expect(afterThrow[0]?.toolName).toBe('write_file');
        const throwResult = afterThrow[0]?.result as { status?: string; error?: string };
        expect(throwResult.status).toBe('denied');
        expect(throwResult.error).toContain('escalation hook boom');

        // 3. A subsequent allowed call must succeed -- proving no mutex or
        //    admission slot leaked from the thrown hook.
        const next = await coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
        );
        expect(next.status).toBe('success');

        // The successful call adds exactly one more outcome entry: still no
        // double-audit of the thrown escalation.
        expect(readOutcomes(auditPath)).toHaveLength(2);
      } finally {
        // 4. close() must drain cleanly (activeToolCalls back to 0).
        await coordinator.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // PTY trust gating: the coordinator's own `isPtySession` option (from
  // IronCurtainConfig, never an environment variable) decides whether the
  // file-IPC user context must come from the trusted mux layer.
  // -------------------------------------------------------------------------

  describe('auto-approver trust in the file-IPC user context', () => {
    const USER_MESSAGE = 'please write the file at /tmp/outside-sandbox/a.txt';

    /** An approver model that counts its calls and always approves. */
    function countingApprover(): { model: LanguageModelV3; calls: () => number } {
      let calls = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          calls++;
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ decision: 'approve', reasoning: 'matches' }) }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 20, text: undefined, reasoning: undefined },
            },
            warnings: [],
            request: {},
            response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
          };
        },
      }) as unknown as LanguageModelV3;
      return { model, calls: () => calls };
    }

    /**
     * Runs one escalating write through a coordinator whose escalation
     * directory holds `context` as user-context.json. A human who would deny
     * is present, so the result tells whether the approver was trusted.
     */
    async function runWithContext(
      suffix: string,
      context: Record<string, unknown>,
      isPtySession: boolean | undefined,
    ): Promise<{ approverCalls: number; humanCalls: number; status: string }> {
      const escalationDir = resolve(TEST_ROOT, `escalations-${suffix}`);
      mkdirSync(escalationDir, { recursive: true });
      writeFileSync(join(escalationDir, 'user-context.json'), JSON.stringify(context));
      const approver = countingApprover();
      let humanCalls = 0;
      const state: ClientState = { client: null as unknown as Client, roots: [] };
      state.client = rootsAwareClient(state, 'ok');
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: makeAuditPath(suffix),
        autoApproveModel: approver.model,
        escalationDir,
        ...(isPtySession !== undefined ? { isPtySession } : {}),
        onEscalation: async () => {
          humanCalls++;
          return { decision: 'denied' };
        },
      });
      const fsTools: ProxiedTool[] = testToolAnnotations.servers.filesystem.tools.map((a) => ({
        serverName: a.serverName,
        name: a.toolName,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      }));
      coordinator.registerTools('filesystem', fsTools, state);
      try {
        const result = await coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/a.txt' } }),
        );
        return { approverCalls: approver.calls(), humanCalls, status: result.status };
      } finally {
        await coordinator.close();
      }
    }

    it('a PTY coordinator refuses a context without source and timestamp', async () => {
      const outcome = await runWithContext('pty-bare', { userMessage: USER_MESSAGE }, true);
      expect(outcome).toEqual({ approverCalls: 0, humanCalls: 1, status: 'denied' });
    });

    it('a PTY coordinator refuses a trusted source without a timestamp, and a timestamp without the source', async () => {
      const noTimestamp = await runWithContext(
        'pty-no-ts',
        { userMessage: USER_MESSAGE, source: 'mux-trusted-input' },
        true,
      );
      expect(noTimestamp).toEqual({ approverCalls: 0, humanCalls: 1, status: 'denied' });
      const noSource = await runWithContext(
        'pty-no-source',
        { userMessage: USER_MESSAGE, source: 'session-direct', timestamp: new Date().toISOString() },
        true,
      );
      expect(noSource).toEqual({ approverCalls: 0, humanCalls: 1, status: 'denied' });
    });

    it('a PTY coordinator consults the approver for fresh input from the mux layer', async () => {
      const outcome = await runWithContext(
        'pty-trusted',
        { userMessage: USER_MESSAGE, source: 'mux-trusted-input', timestamp: new Date().toISOString() },
        true,
      );
      expect(outcome.approverCalls).toBe(1);
      expect(outcome.humanCalls).toBe(0);
    });

    it('a coordinator built without the option is a non-PTY coordinator', async () => {
      // An older writer's context (no source, no timestamp) is accepted
      // outside PTY mode, so the approver is consulted.
      const outcome = await runWithContext('non-pty', { userMessage: USER_MESSAGE }, undefined);
      expect(outcome.approverCalls).toBe(1);
      expect(outcome.humanCalls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Auto-approval liveness: the auto-approval branch (not just the human
  // path) runs inside the escalation wait, outside the call mutex. Two
  // concurrent auto-approvals must not serialize on the mutex.
  // -------------------------------------------------------------------------

  describe('auto-approval runs outside the call mutex', () => {
    it('does not serialize two concurrent auto-approvals on the call mutex', async () => {
      const auditPath = makeAuditPath('auto-approve-concurrent');
      const first = makeGatedAutoApproveModel();
      // After an approved escalation, the pipeline expands MCP roots and
      // waits for the client to refresh. Wire `rootsRefreshed` so the two
      // approved calls don't each block on ROOTS_REFRESH_TIMEOUT_MS, and
      // report the roots back for the post-refresh verification (a root is
      // added whenever /tmp/outside-sandbox happens to exist on this host).
      const state: ClientState = { client: null as unknown as Client, roots: [] };
      state.client = rootsAwareClient(state, 'ok');

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        autoApproveModel: first.model,
        // A human handler must be present for the escalation branch to be
        // entered at all (otherwise the no-handler path denies before the
        // wait). Auto-approval is tried first inside the wait, so this hook
        // should never fire -- if it does, the test fails on the deny.
        onEscalation: async () => ({ decision: 'denied' }),
      });
      // The auto-approver reads the last user message for intent matching.
      coordinator.setLastUserMessage('please write the file at /tmp/outside-sandbox, I authorize it');
      const fsTools: ProxiedTool[] = testToolAnnotations.servers.filesystem.tools.map((a) => ({
        serverName: a.serverName,
        name: a.toolName,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      }));
      coordinator.registerTools('filesystem', fsTools, state);

      try {
        // 1. Start two escalating calls. Each enters the auto-approval
        //    branch of the escalation wait. If that branch held the call
        //    mutex, the second model invocation could not begin until the
        //    first returned.
        const callA = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'auto-A',
            toolName: 'write_file',
            arguments: { path: '/tmp/outside-sandbox/a.txt' },
          }),
        );
        const callB = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'auto-B',
            toolName: 'write_file',
            arguments: { path: '/tmp/outside-sandbox/b.txt' },
          }),
        );

        // 2. KEY assertion: BOTH auto-approval model calls must be parked
        //    inside doGenerate at the same time. `concurrentReached(2)`
        //    resolves only when two invocations are simultaneously gated.
        //    If the call mutex serialized the escalation wait, the second
        //    model call could never start while the first is gated, so the
        //    count would stay at 1 and this would time out.
        const bothInFlight = await Promise.race([
          first.concurrentReached(2).then(() => 'both-in-flight' as const),
          new Promise<'serialized'>((r) => setTimeout(() => r('serialized'), 50)),
        ]);
        expect(bothInFlight).toBe('both-in-flight');

        // 3. Release the gate; both auto-approvals complete and allow.
        first.release();
        const [resultA, resultB] = await Promise.all([callA, callB]);
        expect(resultA.status).toBe('success');
        expect(resultB.status).toBe('success');
        expect(resultA.policyDecision.status).toBe('allow');
        expect(resultB.policyDecision.status).toBe('allow');
        expect(resultA.policyDecision.reason).toContain('Auto-approved');
      } finally {
        await coordinator.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Audit fails closed. Before this, an allowed call was dispatched first and
  // audited afterwards, so a broken audit log (ENOSPC, EACCES, the session
  // directory removed mid-run) let every allowed mutation run unaudited and
  // only then failed. Now the pipeline checks the log before evaluating a
  // call and writes a `dispatching` record before every dispatch; the
  // coordinator latches the failure and stops admitting calls.
  // -------------------------------------------------------------------------

  describe('audit log fails closed', () => {
    it('dispatches nothing once the audit path is removed mid-session, including the first failing call', async () => {
      const auditPath = makeAuditPath('audit-broken-mid-session');
      const dispatched: string[] = [];
      const writeAheadOnDiskAtDispatch: boolean[] = [];
      const client: Client = {
        callTool: async (params: { name: string }) => {
          dispatched.push(params.name);
          // The backend must only ever see a call whose write-ahead record
          // is already on disk.
          const pending = readAudit(auditPath).filter((entry) => isDispatchingAuditEntry(entry));
          writeAheadOnDiskAtDispatch.push(pending.length === dispatched.length);
          return { content: [{ type: 'text', text: 'ok' }], isError: false };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);
      // A mutating call inside the sandbox: allowed by the structural
      // sandbox invariant, so it is dispatched when the log is healthy.
      const writeRequest = (requestId: string): ToolCallRequest =>
        makeRequest({ requestId, toolName: 'write_file', arguments: { path: `${TEST_SANDBOX_DIR}/notes.txt` } });

      try {
        // 1. Healthy log: dispatched, write-ahead record first, outcome second.
        const healthy = await coordinator.handleStructuredToolCall(writeRequest('healthy'));
        expect(healthy.status).toBe('success');
        expect(dispatched).toEqual(['write_file']);
        expect(writeAheadOnDiskAtDispatch).toEqual([true]);
        expect(readAudit(auditPath)).toMatchObject([
          { requestId: 'healthy', result: { status: 'dispatching' }, policyDecision: { status: 'allow' } },
          { requestId: 'healthy', result: { status: 'success' } },
        ]);
        expect(coordinator.getAuditFailure()).toBeNull();

        // 2. The audit path is removed (a directory now sits there). The
        //    very first call whose append fails is refused: policy allowed
        //    it, the write-ahead record could not be written, nothing ran.
        breakAuditPath(auditPath);
        const firstFailure = await rejectionOf(coordinator.handleStructuredToolCall(writeRequest('first-failure')));
        expect(isAuditLogUnavailableError(firstFailure)).toBe(true);
        expect((firstFailure as Error).message).toMatch(/AuditLog stream error/);
        expect(dispatched).toEqual(['write_file']);

        // 3. The failure is latched: later calls are refused at admission.
        const afterLatch = await rejectionOf(coordinator.handleStructuredToolCall(writeRequest('after-latch')));
        expect(isAuditLogUnavailableError(afterLatch)).toBe(true);
        expect((afterLatch as Error).message).toContain('no longer admitted');
        expect(dispatched).toEqual(['write_file']);
        expect(coordinator.getAuditFailure()).toBe(firstFailure);

        // 4. Repairing the path does not reopen the session: the gap is
        //    permanent, so the latch is too, and nothing is written.
        rmSync(auditPath, { recursive: true, force: true });
        const afterRepair = await rejectionOf(coordinator.handleStructuredToolCall(writeRequest('after-repair')));
        expect(isAuditLogUnavailableError(afterRepair)).toBe(true);
        expect(dispatched).toEqual(['write_file']);
        expect(existsSync(auditPath)).toBe(false);
      } finally {
        // close() still drains and resolves on a latched coordinator.
        await coordinator.close();
      }
    });

    it('refuses a denied call too when the audit log is broken, instead of auditing it', async () => {
      const auditPath = makeAuditPath('audit-broken-deny');
      let callCount = 0;
      const client: Client = {
        callTool: async () => {
          callCount++;
          return { content: [{ type: 'text', text: 'ok' }], isError: false };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);

      try {
        breakAuditPath(auditPath);
        const refused = await rejectionOf(
          coordinator.handleStructuredToolCall(
            makeRequest({ toolName: 'read_file', arguments: { path: TEST_PROTECTED_PATHS[0] } }),
          ),
        );
        expect(isAuditLogUnavailableError(refused)).toBe(true);
        expect(callCount).toBe(0);
      } finally {
        await coordinator.close();
      }
    });

    it('dispatches nothing once the session directory holding the audit log is deleted', async () => {
      // The literal "audit path removed" case: the directory is gone, so the
      // next append fails with ENOENT (a deleted file alone would simply be
      // recreated by the append).
      const sessionDir = resolve(TEST_ROOT, 'removed-session');
      const auditPath = resolve(sessionDir, 'audit.jsonl');
      let callCount = 0;
      const client: Client = {
        callTool: async () => {
          callCount++;
          return { content: [{ type: 'text', text: 'ok' }], isError: false };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);
      const writeRequest = (requestId: string): ToolCallRequest =>
        makeRequest({ requestId, toolName: 'write_file', arguments: { path: `${TEST_SANDBOX_DIR}/notes.txt` } });

      try {
        expect((await coordinator.handleStructuredToolCall(writeRequest('healthy'))).status).toBe('success');
        expect(callCount).toBe(1);

        rmSync(sessionDir, { recursive: true, force: true });
        const refused = await rejectionOf(coordinator.handleStructuredToolCall(writeRequest('after-removal')));
        expect(isAuditLogUnavailableError(refused)).toBe(true);
        expect((refused as Error).message).toMatch(/ENOENT/);
        expect(callCount).toBe(1);
        expect(existsSync(sessionDir)).toBe(false);
      } finally {
        await coordinator.close();
      }
    });

    it('writes the write-ahead record before an approved escalation widens the roots, and widens nothing once the log broke', async () => {
      const auditPath = makeAuditPath('audit-broken-during-escalation');
      const dispatched: string[] = [];
      const state: ClientState = { client: null as unknown as Client, roots: [] };
      const backend = rootsAwareClient(state, 'file content', (name) => dispatched.push(name));
      // Every roots update the backend receives, with the requestIds whose
      // write-ahead record was already on disk when it arrived.
      const rootsUpdates: string[][] = [];
      state.client = {
        callTool: backend.callTool,
        sendRootsListChanged: async () => {
          let writeAheadOnDisk: string[] = [];
          try {
            writeAheadOnDisk = readAudit(auditPath)
              .filter((entry) => isDispatchingAuditEntry(entry))
              .map((entry) => entry.requestId as string);
          } catch {
            // The audit path is a directory (broken): no record is on disk.
          }
          rootsUpdates.push(writeAheadOnDisk);
          await backend.sendRootsListChanged();
        },
      } as unknown as Client;

      // The first escalation is approved at once; the second is held until
      // the test releases it.
      const held = deferred<'approved' | 'denied'>();
      const heldEntered = deferred<undefined>();
      let escalations = 0;
      const onEscalation = async (): Promise<{ decision: 'approved' | 'denied' }> => {
        escalations++;
        if (escalations === 1) return { decision: 'approved' };
        heldEntered.resolve(undefined);
        return { decision: await held.promise };
      };

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation,
      });
      const fsTools: ProxiedTool[] = testToolAnnotations.servers.filesystem.tools.map((a) => ({
        serverName: a.serverName,
        name: a.toolName,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      }));
      coordinator.registerTools('filesystem', fsTools, state);

      try {
        // 1. Healthy log: the approved read outside the sandbox needs a new
        //    root. Widening the roots acts on the backend for this call, so
        //    its write-ahead record is on disk before the roots update.
        const approved = await coordinator.handleStructuredToolCall(
          makeRequest({ requestId: 'approved', toolName: 'read_file', arguments: { path: '/etc/hostname' } }),
        );
        expect(approved.status).toBe('success');
        expect(dispatched).toEqual(['read_file']);
        expect(rootsUpdates).toEqual([['approved']]);
        expect(readAudit(auditPath)).toMatchObject([
          { requestId: 'approved', result: { status: 'dispatching' }, escalationResult: 'approved' },
          { requestId: 'approved', result: { status: 'success' } },
        ]);
        const rootsAfterApproval = [...state.roots];
        expect(rootsAfterApproval).toHaveLength(1);

        // 2. Park a read that needs another root in the human escalation wait.
        const escalating = coordinator.handleStructuredToolCall(
          makeRequest({ requestId: 'held', toolName: 'read_file', arguments: { path: '/usr/share/held-read.txt' } }),
        );
        await heldEntered.promise;

        // 3. The audit log breaks while the human decides; the approval
        //    arrives afterwards. The call is approved but cannot be audited,
        //    so it is refused before anything reaches the backend: no tool
        //    call and no roots update either.
        breakAuditPath(auditPath);
        held.resolve('approved');
        const refused = await rejectionOf(escalating);
        expect(isAuditLogUnavailableError(refused)).toBe(true);
        expect(dispatched).toEqual(['read_file']);
        expect(rootsUpdates).toHaveLength(1);
        expect(state.roots).toEqual(rootsAfterApproval);
      } finally {
        await coordinator.close();
      }
    });

    it('applies the same write-ahead contract to virtual proxy tools', async () => {
      const auditPath = makeAuditPath('audit-virtual-proxy');
      const listings: boolean[] = [];
      const controlApiClient: ControlApiClient = {
        addDomain: async () => ({ added: false }),
        removeDomain: async () => ({ removed: false }),
        listDomains: async () => {
          // The write-ahead record is on disk before the tool runs.
          listings.push(readAudit(auditPath).some((entry) => isDispatchingAuditEntry(entry)));
          return { providers: ['api.anthropic.com'], dynamic: [] };
        },
      };
      // The sandbox merges the virtual `proxy` server's annotations and
      // rules at construction time; mirror that here.
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: { ...testCompiledPolicy, rules: [...proxyPolicyRules, ...testCompiledPolicy.rules] },
        toolAnnotations: {
          ...testToolAnnotations,
          servers: { ...testToolAnnotations.servers, proxy: { inputHash: 'hardcoded', tools: proxyAnnotations } },
        },
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        controlApiClient,
      });
      coordinator.registerTools(
        'proxy',
        proxyAnnotations.map((a) => ({ serverName: 'proxy', name: a.toolName, inputSchema: a.inputSchema })),
      );
      const listRequest = (requestId: string): ToolCallRequest =>
        makeRequest({ requestId, serverName: 'proxy', toolName: 'list_proxy_domains', arguments: {} });

      try {
        const healthy = await coordinator.handleStructuredToolCall(listRequest('healthy'));
        expect(healthy.status).toBe('success');
        expect(listings).toEqual([true]);
        expect(readAudit(auditPath)).toMatchObject([
          { requestId: 'healthy', serverName: 'proxy', result: { status: 'dispatching' } },
          { requestId: 'healthy', serverName: 'proxy', result: { status: 'success' } },
        ]);

        breakAuditPath(auditPath);
        const refused = await rejectionOf(coordinator.handleStructuredToolCall(listRequest('refused')));
        expect(isAuditLogUnavailableError(refused)).toBe(true);
        expect(listings).toEqual([true]);
      } finally {
        await coordinator.close();
      }
    });
  });

  describe('virtual proxy tools: approvals are scoped to host:port', () => {
    /** A coordinator with the proxy tools merged in, as the sandbox builds it. */
    function makeProxyCoordinator(
      auditSuffix: string,
      onEscalation: (request: ToolCallRequest) => Promise<{ decision: 'approved' | 'denied' }>,
      calls: Array<[string, string, number | undefined]>,
    ): ToolCallCoordinator {
      const controlApiClient: ControlApiClient = {
        addDomain: async (domain, port) => {
          calls.push(['add', domain, port]);
          return { added: true };
        },
        removeDomain: async (domain, port) => {
          calls.push(['remove', domain, port]);
          return { removed: true };
        },
        listDomains: async () => ({ providers: [], dynamic: [] }),
      };
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: { ...testCompiledPolicy, rules: [...proxyPolicyRules, ...testCompiledPolicy.rules] },
        toolAnnotations: {
          ...testToolAnnotations,
          servers: { ...testToolAnnotations.servers, proxy: { inputHash: 'hardcoded', tools: proxyAnnotations } },
        },
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: makeAuditPath(auditSuffix),
        onEscalation,
        controlApiClient,
      });
      coordinator.registerTools(
        'proxy',
        proxyToolDefinitions.map((tool) => ({
          serverName: 'proxy',
          name: tool.name,
          inputSchema: tool.inputSchema,
        })),
      );
      return coordinator;
    }

    it('shows the reviewer the port an add_proxy_domain approval grants, and grants exactly that', async () => {
      const escalated: ToolCallRequest[] = [];
      const calls: Array<[string, string, number | undefined]> = [];
      const coordinator = makeProxyCoordinator(
        'proxy-port-scope',
        async (request) => {
          escalated.push(request);
          return { decision: 'approved' };
        },
        calls,
      );
      try {
        const https = await coordinator.handleStructuredToolCall(
          makeRequest({
            serverName: 'proxy',
            toolName: 'add_proxy_domain',
            arguments: { domain: 'api.example.com', justification: 'docs' },
          }),
        );
        expect(https.status).toBe('success');
        const plain = await coordinator.handleStructuredToolCall(
          makeRequest({
            serverName: 'proxy',
            toolName: 'add_proxy_domain',
            arguments: { domain: 'API.example.com:80', justification: 'legacy mirror' },
          }),
        );
        expect(plain.status).toBe('success');
      } finally {
        await coordinator.close();
      }

      // The escalation names the exact host:port that will be opened.
      expect(escalated.map((request) => request.arguments.domain)).toEqual([
        'api.example.com:443',
        'api.example.com:80',
      ]);
      expect(calls).toEqual([
        ['add', 'api.example.com', 443],
        ['add', 'api.example.com', 80],
      ]);
    });

    it('never reaches the control API, or a reviewer, for a port the approval scheme does not allow', async () => {
      const calls: Array<[string, string, number | undefined]> = [];
      const escalated: ToolCallRequest[] = [];
      const coordinator = makeProxyCoordinator(
        'proxy-port-refused',
        async (request) => {
          escalated.push(request);
          return { decision: 'approved' };
        },
        calls,
      );
      try {
        const result = await coordinator.handleStructuredToolCall(
          makeRequest({
            serverName: 'proxy',
            toolName: 'add_proxy_domain',
            arguments: { domain: 'api.example.com:22', justification: 'ssh' },
          }),
        );
        // Refused before policy evaluation (validateProxyToolArguments), so
        // no human is ever asked to approve a scope that cannot be granted.
        expect(result.status).toBe('denied');
        expect(result.policyDecision).toMatchObject({ status: 'deny', rule: 'invalid-arguments' });
        expect(result.policyDecision.reason).toContain('Port 22 is not allowed for a passthrough domain');
      } finally {
        await coordinator.close();
      }
      expect(escalated).toEqual([]);
      expect(calls).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Per-call cancellation (WP-55, SES-6). The Code Mode chain runner aborts a
// call's signal when the script that made it ends. The coordinator must then
// withdraw the call's pending escalation, never act on an approval that
// arrives afterwards, and dispatch nothing.
// ---------------------------------------------------------------------------

describe('ToolCallCoordinator per-call cancellation', () => {
  const outsideWrite = (requestId = 'cancelled-write'): ToolCallRequest =>
    makeRequest({ requestId, toolName: 'write_file', arguments: { path: '/tmp/outside-sandbox/f.txt' } });

  /** A filesystem client that records every dispatched tool call. */
  function recordingClient(dispatched: string[]): Client {
    return {
      callTool: async (params: { name: string }) => {
        dispatched.push(params.name);
        return { content: [{ type: 'text', text: 'done' }], isError: false };
      },
      sendRootsListChanged: async () => undefined,
    } as unknown as Client;
  }

  function makeCancellableCoordinator(
    suffix: string,
    client: Client,
    extra: Partial<ConstructorParameters<typeof ToolCallCoordinator>[0]> = {},
  ): { coordinator: ToolCallCoordinator; auditPath: string } {
    const auditPath = makeAuditPath(suffix);
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: auditPath,
      escalationTimeoutMs: 30_000,
      ...extra,
    });
    registerFilesystemTools(coordinator, client);
    return { coordinator, auditPath };
  }

  it('withdraws a pending in-process escalation and ignores the approval that arrives afterwards', async () => {
    const escalation = makeHeldEscalation();
    const dispatched: string[] = [];
    const { coordinator, auditPath } = makeCancellableCoordinator('cancel-in-process', recordingClient(dispatched), {
      onEscalation: escalation.onEscalation,
    });
    const controller = new AbortController();
    try {
      const call = coordinator.handleStructuredToolCall(outsideWrite(), { signal: controller.signal });
      await escalation.entered;
      expect(coordinator.getPendingEscalationCount()).toBe(1);

      // The script timed out while the human was still deciding.
      controller.abort(new Error('the execute_code script timed out after 300ms before this tool call completed'));
      const result = await call;
      expect(result.status).toBe('denied');
      expect(result.policyDecision.reason).toContain('Escalation cancelled: the execute_code script timed out');
      expect(escalation.signal?.aborted).toBe(true);
      expect(escalation.signal?.reason).toMatchObject({ kind: 'cancelled' });
      expect(coordinator.getPendingEscalationCount()).toBe(0);

      // The approval lands later: nothing is dispatched.
      escalation.release('approved');
      await new Promise((r) => setTimeout(r, 50));
      expect(dispatched).toEqual([]);
      const entries = readAudit(auditPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ escalationResult: 'cancelled', result: { status: 'denied' } });
    } finally {
      await coordinator.close();
    }
  });

  it('removes the request file of a pending file-IPC escalation when the caller cancels', async () => {
    const escalationDir = join(TEST_ROOT, 'esc-call-cancel');
    mkdirSync(escalationDir, { recursive: true });
    const dispatched: string[] = [];
    const { coordinator, auditPath } = makeCancellableCoordinator('cancel-file-ipc', recordingClient(dispatched), {
      escalationDir,
    });
    const controller = new AbortController();
    try {
      const call = coordinator.handleStructuredToolCall(outsideWrite(), { signal: controller.signal });
      expect(await waitForFile(escalationDir, 'request-')).toBeDefined();
      controller.abort(new Error('the execute_code call was cancelled'));
      const result = await call;
      expect(result.status).toBe('denied');
      expect(result.policyDecision.reason).toContain('Escalation cancelled');
      // The session side sees the request vanish and reports it expired.
      expect(readdirSync(escalationDir).filter((f) => f.startsWith('request-'))).toEqual([]);
      expect(dispatched).toEqual([]);
      expect(readAudit(auditPath)[0]).toMatchObject({ escalationResult: 'cancelled' });
    } finally {
      await coordinator.close();
    }
  });

  it('records but does not act on an approval that lands as the caller cancels (call-cancelled)', async () => {
    const escalationDir = join(TEST_ROOT, 'esc-call-cancel-race');
    mkdirSync(escalationDir, { recursive: true });
    // A backend whose roots an approved read outside the sandbox would widen.
    const dispatched: string[] = [];
    let rootsUpdates = 0;
    const state: ClientState = { client: null as unknown as Client, roots: [] };
    const backend = rootsAwareClient(state, 'file content', (name) => dispatched.push(name));
    state.client = {
      callTool: backend.callTool,
      sendRootsListChanged: async () => {
        rootsUpdates++;
        await backend.sendRootsListChanged();
      },
    } as unknown as Client;
    const auditPath = makeAuditPath('cancel-race');
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: auditPath,
      escalationDir,
      escalationTimeoutMs: 30_000,
    });
    coordinator.registerTools(
      'filesystem',
      testToolAnnotations.servers.filesystem.tools.map((a) => ({
        serverName: a.serverName,
        name: a.toolName,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      })),
      state,
    );
    const controller = new AbortController();
    try {
      const call = coordinator.handleStructuredToolCall(
        makeRequest({ requestId: 'race', toolName: 'read_file', arguments: { path: '/etc/hostname' } }),
        { signal: controller.signal },
      );
      const requestFile = await waitForFile(escalationDir, 'request-');
      expect(requestFile).toBeDefined();
      const escalationId = String(requestFile)
        .replace(/^request-/, '')
        .replace(/\.json$/, '');
      // The human's approval and the script's end land together: the wait
      // reads the approval in its final check, then the call is refused
      // before any root is widened or anything is dispatched.
      writeFileSync(join(escalationDir, `response-${escalationId}.json`), JSON.stringify({ decision: 'approved' }));
      controller.abort(new Error('the execute_code script timed out after 300ms before this tool call completed'));

      const result = await call;
      expect(result.status).toBe('denied');
      expect(result.policyDecision.rule).toBe(RULE_CALL_CANCELLED);
      expect(result.policyDecision.reason).toContain('Tool call cancelled before it was dispatched');
      expect(rootsUpdates).toBe(0);
      expect(state.roots).toEqual([]);
      expect(dispatched).toEqual([]);
      const entries = readAudit(auditPath);
      expect(entries.some((entry) => isDispatchingAuditEntry(entry))).toBe(false);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        escalationResult: 'approved',
        policyDecision: { status: 'deny', rule: RULE_CALL_CANCELLED },
        result: { status: 'denied' },
      });
    } finally {
      await coordinator.close();
    }
  });

  it('never asks a human about a call whose caller has already cancelled it', async () => {
    let asked = 0;
    const dispatched: string[] = [];
    const { coordinator, auditPath } = makeCancellableCoordinator(
      'cancel-before-escalation',
      recordingClient(dispatched),
      {
        onEscalation: async () => {
          asked++;
          return { decision: 'approved' };
        },
      },
    );
    try {
      const result = await coordinator.handleStructuredToolCall(outsideWrite(), {
        signal: AbortSignal.abort(new Error('the execute_code script finished before this tool call completed')),
      });
      expect(result.status).toBe('denied');
      expect(result.policyDecision.rule).toBe(RULE_CALL_CANCELLED);
      expect(asked).toBe(0);
      expect(dispatched).toEqual([]);
      expect(readAudit(auditPath)).toHaveLength(1);
    } finally {
      await coordinator.close();
    }
  });

  it('does not dispatch an allowed call whose caller has already cancelled it', async () => {
    const dispatched: string[] = [];
    const { coordinator } = makeCancellableCoordinator('cancel-before-dispatch', recordingClient(dispatched));
    try {
      const result = await coordinator.handleStructuredToolCall(
        makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
        { signal: AbortSignal.abort() },
      );
      expect(result.status).toBe('denied');
      expect(result.policyDecision.rule).toBe(RULE_CALL_CANCELLED);
      expect(dispatched).toEqual([]);

      // Without a cancelled signal the same call runs.
      const ok = await coordinator.handleStructuredToolCall(
        makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
        { signal: new AbortController().signal },
      );
      expect(ok.status).toBe('success');
      expect(dispatched).toEqual(['list_allowed_directories']);
    } finally {
      await coordinator.close();
    }
  });

  it('cancels a backend call in flight when the caller cancels', async () => {
    let sawSignal: AbortSignal | undefined;
    const client = {
      callTool: (_params: unknown, _schema: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          sawSignal = options?.signal;
          options?.signal?.addEventListener('abort', () => {
            reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error('aborted'));
          });
        }),
      sendRootsListChanged: async () => undefined,
    } as unknown as Client;
    const { coordinator, auditPath } = makeCancellableCoordinator('cancel-in-flight', client);
    const controller = new AbortController();
    try {
      const call = coordinator.handleStructuredToolCall(
        makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
        { signal: controller.signal },
      );
      for (let i = 0; i < 100 && sawSignal === undefined; i++) await new Promise((r) => setTimeout(r, 5));
      expect(sawSignal).toBeDefined();
      const started = Date.now();
      controller.abort(new Error('the execute_code call was cancelled before this tool call completed'));
      const result = await call;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result.status).toBe('error');
      const outcomes = readOutcomes(auditPath);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ result: { status: 'error' } });
      expect(String((outcomes[0].result as { error?: string }).error)).toContain('cancelled');
    } finally {
      await coordinator.close();
    }
  });
});
