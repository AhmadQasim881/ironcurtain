/**
 * Regression tests for escalation-time roots expansion (GAP2-3).
 *
 * After an approved escalation the pipeline adds MCP roots so the backend
 * filesystem server accepts the call. The server re-resolves every root
 * URI on each refresh and installs the result as a persistent allowed
 * directory, so a root the agent can redirect is a permanent sandbox
 * escape. These tests drive `handleCallTool` with the real PolicyEngine
 * and path normalization and check that:
 *
 * - swapping an approved directory (or an in-sandbox directory of a mixed
 *   call) for a symlink during the approval wait denies the call and adds
 *   no root;
 * - a mixed escalation with a relative in-sandbox path adds no
 *   `<cwd>/<dir>` root, and roots under the workspace are never added;
 * - a backend that resolves a root to an unapproved directory loses its
 *   connection;
 * - read_multiple_files per-file roots-race failures are retried.
 *
 * The first suite uses a fake backend that mimics server-filesystem's roots
 * handling; the second runs the real `@modelcontextprotocol/server-filesystem`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { AuditLog } from '../src/trusted-process/audit-log.js';
import { isDispatchingAuditEntry } from '../src/types/audit.js';
import { CallCircuitBreaker } from '../src/trusted-process/call-circuit-breaker.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import { permissiveJsonSchemaValidator } from '../src/trusted-process/permissive-output-validator.js';
import { listBackendAllowedDirectories } from '../src/trusted-process/roots-expansion.js';
import { VERSION } from '../src/version.js';
import {
  CONFINED_ROOTS_VERIFY_TIMEOUT_MS,
  extractTextFromContent,
  handleCallTool,
  type CallToolDeps,
  type ClientState,
  type InProcessEscalationFn,
  type ProxiedTool,
} from '../src/trusted-process/tool-call-pipeline.js';
import { ROOTS_REFRESH_TIMEOUT_MS, type McpRoot } from '../src/trusted-process/mcp-client-manager.js';
import { RULE_ROOT_NOT_EXPOSABLE } from '../src/trusted-process/roots-confinement.js';
import type { ResolvedSandboxConfig } from '../src/trusted-process/sandbox-integration.js';
import type { CompiledPolicyFile } from '../src/pipeline/types.js';
import { withInputSchemas } from './fixtures/test-policy.js';

// ---------------------------------------------------------------------------
// Fixture: sandbox, an approvable outside area and a secret directory
// ---------------------------------------------------------------------------

let base: string;
let sandbox: string;
let outside: string;
let approvedDir: string;
let secret: string;
let auditPath: string;
let auditLog: AuditLog;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'roots-toctou-')));
  sandbox = join(base, 'sandbox');
  outside = join(base, 'outside');
  approvedDir = join(outside, 'approved');
  secret = join(base, 'secret');
  mkdirSync(join(sandbox, 'sub'), { recursive: true });
  mkdirSync(join(sandbox, 'cmp'));
  mkdirSync(approvedDir, { recursive: true });
  mkdirSync(secret);
  writeFileSync(join(sandbox, 'sub', 'a.txt'), 'in sandbox');
  writeFileSync(join(sandbox, 'cmp', 'id_rsa'), 'decoy key');
  writeFileSync(join(approvedDir, 'notes.txt'), 'approved notes');
  writeFileSync(join(outside, 'b.txt'), 'outside file');
  writeFileSync(join(outside, 'notes.txt'), 'outside notes');
  writeFileSync(join(secret, 'id_rsa'), 'TOP-SECRET-KEY');
  writeFileSync(join(secret, 'notes.txt'), 'secret notes');
  auditPath = join(base, 'audit.jsonl');
  auditLog = new AuditLog(auditPath);
});

afterEach(async () => {
  await auditLog.close();
  rmSync(base, { recursive: true, force: true });
});

/** Replaces `dir` with a symlink to `target`, as an agent with write access could. */
function swapForSymlink(dir: string, target: string): void {
  renameSync(dir, `${dir}.orig`);
  symlinkSync(target, dir);
}

