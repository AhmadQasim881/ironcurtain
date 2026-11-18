/**
 * The coordinator-owned `workflow_commit` tool (WP-133, DOM-14).
 *
 * A workflow agent state commits its result through a tool call tied to its
 * invocation id; a turn that ends without an accepted call has not
 * committed, whatever its text says. These tests cover the orchestrator's
 * commit channel, the tool's argument checks, the coordinator and pipeline
 * that own the tool (policy, audit, in-process dispatch, persona swaps), the
 * prompts, and the orchestrator end to end: the agent below calls the tool
 * through a real ToolCallCoordinator, exactly as the Code Mode sandbox does,
 * with stub Docker bundles standing in for containers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowCommitChannel } from '../../src/workflow/workflow-commit.js';
import {
  WORKFLOW_COMMIT_LIMITS,
  WORKFLOW_COMMIT_SERVER,
  WORKFLOW_COMMIT_TOOL,
  parseWorkflowCommitArguments,
  type WorkflowCommitHandler,
} from '../../src/trusted-process/workflow-commit-tool.js';
import { ToolCallCoordinator } from '../../src/trusted-process/tool-call-coordinator.js';
import { RULE_CALL_CANCELLED } from '../../src/trusted-process/tool-call-pipeline.js';
import { EGRESS_ALLOWED_HOSTS_RULE, EGRESS_ESCALATE_RULE } from '../../src/trusted-process/egress-policy.js';
import { TASK_SCOPE_ESCALATE_RULE } from '../../src/trusted-process/policy-engine.js';
import { RESERVED_SERVER_NAMES } from '../../src/types/reserved-servers.js';
import { isDispatchingAuditEntry } from '../../src/types/audit.js';
import {
  WorkflowOrchestrator,
  type CreateWorkflowInfrastructureInput,
  type WorkflowOrchestratorDeps,
} from '../../src/workflow/orchestrator.js';
import {
  RESUME_NOTICE,
  buildAgentCommand,
  buildAgentReplacementCommand,
  buildArtifactReprompt,
} from '../../src/workflow/prompt-builder.js';
import type { AgentTurnResult, BundleId, SessionOptions } from '../../src/session/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type {
  AgentStateDefinition,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowId,
} from '../../src/workflow/types.js';
import { REAL_TMP, testCompiledPolicy, testToolAnnotations } from '../fixtures/test-policy.js';
import { scopeRule, taskScopePolicy } from '../fixtures/task-scope.js';
import {
  MockSession,
  type ResponseFn,
  approvedResponse,
  createDeps,
  stubPersonasForTest,
  waitForCompletion,
  writeDefinitionFile,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The invocation id the orchestrator put into a prompt (`invocation: "<uuid>"`). */
function invocationIdOf(prompt: string): string {
  const match = /invocation: "([0-9a-f-]{36})"/.exec(prompt);
  if (!match) throw new Error(`no invocation id in prompt:\n${prompt}`);
  return match[1];
}

/** A handler that records nothing; for coordinator tests that only need a target. */
function recordingHandler(): WorkflowCommitHandler & { attachCalls: number; requests: unknown[] } {
  const handler = {
    attachCalls: 0,
    requests: [] as unknown[],
    attach(): void {
      handler.attachCalls++;
    },
    commit(request: unknown) {
      handler.requests.push(request);
      return { accepted: true as const, message: 'recorded' };
    },
  };
  return handler;
}

