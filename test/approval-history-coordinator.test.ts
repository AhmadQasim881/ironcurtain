/**
 * The coordinator feeds the approval history: human approvals only (never the
 * auto-approver or a whitelist match), attributed to the constitution scope in
 * effect, and only when the coordinator was configured with a scope. What is
 * recorded is the directory-wide whitelist candidate, never the exact path the
 * human approved, and nothing a session's task scope escalated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { ToolCallCoordinator, type EscalationPromptFn } from '../src/trusted-process/tool-call-coordinator.js';
import type { ClientState, ProxiedTool } from '../src/trusted-process/tool-call-pipeline.js';
import type { TaskScopePolicy } from '../src/trusted-process/policy-types.js';
import { readApprovalHistory, type ApprovalRecord } from '../src/audit/approval-history.js';
import { loadAmendmentProposals } from '../src/audit/amendment-proposals.js';
import {
  REAL_TMP,
  testCompiledPolicy,
  testToolAnnotations,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
} from './fixtures/test-policy.js';
import { scopeRule, taskScopePolicy } from './fixtures/task-scope.js';

let root: string;
let historyPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ironcurtain-approval-coordinator-'));
  historyPath = join(root, 'approval-history.jsonl');
  mkdirSync(TEST_SANDBOX_DIR, { recursive: true });
  // loadPolicy only accepts policy directories under the IronCurtain home.
  process.env.IRONCURTAIN_HOME = root;
});

afterEach(() => {
  delete process.env.IRONCURTAIN_HOME;
  rmSync(root, { recursive: true, force: true });
});

/** A backend that answers the roots verification and every tool call. */
function rootsAwareClient(state: ClientState): Client {
  return {
    callTool: async (params: { name: string }) => {
      if (params.name === 'list_allowed_directories') {
        const directories = state.roots.map((r) => fileURLToPath(r.uri));
        return { content: [{ type: 'text', text: `Allowed directories:\n${directories.join('\n')}` }], isError: false };
      }
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
    sendRootsListChanged: async () => {
      state.rootsRefreshed?.();
      state.rootsRefreshed = undefined;
    },
  } as unknown as Client;
}

function approvingModel(): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ decision: 'approve', reasoning: 'asked for it' }) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: undefined, reasoning: undefined },
      },
      warnings: [],
      request: {},
      response: { id: 'id', modelId: 'm', timestamp: new Date() },
    }),
  });
}

function makeCoordinator(options: {
  scope?: string;
  onEscalation: EscalationPromptFn;
  autoApproveModel?: LanguageModelV3;
  taskScope?: TaskScopePolicy;
}): ToolCallCoordinator {
  const coordinator = new ToolCallCoordinator({
    compiledPolicy: testCompiledPolicy,
    toolAnnotations: testToolAnnotations,
    protectedPaths: TEST_PROTECTED_PATHS,
    allowedDirectory: TEST_SANDBOX_DIR,
    auditLogPath: join(root, 'audit.jsonl'),
    onEscalation: options.onEscalation,
    escalationTimeoutMs: 30_000,
    ...(options.autoApproveModel ? { autoApproveModel: options.autoApproveModel } : {}),
    ...(options.scope !== undefined ? { approvalHistoryScope: options.scope } : {}),
    ...(options.taskScope !== undefined ? { taskScope: options.taskScope } : {}),
    approvalHistoryPath: historyPath,
  });
  const state: ClientState = { client: null as unknown as Client, roots: [] };
  state.client = rootsAwareClient(state);
  const tools: ProxiedTool[] = testToolAnnotations.servers.filesystem.tools.map((a) => ({
    serverName: a.serverName,
    name: a.toolName,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  }));
  coordinator.registerTools('filesystem', tools, state);
  return coordinator;
}