/**
 * Swaps `dir` for a symlink to `target` as soon as the policy engine has
 * evaluated the next call, before the pipeline records the approved
 * paths: the window an agent's concurrently running shell can hit.
 */
function swapAfterEvaluation(deps: CallToolDeps, dir: string, target: string): void {
  const engine = deps.policyEngine;
  const evaluate = engine.evaluate.bind(engine);
  engine.evaluate = (request) => {
    const result = evaluate(request);
    swapForSymlink(dir, target);
    return result;
  };
}

function rootFor(path: string): McpRoot {
  return { uri: pathToFileURL(path).href, name: 'test-root' };
}

function rootPaths(state: ClientState): string[] {
  return state.roots.map((root) => fileURLToPath(root.uri));
}

/** Outcome records only: the write-ahead `dispatching` record before each dispatch is skipped. */
function readAudit(): Record<string, unknown>[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => !isDispatchingAuditEntry(entry));
}

const compiledPolicy: CompiledPolicyFile = {
  generatedAt: 'test-fixture',
  constitutionHash: 'test-fixture',
  inputHash: 'test-fixture',
  rules: [
    {
      name: 'escalate-read-outside-sandbox',
      description: 'Escalate filesystem reads outside the sandbox.',
      principle: 'Human oversight',
      if: { roles: ['read-path'], server: ['filesystem'] },
      then: 'escalate',
      reason: 'Reads outside the sandbox require approval.',
    },
    {
      name: 'escalate-write-outside-sandbox',
      description: 'Escalate filesystem writes outside the sandbox.',
      principle: 'Human oversight',
      if: { roles: ['write-path'], server: ['filesystem'] },
      then: 'escalate',
      reason: 'Writes outside the sandbox require approval.',
    },
    {
      // A server without structural sandbox containment: even in-sandbox
      // paths escalate, which is how a workspace path can reach roots
      // expansion at all.
      name: 'escalate-docs-reads',
      description: 'Escalate every docs read.',
      principle: 'Human oversight',
      if: { roles: ['read-path'], server: ['docs'] },
      then: 'escalate',
      reason: 'Docs reads require approval.',
    },
  ],
};

const toolAnnotations = withInputSchemas({
  generatedAt: 'test-fixture',
  servers: {
    filesystem: {
      inputHash: 'test-fixture',
      tools: [
        { toolName: 'read_file', serverName: 'filesystem', comment: 'Reads a file.', args: { path: ['read-path'] } },
        {
          toolName: 'read_multiple_files',
          serverName: 'filesystem',
          comment: 'Reads several files.',
          args: { paths: ['read-path'] },
        },
        {
          toolName: 'write_file',
          serverName: 'filesystem',
          comment: 'Writes a file.',
          args: { path: ['write-path'], content: ['none'] },
        },
        {
          toolName: 'list_allowed_directories',
          serverName: 'filesystem',
          comment: 'Lists the allowed directories.',
          args: {},
        },
      ],
    },
    docs: {
      inputHash: 'test-fixture',
      tools: [{ toolName: 'read_doc', serverName: 'docs', comment: 'Reads a doc.', args: { path: ['read-path'] } }],
    },
  },
});

function tool(serverName: string, name: string): ProxiedTool {
  return { serverName, name, inputSchema: { type: 'object' } };
}

/** Filesystem tools; `list_allowed_directories` makes the server's roots verifiable. */
function filesystemTools(verifiable = true): ProxiedTool[] {
  const names = ['read_file', 'read_multiple_files', 'write_file'];
  if (verifiable) names.push('list_allowed_directories');
  return names.map((name) => tool('filesystem', name));
}

/** The filesystem server's disposition when its relay confines it to its roots (WP-11). */
const CONFINED_FILESYSTEM: ResolvedSandboxConfig = {
  sandboxed: true,
  config: { allowWrite: [], allowRead: [], denyRead: [], denyWrite: [], network: false, confineToRoots: true },
};

