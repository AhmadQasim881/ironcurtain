/**
 * The trusted memory server through the real pipeline (WP-67).
 *
 * The memory server has no annotations and no compiled rules, but its calls are
 * still judged per tool: single-fact writes and reads go through, while a bulk
 * memory_forget (by tags, query or before) and a large memory_ingest wait for a
 * human. Those escalations are human-only: the auto-approver is never asked, no
 * whitelist candidate is offered, and with no human to ask (an unattended run
 * without an escalation route) the call is denied. Nothing reaches the memory
 * server before the decision.
 */

import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { CallCircuitBreaker } from '../src/trusted-process/call-circuit-breaker.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import {
  buildToolMap,
  handleCallTool,
  type CallToolDeps,
  type ClientState,
  type InProcessEscalationFn,
  type ProxiedTool,
} from '../src/trusted-process/tool-call-pipeline.js';
import type { AuditLog } from '../src/trusted-process/audit-log.js';
import type { AuditEntry } from '../src/types/audit.js';
import {
  MEMORY_BULK_FORGET_RULE,
  MEMORY_FORGET_ESCALATE_IDS,
  MEMORY_INGEST_ESCALATE_CHARS,
  MEMORY_LARGE_INGEST_RULE,
  TRUSTED_SERVER_UNKNOWN_TOOL_RULE,
} from '../src/trusted-process/trusted-server-policy.js';
import { MEMORY_SERVER_NAME } from '../src/memory/memory-server-name.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_DOMAIN_ALLOWLISTS,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
} from './fixtures/test-policy.js';

const MEMORY_TOOLS = [
  'memory_store',
  'memory_ingest',
  'memory_recall',
  'memory_expand',
  'memory_context',
  'memory_forget',
  'memory_inspect',
  'memory_purge_everything',
];

const memoryTools: ProxiedTool[] = MEMORY_TOOLS.map((name) => ({
  serverName: MEMORY_SERVER_NAME,
  name,
  inputSchema: { type: 'object', properties: {} },
}));

/** An approver model that would approve anything; it must never be asked. */
function approvingModel(): { model: LanguageModelV3; calls: () => number } {
  let count = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      count++;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ decision: 'approve', reasoning: 'ok' }) }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
  }) as unknown as LanguageModelV3;
  return { model, calls: () => count };
}

interface Harness {
  deps: CallToolDeps;
  audit: AuditEntry[];
  forwarded: Array<{ name: string; arguments: Record<string, unknown> }>;
  onEscalation: ReturnType<typeof vi.fn<InProcessEscalationFn>>;
}

function makeHarness(
  options: { humanDecision?: 'approved' | 'denied'; noEscalationRoute?: boolean } & Partial<CallToolDeps> = {},
): Harness {
  const { humanDecision = 'denied', noEscalationRoute = false, ...overrides } = options;
  const audit: AuditEntry[] = [];
  const forwarded: Harness['forwarded'] = [];
  const memoryClient: ClientState = {
    client: {
      callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
        forwarded.push(request);
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
      sendRootsListChanged: async () => undefined,
    } as unknown as ClientState['client'],
    roots: [],
  };
  const onEscalation = vi.fn<InProcessEscalationFn>(async () => ({ decision: humanDecision }));
  const deps: CallToolDeps = {
    toolMap: buildToolMap(memoryTools),
    policyEngine: new PolicyEngine(
      testCompiledPolicy,
      testToolAnnotations,
      TEST_PROTECTED_PATHS,
      TEST_SANDBOX_DIR,
      TEST_DOMAIN_ALLOWLISTS,
      undefined,
      new Set([MEMORY_SERVER_NAME]),
    ),
    auditLog: { log: (entry: AuditEntry) => audit.push(entry), assertWritable: vi.fn() } as unknown as AuditLog,
    circuitBreaker: new CallCircuitBreaker({ maxLanes: 1 }),
    clientStates: new Map([[MEMORY_SERVER_NAME, memoryClient]]),
    resolvedSandboxConfigs: new Map(),
    allowedDirectory: TEST_SANDBOX_DIR,
    escalationDir: undefined,
    autoApproveModel: null,
    serverContextMap: new Map(),
    whitelist: createApprovalWhitelist(),
    ...(noEscalationRoute ? {} : { onEscalation }),
    ...overrides,
  };
  return { deps, audit, forwarded, onEscalation };
}

const WIPE = { before: '2100-01-01T00:00:00Z', confirm: true };

