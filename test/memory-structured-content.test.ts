/**
 * A tool result's structuredContent from the backend to the agent:
 *
 * - the coordinator pipeline returns it with the content (host sandbox paths
 *   rewritten like the content's), instead of dropping it;
 * - the Code Mode bridge hands it to the isolate for the memory server, whose
 *   recall reports the source segments memory.expand takes, and not for servers
 *   that repeat their whole result in it (the filesystem server does, for every
 *   tool), and never the coordinator's internal fields;
 * - help.help('memory') documents it.
 */

import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { CommunicationProtocol, type CallTemplate, type IUtcpClient } from '@utcp/sdk';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { CallCircuitBreaker } from '../src/trusted-process/call-circuit-breaker.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import {
  buildToolMap,
  handleCallTool,
  type CallToolDeps,
  type ClientState,
  type ProxiedTool,
  type ToolCallResponse,
} from '../src/trusted-process/tool-call-pipeline.js';
import { rewriteStructuredContent } from '../src/trusted-process/path-utils.js';
import type { AuditLog } from '../src/trusted-process/audit-log.js';
import type { ToolCallCoordinator } from '../src/trusted-process/tool-call-coordinator.js';
import {
  IRONCURTAIN_CALL_TEMPLATE_TYPE,
  bindCoordinatorToManual,
  unbindCoordinatorFromManual,
} from '../src/sandbox/ironcurtain-protocol.js';
import { buildHelpSnippet, type HelpData } from '../src/sandbox/index.js';
import { exposesStructuredContent, structuredResultNotes } from '../src/sandbox/structured-results.js';
import { MEMORY_SERVER_NAME } from '../src/memory/memory-server-name.js';
import { CONTAINER_WORKSPACE_DIR } from '../src/docker/agent-adapter.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_DOMAIN_ALLOWLISTS,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
} from './fixtures/test-policy.js';

const SEGMENT = '0123456789abcdef0123456789abcdef';

function pipelineDeps(result: Record<string, unknown>, allowedDirectory: string | undefined): CallToolDeps {
  const tools: ProxiedTool[] = [{ serverName: MEMORY_SERVER_NAME, name: 'memory_recall', inputSchema: {} }];
  const client: ClientState = {
    client: {
      callTool: async () => result,
      sendRootsListChanged: async () => undefined,
    } as unknown as ClientState['client'],
    roots: [],
  };
  return {
    toolMap: buildToolMap(tools),
    policyEngine: new PolicyEngine(
      testCompiledPolicy,
      testToolAnnotations,
      TEST_PROTECTED_PATHS,
      TEST_SANDBOX_DIR,
      TEST_DOMAIN_ALLOWLISTS,
      undefined,
      new Set([MEMORY_SERVER_NAME]),
    ),
    auditLog: { log: () => undefined, assertWritable: vi.fn() } as unknown as AuditLog,
    circuitBreaker: new CallCircuitBreaker({ maxLanes: 1 }),
    clientStates: new Map([[MEMORY_SERVER_NAME, client]]),
    resolvedSandboxConfigs: new Map(),
    allowedDirectory,
    escalationDir: undefined,
    autoApproveModel: null,
    serverContextMap: new Map(),
    whitelist: createApprovalWhitelist(),
  };
}

describe('the pipeline forwards structuredContent', () => {
  it('returns the backend structuredContent with the content', async () => {
    const structured = { memories_used: 2, source_segment_ids: [SEGMENT] };
    const response = await handleCallTool(
      'memory_recall',
      { query: 'deploys' },
      pipelineDeps({ content: [{ type: 'text', text: 'recalled' }], structuredContent: structured }, undefined),
    );

    expect(response.isError).toBeUndefined();
    expect(response.content).toEqual([{ type: 'text', text: 'recalled' }]);
    expect(response.structuredContent).toEqual(structured);
  });

  it('rewrites host sandbox paths in it as in the content', async () => {
    const hostPath = `${TEST_SANDBOX_DIR}/notes/deploy.md`;
    const response = await handleCallTool(
      'memory_recall',
      { query: 'deploys' },
      pipelineDeps(
        {
          content: [{ type: 'text', text: hostPath }],
          structuredContent: { files: [hostPath], nested: { at: hostPath } },
        },
        TEST_SANDBOX_DIR,
      ),
    );

    const containerPath = `${CONTAINER_WORKSPACE_DIR}/notes/deploy.md`;
    expect(response.content).toEqual([{ type: 'text', text: containerPath }]);
    expect(response.structuredContent).toEqual({ files: [containerPath], nested: { at: containerPath } });
  });

  it('adds nothing when the backend sends no structuredContent', async () => {
    const response = await handleCallTool(
      'memory_recall',
      { query: 'deploys' },
      pipelineDeps({ content: [{ type: 'text', text: 'recalled' }] }, TEST_SANDBOX_DIR),
    );
    expect('structuredContent' in response).toBe(false);
  });
});