function buildDeps(options: {
  readonly clientStates: Map<string, ClientState>;
  readonly onEscalation: InProcessEscalationFn;
  readonly tools: readonly ProxiedTool[];
  /** The filesystem server's disposition; default: opted out of the OS sandbox. */
  readonly filesystemSandbox?: ResolvedSandboxConfig;
}): CallToolDeps {
  return {
    toolMap: new Map(options.tools.map((t) => [t.name, t])),
    policyEngine: new PolicyEngine(compiledPolicy, toolAnnotations, [], sandbox),
    auditLog,
    circuitBreaker: new CallCircuitBreaker(),
    clientStates: options.clientStates,
    resolvedSandboxConfigs: new Map<string, ResolvedSandboxConfig>([
      ['filesystem', options.filesystemSandbox ?? { sandboxed: false, reason: 'opt-out' }],
      ['docs', { sandboxed: false, reason: 'opt-out' }],
    ]),
    allowedDirectory: sandbox,
    escalationDir: undefined,
    autoApproveModel: null,
    serverContextMap: new Map(),
    whitelist: createApprovalWhitelist(),
    onEscalation: options.onEscalation,
  };
}

const approve: InProcessEscalationFn = async () => ({ decision: 'approved' });

// ---------------------------------------------------------------------------
// Fake backend mimicking server-filesystem's roots handling
// ---------------------------------------------------------------------------

interface FakeBackend {
  readonly state: ClientState;
  /** Tool calls that reached the backend, excluding roots verification. */
  readonly toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  /** Queued results per tool name; the default is a plain success. */
  readonly results: Map<string, Array<Record<string, unknown>>>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly sendRootsListChanged: ReturnType<typeof vi.fn>;
  /** Runs when the backend fetches the new roots, before it resolves them. */
  onRefresh?: () => void;
}

/** realpath of every root that is an existing directory, as server-filesystem's parseRootUri does. */
function resolveRootsLikeServer(roots: readonly McpRoot[]): string[] {
  const directories: string[] = [];
  for (const root of roots) {
    try {
      const real = realpathSync(fileURLToPath(root.uri));
      if (statSync(real).isDirectory()) directories.push(real);
    } catch {
      // The server skips roots that do not resolve.
    }
  }
  return directories;
}

function makeFakeBackend(initialRoots: readonly string[]): FakeBackend {
  const state: ClientState = { client: null as unknown as Client, roots: initialRoots.map(rootFor) };
  let allowed = resolveRootsLikeServer(state.roots);
  const toolCalls: FakeBackend['toolCalls'] = [];
  const results: FakeBackend['results'] = new Map();
  const close = vi.fn(async () => undefined);
  const backend: FakeBackend = {
    state,
    toolCalls,
    results,
    close,
    sendRootsListChanged: vi.fn(async () => {
      // server-filesystem fetches roots/list (the acknowledgment), then
      // realpaths every root and replaces its allow-list with the result.
      backend.onRefresh?.();
      state.rootsRefreshed?.();
      state.rootsRefreshed = undefined;
      allowed = resolveRootsLikeServer(state.roots);
    }),
  };
  const callTool = vi.fn(async (params: { name: string; arguments?: Record<string, unknown> }) => {
    if (params.name === 'list_allowed_directories') {
      return { content: [{ type: 'text', text: `Allowed directories:\n${allowed.join('\n')}` }] };
    }
    toolCalls.push(params);
    return results.get(params.name)?.shift() ?? { content: [{ type: 'text', text: `ok ${params.name}` }] };
  });
  state.client = { callTool, sendRootsListChanged: backend.sendRootsListChanged, close } as unknown as Client;
  return backend;
}

