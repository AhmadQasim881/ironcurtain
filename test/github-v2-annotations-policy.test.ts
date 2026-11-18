/**
 * The shipped github annotations against the argument shapes of the pinned
 * github-mcp-server v2.1.0 (src/config/mcp-servers.json), driven through the
 * real PolicyEngine with the shipped compiled policy and the approval
 * whitelist.
 *
 * v2 added arguments that name a resource outside the call's owner/repo:
 *
 *  - issue_write's parent_owner/parent_repo attach a new issue as a sub-issue
 *    of an issue in another repository. They are classified like owner/repo
 *    (github-owner/github-repo), so list conditions, whitelist constraints
 *    and the auto-approver must accept both repositories.
 *  - pull_request_review_write's resolve_thread/unresolve_thread address a
 *    review thread by its global node ID (threadId) and ignore owner/repo.
 *    threadId, like sub_issue_write's sub_issue_id, is a github-resource-id:
 *    an opaque resource role, so those calls escalate and can never be
 *    whitelisted or discharged by an owner/repo-scoped rule.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  StoredToolAnnotationsFile,
  ToolAnnotation,
} from '../src/pipeline/types.js';
import {
  createApprovalWhitelist,
  extractWhitelistCandidates,
  type WhitelistContext,
} from '../src/trusted-process/approval-whitelist.js';
import { buildAnnotationPrompt } from '../src/pipeline/tool-annotator.js';
import { extractArgsForAutoApprove, unanchoredArguments } from '../src/trusted-process/auto-approver.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { EvaluationResult } from '../src/trusted-process/policy-types.js';
import { diffToolSchema, hasToolDrift, type LiveToolSchema } from '../src/trusted-process/schema-drift.js';
import { findUnannotatedArguments } from '../src/trusted-process/tool-call-pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const generatedDir = resolve(__dirname, '../src/config/generated');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const compiledPolicy = readJson(resolve(generatedDir, 'compiled-policy.json')) as CompiledPolicyFile;
const toolAnnotations = readJson(resolve(generatedDir, 'tool-annotations.json')) as StoredToolAnnotationsFile;
const dynamicLists = readJson(resolve(generatedDir, 'dynamic-lists.json')) as DynamicListsFile;

function engineWith(rules: readonly CompiledRule[] = []): PolicyEngine {
  return new PolicyEngine(
    { ...compiledPolicy, rules: [...rules, ...compiledPolicy.rules] },
    toolAnnotations,
    [],
    undefined,
    undefined,
    dynamicLists,
  );
}

const shippedEngine = engineWith();

/**
 * The input schemas github-mcp-server v2.1.0 serves for the tools re-annotated
 * for it, as recorded in its pkg/github/__toolsnaps__ at tag v2.1.0 (the
 * release mcp-servers.json pins by digest).
 */
const V2_1_0_TOOLS = readJson(resolve(__dirname, 'fixtures/github-mcp-server-v2.1.0-tools.json')) as LiveToolSchema[];

describe('the re-annotated tools describe the pinned v2.1.0 release', () => {
  // The rest of the github entry still has to be re-annotated with
  // `annotate-tools --server github`; the role guidance in the annotation
  // prompt must steer that run to the classification asserted here.
  it('steers a github re-annotation to classify the parent repository and global IDs the same way', () => {
    const prompt = buildAnnotationPrompt('github', V2_1_0_TOOLS);
    expect(prompt).toContain('issue_write.parent_owner');
    expect(prompt).toContain('issue_write.parent_repo');
    expect(prompt).toContain('pull_request_review_write.threadId');
    expect(prompt).toContain('sub_issue_write.sub_issue_id');
  });

  it.each(V2_1_0_TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s: the stored schema is the served one and every argument is classified',
    (name, live) => {
      const stored = toolAnnotations.servers.github.tools.find((t) => t.toolName === name);
      if (!stored) throw new Error(`no shipped annotation for github/${name}`);
      const drift = diffToolSchema(stored, live);
      expect({ name, drifted: hasToolDrift(drift), drift }).toMatchObject({
        name,
        drifted: false,
        drift: { unannotatedArgs: [], removedArgs: [], brokenDiscriminators: [], schemaChanged: false },
      });
    },
  );
});

/** A user policy that allows `tool` only for the repository me/proj. */
function ownRepoAllowRule(tool: string): CompiledRule {
  return {
    name: `allow-${tool}-own-repo`,
    description: 'Allow writes to my own repository',
    principle: 'The user owns me/proj',
    if: {
      server: ['github'],
      tool: [tool],
      lists: [
        { roles: ['github-owner'], allowed: ['me'], matchType: 'identifiers' },
        { roles: ['github-repo'], allowed: ['proj'], matchType: 'identifiers' },
      ],
    },
    then: 'allow',
    reason: 'me/proj belongs to the user',
  };
}

