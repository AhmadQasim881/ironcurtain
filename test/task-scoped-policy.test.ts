/**
 * Task-scoped policies (`--task-scoped`, WP-119).
 *
 * A task scope is a policy compiled from the session's task text that the
 * engine intersects with the session policy: both must allow a call, a call
 * outside the task scope escalates instead of being denied, and otherwise
 * the most restrictive decision wins.
 *
 * Covered here:
 *  - intersection semantics in the PolicyEngine (acceptance: a call the
 *    base policy allows but the task scope does not escalates); task rule
 *    directories pinned when the engine is built, and `@list` references
 *    expanded only against the scope's own lists;
 *  - the coordinator: the escalation reaches the human, the scope survives
 *    a policy hot-swap, the virtual proxy tools and the configured egress
 *    hosts keep their decisions;
 *  - task-scope directories: validation, fail-closed loading;
 *  - the lighter compile and its cache (acceptance: a cached task policy is
 *    reused on rerun), driven by the scripted fake LLM (no network), still
 *    held to the policy lint;
 *  - session plumbing (config, metadata, resume) and the mux / PTY argv.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PolicyEngine, TASK_SCOPE_ESCALATE_RULE } from '../src/trusted-process/policy-engine.js';
import type { TaskScopePolicy } from '../src/trusted-process/policy-types.js';
import {
  MEMORY_BULK_FORGET_RULE,
  TRUSTED_SERVER_RULE,
  TRUSTED_SERVER_UNKNOWN_TOOL_RULE,
} from '../src/trusted-process/trusted-server-policy.js';
import { MEMORY_SERVER_NAME } from '../src/memory/memory-server-name.js';
import { ToolCallCoordinator, type EscalationPromptFn } from '../src/trusted-process/tool-call-coordinator.js';
import { EGRESS_ALLOWED_HOSTS_RULE, EGRESS_ESCALATE_RULE } from '../src/trusted-process/egress-policy.js';
import type { ClientState, ProxiedTool } from '../src/trusted-process/tool-call-pipeline.js';
import { loadTaskScopePolicy } from '../src/trusted-process/task-scope.js';
import { checkTaskScopeDir, TASK_SCOPE_RECORD_FILENAME } from '../src/config/task-scope-policy.js';
import { getTaskPoliciesDir } from '../src/config/paths.js';
import { POLICY_COMPILER_EPOCH } from '../src/policy-artifacts/provenance.js';
import { proxyAnnotations, proxyPolicyRules } from '../src/docker/proxy-tools.js';
import { isDispatchingAuditEntry } from '../src/types/audit.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { CompiledPolicyFile, CompiledRule, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import {
  compileTaskScopePolicy,
  computeTaskScopeKey,
  formatTaskScopeSummary,
} from '../src/cron/compile-task-policy.js';
import { buildSpawnArgs } from '../src/pty/pty-bridge.js';
import { parseNewCommandArgs } from '../src/mux/new-command-args.js';
import {
  REAL_TMP,
  TEST_DOMAIN_ALLOWLISTS,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
  testCompiledPolicy,
  testToolAnnotations,
} from './fixtures/test-policy.js';
import { scopeRule, taskScopePolicy, writeTaskScopeDir } from './fixtures/task-scope.js';
import {
  createScriptedPipelineModels,
  createThrowingPipelineModels,
  type FakeLlmCall,
  type FakePhaseScript,
} from './fixtures/fake-pipeline-models.js';
import { FS_AND_NEWS, NEWS, rule } from './fixtures/two-server-pipeline-fixture.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PERMITTED_A = `${REAL_TMP}/permitted-a`;
const PERMITTED_B = `${REAL_TMP}/permitted-b`;
const PERMITTED_C = `${REAL_TMP}/permitted-c`;
const PERMITTED_D = `${REAL_TMP}/permitted-d`;

const TASK = 'Summarize the reports in permitted-a and look up the docs site.';

/** The task scope used by the engine and coordinator tests. */
const SCOPE_RULES: CompiledRule[] = [
  scopeRule('scope-read-a', 'filesystem', { paths: { roles: ['read-path'], within: PERMITTED_A } }),
  scopeRule(
    'scope-escalate-write-a',
    'filesystem',
    { paths: { roles: ['write-path'], within: PERMITTED_A } },
    'escalate',
  ),
  scopeRule('scope-write-c', 'filesystem', { paths: { roles: ['write-path'], within: PERMITTED_C } }),
  scopeRule('scope-fetch-docs', 'fetch', {
    tool: ['http_fetch'],
    domains: { roles: ['fetch-url'], allowed: ['docs.example.com'] },
  }),
];

const SCOPE: TaskScopePolicy = { compiledPolicy: taskScopePolicy(TASK, SCOPE_RULES) };

function request(serverName: string, toolName: string, args: Record<string, unknown>): ToolCallRequest {
  return { requestId: uuidv4(), serverName, toolName, arguments: args, timestamp: new Date().toISOString() };
}

function engine(scope?: TaskScopePolicy, policy: CompiledPolicyFile = testCompiledPolicy): PolicyEngine {
  return new PolicyEngine(
    policy,
    testToolAnnotations,
    TEST_PROTECTED_PATHS,
    TEST_SANDBOX_DIR,
    TEST_DOMAIN_ALLOWLISTS,
    undefined,
    undefined,
    scope,
  );
}

const readFile = (path: string) => request('filesystem', 'read_file', { path });
const writeFile = (path: string) => request('filesystem', 'write_file', { path, content: 'x' });
const fetchUrl = (url: string) => request('fetch', 'http_fetch', { url });

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.IRONCURTAIN_HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ic-task-scope-')));
  process.env.IRONCURTAIN_HOME = home;
  mkdirSync(TEST_SANDBOX_DIR, { recursive: true });
});