describe('roots expansion after approval (fake backend)', () => {
  it('denies and adds no root when an approved directory is swapped for a symlink during the approval wait', async () => {
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: async () => {
        // While the human looks at outside/approved/notes.txt, the agent
        // points the approved directory at the secret directory.
        swapForSymlink(approvedDir, secret);
        return { decision: 'approved' };
      },
    });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result.isError).toBe(true);
    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'approved-path-changed' });
    expect(extractTextFromContent(result.content)).toContain(join(approvedDir, 'notes.txt'));
    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(backend.sendRootsListChanged).not.toHaveBeenCalled();
    expect(backend.toolCalls).toEqual([]);

    const [entry] = readAudit();
    expect(entry).toMatchObject({
      escalationResult: 'approved',
      policyDecision: { status: 'deny', rule: 'approved-path-changed' },
      result: { status: 'denied' },
    });
  });

  it('keeps no whitelist pattern from an approval whose paths changed during the wait', async () => {
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: async (_request, _reason, _context, candidates) => {
        // The exact file and, second, its directory.
        expect(candidates?.map((c) => c.scope)).toEqual(['exact', 'directory']);
        swapForSymlink(approvedDir, secret);
        return { decision: 'approved', whitelistSelection: 0 };
      },
    });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'approved-path-changed' });
    expect(deps.whitelist.size).toBe(0);
  });

  it('keeps the whitelist pattern the approver selected when the paths are unchanged', async () => {
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: async () => ({ decision: 'approved', whitelistSelection: 0 }),
    });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result._policyDecision?.status).toBe('allow');
    expect(deps.whitelist.size).toBe(1);
    expect(rootPaths(backend.state)).toEqual([sandbox, approvedDir]);
  });

  it('denies a mixed call when an in-sandbox directory is swapped during the approval wait', async () => {
    // The approver sees a workspace key path and an outside notes file; the
    // agent then redirects the workspace directory to the secret directory.
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: async () => {
        swapForSymlink(join(sandbox, 'cmp'), secret);
        return { decision: 'approved' };
      },
    });

    const result = await handleCallTool(
      'read_multiple_files',
      { paths: ['/workspace/cmp/id_rsa', join(outside, 'notes.txt')] },
      deps,
    );

    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'approved-path-changed' });
    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(backend.toolCalls).toEqual([]);
  });

  it('denies and adds no root when an in-sandbox directory is swapped right after policy evaluation', async () => {
    // The agent's shell flips the directory between the policy engine's
    // evaluation and the capture of the approved paths. The swapped-in
    // target must not become a root, even though it still resolves the
    // same way after the approval wait.
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: approve,
    });
    swapAfterEvaluation(deps, join(sandbox, 'cmp'), secret);

    const result = await handleCallTool(
      'read_multiple_files',
      { paths: ['/workspace/cmp/id_rsa', join(outside, 'notes.txt')] },
      deps,
    );

    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'approved-path-changed' });
    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(backend.sendRootsListChanged).not.toHaveBeenCalled();
    expect(backend.toolCalls).toEqual([]);
  });

  it('adds no <cwd>/<dir> root for a relative in-sandbox path in a mixed escalation', async () => {
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: approve,
    });

    const result = await handleCallTool('read_multiple_files', { paths: ['sub/a.txt', join(outside, 'b.txt')] }, deps);

    expect(result.isError).toBeUndefined();
    expect(result._policyDecision?.status).toBe('allow');
    // Only the escalated outside path gets a root; the relative in-sandbox
    // path yields neither <cwd>/sub nor <sandbox>/sub.
    expect(rootPaths(backend.state)).toEqual([sandbox, outside]);
    expect(rootPaths(backend.state)).not.toContain(resolve('sub'));
    expect(backend.toolCalls.map((call) => call.name)).toEqual(['read_multiple_files']);
  });

  it('adds the approved directory itself, not its parent, for a directory path', async () => {
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: approve,
    });

    await handleCallTool('read_multiple_files', { paths: [approvedDir] }, deps);

    expect(rootPaths(backend.state)).toEqual([sandbox, approvedDir]);
  });

  it('never adds a root under the workspace', async () => {
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['docs', backend.state]]),
      tools: [tool('docs', 'read_doc')],
      onEscalation: approve,
    });

    for (const path of [join(sandbox, 'sub', 'a.txt'), '/workspace/sub/a.txt', 'cmp/id_rsa', sandbox]) {
      const result = await handleCallTool('read_doc', { path }, deps);
      expect(result._policyDecision?.status).toBe('allow');
    }

    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(backend.sendRootsListChanged).not.toHaveBeenCalled();
    expect(backend.toolCalls).toHaveLength(4);
  });

  it('skips a path that an existing root already contains', async () => {
    const backend = makeFakeBackend([sandbox, outside]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: approve,
    });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result.isError).toBeUndefined();
    expect(rootPaths(backend.state)).toEqual([sandbox, outside]);
    expect(backend.sendRootsListChanged).not.toHaveBeenCalled();
  });

  it('drops the connection when the backend resolves a root to an unapproved directory', async () => {
    const backend = makeFakeBackend([sandbox]);
    // The agent wins the race between IronCurtain's last check and the
    // server's own realpath of the new root URI.
    backend.onRefresh = () => swapForSymlink(approvedDir, secret);
    const clientStates = new Map([['filesystem', backend.state]]);
    const deps = buildDeps({ clientStates, tools: filesystemTools(), onEscalation: approve });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result.isError).toBe(true);
    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'roots-verification-failed' });
    expect(extractTextFromContent(result.content)).toContain(secret);
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(clientStates.has('filesystem')).toBe(false);
    expect(backend.toolCalls).toEqual([]);

    // Every later call is refused instead of reaching the widened server.
    const next = await handleCallTool('read_file', { path: join(sandbox, 'sub', 'a.txt') }, deps);
    expect(next._policyDecision).toMatchObject({ status: 'deny', rule: 'no-client-connection' });
    expect(backend.toolCalls).toEqual([]);

    const entries = readAudit();
    expect(entries[0]).toMatchObject({
      escalationResult: 'approved',
      policyDecision: { status: 'deny', rule: 'roots-verification-failed' },
    });
  });

  it('drops the connection when the roots update cannot be sent', async () => {
    // The server's containment is unknown once the notification fails
    // (its relay may be gone or half-updated): fail closed.
    const backend = makeFakeBackend([sandbox]);
    backend.sendRootsListChanged.mockRejectedValueOnce(new Error('Not connected'));
    const clientStates = new Map([['filesystem', backend.state]]);
    const deps = buildDeps({ clientStates, tools: filesystemTools(), onEscalation: approve });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'roots-verification-failed' });
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(clientStates.has('filesystem')).toBe(false);
    expect(backend.toolCalls).toEqual([]);
  });

  it('retries read_multiple_files once when its per-file results hit the roots race', async () => {
    const backend = makeFakeBackend([sandbox]);
    const outsideFile = join(outside, 'b.txt');
    backend.results.set('read_multiple_files', [
      {
        content: [
          {
            type: 'text',
            text: `${outsideFile}: Error - Access denied - path outside allowed directories: ${outsideFile} not in ${sandbox}`,
          },
        ],
      },
      { content: [{ type: 'text', text: `${outsideFile}:\noutside file\n` }] },
    ]);
    // No list_allowed_directories: the refresh cannot be verified, so the
    // pipeline keeps the roots-race retry.
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(false),
      onEscalation: approve,
    });

    const result = await handleCallTool('read_multiple_files', { paths: [outsideFile] }, deps);

    expect(backend.toolCalls.map((call) => call.name)).toEqual(['read_multiple_files', 'read_multiple_files']);
    expect(extractTextFromContent(result.content)).toContain('outside file');
    const [raceEntry] = readAudit();
    expect(raceEntry).toMatchObject({ result: { status: 'error' } });
    expect((raceEntry.result as { error: string }).error).toContain('Roots race detected');
  });

  it('does not replay a call that may write when its successful result mentions an access denial', async () => {
    const backend = makeFakeBackend([sandbox]);
    const target = join(outside, 'new.txt');
    backend.results.set('write_file', [
      { content: [{ type: 'text', text: `x: Error - Access denied - path outside allowed directories: ${target}` }] },
    ]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(false),
      onEscalation: approve,
    });

    await handleCallTool('write_file', { path: target, content: 'data' }, deps);

    expect(rootPaths(backend.state)).toEqual([sandbox, outside]);
    expect(backend.toolCalls.map((call) => call.name)).toEqual(['write_file']);
  });
});