/** A session that answers its turns with `turns`, in order (MockSession returns array entries verbatim). */
function scriptedSession(...turns: ResponseFn[]): MockSession {
  let index = 0;
  return new MockSession({
    responses: (prompt) => {
      if (index >= turns.length) throw new Error(`no scripted turn ${index + 1}`);
      return turns[index++](prompt);
    },
  });
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeStubInfrastructure(workflowId: string, bundleId: BundleId): DockerInfrastructure {
  return {
    workflowId,
    bundleId,
    runtimeKind: 'docker',
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  } as unknown as DockerInfrastructure;
}

// ---------------------------------------------------------------------------
// The orchestrator's commit channel
// ---------------------------------------------------------------------------

describe('WorkflowCommitChannel', () => {
  it('is attached only once a coordinator registered the tool', () => {
    const channel = new WorkflowCommitChannel();
    expect(channel.isAttached).toBe(false);
    channel.attach();
    expect(channel.isAttached).toBe(true);
  });

  it('records the commit of an open invocation', () => {
    const channel = new WorkflowCommitChannel();
    const invocation = channel.open({ stateId: 'review' });
    expect(invocation.committed()).toBeUndefined();

    const outcome = channel.commit({ invocation: invocation.id, verdict: 'approved', notes: 'ok', handoff: 'next' });

    expect(outcome).toEqual({ accepted: true, message: expect.stringContaining('"review"') as unknown });
    expect(invocation.committed()).toMatchObject({
      invocationId: invocation.id,
      verdict: 'approved',
      notes: 'ok',
      handoff: 'next',
    });
  });

  it('refuses an unknown id without revealing the invocation that is open', () => {
    const channel = new WorkflowCommitChannel();
    const open = channel.open({ stateId: 'review' });

    const outcome = channel.commit({ invocation: '00000000-0000-4000-8000-000000000000', verdict: 'approved' });

    expect(outcome.accepted).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(open.id);
    expect(open.committed()).toBeUndefined();
  });

  it('refuses a commit for an invocation that has ended', () => {
    const channel = new WorkflowCommitChannel();
    const invocation = channel.open({ stateId: 'review' });
    invocation.close();
    invocation.close(); // idempotent

    expect(channel.commit({ invocation: invocation.id, verdict: 'approved' }).accepted).toBe(false);
    expect(channel.openInvocationCount).toBe(0);
  });

  it('keeps the first commit: a second call is refused and changes nothing', () => {
    const channel = new WorkflowCommitChannel();
    const invocation = channel.open({ stateId: 'review' });
    expect(channel.commit({ invocation: invocation.id, verdict: 'approved' }).accepted).toBe(true);

    const second = channel.commit({ invocation: invocation.id, verdict: 'rejected' });

    expect(second).toEqual({ accepted: false, reason: expect.stringContaining('already committed') as unknown });
    expect(invocation.committed()?.verdict).toBe('approved');
  });

  it('refuses a verdict the state does not route on, naming the valid ones', () => {
    const channel = new WorkflowCommitChannel();
    const invocation = channel.open({ stateId: 'review', validVerdicts: new Set(['approved', 'rejected']) });

    const refused = channel.commit({ invocation: invocation.id, verdict: 'maybe' });

    expect(refused.accepted).toBe(false);
    expect(refused.accepted ? '' : refused.reason).toContain('"approved", "rejected"');
    expect(invocation.committed()).toBeUndefined();
    expect(channel.commit({ invocation: invocation.id, verdict: 'rejected' }).accepted).toBe(true);
  });

  it('keeps concurrently open invocations (fan-out lanes) apart', () => {
    const channel = new WorkflowCommitChannel();
    const laneA = channel.open({ stateId: 'research' });
    const laneB = channel.open({ stateId: 'research' });
    expect(laneA.id).not.toBe(laneB.id);

    channel.commit({ invocation: laneB.id, verdict: 'b' });

    expect(laneA.committed()).toBeUndefined();
    expect(laneB.committed()?.verdict).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Tool arguments
// ---------------------------------------------------------------------------

describe('parseWorkflowCommitArguments', () => {
  const id = '3f1c2a64-1111-4a2b-8c3d-5e6f7a8b9c0d';

  it('trims the fields and drops empty optional ones', () => {
    expect(
      parseWorkflowCommitArguments({ invocation: ` ${id} `, verdict: ' approved ', notes: '  ', handoff: '' }),
    ).toEqual({ ok: true, request: { invocation: id, verdict: 'approved' } });
  });

  it.each([
    [{ verdict: 'approved' }, 'Missing required argument "invocation"'],
    [{ invocation: id }, 'Missing required argument "verdict"'],
    [{ invocation: id, verdict: '   ' }, 'must not be empty'],
    [{ invocation: id, verdict: 7 }, 'must be a string'],
    [{ invocation: 'not an id!', verdict: 'approved' }, 'not an invocation id'],
    [{ invocation: id, verdict: 'approved\nrejected' }, 'single line'],
    [{ invocation: id, verdict: 'appro\u0007ved' }, 'single line'],
    [{ invocation: id, verdict: 'a b' }, 'single line'],
    [{ invocation: id, verdict: 'v'.repeat(WORKFLOW_COMMIT_LIMITS.verdict + 1) }, 'too long'],
    [{ invocation: id, verdict: 'ok', notes: 'n'.repeat(WORKFLOW_COMMIT_LIMITS.notes + 1) }, 'too long'],
    [{ invocation: id, verdict: 'ok', handoff: 'h'.repeat(WORKFLOW_COMMIT_LIMITS.handoff + 1) }, 'too long'],
  ])('refuses %j', (args, message) => {
    const parsed = parseWorkflowCommitArguments(args);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toContain(message);
  });

  it('reserves the virtual server name', () => {
    expect(RESERVED_SERVER_NAMES.has(WORKFLOW_COMMIT_SERVER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coordinator and pipeline
// ---------------------------------------------------------------------------

describe('ToolCallCoordinator workflow_commit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-commit-coordinator-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeCoordinator(workflowCommit?: WorkflowCommitHandler): {
    coordinator: ToolCallCoordinator;
    audit: string;
  } {
    const audit = join(dir, 'audit.jsonl');
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: [],
      allowedDirectory: dir,
      auditLogPath: audit,
      ...(workflowCommit ? { workflowCommit } : {}),
    });
    return { coordinator, audit };
  }

  it('registers the tool, attaches the handler once and dispatches an allowed, audited commit to it', async () => {
    const handler = recordingHandler();
    const { coordinator, audit } = makeCoordinator(handler);
    try {
      expect(handler.attachCalls).toBe(1);
      expect(
        coordinator
          .getRegisteredTools()
          .some((tool) => tool.serverName === WORKFLOW_COMMIT_SERVER && tool.name === WORKFLOW_COMMIT_TOOL),
      ).toBe(true);

      const response = await coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, {
        invocation: 'abc-123',
        verdict: ' approved ',
        notes: 'summary',
      });

      expect(response.isError).toBeFalsy();
      expect(response.content).toEqual([{ type: 'text', text: 'recorded' }]);
      expect(response._policyDecision).toMatchObject({ status: 'allow', rule: 'workflow-commit-allow' });
      expect(handler.requests).toEqual([{ invocation: 'abc-123', verdict: 'approved', notes: 'summary' }]);
      // Write-ahead record, then the outcome, like every dispatched call.
      const entries = readJsonl(audit);
      expect(entries.map((entry) => isDispatchingAuditEntry(entry))).toEqual([true, false]);
      expect(entries[1]).toMatchObject({
        serverName: 'workflow',
        toolName: 'workflow_commit',
        result: { status: 'success' },
      });
    } finally {
      await coordinator.close();
    }
  });

  it('denies malformed arguments before the handler sees them', async () => {
    const handler = recordingHandler();
    const { coordinator, audit } = makeCoordinator(handler);
    try {
      const missing = await coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, {
        invocation: 'abc-123',
      });
      const unknownArg = await coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, {
        invocation: 'abc-123',
        verdict: 'approved',
        status: 'done',
      });

      expect(missing.isError).toBe(true);
      expect(missing._policyDecision).toMatchObject({ status: 'deny', rule: 'invalid-arguments' });
      expect(unknownArg.isError).toBe(true);
      expect(handler.requests).toEqual([]);
      expect(readJsonl(audit)).toHaveLength(2);
    } finally {
      await coordinator.close();
    }
  });

  it("returns the handler's refusal to the agent as an error and audits it", async () => {
    const channel = new WorkflowCommitChannel();
    const { coordinator, audit } = makeCoordinator(channel);
    try {
      const response = await coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, {
        invocation: '00000000-0000-4000-8000-000000000000',
        verdict: 'approved',
      });

      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain('no open workflow state invocation');
      expect(readJsonl(audit).at(-1)).toMatchObject({ result: { status: 'error' } });
    } finally {
      await coordinator.close();
    }
  });

  it('offers no such tool without a handler', async () => {
    const { coordinator } = makeCoordinator();
    try {
      expect(coordinator.getRegisteredTools().some((tool) => tool.serverName === WORKFLOW_COMMIT_SERVER)).toBe(false);
      const response = await coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, {
        invocation: 'abc-123',
        verdict: 'approved',
      });
      expect(response.isError).toBe(true);
      expect(response._policyDecision).toMatchObject({ rule: 'unknown-tool' });
    } finally {
      await coordinator.close();
    }
  });

  it('keeps the tool allowed across a persona policy swap', async () => {
    const previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = dir;
    const handler = recordingHandler();
    const { coordinator } = makeCoordinator(handler);
    try {
      const policyDir = join(dir, 'personas', 'reviewer', 'generated');
      mkdirSync(policyDir, { recursive: true });
      // A persona policy with no rules at all: default deny for everything else.
      writeFileSync(join(policyDir, 'compiled-policy.json'), JSON.stringify({ ...testCompiledPolicy, rules: [] }));
      await coordinator.loadPolicy({ persona: 'reviewer', policyDir });

      const response = await coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, {
        invocation: 'abc-123',
        verdict: 'approved',
      });

      expect(response.isError).toBeFalsy();
      expect(handler.requests).toHaveLength(1);
    } finally {
      await coordinator.close();
      if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = previousHome;
    }
  });

  /** Installs an empty persona policy (default deny for everything else) under `dir`. */
  async function swapToEmptyPersona(coordinator: ToolCallCoordinator): Promise<void> {
    const policyDir = join(dir, 'personas', 'reviewer', 'generated');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, 'compiled-policy.json'), JSON.stringify({ ...testCompiledPolicy, rules: [] }));
    await coordinator.loadPolicy({ persona: 'reviewer', policyDir });
  }

  // A task scope (`--task-scoped`, WP-119) is compiled from the task text and
  // never names the virtual `workflow` server. The coordinator gives it the
  // commit rule as it gives every session policy; without it each commit of
  // a task-scoped workflow would escalate as outside the task scope.
  it('keeps the tool allowed under a task scope, before and after a persona swap', async () => {
    const previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = dir;
    const handler = recordingHandler();
    const escalations: string[] = [];
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      taskScope: {
        compiledPolicy: taskScopePolicy('Summarize the reports in permitted-a.', [
          scopeRule('scope-read-a', 'filesystem', {
            paths: { roles: ['read-path'], within: `${REAL_TMP}/permitted-a` },
          }),
        ]),
      },
      protectedPaths: [],
      allowedDirectory: dir,
      auditLogPath: join(dir, 'audit.jsonl'),
      workflowCommit: handler,
      onEscalation: async (_request, reason) => {
        escalations.push(reason);
        return { decision: 'denied' };
      },
    });
    const commit = (invocation: string) =>
      coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, { invocation, verdict: 'approved' });
    try {
      expect(coordinator.hasTaskScope()).toBe(true);
      // The scope still narrows everything else: a read the session policy
      // allows outside the scope's directory escalates.
      expect(
        coordinator.getPolicyEngine().evaluate({
          requestId: 'r1',
          serverName: 'filesystem',
          toolName: 'read_file',
          arguments: { path: `${REAL_TMP}/permitted-b/report.txt` },
          timestamp: new Date().toISOString(),
        }),
      ).toMatchObject({ decision: 'escalate', rule: TASK_SCOPE_ESCALATE_RULE });

      const before = await commit('abc-1');
      expect(before.isError).toBeFalsy();
      expect(before._policyDecision).toMatchObject({ status: 'allow', rule: 'workflow-commit-allow' });

      await swapToEmptyPersona(coordinator);
      const after = await commit('abc-2');
      expect(after.isError).toBeFalsy();
      expect(after._policyDecision).toMatchObject({ status: 'allow', rule: 'workflow-commit-allow' });

      expect(escalations).toEqual([]);
      expect(handler.requests).toEqual([
        { invocation: 'abc-1', verdict: 'approved' },
        { invocation: 'abc-2', verdict: 'approved' },
      ]);
    } finally {
      await coordinator.close();
      if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = previousHome;
    }
  });

  // Policy-evaluated MITM egress (WP-118) adds its own hardcoded `network`
  // rules after the compiled ones; the commit rule goes ahead of them. Both
  // sets must survive construction and every persona swap.
  it('keeps the tool and the egress rules together when policy-evaluated egress is on', async () => {
    const previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = dir;
    const handler = recordingHandler();
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: [],
      allowedDirectory: dir,
      auditLogPath: join(dir, 'audit.jsonl'),
      workflowCommit: handler,
      egressPolicy: { allowedHosts: ['allowed.example.com'] },
      onEscalation: async () => ({ decision: 'denied' }),
    });
    const connect = (host: string) => coordinator.authorizeEgress({ method: 'CONNECT', host, port: 443 });
    const expectBoth = async (invocation: string): Promise<void> => {
      const response = await coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, {
        invocation,
        verdict: 'approved',
      });
      expect(response._policyDecision).toMatchObject({ status: 'allow', rule: 'workflow-commit-allow' });
      expect(await connect('allowed.example.com')).toMatchObject({
        allowed: true,
        settledBy: 'policy',
        rule: EGRESS_ALLOWED_HOSTS_RULE,
      });
      expect(await connect('other.example.com')).toMatchObject({ allowed: false, rule: EGRESS_ESCALATE_RULE });
    };
    try {
      await expectBoth('abc-1');
      await swapToEmptyPersona(coordinator);
      await expectBoth('abc-2');
      expect(handler.requests).toHaveLength(2);
    } finally {
      await coordinator.close();
      if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = previousHome;
    }
  });

  // Cancellable execute_code (WP-55): a call whose script ended (the agent
  // was told it failed) is never acted on. A commit routes the workflow, so
  // it records nothing either.
  it('records nothing for a commit whose caller cancelled it', async () => {
    const handler = recordingHandler();
    const { coordinator, audit } = makeCoordinator(handler);
    try {
      const controller = new AbortController();
      controller.abort(new DOMException('the script timed out', 'AbortError'));
      const response = await coordinator.handleToolCall(
        WORKFLOW_COMMIT_SERVER,
        WORKFLOW_COMMIT_TOOL,
        { invocation: 'abc-123', verdict: 'approved' },
        { signal: controller.signal },
      );

      expect(response.isError).toBe(true);
      expect(response._policyDecision).toMatchObject({ status: 'deny', rule: RULE_CALL_CANCELLED });
      expect(handler.requests).toEqual([]);
      expect(readJsonl(audit).some((entry) => isDispatchingAuditEntry(entry))).toBe(false);
    } finally {
      await coordinator.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe('commit-tool prompts', () => {
  const stateConfig: AgentStateDefinition = {
    type: 'agent',
    description: 'Reviews',
    persona: 'global',
    prompt: 'Review the code.',
    inputs: [],
    outputs: [],
    transitions: [
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'fix', when: { verdict: 'rejected' } },
    ],
  };
  const definition: WorkflowDefinition = {
    name: 'prompts',
    description: 'prompts',
    initial: 'review',
    states: {
      review: stateConfig,
      fix: { type: 'terminal', description: 'Fix' },
      done: { type: 'terminal', description: 'Done' },
    },
  };
  const context: WorkflowContext = {
    taskDescription: 'task',
    artifacts: {},
    round: 0,
    maxRounds: 3,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    totalTokens: 0,
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: { review: 1 },
  };
  const commit = { invocationId: '3f1c2a64-1111-4a2b-8c3d-5e6f7a8b9c0d' };

  it('tells the agent to commit through the tool, with its invocation id and the routing verdicts', () => {
    const prompt = buildAgentCommand('review', stateConfig, context, definition, { commit });

    expect(prompt).toContain('workflow.commit({');
    expect(prompt).toContain(`invocation: "${commit.invocationId}"`);
    expect(prompt).toContain('exactly one of: `approved`, `rejected`');
    expect(prompt).not.toContain('include the following YAML block');
  });

  it('keeps the YAML status block without a commit tool', () => {
    const prompt = buildAgentCommand('review', stateConfig, context, definition);
    expect(prompt).toContain('agent_status:');
    expect(prompt).not.toContain('workflow.commit');
  });

  it('carries the current invocation id into a re-visit of a continued conversation', () => {
    const revisit = buildAgentCommand(
      'review',
      { ...stateConfig, freshSession: false },
      { ...context, visitCounts: { review: 2 } },
      definition,
      { commit },
    );
    expect(revisit).toContain('## Round');
    expect(revisit).toContain(`invocation: "${commit.invocationId}"`);
  });

  it('pairs the resume notice with the commit instructions when a resume replays the invocation', () => {
    const options = { resumeReplay: true, commit };
    const first = buildAgentCommand('review', stateConfig, context, definition, options);
    const revisit = buildAgentCommand(
      'review',
      { ...stateConfig, freshSession: false },
      { ...context, visitCounts: { review: 2 } },
      definition,
      options,
    );
    const replacement = buildAgentReplacementCommand(
      'review',
      stateConfig,
      context,
      definition,
      { incompleteOutputExcerpts: [] },
      options,
    );

    for (const prompt of [first, revisit, replacement]) {
      expect(prompt.startsWith(RESUME_NOTICE)).toBe(true);
      expect(prompt).toContain(`invocation: "${commit.invocationId}"`);
      expect(prompt).not.toContain('include the following YAML block');
    }
  });

  it('tells a committed state its verdict stands when only artifacts are missing', () => {
    const committed = buildArtifactReprompt(['report'], stateConfig.transitions, { ...commit, committed: true });
    const uncommitted = buildArtifactReprompt(['report'], stateConfig.transitions, { ...commit, committed: false });

    expect(committed).toContain('verdict, which stands');
    expect(committed).not.toContain('invocation:');
    expect(uncommitted).toContain(`invocation: "${commit.invocationId}"`);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator, end to end through a real coordinator
// ---------------------------------------------------------------------------

const routedDef: WorkflowDefinition = {
  name: 'commit-routing',
  description: 'An agent state that routes on its committed verdict',
  initial: 'analyze',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    analyze: {
      type: 'agent',
      description: 'Analyzes the target',
      persona: 'global',
      prompt: 'Analyze the target.',
      inputs: [],
      outputs: [],
      transitions: [
        { to: 'report', when: { verdict: 'approved' } },
        { to: 'rework', when: { verdict: 'rejected' } },
      ],
    },
    report: {
      type: 'agent',
      description: 'Writes the report',
      persona: 'global',
      prompt: 'Write the report.',
      inputs: [],
      outputs: [],
      transitions: [{ to: 'done' }],
    },
    rework: { type: 'terminal', description: 'Needs rework' },
    done: { type: 'terminal', description: 'Done' },
  },
};

describe('WorkflowOrchestrator with workflow_commit', () => {
  let tmpDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;
  let coordinators: ToolCallCoordinator[];
  let cleanupPersonas: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-commit-orchestrator-'));
    coordinators = [];
    orchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(tmpDir, routedDef);
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    for (const coordinator of coordinators) await coordinator.close();
    cleanupPersonas();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A bundle factory whose "container" runs a real ToolCallCoordinator built
   * with the bundle's commit channel, as `createDockerInfrastructure` builds
   * the Code Mode sandbox's coordinator. `commit` is what an agent's
   * `workflow.commit({...})` reaches through UTCP.
   */
  function coordinatorBundles(): {
    createInfra: ReturnType<typeof vi.fn>;
    commit: (args: Record<string, unknown>) => ReturnType<ToolCallCoordinator['handleToolCall']>;
    audit: () => Record<string, unknown>[];
  } {
    const auditPath = join(tmpDir, 'bundle-audit.jsonl');
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: [],
        allowedDirectory: input.workspacePath,
        auditLogPath: auditPath,
        ...(input.workflowCommit ? { workflowCommit: input.workflowCommit } : {}),
      });
      coordinators.push(coordinator);
      return makeStubInfrastructure(input.workflowId, input.bundleId);
    });
    return {
      createInfra,
      commit: (args) => {
        const coordinator = coordinators.at(-1);
        if (!coordinator) throw new Error('no bundle coordinator yet');
        return coordinator.handleToolCall(WORKFLOW_COMMIT_SERVER, WORKFLOW_COMMIT_TOOL, args);
      },
      audit: () => readJsonl(auditPath),
    };
  }

  function start(
    sessions: MockSession[],
    createInfra: ReturnType<typeof vi.fn>,
  ): { started: Promise<string>; createSession: ReturnType<typeof vi.fn> } {
    let index = 0;
    const createSession = vi.fn(async () => {
      if (index >= sessions.length) throw new Error(`unexpected session ${index + 1}`);
      return sessions[index++];
    });
    orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession,
        createWorkflowInfrastructure: createInfra as never,
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    return { started: orchestrator.start(writeDefinitionFile(tmpDir, routedDef), 'find the bug'), createSession };
  }

  function messageLog(workflowId: string): Record<string, unknown>[] {
    return readJsonl(join(tmpDir, workflowId, 'messages.jsonl'));
  }

  it('counts a truncated end_turn without workflow_commit as uncommitted and continues the agent', async () => {
    const bundles = coordinatorBundles();
    let analyzeId = '';
    const analyze = scriptedSession(
      (prompt) => {
        analyzeId = invocationIdOf(prompt);
        // The upstream dropped the tool call: an ordinary end_turn that ends
        // mid-investigation, with no commit.
        return 'Both call `__sanitizer_cov_8bit_counters_init`. Let me check the start/stop symbols:';
      },
      async (prompt) => {
        expect(prompt).toContain('this state has not committed');
        expect(invocationIdOf(prompt)).toBe(analyzeId);
        const response = await bundles.commit({
          invocation: analyzeId,
          verdict: 'approved',
          notes: 'found the overflow',
          handoff: 'Write up the overflow in parse_header().',
        });
        expect(response.isError).toBeFalsy();
        return 'The symbols are present; committed.';
      },
    );
    let reportPrompt = '';
    const report = scriptedSession(async (prompt) => {
      reportPrompt = prompt;
      await bundles.commit({ invocation: invocationIdOf(prompt), verdict: 'written' });
      return 'Report written.';
    });
    const { started } = start([analyze, report], bundles.createInfra);
    const workflowId = (await started) as never;
    await waitForCompletion(orchestrator as WorkflowOrchestrator, workflowId);

    expect(orchestrator?.getStatus(workflowId)?.phase).toBe('completed');
    expect(analyze.sentMessages).toHaveLength(2);
    expect(analyze.sentMessages[0]).toContain('workflow.commit({');
    expect(analyze.sentMessages[0]).not.toContain('include the following YAML block');

    const retries = messageLog(workflowId).filter((entry) => entry.type === 'agent_retry');
    expect(retries).toEqual([expect.objectContaining({ reason: 'missing_commit' })]);
    // The committed verdict routed the run, and the handoff and notes are
    // what the next state was given.
    expect(reportPrompt).toContain('Write up the overflow in parse_header().');
    expect(reportPrompt).toContain('found the overflow');
    expect(reportPrompt).not.toContain('Let me check the start/stop symbols');

    // Each commit is an audited, allowed tool call.
    const commits = bundles
      .audit()
      .filter((entry) => entry.toolName === 'workflow_commit' && !isDispatchingAuditEntry(entry));
    expect(commits.map((entry) => (entry.result as { status: string }).status)).toEqual(['success', 'success']);

    // The invocation is over: a late commit naming it is refused.
    const late = await bundles.commit({ invocation: analyzeId, verdict: 'rejected' });
    expect(late.isError).toBe(true);
  });

  it('never reads a YAML status block when the tool is offered', async () => {
    const bundles = coordinatorBundles();
    const analyze = scriptedSession(
      // A well-formed agent_status block, but no commit: not committed.
      () => approvedResponse('looks fine'),
      async (prompt) => {
        await bundles.commit({ invocation: invocationIdOf(prompt), verdict: 'rejected', notes: 'actually broken' });
        return 'Committed.';
      },
    );
    const { started } = start([analyze], bundles.createInfra);
    const workflowId = (await started) as never;
    await waitForCompletion(orchestrator as WorkflowOrchestrator, workflowId);

    // The YAML block's `approved` would have gone to `report`.
    const history = orchestrator?.getDetail(workflowId)?.transitionHistory ?? [];
    expect(history.map((record) => record.to)).toEqual(['rework']);
    expect(analyze.sentMessages).toHaveLength(2);
  });

  it('lets the agent correct a refused verdict within its turn', async () => {
    const bundles = coordinatorBundles();
    const analyze = scriptedSession(async (prompt) => {
      const invocation = invocationIdOf(prompt);
      const refused = await bundles.commit({ invocation, verdict: 'looks good' });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('\\"approved\\", \\"rejected\\"');
      await bundles.commit({ invocation, verdict: 'rejected' });
      return 'Committed after correcting the verdict.';
    });
    const { started } = start([analyze], bundles.createInfra);
    const workflowId = (await started) as never;
    await waitForCompletion(orchestrator as WorkflowOrchestrator, workflowId);

    expect(orchestrator?.getDetail(workflowId)?.transitionHistory.map((record) => record.to)).toEqual(['rework']);
    expect(analyze.sentMessages).toHaveLength(1);
    expect(messageLog(workflowId).filter((entry) => entry.type === 'agent_retry')).toEqual([]);
  });

  it('keeps a commit made before the agent CLI failed, without re-running the state', async () => {
    const bundles = coordinatorBundles();
    const analyze = scriptedSession(async (prompt): Promise<AgentTurnResult> => {
      await bundles.commit({ invocation: invocationIdOf(prompt), verdict: 'approved', notes: 'overflow found' });
      return { text: 'Agent exited with code 137 (killed)', hardFailure: true };
    });
    let reportPrompt = '';
    const report = scriptedSession(async (prompt) => {
      reportPrompt = prompt;
      await bundles.commit({ invocation: invocationIdOf(prompt), verdict: 'written' });
      return 'Report written.';
    });
    const { started } = start([analyze, report], bundles.createInfra);
    const workflowId = (await started) as never;
    await waitForCompletion(orchestrator as WorkflowOrchestrator, workflowId);

    expect(orchestrator?.getDetail(workflowId)?.transitionHistory.map((record) => record.to)).toEqual([
      'report',
      'done',
    ]);
    expect(analyze.sentMessages).toHaveLength(1);
    // The broken conversation is not resumed by a later visit.
    expect(analyze.rotateCalls).toHaveLength(1);
    // The notes reach the next state; the failed turn's error text does not.
    expect(reportPrompt).toContain('overflow found');
    expect(reportPrompt).not.toContain('exited with code 137');
  });

  it('fails the state when no turn ever commits', async () => {
    const bundles = coordinatorBundles();
    const analyze = new MockSession({ responses: () => 'Still working on it...' });
    const { started } = start([analyze], bundles.createInfra);
    const workflowId = (await started) as never;
    await waitForCompletion(orchestrator as WorkflowOrchestrator, workflowId);

    // Primary turn, two continuations, one fresh replacement.
    expect(analyze.sentMessages).toHaveLength(4);
    expect(analyze.sentMessages[3]).toContain('## Recovery handoff');
    expect(new Set(analyze.sentMessages.map((message) => invocationIdOf(message))).size).toBe(1);
    const status = orchestrator?.getStatus(workflowId);
    expect(status?.phase).toBe('failed');
    expect(JSON.stringify(status)).toContain('no accepted workflow_commit call');
  });

  it('falls back to the YAML status block when the bundle offers no tool', async () => {
    // A factory that ignores the channel: nothing attaches it.
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const analyze = new MockSession({ responses: [approvedResponse('fine')] });
    const report = new MockSession({ responses: [approvedResponse('written')] });
    const { started } = start([analyze, report], createInfra);
    const workflowId = (await started) as never;
    await waitForCompletion(orchestrator as WorkflowOrchestrator, workflowId);

    expect(orchestrator?.getStatus(workflowId)?.phase).toBe('completed');
    expect(analyze.sentMessages[0]).toContain('agent_status:');
    expect(analyze.sentMessages[0]).not.toContain('workflow.commit');
  });
});

describe('WorkflowOrchestrator workflow_commit without a shared bundle', () => {
  let tmpDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: () => void;

  const perStateDef: WorkflowDefinition = {
    ...routedDef,
    name: 'commit-per-state',
    settings: { mode: 'docker', dockerAgent: 'claude-code' },
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-commit-per-state-'));
    cleanupPersonas = stubPersonasForTest(tmpDir, perStateDef);
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    cleanupPersonas();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hands each state's session its own commit target, which the session's coordinator attaches", async () => {
    const options: SessionOptions[] = [];
    const createSession = vi.fn(async (sessionOptions: SessionOptions) => {
      options.push(sessionOptions);
      const handler = sessionOptions.workflow?.workflowCommit;
      // The session's own coordinator registers the tool.
      handler?.attach();
      const verdict = options.length === 1 ? 'approved' : 'done';
      return scriptedSession((prompt) => {
        handler?.commit({ invocation: invocationIdOf(prompt), verdict });
        return 'Committed.';
      });
    });
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession }));
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, perStateDef), 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(options).toHaveLength(2);
    const [first, second] = options.map((sessionOptions) => sessionOptions.workflow?.workflowCommit);
    expect(first).toBeInstanceOf(WorkflowCommitChannel);
    expect(second).toBeInstanceOf(WorkflowCommitChannel);
    expect(first).not.toBe(second);
  });

  it('passes no session commit target when the state borrows a bundle', async () => {
    const sharedDef: WorkflowDefinition = { ...perStateDef, name: 'commit-borrow', settings: routedDef.settings };
    const options: SessionOptions[] = [];
    orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: vi.fn(async (sessionOptions: SessionOptions) => {
          options.push(sessionOptions);
          return new MockSession({ responses: [approvedResponse('ok')] });
        }),
        createWorkflowInfrastructure: async (input) => makeStubInfrastructure(input.workflowId, input.bundleId),
        destroyWorkflowInfrastructure: async () => {},
      }),
    );
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, sharedDef), 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(options.length).toBeGreaterThan(0);
    for (const sessionOptions of options) {
      expect(sessionOptions.workflow?.infrastructure).toBeDefined();
      expect(sessionOptions.workflow?.workflowCommit).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// A commit outlives the end of its turn
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator workflow_commit through a failed end of turn', () => {
  let tmpDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: () => void;

  /** `routedDef` with per-state containers; `analyze` may also require an output. */
  function definitionWith(outputs: string[]): WorkflowDefinition {
    const analyze = routedDef.states.analyze;
    if (analyze.type !== 'agent') throw new Error('analyze is an agent state');
    return {
      ...routedDef,
      name: 'commit-end-of-turn',
      settings: { mode: 'docker', dockerAgent: 'claude-code' },
      states: { ...routedDef.states, analyze: { ...analyze, outputs } },
    };
  }

  interface TurnTools {
    /** `workflow.commit` for the invocation named in this turn's prompt; the commit must be accepted. */
    commit(verdict: string, extra?: { notes?: string; handoff?: string }): void;
    /** Creates the named artifact output, as an agent writing `.workflow/<name>/` would. */
    writeOutput(name: string): void;
  }
  type Turn = (prompt: string, tools: TurnTools) => AgentTurnResult | string;

  /**
   * One per-state session per entry, each answering its turns in order. Each
   * session attaches its commit target, as the coordinator it builds would.
   */
  function sessions(...scripts: Turn[][]): {
    createSession: WorkflowOrchestratorDeps['createSession'];
    created: MockSession[];
  } {
    const created: MockSession[] = [];
    const createSession = vi.fn(async (options: SessionOptions) => {
      const turns = scripts.at(created.length);
      if (!turns) throw new Error(`unexpected session ${created.length + 1}`);
      const handler = options.workflow?.workflowCommit;
      if (!handler) throw new Error('per-state session without a commit target');
      handler.attach();
      const session = scriptedSession(
        ...turns.map(
          (turn): ResponseFn =>
            (prompt) =>
              turn(prompt, {
                commit: (verdict, extra = {}) => {
                  const outcome = handler.commit({ invocation: invocationIdOf(prompt), verdict, ...extra });
                  if (!outcome.accepted) throw new Error(`commit refused: ${outcome.reason}`);
                },
                writeOutput: (name) => {
                  const dir = join(options.workspacePath ?? '', '.workflow', name);
                  mkdirSync(dir, { recursive: true });
                  writeFileSync(join(dir, `${name}.md`), `content for ${name}`);
                },
              }),
        ),
      );
      created.push(session);
      return session;
    });
    return { createSession, created };
  }

  async function run(
    definition: WorkflowDefinition,
    createSession: WorkflowOrchestratorDeps['createSession'],
  ): Promise<WorkflowId> {
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession }));
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'find the bug');
    await waitForCompletion(orchestrator, workflowId);
    return workflowId;
  }

  function messageLog(workflowId: string): Record<string, unknown>[] {
    return readJsonl(join(tmpDir, workflowId, 'messages.jsonl'));
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-commit-end-of-turn-'));
    cleanupPersonas = stubPersonasForTest(tmpDir, routedDef);
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    cleanupPersonas();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const upstreamFailures: Array<[string, Partial<AgentTurnResult>]> = [
    ['transient_failure', { transientFailure: { kind: 'upstream_5xx', rawMessage: 'API Error: 529 overloaded' } }],
    ['quota_exhausted', { quotaExhausted: { rawMessage: 'API Error: 429 rate limited' } }],
  ];

  it.each(upstreamFailures)(
    'keeps a commit made before an upstream failure (%s) ended the turn',
    async (entryType, failure) => {
      let reportPrompt = '';
      const { createSession, created } = sessions(
        [
          (_prompt, { commit }) => {
            commit('approved', { notes: 'found the overflow', handoff: 'Write up the overflow in parse_header().' });
            // The provider failed on the agent's closing message, after the commit.
            return { text: 'API Error', hardFailure: false, ...failure };
          },
        ],
        [
          (prompt, { commit }) => {
            reportPrompt = prompt;
            commit('written');
            return 'Report written.';
          },
        ],
      );
      const workflowId = await run(definitionWith([]), createSession);

      // The commit routed the run and nothing was re-run; the run did not park.
      expect(orchestrator?.getStatus(workflowId)?.phase).toBe('completed');
      expect(orchestrator?.getDetail(workflowId)?.transitionHistory.map((record) => record.to)).toEqual([
        'report',
        'done',
      ]);
      expect(created[0].sentMessages).toHaveLength(1);
      // The failed conversation is not resumed by a later visit.
      expect(created[0].rotateCalls).toHaveLength(1);
      expect(reportPrompt).toContain('Write up the overflow in parse_header().');
      expect(reportPrompt).toContain('found the overflow');
      expect(reportPrompt).not.toContain('API Error');
      // The upstream failure is still on record.
      expect(messageLog(workflowId).filter((entry) => entry.type === entryType)).toHaveLength(1);
    },
  );

  it.each(upstreamFailures)(
    'still stops resumably on an upstream failure (%s) after a commit when an output is missing',
    async (_entryType, failure) => {
      const { createSession } = sessions([
        (_prompt, { commit }) => {
          // Committed, but the required `findings` output was never written:
          // the turn that would write it cannot run against this upstream.
          commit('approved');
          return { text: 'API Error', hardFailure: false, ...failure };
        },
      ]);
      const workflowId = await run(definitionWith(['findings']), createSession);

      expect(orchestrator?.getStatus(workflowId)?.phase).toBe('aborted');
      expect(createSession).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a commit through an upstream failure on the turn that wrote the missing output', async () => {
    const { createSession, created } = sessions(
      [
        (_prompt, { commit }) => {
          commit('approved', { notes: 'overflow found' });
          return 'Committed; writing the findings next.';
        },
        (_prompt, { writeOutput }) => {
          writeOutput('findings');
          return { text: 'API Error', hardFailure: false, ...upstreamFailures[0][1] };
        },
      ],
      [
        (_prompt, { commit }) => {
          commit('written');
          return 'Report written.';
        },
      ],
    );
    const workflowId = await run(definitionWith(['findings']), createSession);

    expect(orchestrator?.getStatus(workflowId)?.phase).toBe('completed');
    expect(created[0].sentMessages).toHaveLength(2);
  });

  it('never hands on the text of a failed turn that a commit survived', async () => {
    let reportPrompt = '';
    const { createSession } = sessions(
      [
        (_prompt, { commit }) => {
          // Committed without a handoff: the final message is passed on.
          commit('approved', { notes: 'overflow found' });
          return 'The overflow is in parse_header(); the length check is off by one.';
        },
        (_prompt, { writeOutput }) => {
          // The missing-artifact turn writes the output, then the CLI dies.
          writeOutput('findings');
          return { text: 'Agent exited with code 137.\n\nOutput:\n', hardFailure: true };
        },
      ],
      [
        (prompt, { commit }) => {
          reportPrompt = prompt;
          commit('written');
          return 'Report written.';
        },
      ],
    );
    const workflowId = await run(definitionWith(['findings']), createSession);

    expect(orchestrator?.getStatus(workflowId)?.phase).toBe('completed');
    expect(reportPrompt).toContain('the length check is off by one');
    expect(reportPrompt).not.toContain('exited with code 137');
  });
});