interface Evaluated {
  readonly result: EvaluationResult;
  readonly annotation: ToolAnnotation;
  readonly context: WhitelistContext;
}

function evaluate(engine: PolicyEngine, toolName: string, args: Record<string, unknown>): Evaluated {
  const result = engine.evaluate({ requestId: 'r', serverName: 'github', toolName, arguments: args, timestamp: '' });
  const annotation = engine.getAnnotation('github', toolName, args);
  if (!annotation) throw new Error(`no shipped annotation for github/${toolName}`);
  return { result, annotation, context: { escalatedRoles: result.escalatedRoles } };
}

/** The whitelist pattern a human approval of `args` would add, if any. */
function approveAndWhitelist(toolName: string, args: Record<string, unknown>) {
  const { result, annotation, context } = evaluate(shippedEngine, toolName, args);
  expect(result.decision).toBe('escalate');
  const { patterns } = extractWhitelistCandidates(
    'github',
    toolName,
    args,
    annotation,
    context,
    'esc-1',
    result.reason,
  );
  const whitelist = createApprovalWhitelist();
  for (const pattern of patterns) whitelist.add(pattern);
  return { patterns, whitelist };
}

function matches(
  whitelist: ReturnType<typeof createApprovalWhitelist>,
  toolName: string,
  args: Record<string, unknown>,
) {
  const { result, annotation, context } = evaluate(shippedEngine, toolName, args);
  expect(result.decision).toBe('escalate');
  return whitelist.match('github', toolName, args, annotation, context).matched;
}

const OWN_ISSUE = { method: 'create', owner: 'me', repo: 'proj', title: 'Bug', body: 'details' };
const CROSS_REPO_SUB_ISSUE = {
  ...OWN_ISSUE,
  parent_owner: 'victim-org',
  parent_repo: 'private-repo',
  parent_issue_number: 7,
};

describe('issue_write parent_owner/parent_repo (github-mcp-server v2)', () => {
  it('classifies every v2 argument, parent_owner/parent_repo as owner and repo', () => {
    const stored = toolAnnotations.servers.github.tools.find((t) => t.toolName === 'issue_write');
    expect(stored?.args).toMatchObject({
      parent_owner: ['github-owner'],
      parent_repo: ['github-repo'],
      parent_issue_number: ['none'],
      issue_fields: ['none'],
    });
    // The pipeline's unannotated-arguments guard does not deny them.
    expect(findUnannotatedArguments(CROSS_REPO_SUB_ISSUE, stored)).toEqual([]);
  });

  it('escalates a sub-issue of another repository on the owner and repo roles', () => {
    const { result } = evaluate(shippedEngine, 'issue_write', CROSS_REPO_SUB_ISSUE);
    expect(result.decision).toBe('escalate');
    expect(result.escalatedRoles).toEqual(expect.arrayContaining(['github-owner', 'github-repo']));
  });

  it('is not matched by the owner/repo whitelist pattern approved for the call repository', () => {
    const { patterns, whitelist } = approveAndWhitelist('issue_write', OWN_ISSUE);
    expect(patterns.map((p) => p.description)).toEqual(['Allow github/issue_write github-owner=me, github-repo=proj']);

    // The approved repository stays covered...
    expect(matches(whitelist, 'issue_write', { ...OWN_ISSUE, title: 'Another bug' })).toBe(true);
    // ...but not a sub-issue attached in a repository the user never approved,
    expect(matches(whitelist, 'issue_write', CROSS_REPO_SUB_ISSUE)).toBe(false);
    // nor one whose parent lives in another repository of the same owner.
    expect(matches(whitelist, 'issue_write', { ...OWN_ISSUE, parent_owner: 'me', parent_repo: 'secret' })).toBe(false);
  });

  it('is not allowed by a rule that allows issue_write for the call repository only', () => {
    const engine = engineWith([ownRepoAllowRule('issue_write')]);
    expect(evaluate(engine, 'issue_write', OWN_ISSUE).result.decision).toBe('allow');
    expect(
      evaluate(engine, 'issue_write', { ...OWN_ISSUE, parent_owner: 'me', parent_repo: 'proj' }).result.decision,
    ).toBe('allow');
    const crossRepo = evaluate(engine, 'issue_write', CROSS_REPO_SUB_ISSUE).result;
    expect(crossRepo.decision).toBe('escalate');
    expect(crossRepo.rule).toBe('github-write-operations-escalate');
  });

  it('shows the parent repository to the auto-approver as escalated identifiers', () => {
    const { result, annotation } = evaluate(shippedEngine, 'issue_write', CROSS_REPO_SUB_ISSUE);
    expect(
      extractArgsForAutoApprove(CROSS_REPO_SUB_ISSUE, annotation, {
        escalatedRoles: result.escalatedRoles,
        destinationGate: false,
      }),
    ).toEqual({
      owner: { kind: 'identifier', values: ['me'], escalated: true, anchors: [['me']] },
      repo: { kind: 'identifier', values: ['proj'], escalated: true, anchors: [['proj']] },
      parent_owner: { kind: 'identifier', values: ['victim-org'], escalated: true, anchors: [['victim-org']] },
      parent_repo: { kind: 'identifier', values: ['private-repo'], escalated: true, anchors: [['private-repo']] },
    });
  });

  it('is never auto-approved on a request that names only the call repository', () => {
    const args = { ...CROSS_REPO_SUB_ISSUE, owner: 'octocat', repo: 'hello-world' };
    const { result, annotation } = evaluate(shippedEngine, 'issue_write', args);
    const context = {
      toolName: 'github/issue_write',
      rule: result.rule,
      escalationReason: result.reason,
      arguments: extractArgsForAutoApprove(args, annotation, {
        escalatedRoles: result.escalatedRoles,
        destinationGate: false,
      }),
    };
    // The parent repository has to be named too before the model is consulted.
    expect(unanchoredArguments({ ...context, userMessage: 'file a bug in octocat/hello-world' })).toEqual([
      'parent_owner',
      'parent_repo',
    ]);
    expect(
      unanchoredArguments({
        ...context,
        userMessage: 'file a bug in octocat/hello-world as a sub-issue of victim-org/private-repo#7',
      }),
    ).toEqual([]);
  });
});