// ---------------------------------------------------------------------------
// A server confined to its roots by the OS sandbox (WP-11)
// ---------------------------------------------------------------------------

describe('roots expansion for a server confined to its roots', () => {
  /** The timeouts the roots verification's list_allowed_directories calls carried. */
  function verificationTimeouts(backend: FakeBackend): unknown[] {
    const callTool = vi.mocked(backend.state.client.callTool);
    return callTool.mock.calls
      .filter(([params]) => params.name === 'list_allowed_directories')
      .map(([, , options]) => options?.timeout);
  }

  it('gives the roots verification more time, because the relay restarts the confined server', async () => {
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: approve,
      filesystemSandbox: CONFINED_FILESYSTEM,
    });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result.isError).toBeUndefined();
    expect(rootPaths(backend.state)).toEqual([sandbox, approvedDir]);
    const timeouts = verificationTimeouts(backend);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(new Set(timeouts)).toEqual(new Set([CONFINED_ROOTS_VERIFY_TIMEOUT_MS]));
  });

  it('keeps the ordinary verification timeout for a server that is not confined', async () => {
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: approve,
    });

    await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(new Set(verificationTimeouts(backend))).toEqual(new Set([ROOTS_REFRESH_TIMEOUT_MS]));
  });

  // srt reads allow entries as patterns, so a root spelled with glob
  // characters would expose matching siblings instead of the directory.
  it('refuses an approved root spelled with glob characters and adds no root', async () => {
    const album = join(outside, 'Album [Live]');
    mkdirSync(album);
    writeFileSync(join(album, 'track.txt'), 'track');
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: approve,
      filesystemSandbox: CONFINED_FILESYSTEM,
    });

    const result = await handleCallTool('read_file', { path: join(album, 'track.txt') }, deps);

    expect(result.isError).toBe(true);
    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: RULE_ROOT_NOT_EXPOSABLE });
    expect(extractTextFromContent(result.content)).toContain('pattern');
    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(backend.sendRootsListChanged).not.toHaveBeenCalled();
    expect(backend.toolCalls).toEqual([]);
  });

  describe('when the approved directory contains the home directory', () => {
    const savedHome = process.env.HOME;

    beforeEach(() => {
      // `outside` (the root a read of outside/b.txt needs) now contains the
      // home directory, which the confinement hides.
      process.env.HOME = join(outside, 'home');
      mkdirSync(process.env.HOME);
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    });

    it('refuses the approved call and adds no root the confined server could not be given', async () => {
      const backend = makeFakeBackend([sandbox]);
      const deps = buildDeps({
        clientStates: new Map([['filesystem', backend.state]]),
        tools: filesystemTools(),
        onEscalation: approve,
        filesystemSandbox: CONFINED_FILESYSTEM,
      });

      const result = await handleCallTool('read_file', { path: join(outside, 'b.txt') }, deps);

      expect(result.isError).toBe(true);
      expect(result._policyDecision).toMatchObject({ status: 'deny', rule: RULE_ROOT_NOT_EXPOSABLE });
      expect(extractTextFromContent(result.content)).toContain('confined to its roots');
      expect(extractTextFromContent(result.content)).toContain(outside);
      expect(rootPaths(backend.state)).toEqual([sandbox]);
      expect(backend.sendRootsListChanged).not.toHaveBeenCalled();
      expect(backend.toolCalls).toEqual([]);
      expect(readAudit()[0]).toMatchObject({
        escalationResult: 'approved',
        policyDecision: { status: 'deny', rule: RULE_ROOT_NOT_EXPOSABLE },
      });
    });

    it('still adds that root for a server that is not confined (control)', async () => {
      const backend = makeFakeBackend([sandbox]);
      const deps = buildDeps({
        clientStates: new Map([['filesystem', backend.state]]),
        tools: filesystemTools(),
        onEscalation: approve,
      });

      const result = await handleCallTool('read_file', { path: join(outside, 'b.txt') }, deps);

      expect(result.isError).toBeUndefined();
      expect(rootPaths(backend.state)).toEqual([sandbox, outside]);
    });
  });
});