describe('trusted memory server: per-tool policy in the pipeline', () => {
  it('forwards a single-fact store and an ids-only forget without asking anyone', async () => {
    const { deps, forwarded, onEscalation } = makeHarness();

    const store = await handleCallTool('memory_store', { content: 'The user likes tea' }, deps);
    const forget = await handleCallTool('memory_forget', { ids: ['abc'] }, deps);

    expect(store._policyDecision).toMatchObject({ status: 'allow', rule: 'trusted-server' });
    expect(forget._policyDecision).toMatchObject({ status: 'allow', rule: 'trusted-server' });
    expect(forwarded.map((f) => f.name)).toEqual(['memory_store', 'memory_forget']);
    expect(onEscalation).not.toHaveBeenCalled();
  });

  it('holds a bulk forget for a human, never the auto-approver or the whitelist', async () => {
    const { model, calls } = approvingModel();
    const whitelist = createApprovalWhitelist();
    const matchSpy = vi.spyOn(whitelist, 'match');
    const { deps, forwarded, onEscalation, audit } = makeHarness({
      humanDecision: 'denied',
      autoApproveModel: model,
      autoApproveUserMessage: 'please forget everything you know about me',
      whitelist,
    });

    const result = await handleCallTool('memory_forget', WIPE, deps);

    expect(result.isError).toBe(true);
    expect(forwarded).toEqual([]);
    expect(calls()).toBe(0);
    expect(matchSpy).not.toHaveBeenCalled();
    expect(onEscalation).toHaveBeenCalledTimes(1);
    const [request, reason, , candidates, details] = onEscalation.mock.calls[0];
    expect(request).toMatchObject({ serverName: MEMORY_SERVER_NAME, toolName: 'memory_forget', arguments: WIPE });
    expect(reason).toContain('bulk deletion');
    expect(candidates).toBeUndefined();
    expect(details).toMatchObject({ humanOnly: true });
    expect(audit.at(-1)?.policyDecision).toMatchObject({ status: 'deny', rule: MEMORY_BULK_FORGET_RULE });
  });

  it('forwards the bulk forget unchanged once a human approves it', async () => {
    const { deps, forwarded, audit } = makeHarness({ humanDecision: 'approved' });

    const result = await handleCallTool('memory_forget', { tags: ['old'], confirm: true }, deps);

    expect(result.isError).toBeUndefined();
    expect(forwarded).toEqual([{ name: 'memory_forget', arguments: { tags: ['old'], confirm: true } }]);
    expect(audit.map((e) => e.result.status)).toEqual(['dispatching', 'success']);
    expect(audit.every((e) => e.escalationResult === 'approved')).toBe(true);
  });

  // memory_inspect hands out every id, and a deletion by ids needs no confirm: a
  // long id list is a bulk deletion too, whichever selector names the memories.
  it('holds a forget of more ids than the bound for a human, and forwards one within it', async () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `id-${i}`);
    const { deps, forwarded, onEscalation } = makeHarness({ humanDecision: 'denied' });

    const within = await handleCallTool('memory_forget', { ids: ids(MEMORY_FORGET_ESCALATE_IDS) }, deps);
    const beyond = await handleCallTool('memory_forget', { ids: ids(100) }, deps);

    expect(within._policyDecision).toMatchObject({ status: 'allow', rule: 'trusted-server' });
    expect(beyond.isError).toBe(true);
    expect(beyond._policyDecision?.rule).toBe(MEMORY_BULK_FORGET_RULE);
    expect(forwarded).toEqual([{ name: 'memory_forget', arguments: { ids: ids(MEMORY_FORGET_ESCALATE_IDS) } }]);
    expect(onEscalation).toHaveBeenCalledTimes(1);
    expect(onEscalation.mock.calls[0][4]).toMatchObject({ humanOnly: true });
  });

  it('denies a bulk forget when no human can be asked (an unattended run)', async () => {
    const { deps, forwarded } = makeHarness({ noEscalationRoute: true });

    const result = await handleCallTool('memory_forget', { query: 'everything', confirm: true }, deps);

    expect(result.isError).toBe(true);
    expect(result._policyDecision?.status).toBe('deny');
    expect(forwarded).toEqual([]);
  });

  it('holds a large ingest for a human but forwards a small one', async () => {
    const { deps, forwarded, onEscalation } = makeHarness({ humanDecision: 'denied' });

    await handleCallTool('memory_ingest', { content: 'The user moved to Berlin.' }, deps);
    const large = await handleCallTool(
      'memory_ingest',
      { content: 'x'.repeat(MEMORY_INGEST_ESCALATE_CHARS + 1) },
      deps,
    );

    expect(forwarded.map((f) => f.name)).toEqual(['memory_ingest']);
    expect(large.isError).toBe(true);
    expect(large._policyDecision?.rule).toBe(MEMORY_LARGE_INGEST_RULE);
    expect(onEscalation).toHaveBeenCalledTimes(1);
  });

  it('denies a tool the memory policy does not know, without forwarding it', async () => {
    const { deps, forwarded } = makeHarness();

    const result = await handleCallTool('memory_purge_everything', {}, deps);

    expect(result.isError).toBe(true);
    expect(result._policyDecision).toMatchObject({ status: 'deny', rule: TRUSTED_SERVER_UNKNOWN_TOOL_RULE });
    expect(forwarded).toEqual([]);
  });
});