afterEach(async () => {
  const logger = await import('../src/logger.js');
  logger.teardown();
  if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PolicyEngine: intersection semantics
// ---------------------------------------------------------------------------

describe('PolicyEngine task scope (intersection with the session policy)', () => {
  it('escalates a call the base policy allows but the task scope does not cover', () => {
    const call = readFile(`${PERMITTED_B}/report.txt`);
    // Control: the session policy alone allows it.
    expect(engine().evaluate(call)).toMatchObject({ decision: 'allow', rule: 'allow-reads-within-dir-b' });

    const result = engine(SCOPE).evaluate(call);
    expect(result).toMatchObject({
      decision: 'escalate',
      rule: TASK_SCOPE_ESCALATE_RULE,
      escalatedRoles: ['read-path'],
    });
    expect(result.reason).toMatch(/^Outside the task scope/);
    expect(result.humanOnly).toBeUndefined();
  });

  it('escalates a fetch the base policy allows to a destination outside the task scope', () => {
    expect(engine().evaluate(fetchUrl('https://evil.example.com/x?d=1'))).toMatchObject({ decision: 'allow' });
    expect(engine(SCOPE).evaluate(fetchUrl('https://evil.example.com/x?d=1'))).toMatchObject({
      decision: 'escalate',
      rule: TASK_SCOPE_ESCALATE_RULE,
      escalatedRoles: ['fetch-url'],
    });
    // In scope: the session policy's decision stands.
    expect(engine(SCOPE).evaluate(fetchUrl('https://docs.example.com/guide'))).toMatchObject({
      decision: 'allow',
      rule: 'allow-fetch-get',
    });
  });

  it('allows a call both policies allow, naming the session policy rule', () => {
    expect(engine(SCOPE).evaluate(readFile(`${PERMITTED_A}/report.txt`))).toMatchObject({
      decision: 'allow',
      rule: 'allow-reads-within-dir-a',
    });
  });

  it('never lets the task scope allow what the session policy escalates', () => {
    // The scope allows writes in permitted-c; the session policy escalates them.
    const result = engine(SCOPE).evaluate(writeFile(`${PERMITTED_C}/out.txt`));
    const base = engine().evaluate(writeFile(`${PERMITTED_C}/out.txt`));
    expect(base).toMatchObject({ decision: 'escalate', rule: 'escalate-write-outside-permitted-areas' });
    expect(result).toEqual(base);
  });

  it('keeps one escalation, noting the task scope, when both policies escalate', () => {
    const outOfScope = engine(SCOPE).evaluate(writeFile(`${PERMITTED_D}/out.txt`));
    expect(outOfScope).toMatchObject({
      decision: 'escalate',
      rule: 'escalate-write-outside-permitted-areas',
      escalatedRoles: ['write-path'],
    });
    expect(outOfScope.reason).toBe('Writes outside sandbox require human approval. (also outside the task scope)');

    const scopedEscalation = engine(SCOPE).evaluate(writeFile(`${PERMITTED_A}/out.txt`));
    expect(scopedEscalation).toMatchObject({ decision: 'escalate', rule: 'escalate-write-outside-permitted-areas' });
    expect(scopedEscalation.reason).toContain('the task scope also escalates it: scope-escalate-write-a reason');
  });

  it('names every role either policy escalated (an approval pattern must cover all of them)', () => {
    // edit_file in permitted-c: the session policy escalates read and write;
    // the scope allows the write but not the read.
    const result = engine(SCOPE).evaluate(request('filesystem', 'edit_file', { path: `${PERMITTED_C}/f`, edits: [] }));
    expect(result.decision).toBe('escalate');
    expect([...(result.escalatedRoles ?? [])].sort()).toEqual(['read-path', 'write-path']);
  });

  it('leaves session-policy and structural denials final', () => {
    // move_file deletes its source: the session policy denies deletes outside the sandbox.
    const move = request('filesystem', 'move_file', {
      source: `${PERMITTED_A}/f`,
      destination: `${TEST_SANDBOX_DIR}/f`,
    });
    expect(engine(SCOPE).evaluate(move)).toMatchObject({
      decision: 'deny',
      rule: 'deny-delete-outside-permitted-areas',
    });
    expect(engine(SCOPE).evaluate(readFile(TEST_PROTECTED_PATHS[0]))).toMatchObject({
      decision: 'deny',
      rule: 'structural-protected-path',
    });
    expect(engine(SCOPE).evaluate(request('filesystem', 'no_such_tool', {}))).toMatchObject({
      decision: 'deny',
      rule: 'structural-unknown-tool',
    });
  });

  it('leaves the trusted memory server to its own per-tool policy', () => {
    // Neither compiled policy covers the memory server: the task scope neither
    // puts everyday memory use out of scope nor weakens the trusted-server
    // policy (a bulk wipe stays a human-only escalation, an unknown tool a deny).
    const scoped = new PolicyEngine(
      testCompiledPolicy,
      testToolAnnotations,
      TEST_PROTECTED_PATHS,
      TEST_SANDBOX_DIR,
      TEST_DOMAIN_ALLOWLISTS,
      undefined,
      new Set([MEMORY_SERVER_NAME]),
      SCOPE,
    );
    const memory = (toolName: string, args: Record<string, unknown>) => request(MEMORY_SERVER_NAME, toolName, args);

    expect(scoped.evaluate(memory('memory_store', { content: 'The user likes tea' }))).toMatchObject({
      decision: 'allow',
      rule: TRUSTED_SERVER_RULE,
    });
    expect(scoped.evaluate(memory('memory_forget', { before: '2100-01-01T00:00:00Z', confirm: true }))).toMatchObject({
      decision: 'escalate',
      rule: MEMORY_BULK_FORGET_RULE,
      humanOnly: true,
    });
    expect(scoped.evaluate(memory('memory_purge_everything', {}))).toMatchObject({
      decision: 'deny',
      rule: TRUSTED_SERVER_UNKNOWN_TOOL_RULE,
    });
  });

  it('keeps the session directory in scope', () => {
    expect(engine(SCOPE).evaluate(readFile(`${TEST_SANDBOX_DIR}/notes.txt`))).toMatchObject({ decision: 'allow' });
    expect(engine(SCOPE).evaluate(writeFile(`${TEST_SANDBOX_DIR}/notes.txt`))).toMatchObject({ decision: 'allow' });
  });

  it('honours an explicit deny rule in the task scope (most restrictive wins)', () => {
    const scope: TaskScopePolicy = {
      compiledPolicy: taskScopePolicy(TASK, [
        scopeRule('scope-never-fetch', 'fetch', { tool: ['http_fetch'] }, 'deny'),
      ]),
    };
    expect(engine(scope).evaluate(fetchUrl('https://docs.example.com/'))).toMatchObject({
      decision: 'deny',
      rule: 'scope-never-fetch',
    });
  });

  it('escalates an out-of-scope tool without resource roles with its roles unknown', () => {
    const policy: CompiledPolicyFile = {
      ...testCompiledPolicy,
      rules: [...proxyPolicyRules, ...testCompiledPolicy.rules],
    };
    const annotations: StoredToolAnnotationsFile = {
      ...testToolAnnotations,
      servers: { ...testToolAnnotations.servers, proxy: { inputHash: 'hardcoded', tools: proxyAnnotations } },
    };
    const scoped = new PolicyEngine(policy, annotations, [], TEST_SANDBOX_DIR, undefined, undefined, undefined, SCOPE);
    const result = scoped.evaluate(request('proxy', 'list_proxy_domains', {}));
    expect(result).toMatchObject({ decision: 'escalate', rule: TASK_SCOPE_ESCALATE_RULE, escalatedRoles: [] });
  });

  it("pins a task rule's directory when the engine is built: re-pointing a symlink there does not move the scope", () => {
    // Like the session policy's `paths.within` (canonicalized once, when the
    // engine is built), so a link the agent swaps later cannot redirect it.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-task-scope-pin-')));
    try {
      const first = join(root, 'first');
      const second = join(root, 'second');
      mkdirSync(first);
      mkdirSync(second);
      const docs = join(root, 'docs');
      symlinkSync(first, docs);
      const readsAnywhere: CompiledPolicyFile = {
        ...testCompiledPolicy,
        rules: [scopeRule('session-reads-anywhere', 'filesystem', { roles: ['read-path'] })],
      };
      const scope: TaskScopePolicy = {
        compiledPolicy: taskScopePolicy(TASK, [
          scopeRule('scope-read-docs', 'filesystem', { paths: { roles: ['read-path'], within: docs } }),
        ]),
      };
      const scoped = engine(scope, readsAnywhere);

      rmSync(docs);
      symlinkSync(second, docs);
      expect(scoped.evaluate(readFile(join(first, 'a.txt')))).toMatchObject({
        decision: 'allow',
        rule: 'session-reads-anywhere',
      });
      expect(scoped.evaluate(readFile(join(second, 'b.txt')))).toMatchObject({
        decision: 'escalate',
        rule: TASK_SCOPE_ESCALATE_RULE,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("expands a task rule's @list against the scope's own lists: without a lists file it allows nothing", () => {
    const sendAllowed: CompiledPolicyFile = {
      ...testCompiledPolicy,
      rules: [scopeRule('session-allows-send', 'google-workspace', { tool: ['gmail_send_message'] })],
    };
    const contactsRule = scopeRule('scope-mail-contacts', 'google-workspace', {
      tool: ['gmail_send_message'],
      lists: [{ roles: ['email-address'], allowed: ['@my-contacts'], matchType: 'emails' }],
    });
    const send = (to: string) => request('google-workspace', 'gmail_send_message', { to, subject: 's', body: 'b' });
    const unresolved: TaskScopePolicy = { compiledPolicy: taskScopePolicy(TASK, [contactsRule]) };
    // An argument spelled like the list reference never matches it.
    for (const to of ['@my-contacts', 'alice@corp.example']) {
      expect(engine(unresolved, sendAllowed).evaluate(send(to)), to).toMatchObject({
        decision: 'escalate',
        rule: TASK_SCOPE_ESCALATE_RULE,
      });
    }

    const resolved: TaskScopePolicy = {
      ...unresolved,
      dynamicLists: {
        generatedAt: '',
        lists: {
          'my-contacts': {
            values: ['alice@corp.example'],
            manualAdditions: [],
            manualRemovals: [],
            resolvedAt: '',
            inputHash: '',
          },
        },
      },
    };
    expect(engine(resolved, sendAllowed).evaluate(send('alice@corp.example'))).toMatchObject({
      decision: 'allow',
      rule: 'session-allows-send',
    });
    expect(engine(resolved, sendAllowed).evaluate(send('@my-contacts'))).toMatchObject({
      decision: 'escalate',
      rule: TASK_SCOPE_ESCALATE_RULE,
    });
  });

  it('does not change evaluation without a task scope', () => {
    expect(engine().hasTaskScope()).toBe(false);
    expect(engine(SCOPE).hasTaskScope()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolCallCoordinator
// ---------------------------------------------------------------------------

/** A backend that answers roots verification like server-filesystem and reports every other call. */
function rootsAwareClient(state: ClientState, onToolCall: (name: string) => void): Client {
  return {
    callTool: async (params: { name: string }) => {
      if (params.name === 'list_allowed_directories') {
        const directories = state.roots.map((root) => fileURLToPath(root.uri));
        return { content: [{ type: 'text', text: `Allowed directories:\n${directories.join('\n')}` }], isError: false };
      }
      onToolCall(params.name);
      return { content: [{ type: 'text', text: 'file content' }], isError: false };
    },
    sendRootsListChanged: async () => {
      state.rootsRefreshed?.();
      state.rootsRefreshed = undefined;
    },
  } as unknown as Client;
}

function registerFilesystem(coordinator: ToolCallCoordinator, onToolCall: (name: string) => void): void {
  const tools: ProxiedTool[] = testToolAnnotations.servers.filesystem.tools.map((a) => ({
    serverName: a.serverName,
    name: a.toolName,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  }));
  const state: ClientState = { client: undefined as unknown as Client, roots: [] };
  state.client = rootsAwareClient(state, onToolCall);
  coordinator.registerTools('filesystem', tools, state);
}

function readOutcomes(auditPath: string): Record<string, unknown>[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => !isDispatchingAuditEntry(entry));
}

describe('ToolCallCoordinator with a task scope', () => {
  function makeCoordinator(onEscalation: EscalationPromptFn, { scoped = true }: { scoped?: boolean } = {}) {
    const scope = scoped ? SCOPE : undefined;
    const auditPath = resolve(home, `audit-${uuidv4()}.jsonl`);
    const dispatched: string[] = [];
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      ...(scope ? { taskScope: scope } : {}),
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: auditPath,
      onEscalation,
    });
    registerFilesystem(coordinator, (name) => dispatched.push(name));
    return { coordinator, auditPath, dispatched };
  }

  it('sends an out-of-scope call the base policy allows to the human; a denial blocks it', async () => {
    const reasons: string[] = [];
    const { coordinator, auditPath, dispatched } = makeCoordinator(async (_req, reason) => {
      reasons.push(reason);
      return { decision: 'denied' };
    });
    try {
      const result = await coordinator.handleStructuredToolCall(readFile(`${PERMITTED_B}/report.txt`));
      expect(result.status).toBe('denied');
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toMatch(/^Outside the task scope/);
      expect(dispatched).toEqual([]);
      const [outcome] = readOutcomes(auditPath);
      expect(outcome).toMatchObject({
        policyDecision: { status: 'deny', rule: TASK_SCOPE_ESCALATE_RULE },
        escalationResult: 'denied',
      });
    } finally {
      await coordinator.close();
    }
  });

  it('runs an out-of-scope call once the human approves it', async () => {
    const { coordinator, dispatched } = makeCoordinator(async () => ({ decision: 'approved' }));
    try {
      const result = await coordinator.handleStructuredToolCall(readFile(`${PERMITTED_B}/report.txt`));
      expect(result.status).toBe('success');
      expect(dispatched).toEqual(['read_file']);
    } finally {
      await coordinator.close();
    }
  });

  it('runs an in-scope call the base policy allows without asking anyone', async () => {
    let asked = 0;
    const { coordinator, dispatched } = makeCoordinator(async () => {
      asked++;
      return { decision: 'denied' };
    });
    try {
      const result = await coordinator.handleStructuredToolCall(readFile(`${PERMITTED_A}/report.txt`));
      expect(result.status).toBe('success');
      expect(asked).toBe(0);
      expect(dispatched).toEqual(['read_file']);
    } finally {
      await coordinator.close();
    }
  });

  it('keeps the task scope across a policy hot-swap (workflow personas)', async () => {
    const personaDir = resolve(home, 'personas', 'reader', 'generated');
    mkdirSync(personaDir, { recursive: true });
    const permissive: CompiledPolicyFile = {
      ...testCompiledPolicy,
      rules: [scopeRule('reader-reads-anywhere', 'filesystem', { roles: ['read-path'] })],
    };
    writeFileSync(resolve(personaDir, 'compiled-policy.json'), JSON.stringify(permissive));
    const call = readFile(`${PERMITTED_D}/anything.txt`);

    const scoped = makeCoordinator(async () => ({ decision: 'denied' }));
    const unscoped = makeCoordinator(async () => ({ decision: 'denied' }), { scoped: false });
    try {
      await scoped.coordinator.loadPolicy({ persona: 'reader', policyDir: personaDir });
      await unscoped.coordinator.loadPolicy({ persona: 'reader', policyDir: personaDir });
      // The persona policy alone allows the read ...
      expect(unscoped.coordinator.getPolicyEngine().evaluate(call)).toMatchObject({ decision: 'allow' });
      // ... the task scope still narrows it after the swap.
      expect(scoped.coordinator.hasTaskScope()).toBe(true);
      expect(scoped.coordinator.getPolicyEngine().evaluate(call)).toMatchObject({
        decision: 'escalate',
        rule: TASK_SCOPE_ESCALATE_RULE,
      });
    } finally {
      await scoped.coordinator.close();
      await unscoped.coordinator.close();
    }
  });

  it('keeps the virtual proxy tools at their fixed decisions under a task scope', async () => {
    // As the sandbox builds it: proxy annotations and rules merged into the session policy.
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: { ...testCompiledPolicy, rules: [...proxyPolicyRules, ...testCompiledPolicy.rules] },
      toolAnnotations: {
        ...testToolAnnotations,
        servers: { ...testToolAnnotations.servers, proxy: { inputHash: 'hardcoded', tools: proxyAnnotations } },
      },
      taskScope: SCOPE,
      protectedPaths: [],
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: resolve(home, 'audit-proxy.jsonl'),
    });
    try {
      const policy = coordinator.getPolicyEngine();
      expect(policy.evaluate(request('proxy', 'list_proxy_domains', {}))).toMatchObject({
        decision: 'allow',
        rule: 'proxy-list-domains-allow',
      });
      const add = policy.evaluate(request('proxy', 'add_proxy_domain', { domain: 'example.com:443' }));
      expect(add).toMatchObject({ decision: 'escalate', rule: 'proxy-add-domain-escalate', humanOnly: true });
      expect(add.reason).toBe(proxyPolicyRules[0].reason);
    } finally {
      await coordinator.close();
    }
  });

  it('gives the task scope the egress rules: allowed hosts stay admitted, other destinations reach a human', async () => {
    // Policy-evaluated MITM egress: a task compile never sees the virtual
    // `network` server, so the scope gets the same hardcoded egress rules as
    // every session policy. A destination only the session policy's own
    // compiled rule admits is outside the task scope.
    const asked: unknown[] = [];
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: {
        ...testCompiledPolicy,
        rules: [
          ...testCompiledPolicy.rules,
          scopeRule('session-allows-api', 'network', {
            tool: ['request'],
            domains: { roles: ['egress-host'], allowed: ['api.example.com'] },
          }),
        ],
      },
      toolAnnotations: testToolAnnotations,
      taskScope: SCOPE,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: resolve(home, 'audit-egress.jsonl'),
      egressPolicy: { allowedHosts: ['allowed.example.com'] },
      onEscalation: async (req) => {
        asked.push(req.arguments.host);
        return { decision: 'denied' };
      },
    });
    const connect = (host: string) => coordinator.authorizeEgress({ method: 'CONNECT', host, port: 443 });
    try {
      expect(await connect('allowed.example.com')).toMatchObject({
        allowed: true,
        settledBy: 'policy',
        rule: EGRESS_ALLOWED_HOSTS_RULE,
      });
      expect(await connect('api.example.com')).toMatchObject({
        allowed: false,
        settledBy: 'human',
        rule: EGRESS_ESCALATE_RULE,
      });
      expect(await connect('other.example.com')).toMatchObject({
        allowed: false,
        settledBy: 'human',
        rule: EGRESS_ESCALATE_RULE,
      });
      expect(asked).toEqual(['api.example.com', 'other.example.com']);
    } finally {
      await coordinator.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Task-scope directories
// ---------------------------------------------------------------------------

describe('task-scope directories', () => {
  it('loads a published scope from its canonical directory', () => {
    const dir = writeTaskScopeDir(TASK, SCOPE_RULES);
    const loaded = loadTaskScopePolicy(dir);
    expect(loaded.policyDir).toBe(realpathSync(dir));
    expect(loaded.task).toBe(TASK);
    expect(loaded.policy.compiledPolicy.rules.map((r) => r.name)).toEqual(SCOPE_RULES.map((r) => r.name));
  });

  it('refuses a scope without a record, with a tampered policy, or filed under another key', () => {
    const missingRecord = writeTaskScopeDir('task one', SCOPE_RULES);
    rmSync(resolve(missingRecord, TASK_SCOPE_RECORD_FILENAME));
    expect(() => loadTaskScopePolicy(missingRecord)).toThrow(/task-scope\.json is missing/);

    const tampered = writeTaskScopeDir('task two', SCOPE_RULES);
    writeFileSync(
      resolve(tampered, 'compiled-policy.json'),
      JSON.stringify(taskScopePolicy('a different task', [scopeRule('allow-all', 'filesystem', {})])),
    );
    expect(() => loadTaskScopePolicy(tampered)).toThrow(/cannot be trusted/);

    const misfiled = writeTaskScopeDir('task three', SCOPE_RULES, { key: 'f'.repeat(64) });
    expect(() => loadTaskScopePolicy(misfiled)).toThrow(/belongs to another directory/);

    for (const dir of [missingRecord, tampered, misfiled]) expect(checkTaskScopeDir(dir).ok).toBe(false);
  });

  it('refuses a scope outside the trusted roots', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ic-untrusted-scope-'));
    try {
      expect(() => loadTaskScopePolicy(outside)).toThrow(
        /Task scope rejected: policyDir must be one of IronCurtain's compiled-policy directories/,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The lighter compile and its cache
// ---------------------------------------------------------------------------

const noopReporter: ServerProgressReporter = {
  update: () => {},
  complete: () => {},
  warn: () => {},
  fail: () => {},
  done: () => {},
};

describe('compileTaskScopePolicy', () => {
  const DOCS = '/srv/docs';
  const COMPILE_TASK = 'Summarize the Markdown files in /srv/docs.';

  /** A config with two configured servers (fs, news) whose annotations live in the user generated dir. */
  function makeConfig(): IronCurtainConfig {
    const generatedDir = resolve(home, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(FS_AND_NEWS));
    return {
      mcpServers: { fs: { command: 'fs-server', args: [] }, news: { command: 'news-server', args: [] } },
      protectedPaths: [],
      generatedDir,
      toolAnnotationsDir: generatedDir,
    } as unknown as IronCurtainConfig;
  }

  /** The pre-filter keeps fs (the task needs it) and skips news; fs compiles to a read-only scope. */
  const SCRIPT: FakePhaseScript = {
    prefilter: [(call: FakeLlmCall) => ({ skip: call.system.includes('## Server: "news"'), reason: 'routing' })],
    compile: [
      (call: FakeLlmCall) => {
        if (!call.system.includes('for the "fs" server')) throw new Error('only fs should be compiled');
        return {
          rules: [rule('read-docs', 'fs', { tool: ['read_file'], paths: { roles: ['read-path'], within: DOCS } })],
        };
      },
    ],
  };

  const quiet = { quiet: true, reporterFactory: () => noopReporter, onProgress: () => {} };

  it('compiles only the servers the task needs, without scenarios or verification, and publishes the scope', async () => {
    const config = makeConfig();
    const fake = createScriptedPipelineModels(SCRIPT, resolve(home, 'llm.jsonl'));
    const result = await compileTaskScopePolicy(COMPILE_TASK, { config, models: fake.models, ...quiet });

    expect(result.cached).toBe(false);
    expect(result.policyDir.startsWith(getTaskPoliciesDir())).toBe(true);
    expect(result.record).toMatchObject({ task: COMPILE_TASK, complete: true });
    expect(result.policy.rules.map((r) => r.name)).toEqual(['read-docs']);
    expect(result.policy.skippedServers?.map((s) => s.serverName)).toEqual(['news']);
    // The light path: one pre-filter call per server, one compile, nothing else.
    expect(fake.calls.map((c) => c.phase).sort()).toEqual(['compile', 'prefilter', 'prefilter']);
    // Published as a whole: no temporary compile directories are left behind.
    expect(readdirSync(getTaskPoliciesDir()).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(checkTaskScopeDir(result.policyDir).ok).toBe(true);
    // Unverified rules are kept only as a draft, never as a cache-eligible verified commit.
    expect(existsSync(resolve(result.policyDir, 'servers', 'fs', 'compiled-policy.unverified.json'))).toBe(true);
    expect(existsSync(resolve(result.policyDir, 'servers', 'fs', 'compiled-policy.json'))).toBe(false);
  });

  it('reuses the cached task policy on rerun without any LLM call', async () => {
    const config = makeConfig();
    const first = await compileTaskScopePolicy(COMPILE_TASK, {
      config,
      models: createScriptedPipelineModels(SCRIPT, resolve(home, 'llm.jsonl')).models,
      ...quiet,
    });

    const unavailable = createThrowingPipelineModels(resolve(home, 'llm-2.jsonl'));
    const rerun = await compileTaskScopePolicy(`  ${COMPILE_TASK}\n`, { config, models: unavailable.models, ...quiet });

    expect(rerun.cached).toBe(true);
    expect(rerun.policyDir).toBe(first.policyDir);
    expect(rerun.policy.rules).toEqual(first.policy.rules);
    expect(unavailable.calls).toEqual([]);
    expect(formatTaskScopeSummary(first)[0]).toBe(
      'Task scope compiled: 1 rule for fs. Calls outside the task scope will be escalated.',
    );
    expect(formatTaskScopeSummary(rerun)[0]).toMatch(/^Task scope reused: 1 rule for fs\./);
  });

  it('compiles again for another task or another workspace', async () => {
    const config = makeConfig();
    const first = await compileTaskScopePolicy(COMPILE_TASK, {
      config,
      models: createScriptedPipelineModels(SCRIPT, resolve(home, 'llm.jsonl')).models,
      ...quiet,
    });
    for (const options of [
      { task: 'Delete everything in /srv/docs.', workspacePath: undefined },
      { task: COMPILE_TASK, workspacePath: resolve(home, 'project') },
    ]) {
      const unavailable = createThrowingPipelineModels(resolve(home, 'llm-x.jsonl'));
      await expect(
        compileTaskScopePolicy(options.task, {
          config,
          models: unavailable.models,
          ...(options.workspacePath ? { workspacePath: options.workspacePath } : {}),
          ...quiet,
        }),
      ).rejects.toThrow();
      // It tried to compile (no cache hit) and published nothing.
      expect(unavailable.calls.length).toBeGreaterThan(0);
    }
    expect(readdirSync(getTaskPoliciesDir()).filter((name) => !name.startsWith('.'))).toEqual([
      first.policyDir.split('/').pop(),
    ]);
  });

  it('keys the cache on the task, the workspace, the protected paths and the annotations', () => {
    const base = { task: 't', allowedDirectory: '/w', protectedPaths: ['/p'], annotations: FS_AND_NEWS };
    const key = computeTaskScopeKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(computeTaskScopeKey({ ...base, protectedPaths: ['/p'] })).toBe(key);
    expect(computeTaskScopeKey({ ...base, task: 't2' })).not.toBe(key);
    expect(computeTaskScopeKey({ ...base, allowedDirectory: '/w2' })).not.toBe(key);
    expect(computeTaskScopeKey({ ...base, protectedPaths: ['/p', '/q'] })).not.toBe(key);
    // A compiler fix that bumps the epoch recompiles cached scopes, like every per-server compile cache.
    expect(computeTaskScopeKey({ ...base, compilerEpoch: POLICY_COMPILER_EPOCH })).toBe(key);
    expect(computeTaskScopeKey({ ...base, compilerEpoch: POLICY_COMPILER_EPOCH + 1 })).not.toBe(key);
    const changed: StoredToolAnnotationsFile = {
      ...FS_AND_NEWS,
      servers: { ...FS_AND_NEWS.servers, news: { inputHash: 'news', tools: [] } },
    };
    expect(computeTaskScopeKey({ ...base, annotations: changed })).not.toBe(key);
  });

  it('serves an incomplete compile (a server failed) once, but never reuses it', async () => {
    const config = makeConfig();
    const flaky: FakePhaseScript = {
      prefilter: [{ skip: false, reason: 'needed' }],
      compile: [
        (call: FakeLlmCall) => {
          if (call.system.includes('for the "news" server')) throw new Error('LLM overloaded');
          return { rules: [rule('read-docs', 'fs', { tool: ['read_file'] })] };
        },
      ],
    };
    const first = await compileTaskScopePolicy(COMPILE_TASK, {
      config,
      models: createScriptedPipelineModels(flaky, resolve(home, 'llm.jsonl')).models,
      ...quiet,
    });
    expect(first.record.complete).toBe(false);
    expect(first.policy.failedServers?.map((f) => f.serverName)).toEqual(['news']);
    expect(checkTaskScopeDir(first.policyDir).ok).toBe(true);

    // Not served from the cache: the next start compiles again.
    const unavailable = createThrowingPipelineModels(resolve(home, 'llm-2.jsonl'));
    await expect(
      compileTaskScopePolicy(COMPILE_TASK, { config, models: unavailable.models, ...quiet }),
    ).rejects.toThrow();
    expect(unavailable.calls.length).toBeGreaterThan(0);

    // A complete compile replaces the incomplete scope under the same key.
    const second = await compileTaskScopePolicy(COMPILE_TASK, {
      config,
      models: createScriptedPipelineModels(
        { prefilter: [{ skip: false, reason: 'needed' }], compile: [(c: FakeLlmCall) => compileFor(c)] },
        resolve(home, 'llm-3.jsonl'),
      ).models,
      ...quiet,
    });
    expect(second.policyDir).toBe(first.policyDir);
    expect(second.record.complete).toBe(true);
  });

  it('still lints the light compile: a URL allow without domains fails its server, which gets no rules', async () => {
    const config = makeConfig();
    const broadNews = { rules: [rule('allow-any-news', 'news', { tool: ['http_fetch'] })] };
    const fake = createScriptedPipelineModels(
      {
        prefilter: [{ skip: false, reason: 'needed' }],
        compile: [
          (call: FakeLlmCall) => (call.system.includes('for the "news" server') ? broadNews : compileFor(call)),
        ],
        // Asked to fix the rule, the compiler returns it unchanged.
        validationRepair: [broadNews],
      },
      resolve(home, 'llm.jsonl'),
    );
    const result = await compileTaskScopePolicy(COMPILE_TASK, { config, models: fake.models, ...quiet });

    // skipVerification skips scenarios and the verifier, never the rule checks.
    expect(fake.calls.some((call) => call.phase === 'validationRepair')).toBe(true);
    expect(fake.calls.some((call) => call.phase === 'scenarios' || call.phase === 'judge')).toBe(false);
    expect(result.record.complete).toBe(false);
    expect(result.policy.failedServers?.map((f) => f.serverName)).toEqual(['news']);
    expect(result.policy.failedServers?.[0]?.reason).toMatch(/no domains condition/);
    expect(result.policy.rules.map((r) => r.name)).toEqual(['read-docs']);
  });

  it('produces a scope the engine enforces: out-of-scope calls the base policy allows escalate', async () => {
    const config = makeConfig();
    const result = await compileTaskScopePolicy(COMPILE_TASK, {
      config,
      models: createScriptedPipelineModels(SCRIPT, resolve(home, 'llm.jsonl')).models,
      ...quiet,
    });
    const base: CompiledPolicyFile = {
      generatedAt: 'x',
      constitutionHash: 'x',
      inputHash: 'x',
      rules: [rule('allow-reads', 'fs', { tool: ['read_file'] }), rule('allow-news', 'news', { tool: ['http_fetch'] })],
    };
    const scoped = new PolicyEngine(
      base,
      FS_AND_NEWS,
      [],
      resolve(home, 'sandbox'),
      undefined,
      undefined,
      undefined,
      loadTaskScopePolicy(result.policyDir).policy,
    );
    expect(scoped.evaluate(request('fs', 'read_file', { path: `${DOCS}/guide.md` }))).toMatchObject({
      decision: 'allow',
      rule: 'allow-reads',
    });
    expect(scoped.evaluate(request('fs', 'read_file', { path: '/etc/hosts' }))).toMatchObject({
      decision: 'escalate',
      rule: TASK_SCOPE_ESCALATE_RULE,
    });
    // news was not selected for the task at all.
    expect(scoped.evaluate(request('news', 'http_fetch', { url: 'https://news.example/' }))).toMatchObject({
      decision: 'escalate',
      rule: TASK_SCOPE_ESCALATE_RULE,
    });
  });

  it('refuses an empty task', async () => {
    await expect(compileTaskScopePolicy('   ', { config: makeConfig(), ...quiet })).rejects.toThrow(
      /needs a task description/,
    );
  });
});

/**
 * fs and news each compile to one rule scoped to their own server. The news
 * rule names its domains: the policy lint rejects a URL-role allow without
 * a domains condition, and a task scope compile never opts in to broad
 * domain access.
 */
function compileFor(call: FakeLlmCall): unknown {
  return call.system.includes('for the "news" server')
    ? NEWS
    : { rules: [rule('read-docs', 'fs', { tool: ['read_file'] })] };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe('task-scoped sessions', () => {
  async function load() {
    const { buildSessionConfig, createSession } = await import('../src/session/index.js');
    const { createSessionId } = await import('../src/session/types.js');
    const { loadConfig } = await import('../src/config/index.js');
    return { buildSessionConfig, createSession, sessionId: createSessionId(), config: loadConfig() };
  }

  it('records the validated scope on the session config and in the session metadata', async () => {
    const dir = writeTaskScopeDir(TASK, SCOPE_RULES);
    const { buildSessionConfig, sessionId, config } = await load();

    const sessionConfig = buildSessionConfig(config, sessionId, sessionId, { taskPolicyDir: dir });

    expect(sessionConfig.config.taskPolicyDir).toBe(realpathSync(dir));
    // The session policy itself is unchanged (intersected, not replaced).
    expect(sessionConfig.config.generatedDir).toBe(config.generatedDir);
    const metadata = JSON.parse(
      readFileSync(resolve(home, 'sessions', sessionId, 'session-metadata.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(metadata.taskPolicyDir).toBe(realpathSync(dir));
  });

  it('is never task-scoped unless asked', async () => {
    const { buildSessionConfig, sessionId, config } = await load();
    const sessionConfig = buildSessionConfig(config, sessionId, sessionId, {});
    expect(sessionConfig.config.taskPolicyDir).toBeUndefined();
  });

  it('refuses a session whose task scope does not validate instead of running it unscoped', async () => {
    const dir = writeTaskScopeDir(TASK, SCOPE_RULES);
    rmSync(resolve(dir, TASK_SCOPE_RECORD_FILENAME));
    const { buildSessionConfig, sessionId, config } = await load();
    expect(() => buildSessionConfig(config, sessionId, sessionId, { taskPolicyDir: dir })).toThrow(
      /Refusing to run the session without its task scope/,
    );
    expect(() => buildSessionConfig(config, sessionId, sessionId, { taskPolicyDir: '/tmp' })).toThrow(
      /policyDir must be one of IronCurtain's compiled-policy directories/,
    );
    expect(existsSync(resolve(home, 'sessions', sessionId))).toBe(false);
  });

  it('resumes a task-scoped session under its recorded scope, and refuses when it is gone', async () => {
    const dir = writeTaskScopeDir(TASK, SCOPE_RULES);
    const { buildSessionConfig, createSession, sessionId, config } = await load();
    buildSessionConfig(config, sessionId, sessionId, { taskPolicyDir: dir });
    const logger = await import('../src/logger.js');
    logger.teardown();

    // The scope disappears; resuming must not silently drop it.
    rmSync(dir, { recursive: true, force: true });
    await expect(createSession({ config, resumeSessionId: sessionId })).rejects.toThrow(
      /Refusing to run the session without its task scope/,
    );
  });
});

// ---------------------------------------------------------------------------
// Sandbox: the coordinator a real session builds
// ---------------------------------------------------------------------------

describe('Sandbox coordinator with a task scope', () => {
  function sandboxConfig(taskPolicyDir?: string): IronCurtainConfig {
    const generatedDir = resolve(home, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
    return {
      auditLogPath: resolve(home, `audit-${uuidv4()}.jsonl`),
      allowedDirectory: TEST_SANDBOX_DIR,
      // No backends: only the coordinator wiring is under test.
      mcpServers: {},
      protectedPaths: [],
      generatedDir,
      constitutionPath: resolve(home, 'constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      ...(taskPolicyDir !== undefined ? { taskPolicyDir } : {}),
      userConfig: {
        escalationTimeoutSeconds: 300,
        autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
        auditRedaction: { enabled: true },
        serverCredentials: {},
      },
    } as unknown as IronCurtainConfig;
  }

  it('builds the coordinator with the session task scope from config.taskPolicyDir', async () => {
    const { Sandbox } = await import('../src/sandbox/index.js');
    const dir = writeTaskScopeDir(TASK, SCOPE_RULES);
    const scoped = new Sandbox();
    const unscoped = new Sandbox();
    try {
      await scoped.initialize(sandboxConfig(dir));
      await unscoped.initialize(sandboxConfig());
      const call = readFile(`${PERMITTED_B}/report.txt`);
      expect(unscoped.getCoordinator()?.hasTaskScope()).toBe(false);
      expect(unscoped.getCoordinator()?.getPolicyEngine().evaluate(call)).toMatchObject({ decision: 'allow' });
      expect(scoped.getCoordinator()?.hasTaskScope()).toBe(true);
      expect(scoped.getCoordinator()?.getPolicyEngine().evaluate(call)).toMatchObject({
        decision: 'escalate',
        rule: TASK_SCOPE_ESCALATE_RULE,
      });
    } finally {
      await scoped.shutdown();
      await unscoped.shutdown();
    }
  });

  it('fails to start when the task scope cannot be loaded, rather than running unscoped', async () => {
    const { Sandbox } = await import('../src/sandbox/index.js');
    const dir = writeTaskScopeDir(TASK, SCOPE_RULES);
    rmSync(resolve(dir, 'compiled-policy.json'));
    const sandbox = new Sandbox();
    try {
      await expect(sandbox.initialize(sandboxConfig(dir))).rejects.toThrow(/has no compiled policy/);
    } finally {
      await sandbox.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// mux /new and the PTY child argv
// ---------------------------------------------------------------------------

describe('mux /new --task-scoped', () => {
  it('parses the persona and the task text', () => {
    expect(parseNewCommandArgs([])).toEqual({});
    expect(parseNewCommandArgs(['coder'])).toEqual({ persona: 'coder' });
    expect(parseNewCommandArgs(['--task-scoped', 'fix', 'the', 'parser'])).toEqual({ taskScope: 'fix the parser' });
    expect(parseNewCommandArgs(['coder', '--task-scoped', 'fix', 'it'])).toEqual({
      persona: 'coder',
      taskScope: 'fix it',
    });
    expect(parseNewCommandArgs(['--task-scoped'])).toMatchObject({ error: expect.stringMatching(/^Usage: \/new/) });
    expect(parseNewCommandArgs(['--task-scope', 'typo'])).toMatchObject({ error: expect.any(String) });
  });

  it('refuses a misspelt flag or a stray task instead of spawning an unscoped session', () => {
    // A task typed without the flag, or the flag without its dashes, is not dropped.
    for (const args of [
      ['coder', 'fix', 'it'],
      ['coder', 'task-scoped', 'fix', 'it'],
      ['coder', 'extra', '--task-scoped', 'fix'],
    ]) {
      expect(parseNewCommandArgs(args)).toMatchObject({ error: expect.stringMatching(/^Usage: \/new/) });
    }
    // A misspelt flag is never taken for a persona name, alone or before the real flag.
    for (const flag of ['--task-scope', '--Task-Scoped', '-t', '\u2014task-scoped', '\u2013task-scoped']) {
      for (const args of [[flag], [flag, '--task-scoped', 'fix'], ['coder', flag, 'fix', 'it']]) {
        expect(parseNewCommandArgs(args)).toMatchObject({ error: expect.stringMatching(/^Usage: \/new/) });
      }
    }
    // Option-like words in the task text itself are the task.
    expect(parseNewCommandArgs(['coder', '--task-scoped', '--fix', '-x'])).toEqual({
      persona: 'coder',
      taskScope: '--fix -x',
    });
  });

  it('passes the task to the child after the option terminator, last', () => {
    const args = buildSpawnArgs({
      cols: 80,
      rows: 24,
      ironcurtainBin: 'ironcurtain',
      agent: 'claude-code',
      persona: 'coder',
      captureTraces: true,
      taskScope: '--persona evil -w /',
    });
    expect(args).toEqual([
      'start',
      '--pty',
      '--agent',
      'claude-code',
      '--persona',
      'coder',
      '--capture-traces',
      '--task-scoped',
      '--',
      '--persona evil -w /',
    ]);
    // Opt-in only: no flag without a task.
    expect(buildSpawnArgs({ cols: 80, rows: 24, ironcurtainBin: 'ironcurtain', agent: 'claude-code' })).not.toContain(
      '--task-scoped',
    );
  });
});

// ---------------------------------------------------------------------------
// ironcurtain start --task-scoped
// ---------------------------------------------------------------------------

describe('ironcurtain start --task-scoped', () => {
  it('refuses to start without the task text to compile the scope from', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code ?? 0}`);
    }) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { main } = await import('../src/index.js');
      await expect(main(['--task-scoped'])).rejects.toThrow('exit 1');
      const written = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(written).toContain('--task-scoped needs the task text to compile its scope from');
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });
});