// ---------------------------------------------------------------------------
// Paths that can no longer be canonicalized during roots expansion
// ---------------------------------------------------------------------------

describe('roots expansion when a path can no longer be canonicalized', () => {
  // resolveRealPath throws a PathResolutionError when not even the
  // filesystem root resolves. Before evaluation the pipeline turns that
  // into an audited structural-unresolvable-path deny; the canonicalizations
  // of roots expansion (T0 capture, T1 re-check and the directories that
  // bound root selection) must deny the same way instead of rejecting the
  // call unaudited.
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    vi.restoreAllMocks();
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  });

  /**
   * From now on resolveRealPath fails closed: simulates macOS, whose native
   * realpath then fails for every path, the filesystem root included,
   * except the already canonical `resolvable` ones.
   */
  function makePathsUnresolvable(resolvable: readonly string[] = []): void {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(realpathSync, 'native').mockImplementation((p) => {
      const path = String(p);
      if (resolvable.includes(path)) return path;
      throw Object.assign(new Error(`EIO: i/o error, realpath '${path}'`), { code: 'EIO' });
    });
  }

  it('denies and audits, without asking for approval, when the paths stop resolving right after evaluation', async () => {
    const backend = makeFakeBackend([sandbox]);
    const onEscalation = vi.fn(approve);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation,
    });
    const engine = deps.policyEngine;
    const evaluate = engine.evaluate.bind(engine);
    engine.evaluate = (request) => {
      const result = evaluate(request);
      makePathsUnresolvable();
      return result;
    };

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result.isError).toBe(true);
    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-unresolvable-path' });
    expect(onEscalation).not.toHaveBeenCalled();
    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(backend.toolCalls).toEqual([]);

    const [entry] = readAudit();
    expect(entry).toMatchObject({
      policyDecision: { status: 'deny', rule: 'structural-unresolvable-path' },
      result: { status: 'denied' },
    });
    expect(entry.escalationResult).toBeUndefined();
  });

  it('denies and audits, adding no root or whitelist pattern, when an approved path stops resolving during the wait', async () => {
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: async () => {
        makePathsUnresolvable();
        return { decision: 'approved', whitelistSelection: 0 };
      },
    });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result.isError).toBe(true);
    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-unresolvable-path' });
    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(backend.sendRootsListChanged).not.toHaveBeenCalled();
    expect(backend.toolCalls).toEqual([]);
    expect(deps.whitelist.size).toBe(0);

    const [entry] = readAudit();
    expect(entry).toMatchObject({
      escalationResult: 'approved',
      policyDecision: { status: 'deny', rule: 'structural-unresolvable-path' },
      result: { status: 'denied' },
    });
  });

  it('denies and audits, adding no root, when the directories that bound root selection stop resolving', async () => {
    const notes = join(approvedDir, 'notes.txt');
    const backend = makeFakeBackend([sandbox]);
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: async () => {
        // The approved path still resolves (the T1 re-check passes), but the
        // sandbox and IronCurtain home that roots must stay out of do not.
        makePathsUnresolvable([notes]);
        return { decision: 'approved' };
      },
    });

    const result = await handleCallTool('read_file', { path: notes }, deps);

    expect(result.isError).toBe(true);
    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-unresolvable-path' });
    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(backend.sendRootsListChanged).not.toHaveBeenCalled();
    expect(backend.toolCalls).toEqual([]);

    const [entry] = readAudit();
    expect(entry).toMatchObject({
      escalationResult: 'approved',
      policyDecision: { status: 'deny', rule: 'structural-unresolvable-path' },
      result: { status: 'denied' },
    });
  });
});