describe('rewriteStructuredContent', () => {
  it('matches and writes the directories in their JSON spelling', () => {
    const host = '/home/u/odd"dir\\x';
    const value = { path: `${host}/a.txt`, list: [`see ${host}`], n: 3 };
    expect(rewriteStructuredContent(value, `${host}/`, '/workspace')).toEqual({
      path: '/workspace/a.txt',
      list: ['see /workspace'],
      n: 3,
    });
    // Untouched values come back as they are.
    const untouched = { a: 1 };
    expect(rewriteStructuredContent(untouched, host, '/workspace')).toBe(untouched);
  });
});

describe('the Code Mode bridge', () => {
  const MANUAL = 'tools_structured_test';
  const template = { name: MANUAL, call_template_type: IRONCURTAIN_CALL_TEMPLATE_TYPE } as CallTemplate;

  async function callThroughBridge(serverName: string, response: ToolCallResponse): Promise<unknown> {
    const coordinator = { handleToolCall: vi.fn(async () => response) } as unknown as ToolCallCoordinator;
    bindCoordinatorToManual(MANUAL, coordinator);
    try {
      const protocol = CommunicationProtocol.communicationProtocols[IRONCURTAIN_CALL_TEMPLATE_TYPE];
      return await protocol.callTool({} as IUtcpClient, `${MANUAL}.${serverName}.some_tool`, {}, template);
    } finally {
      unbindCoordinatorFromManual(MANUAL);
    }
  }

  it("gives the agent the memory server's structuredContent, and never the policy decision", async () => {
    const structured = { expanded_segment_ids: [], source_segment_ids: [SEGMENT] };
    const result = await callThroughBridge(MEMORY_SERVER_NAME, {
      content: [{ type: 'text', text: `fact [src:${SEGMENT}]` }],
      structuredContent: structured,
      _policyDecision: { status: 'allow', rule: 'trusted-server', reason: 'internal' },
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: `fact [src:${SEGMENT}]` }],
      structuredContent: structured,
    });
  });

  it('leaves out the structuredContent of a server that repeats its result in it', async () => {
    const text = 'file contents';
    const result = await callThroughBridge('filesystem', {
      content: [{ type: 'text', text }],
      structuredContent: { content: text },
      _policyDecision: { status: 'allow', rule: 'allow-fs', reason: 'internal' },
    });
    expect(result).toEqual({ content: [{ type: 'text', text }] });
    expect(exposesStructuredContent('filesystem')).toBe(false);
  });
});

describe("help.help('memory')", () => {
  function help(data: HelpData): (server?: string) => string {
    // The snippet runs in the isolate as plain JS against its `global`.
    const context: { global: { help?: { help: (server?: string) => string } } } = { global: {} };
    runInNewContext(buildHelpSnippet(data), context);
    const fn = context.global.help?.help;
    if (fn === undefined) throw new Error('help() was not installed');
    return fn;
  }

  it('documents the structured result and the [src:<id>] / memory.expand loop', () => {
    const data: HelpData = {
      serverDescriptions: { memory: 'Persistent memory', filesystem: 'Files' },
      toolsByServer: {
        memory: [{ callableName: 'memory.recall', params: 'query' }],
        filesystem: [{ callableName: 'filesystem.read_text_file', params: 'path' }],
      },
      resultNotes: structuredResultNotes(['memory', 'filesystem']),
    };
    const memoryHelp = help(data)('memory');
    expect(memoryHelp).toContain('memory.recall(query)');
    expect(memoryHelp).toContain('structuredContent');
    expect(memoryHelp).toContain('source_segment_ids');
    expect(memoryHelp).toContain('memory.expand({ segment_id');
    expect(help(data)('filesystem')).not.toContain('structuredContent');
    expect(Object.keys(data.resultNotes ?? {})).toEqual(['memory']);
  });
});