const REVIEW = { method: 'create', owner: 'me', repo: 'proj', pullNumber: 3, body: 'LGTM', event: 'APPROVE' };
const RESOLVE_THREAD = { method: 'resolve_thread', owner: 'me', repo: 'proj', pullNumber: 3, threadId: 'PRRT_kwDOAbc' };

describe('pull_request_review_write resolve_thread/unresolve_thread (github-mcp-server v2)', () => {
  it('keeps review creation whitelistable by owner/repo', () => {
    const { patterns, whitelist } = approveAndWhitelist('pull_request_review_write', REVIEW);
    expect(patterns.map((p) => p.description)).toEqual([
      'Allow github/pull_request_review_write github-owner=me, github-repo=proj',
    ]);
    expect(matches(whitelist, 'pull_request_review_write', { ...REVIEW, pullNumber: 4 })).toBe(true);
  });

  for (const method of ['resolve_thread', 'unresolve_thread']) {
    it(`escalates ${method} on the global thread ID and never offers a whitelist pattern`, () => {
      const args = { ...RESOLVE_THREAD, method };
      const { result } = evaluate(shippedEngine, 'pull_request_review_write', args);
      expect(result.decision).toBe('escalate');
      expect(result.escalatedRoles).toContain('github-resource-id');
      expect(approveAndWhitelist('pull_request_review_write', args).patterns).toEqual([]);
    });

    it(`does not let an owner/repo approval or allow rule cover ${method}`, () => {
      const args = { ...RESOLVE_THREAD, method };
      // A whitelist entry approved for reviews on me/proj...
      const { whitelist } = approveAndWhitelist('pull_request_review_write', REVIEW);
      expect(matches(whitelist, 'pull_request_review_write', args)).toBe(false);
      // ...and a user rule allowing review writes on me/proj leave it escalated.
      const engine = engineWith([ownRepoAllowRule('pull_request_review_write')]);
      expect(evaluate(engine, 'pull_request_review_write', REVIEW).result.decision).toBe('allow');
      expect(evaluate(engine, 'pull_request_review_write', args).result.decision).toBe('escalate');
    });
  }

  it('treats an unknown future method as a thread operation (fail closed)', () => {
    const args = { ...RESOLVE_THREAD, method: 'dismiss_thread' };
    expect(evaluate(shippedEngine, 'pull_request_review_write', args).result.escalatedRoles).toContain(
      'github-resource-id',
    );
    expect(approveAndWhitelist('pull_request_review_write', args).patterns).toEqual([]);
  });
});

describe('sub_issue_write sub_issue_id', () => {
  const ADD_SUB_ISSUE = { method: 'add', owner: 'me', repo: 'proj', issue_number: 1, sub_issue_id: 987654 };

  it('escalates on the global sub-issue ID and is never whitelisted or allowed by owner/repo', () => {
    const { result } = evaluate(shippedEngine, 'sub_issue_write', ADD_SUB_ISSUE);
    expect(result.decision).toBe('escalate');
    expect(result.escalatedRoles).toContain('github-resource-id');
    expect(approveAndWhitelist('sub_issue_write', ADD_SUB_ISSUE).patterns).toEqual([]);
    expect(
      evaluate(engineWith([ownRepoAllowRule('sub_issue_write')]), 'sub_issue_write', ADD_SUB_ISSUE).result.decision,
    ).toBe('escalate');
  });
});