// ---------------------------------------------------------------------------
// End to end with the real @modelcontextprotocol/server-filesystem
// ---------------------------------------------------------------------------

interface RealBackend {
  readonly client: Client;
  readonly state: ClientState;
  /** Runs inside the next roots/list request, before the server receives the list. */
  beforeListRoots?: () => void;
}

async function waitForBackendRoots(client: Client, expected: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const listed = await listBackendAllowedDirectories(client);
    if (listed.length === expected.length && expected.every((dir) => listed.includes(dir))) return;
    if (Date.now() > deadline)
      throw new Error(`backend roots ${listed.join(', ')} never became ${expected.join(', ')}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function connectRealBackend(): Promise<RealBackend> {
  const client = new Client(
    { name: 'ironcurtain-test', version: VERSION },
    { capabilities: { roots: { listChanged: true } }, jsonSchemaValidator: permissiveJsonSchemaValidator },
  );
  const backend: RealBackend = { client, state: { client, roots: [rootFor(sandbox)] } };
  // Mirrors MCPClientManager's roots/list handler.
  client.setRequestHandler(ListRootsRequestSchema, () => {
    const hook = backend.beforeListRoots;
    backend.beforeListRoots = undefined;
    hook?.();
    if (backend.state.rootsRefreshed) {
      backend.state.rootsRefreshed();
      backend.state.rootsRefreshed = undefined;
    }
    return { roots: backend.state.roots };
  });
  await client.connect(
    new StdioClientTransport({ command: 'mcp-server-filesystem', args: [sandbox], stderr: 'ignore' }),
  );
  await waitForBackendRoots(client, [sandbox]);
  return backend;
}

describe('roots expansion after approval (real server-filesystem)', () => {
  let backend: RealBackend | undefined;

  afterEach(async () => {
    await backend?.client.close().catch(() => undefined);
    backend = undefined;
  });

  it('keeps the swapped target out of the server roots when the swap happens during the wait', async () => {
    backend = await connectRealBackend();
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: async () => {
        swapForSymlink(approvedDir, secret);
        return { decision: 'approved' };
      },
    });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'approved-path-changed' });
    expect(JSON.stringify(result.content)).not.toContain('secret notes');
    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(await listBackendAllowedDirectories(backend.client)).toEqual([sandbox]);
  }, 30_000);

  it('keeps the swapped target out of the server roots when the swap happens right after evaluation', async () => {
    backend = await connectRealBackend();
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: approve,
    });
    swapAfterEvaluation(deps, join(sandbox, 'cmp'), secret);

    const result = await handleCallTool(
      'read_multiple_files',
      { paths: ['/workspace/cmp/id_rsa', join(outside, 'notes.txt')] },
      deps,
    );

    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'approved-path-changed' });
    expect(JSON.stringify(result.content)).not.toContain('TOP-SECRET-KEY');
    expect(rootPaths(backend.state)).toEqual([sandbox]);
    expect(await listBackendAllowedDirectories(backend.client)).toEqual([sandbox]);
  }, 30_000);

  it('serves a mixed escalation with only the approved outside root', async () => {
    backend = await connectRealBackend();
    const deps = buildDeps({
      clientStates: new Map([['filesystem', backend.state]]),
      tools: filesystemTools(),
      onEscalation: approve,
    });

    const result = await handleCallTool('read_multiple_files', { paths: ['sub/a.txt', join(outside, 'b.txt')] }, deps);

    expect(result._policyDecision?.status).toBe('allow');
    expect(extractTextFromContent(result.content)).toContain('outside file');
    expect(rootPaths(backend.state)).toEqual([sandbox, outside]);
    const listed = await listBackendAllowedDirectories(backend.client);
    expect(listed.sort()).toEqual([outside, sandbox].sort());
    expect(listed).not.toContain(resolve('sub'));
  }, 30_000);

  it('drops the connection when the server installs a root other than the approved one', async () => {
    backend = await connectRealBackend();
    // Swap right before the server receives the new root list, i.e. after
    // every IronCurtain-side check: the server's realpath of the root URI
    // lands on the secret directory.
    backend.beforeListRoots = () => swapForSymlink(approvedDir, secret);
    const clientStates = new Map([['filesystem', backend.state]]);
    const deps = buildDeps({ clientStates, tools: filesystemTools(), onEscalation: approve });

    const result = await handleCallTool('read_file', { path: join(approvedDir, 'notes.txt') }, deps);

    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: 'roots-verification-failed' });
    expect(extractTextFromContent(result.content)).toContain(secret);
    expect(JSON.stringify(result.content)).not.toContain('secret notes');
    expect(clientStates.has('filesystem')).toBe(false);
    // The connection is closed: the widened server is unreachable.
    await expect(listBackendAllowedDirectories(backend.client)).rejects.toThrow();
  }, 30_000);
});