/** Calls a filesystem tool on one path and returns the call's status. */
async function callOnPath(coordinator: ToolCallCoordinator, toolName: string, path: string): Promise<string> {
  const result = await coordinator.handleStructuredToolCall({
    requestId: uuidv4(),
    serverName: 'filesystem',
    toolName,
    arguments: { path },
    timestamp: new Date().toISOString(),
  });
  return result.status;
}

/** Escalates under the test policy (`escalate-write-outside-permitted-areas`). */
async function writeOutside(coordinator: ToolCallCoordinator, file = 'w.txt'): Promise<string> {
  return callOnPath(coordinator, 'write_file', `/tmp/outside-sandbox/${file}`);
}

function approvals(): ApprovalRecord[] {
  return readApprovalHistory({ path: historyPath }).filter((r): r is ApprovalRecord => r.type === 'approval');
}

describe('approval history from the coordinator', () => {
  it('records each human approval as its generalized pattern, and three of them yield one proposal', async () => {
    const coordinator = makeCoordinator({ scope: 'global', onEscalation: async () => ({ decision: 'approved' }) });
    try {
      for (const file of ['a.txt', 'b.txt', 'c.txt']) expect(await writeOutside(coordinator, file)).toBe('success');
    } finally {
      await coordinator.close();
    }
    const recorded = approvals();
    expect(recorded).toHaveLength(3);
    expect(recorded[0]).toMatchObject({
      scope: 'global',
      serverName: 'filesystem',
      toolName: 'write_file',
      rule: 'escalate-write-outside-permitted-areas',
    });
    expect(recorded[0].constraints).toHaveLength(1);
    expect(recorded[0].constraints[0]).toMatchObject({ kind: 'directory', role: 'write-path' });
    // The directory, never the file the agent named.
    expect(JSON.stringify(recorded)).not.toContain('a.txt');
    expect(new Set(recorded.map((r) => r.key)).size).toBe(1);

    const { proposals } = loadAmendmentProposals({ path: historyPath, homeDir: '/home/tester' });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].approvals).toBe(3);
  });

  it('does not record whitelist matches or human denials', async () => {
    let asked = 0;
    const coordinator = makeCoordinator({
      scope: 'global',
      onEscalation: async () => {
        asked += 1;
        return asked === 1 ? { decision: 'approved', whitelistSelection: 0 } : { decision: 'denied' };
      },
    });
    try {
      // `/approve+` whitelists the exact path approved (the first candidate).
      expect(await writeOutside(coordinator, 'a.txt')).toBe('success'); // human, whitelisted
      expect(await writeOutside(coordinator, 'a.txt')).toBe('success'); // whitelist match
      expect(asked).toBe(1);
    } finally {
      await coordinator.close();
    }
    expect(approvals()).toHaveLength(1);

    const denying = makeCoordinator({ scope: 'global', onEscalation: async () => ({ decision: 'denied' }) });
    try {
      expect(await writeOutside(denying)).toBe('denied');
    } finally {
      await denying.close();
    }
    expect(approvals()).toHaveLength(1);
  });

  it('does not record auto-approver decisions', async () => {
    const coordinator = makeCoordinator({
      scope: 'global',
      autoApproveModel: approvingModel(),
      onEscalation: async () => ({ decision: 'denied' }),
    });
    coordinator.setLastUserMessage('please write the file at /tmp/outside-sandbox, I authorize it');
    try {
      expect(await writeOutside(coordinator)).toBe('success');
    } finally {
      await coordinator.close();
    }
    expect(existsSync(historyPath)).toBe(false);
  });

  it('records nothing when the coordinator has no scope', async () => {
    const coordinator = makeCoordinator({ onEscalation: async () => ({ decision: 'approved' }) });
    try {
      expect(await writeOutside(coordinator)).toBe('success');
    } finally {
      await coordinator.close();
    }
    expect(existsSync(historyPath)).toBe(false);
  });

  it('attributes approvals to the persona whose policy loadPolicy installed', async () => {
    const policyDir = join(root, 'personas', 'coder', 'generated');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    const coordinator = makeCoordinator({ scope: 'global', onEscalation: async () => ({ decision: 'approved' }) });
    try {
      expect(await writeOutside(coordinator, 'a.txt')).toBe('success');
      await coordinator.loadPolicy({ persona: 'coder', policyDir });
      expect(await writeOutside(coordinator, 'b.txt')).toBe('success');
      await coordinator.loadPolicy({ persona: 'global', policyDir });
      expect(await writeOutside(coordinator, 'c.txt')).toBe('success');
    } finally {
      await coordinator.close();
    }
    expect(approvals().map((r) => r.scope)).toEqual(['global', 'persona:coder', 'global']);
  });

  it('records the directory-wide candidate even when the human whitelisted the exact path', async () => {
    const coordinator = makeCoordinator({
      scope: 'global',
      onEscalation: async () => ({ decision: 'approved', whitelistSelection: 0 }),
    });
    try {
      expect(await writeOutside(coordinator, 'a.txt')).toBe('success');
    } finally {
      await coordinator.close();
    }
    const recorded = approvals();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].constraints).toEqual([
      { kind: 'directory', role: 'write-path', directory: expect.stringMatching(/outside-sandbox$/) as string },
    ]);
    expect(recorded[0].description).toContain('(recursive)');
    expect(readFileSync(historyPath, 'utf8')).not.toContain('a.txt');
  });

  it('records nothing when the whitelist refuses a directory-wide grant for the approved path', async () => {
    // The parent directory is the home directory: the whitelist offers only
    // the exact path, and the history never stores an exact path.
    const coordinator = makeCoordinator({ scope: 'global', onEscalation: async () => ({ decision: 'approved' }) });
    try {
      expect(await callOnPath(coordinator, 'write_file', join(homedir(), 'notes.txt'))).toBe('success');
    } finally {
      await coordinator.close();
    }
    expect(existsSync(historyPath)).toBe(false);
  });

  it('does not record approvals of escalations the task scope raised', async () => {
    // The session policy escalates writes outside the sandbox and allows
    // reads in permitted-a and permitted-b. The task scope allows those
    // writes, covers no read in permitted-a and escalates reads in permitted-b.
    const taskScope: TaskScopePolicy = {
      compiledPolicy: taskScopePolicy('edit the reports', [
        scopeRule('task-allow-outside-writes', 'filesystem', {
          paths: { roles: ['write-path'], within: '/tmp/outside-sandbox' },
        }),
        scopeRule(
          'task-escalate-reads-b',
          'filesystem',
          { paths: { roles: ['read-path'], within: `${REAL_TMP}/permitted-b` } },
          'escalate',
        ),
      ]),
    };
    let asked = 0;
    const coordinator = makeCoordinator({
      scope: 'global',
      taskScope,
      onEscalation: async () => {
        asked += 1;
        return { decision: 'approved' };
      },
    });
    try {
      // The session policy's escalation: recorded.
      expect(await writeOutside(coordinator, 'a.txt')).toBe('success');
      // Out of the task scope (`task-scope-escalate`): not recorded.
      expect(await callOnPath(coordinator, 'read_file', `${REAL_TMP}/permitted-a/notes.txt`)).toBe('success');
      // A task rule's escalation: not recorded.
      expect(await callOnPath(coordinator, 'read_file', `${REAL_TMP}/permitted-b/notes.txt`)).toBe('success');
      expect(asked).toBe(3);
    } finally {
      await coordinator.close();
    }
    expect(approvals().map((r) => r.rule)).toEqual(['escalate-write-outside-permitted-areas']);
  });

  it('never lets a broken history affect the call', async () => {
    // A directory where the history file should be: every append fails.
    mkdirSync(historyPath);
    const coordinator = makeCoordinator({ scope: 'global', onEscalation: async () => ({ decision: 'approved' }) });
    try {
      expect(await writeOutside(coordinator)).toBe('success');
    } finally {
      await coordinator.close();
    }
    const audit = readFileSync(join(root, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"status":"success"');
  });
});
