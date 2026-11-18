/**
 * Unit tests for the broad-policy validator + ruleDelta (Phase 1c).
 *
 * The validator is LLM-independent: it inspects the COMPILED policy and rejects,
 * unless the persona is opted in, `allow` rules with broad wildcard
 * domains/lists (judged with the Public Suffix List), out-of-workspace
 * paths.within, or resource arguments left unconstrained (judged with the
 * stored tool annotations). `escalate` rules are never rejected. ruleDelta
 * diffs old vs new compiled policy by rule name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  makeBroadPolicyValidator,
  findBroadPolicy,
  hasBroadAccess,
  isBroadDomainPattern,
  BroadPolicyRejectedError,
} from '../src/persona/broad-policy-validator.js';
import { computeRuleDelta } from '../src/persona/rule-delta.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-broad-test-${process.pid}`);
const WORKSPACE = resolve(TEST_HOME, 'workspace');

function rule(partial: Partial<CompiledRule> & { name: string }): CompiledRule {
  return {
    description: 'd',
    principle: 'pr',
    if: {},
    then: 'allow',
    reason: 'r',
    ...partial,
  };
}

function policy(rules: CompiledRule[]): CompiledPolicyFile {
  return { generatedAt: '', constitutionHash: 'h', inputHash: 'i', rules };
}

/** Builds a DynamicListsFile from a map of list-name => resolved values. */
function dynamicLists(
  lists: Record<string, { values?: string[]; manualAdditions?: string[]; manualRemovals?: string[] }>,
): DynamicListsFile {
  const out: DynamicListsFile['lists'] = {};
  for (const [name, l] of Object.entries(lists)) {
    out[name] = {
      values: l.values ?? [],
      manualAdditions: l.manualAdditions ?? [],
      manualRemovals: l.manualRemovals ?? [],
      resolvedAt: '',
      inputHash: 'i',
    };
  }
  return { generatedAt: '', lists: out };
}

function tool(serverName: string, toolName: string, args: StoredToolAnnotation['args']): StoredToolAnnotation {
  return { toolName, serverName, comment: '', args, inputSchema: {} };
}

/** A small, realistic slice of the shipped tool annotations. */
const ANNOTATIONS: StoredToolAnnotationsFile = {
  generatedAt: '',
  servers: {
    fetch: {
      inputHash: 'h',
      tools: [
        tool('fetch', 'http_fetch', { url: ['fetch-url'], headers: ['none'] }),
        tool('fetch', 'web_search', { query: ['none'] }),
      ],
    },
    filesystem: {
      inputHash: 'h',
      tools: [
        tool('filesystem', 'read_file', { path: ['read-path'] }),
        tool('filesystem', 'write_file', { path: ['write-path'], content: ['none'] }),
        tool('filesystem', 'list_allowed_directories', {}),
      ],
    },
    git: {
      inputHash: 'h',
      tools: [
        tool('git', 'git_push', { path: ['read-path'], remote: ['git-remote-url'], branch: ['branch-name'] }),
        tool('git', 'git_branch', {
          path: {
            default: ['read-path'],
            // A role that only a conditional mode carries must still be bounded.
            when: [{ condition: { arg: 'operation', equals: 'delete' }, roles: ['delete-history'] }],
          },
          operation: ['none'],
        }),
      ],
    },
    github: {
      inputHash: 'h',
      tools: [
        tool('github', 'push_files', {
          owner: ['github-owner'],
          repo: ['github-repo'],
          branch: ['branch-name'],
          files: ['none'],
        }),
        tool('github', 'get_file_contents', { owner: ['github-owner'], repo: ['github-repo'], path: ['none'] }),
      ],
    },
    'google-workspace': {
      inputHash: 'h',
      tools: [
        tool('google-workspace', 'gmail_send_message', {
          to: ['email-address'],
          subject: ['none'],
          body: ['email-body'],
        }),
        tool('google-workspace', 'gmail_search', { query: ['none'] }),
      ],
    },
  },
};

/** findBroadPolicy with the annotations (the shape the pipeline hands the hook). */
function find(rules: CompiledRule[], lists?: DynamicListsFile) {
  return findBroadPolicy(policy(rules), WORKSPACE, { annotations: ANNOTATIONS, dynamicLists: lists });
}

beforeEach(() => {
  mkdirSync(WORKSPACE, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('isBroadDomainPattern', () => {
  it('flags the bare wildcard and TLD-level / empty-suffix wildcards as broad', () => {
    for (const p of ['*', '*.', '*.com', '*.gov', '*.io']) {
      expect(isBroadDomainPattern(p)).toBe(true);
    }
  });

  it('flags wildcards over public suffixes of either PSL section as broad', () => {
    // ICANN section: multi-label registry suffixes.
    for (const p of ['*.co.uk', '*.com.au']) expect(isBroadDomainPattern(p)).toBe(true);
    // Private section: multi-tenant hosting where anyone can get a subdomain.
    for (const p of ['*.github.io', '*.pages.dev', '*.vercel.app', '*.s3.amazonaws.com', '*.readthedocs.io']) {
      expect(isBroadDomainPattern(p)).toBe(true);
    }
  });

  it('flags wildcards at or under a known multi-tenant cloud parent as broad', () => {
    for (const p of ['*.amazonaws.com', '*.core.windows.net', '*.run.app']) {
      expect(isBroadDomainPattern(p)).toBe(true);
    }
  });

  it('flags a wildcard over a name whose every child is a public suffix (PSL wildcard rule)', () => {
    // gateway.dev is registrable, but the PSL rule *.gateway.dev gives every
    // child to a different customer, so *.gateway.dev reaches all of them.
    for (const p of ['*.gateway.dev', '*.kobe.jp']) expect(isBroadDomainPattern(p)).toBe(true);
    // One tenant below such a name, or an exception rule's domain, stays narrow.
    for (const p of ['*.api.us-east1.gateway.dev', '*.city.kobe.jp']) expect(isBroadDomainPattern(p)).toBe(false);
  });

  it('fails closed for wildcards over names that are not public registrable domains', () => {
    for (const p of ['*.localhost', '*.internal', '*.corp.internal', '*.1.2.3.4', '*.*.com', '*.unknown-tld']) {
      expect(isBroadDomainPattern(p)).toBe(true);
    }
  });

  it('classifies case and trailing-dot spellings the way the host parser does', () => {
    expect(isBroadDomainPattern('*.GITHUB.IO')).toBe(true);
    expect(isBroadDomainPattern('*.com.')).toBe(true);
    expect(isBroadDomainPattern('*.GitHub.com')).toBe(false);
  });

  it('treats per-registered-domain wildcards and bare hostnames as narrow', () => {
    for (const p of ['*.github.com', '*.example.co.uk', '*.alice.github.io', 'github.com', 'example.com', 'com']) {
      expect(isBroadDomainPattern(p)).toBe(false);
    }
  });
});

describe('findBroadPolicy: wildcard domains and paths', () => {
  it('flags wildcard domains', () => {
    const f = findBroadPolicy(
      policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*'] } } })]),
      WORKSPACE,
    );
    expect(f.broadenedDomains).toEqual(['*']);
    expect(f.outOfWorkspacePaths).toEqual([]);
  });

  it('flags TLD-level and public-suffix prefix wildcards and records the actual pattern', () => {
    const p = policy([
      rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*.com'] } } }),
      rule({ name: 'r2', if: { domains: { roles: [], allowed: ['*.'] } } }),
      rule({ name: 'r3', if: { domains: { roles: [], allowed: ['*.gov', '*.github.io', '*.co.uk'] } } }),
    ]);
    const f = findBroadPolicy(p, WORKSPACE);
    expect(new Set(f.broadenedDomains)).toEqual(new Set(['*.com', '*.', '*.gov', '*.github.io', '*.co.uk']));
  });

  it('does NOT flag a per-registered-domain wildcard (*.github.com, *.example.co.uk)', () => {
    const p = policy([
      rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*.github.com', '*.example.co.uk'] } } }),
    ]);
    expect(findBroadPolicy(p, WORKSPACE).broadenedDomains).toEqual([]);
  });

  it('flags wildcard list allowances', () => {
    const p = policy([rule({ name: 'r1', if: { lists: [{ roles: [], allowed: ['*'], matchType: 'domains' }] } })]);
    expect(findBroadPolicy(p, WORKSPACE).broadenedDomains).toEqual(['*']);
  });

  it('flags out-of-workspace paths.within', () => {
    const p = policy([rule({ name: 'r1', if: { paths: { roles: [], within: '/etc' } } })]);
    expect(findBroadPolicy(p, WORKSPACE).outOfWorkspacePaths).toEqual(['/etc']);
  });

  it('accepts paths within the workspace', () => {
    const inside = resolve(WORKSPACE, 'sub');
    mkdirSync(inside, { recursive: true });
    const p = policy([rule({ name: 'r1', if: { paths: { roles: [], within: inside } } })]);
    expect(findBroadPolicy(p, WORKSPACE).outOfWorkspacePaths).toEqual([]);
  });

  it('accepts the workspace dir itself', () => {
    const p = policy([rule({ name: 'r1', if: { paths: { roles: [], within: WORKSPACE } } })]);
    expect(findBroadPolicy(p, WORKSPACE).outOfWorkspacePaths).toEqual([]);
  });

  it('resolves a @list domain reference to a broad wildcard and flags it (with via annotation)', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.com'] } });
    expect(findBroadPolicy(p, WORKSPACE, { dynamicLists: lists }).broadenedDomains).toEqual(['*.com (via @news)']);
  });

  it('flags a @list that resolves to a multi-tenant hosting wildcard', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@docs'] } } })]);
    const lists = dynamicLists({ docs: { values: ['readthedocs.org', '*.readthedocs.io'] } });
    expect(findBroadPolicy(p, WORKSPACE, { dynamicLists: lists }).broadenedDomains).toEqual([
      '*.readthedocs.io (via @docs)',
    ]);
  });

  it('resolves a @list hidden in a list allowance and flags broad members', () => {
    const p = policy([rule({ name: 'r1', if: { lists: [{ roles: [], allowed: ['@sites'], matchType: 'domains' }] } })]);
    const lists = dynamicLists({ sites: { values: ['example.com'], manualAdditions: ['*.gov'] } });
    expect(findBroadPolicy(p, WORKSPACE, { dynamicLists: lists }).broadenedDomains).toEqual(['*.gov (via @sites)']);
  });

  it('does not flag a @list resolving only to narrow values', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.github.com'] } });
    expect(findBroadPolicy(p, WORKSPACE, { dynamicLists: lists }).broadenedDomains).toEqual([]);
  });

  it('respects manualRemovals when resolving a @list (removed broad value is not flagged)', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.com'], manualRemovals: ['*.com'] } });
    expect(findBroadPolicy(p, WORKSPACE, { dynamicLists: lists }).broadenedDomains).toEqual([]);
  });

  it('ignores a @list reference with no resolved entry (missing list fails closed -> nothing to flag)', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@gone'] } } })]);
    expect(findBroadPolicy(p, WORKSPACE, { dynamicLists: dynamicLists({}) }).broadenedDomains).toEqual([]);
  });

  it('does not resolve @list references when no dynamicLists are supplied', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    // The literal '@news' symbol is not itself a broad pattern, so without
    // resolution there is nothing to flag.
    expect(findBroadPolicy(p, WORKSPACE).broadenedDomains).toEqual([]);
  });

  it('escapes control characters in reported values', () => {
    const p = policy([rule({ name: 'r1', if: { paths: { roles: [], within: '/etc\u001b[2J' } } })]);
    expect(findBroadPolicy(p, WORKSPACE).outOfWorkspacePaths).toEqual(['/etc\\u001b[2J']);
  });
});

describe('findBroadPolicy: escalate rules keep a human in the loop', () => {
  it('reports escalate wildcards and out-of-workspace paths only as escalateBreadth', () => {
    const f = find([
      rule({
        name: 'escalate-fetch-other-urls',
        then: 'escalate',
        if: { server: ['fetch'], tool: ['http_fetch'], domains: { roles: ['fetch-url'], allowed: ['*'] } },
      }),
      rule({
        name: 'escalate-read-documents',
        then: 'escalate',
        if: { server: ['filesystem'], paths: { roles: ['read-path'], within: '/home/someone/Documents' } },
      }),
    ]);
    expect(f.broadenedDomains).toEqual([]);
    expect(f.outOfWorkspacePaths).toEqual([]);
    expect(f.unconstrainedAllows).toEqual([]);
    expect(f.escalateBreadth).toEqual([
      'escalate-fetch-other-urls: *',
      'escalate-read-documents: within /home/someone/Documents',
    ]);
    expect(hasBroadAccess(f)).toBe(false);
  });

  it('does not report an unconstrained escalate rule', () => {
    const f = find([rule({ name: 'escalate-writes', then: 'escalate', if: { server: ['filesystem'] } })]);
    expect(f.unconstrainedAllows).toEqual([]);
    expect(f.escalateBreadth).toEqual([]);
  });
});

describe('findBroadPolicy: unconstrained allow rules (annotation-aware)', () => {
  it('flags an unconstrained fetch allow in every spelling: server+tool+roles, server only, roles only', () => {
    const variants: CompiledRule['if'][] = [
      { server: ['fetch'], tool: ['http_fetch'], roles: ['fetch-url'] },
      { server: ['fetch'] },
      { roles: ['fetch-url'] },
    ];
    for (const cond of variants) {
      expect(find([rule({ name: 'allow-fetch', if: cond })]).unconstrainedAllows).toEqual([
        'allow-fetch: fetch-url on fetch/http_fetch',
      ]);
    }
  });

  it('accepts a fetch allow bounded by a domains condition', () => {
    const f = find([
      rule({
        name: 'allow-docs',
        if: {
          server: ['fetch'],
          tool: ['http_fetch'],
          domains: { roles: ['fetch-url'], allowed: ['docs.python.org'] },
        },
      }),
    ]);
    expect(hasBroadAccess(f)).toBe(false);
  });

  it('exempts tools without resource arguments', () => {
    const f = find([
      rule({ name: 'allow-web-search', if: { server: ['fetch'], tool: ['web_search'] } }),
      rule({ name: 'allow-introspection', if: { server: ['filesystem'], tool: ['list_allowed_directories'] } }),
      rule({ name: 'allow-mail-search', if: { server: ['google-workspace'], tool: ['gmail_search'] } }),
    ]);
    expect(f.unconstrainedAllows).toEqual([]);
  });

  it('flags a push_files allow without an owner list', () => {
    const f = find([rule({ name: 'allow-push', if: { server: ['github'], tool: ['push_files'] } })]);
    expect(f.unconstrainedAllows).toEqual([
      'allow-push: github-owner on github/push_files',
      'allow-push: github-repo on github/push_files',
    ]);
  });

  it('accepts a push_files allow bounded by owner and repo lists', () => {
    const f = find([
      rule({
        name: 'allow-push-own-repo',
        if: {
          server: ['github'],
          tool: ['push_files'],
          lists: [
            { roles: ['github-owner'], allowed: ['provos'], matchType: 'identifiers' },
            { roles: ['github-repo'], allowed: ['ironcurtain'], matchType: 'identifiers' },
          ],
        },
      }),
    ]);
    expect(f.unconstrainedAllows).toEqual([]);
  });

  it('flags a mail-send allow without a recipient list, and accepts one with it', () => {
    expect(
      find([rule({ name: 'allow-send', if: { server: ['google-workspace'], tool: ['gmail_send_message'] } })])
        .unconstrainedAllows,
    ).toEqual(['allow-send: email-address on google-workspace/gmail_send_message']);
    expect(
      find([
        rule({
          name: 'allow-send-contacts',
          if: {
            server: ['google-workspace'],
            tool: ['gmail_send_message'],
            lists: [{ roles: ['email-address'], allowed: ['@contacts'], matchType: 'emails' }],
          },
        }),
      ]).unconstrainedAllows,
    ).toEqual([]);
  });

  it('flags a path allow without paths.within and checks a bounded one for workspace containment', () => {
    expect(
      find([rule({ name: 'allow-writes', if: { server: ['filesystem'], tool: ['write_file'] } })]).unconstrainedAllows,
    ).toEqual(['allow-writes: write-path on filesystem/write_file']);

    const inside = find([
      rule({
        name: 'allow-workspace-writes',
        if: { server: ['filesystem'], paths: { roles: ['write-path'], within: WORKSPACE } },
      }),
    ]);
    expect(hasBroadAccess(inside)).toBe(false);

    const outside = find([
      rule({
        name: 'allow-home-writes',
        if: { server: ['filesystem'], paths: { roles: ['write-path'], within: '/home' } },
      }),
    ]);
    expect(outside.unconstrainedAllows).toEqual([]);
    expect(outside.outOfWorkspacePaths).toEqual(['/home']);
  });

  it('names every tool a server-wide rule leaves unbounded, per role', () => {
    const f = find([rule({ name: 'allow-filesystem', if: { server: ['filesystem'] } })]);
    expect(f.unconstrainedAllows).toEqual([
      'allow-filesystem: read-path on filesystem/read_file',
      'allow-filesystem: write-path on filesystem/write_file',
    ]);
  });

  it('checks every role a conditional annotation can resolve to', () => {
    const f = find([
      rule({
        name: 'allow-branch-reads',
        if: { server: ['git'], tool: ['git_branch'], paths: { roles: ['read-path'], within: WORKSPACE } },
      }),
      rule({ name: 'allow-branch-anything', if: { server: ['git'], tool: ['git_branch'] } }),
    ]);
    // The paths-bounded rule is not relevant to delete-history, so it cannot
    // discharge it; the unconditioned rule can, for every mode.
    expect(f.unconstrainedAllows).toEqual([
      'allow-branch-anything: read-path on git/git_branch',
      'allow-branch-anything: delete-history on git/git_branch',
    ]);
  });

  it('checks a role-scoped rule on a tool whose resource roles can all resolve away', () => {
    // A share tool whose only resource role disappears when `path` is absent:
    // that call has no resource role, so the engine evaluates it unscoped and
    // a `roles: ['email-address']` rule matches every recipient.
    const share: StoredToolAnnotationsFile = {
      generatedAt: '',
      servers: {
        'google-workspace': {
          inputHash: 'h',
          tools: [
            tool('google-workspace', 'drive_share_file', {
              email: ['email-address'],
              path: { default: ['read-path'], when: [{ condition: { arg: 'path', is: 'absent' }, roles: ['none'] }] },
            }),
          ],
        },
      },
    };
    const byRecipientRole = rule({
      name: 'allow-share',
      if: { server: ['google-workspace'], tool: ['drive_share_file'], roles: ['email-address'] },
    });

    const engine = new PolicyEngine(policy([byRecipientRole]), share, []);
    const call = engine.evaluate({
      requestId: 't',
      serverName: 'google-workspace',
      toolName: 'drive_share_file',
      arguments: { email: 'mallory@evil.example' },
      timestamp: '',
    });
    expect(call.decision).toBe('allow');

    expect(findBroadPolicy(policy([byRecipientRole]), WORKSPACE, { annotations: share }).unconstrainedAllows).toEqual([
      'allow-share: email-address on google-workspace/drive_share_file',
    ]);
  });

  it('only checks the roles a role-scoped rule can discharge', () => {
    // git_push has a path role too; a domains-only rule is not relevant to it,
    // so that role must be (and is, elsewhere) discharged by another rule.
    const f = find([
      rule({
        name: 'allow-push-github',
        if: { server: ['git'], tool: ['git_push'], domains: { roles: ['git-remote-url'], allowed: ['github.com'] } },
      }),
    ]);
    expect(f.unconstrainedAllows).toEqual([]);
  });

  it('ignores tools a rule can never match because its value conditions extract nothing there', () => {
    const f = find([
      rule({
        name: 'allow-mail-links',
        if: { server: ['google-workspace'], domains: { roles: ['fetch-url'], allowed: ['example.com'] } },
      }),
    ]);
    expect(f.unconstrainedAllows).toEqual([]);
  });

  it('fails closed without annotations: any allow rule with no value condition is reported', () => {
    const f = findBroadPolicy(
      policy([
        rule({ name: 'allow-introspection', if: { server: ['filesystem'], tool: ['list_allowed_directories'] } }),
        rule({ name: 'allow-docs', if: { domains: { roles: ['fetch-url'], allowed: ['docs.python.org'] } } }),
      ]),
      WORKSPACE,
    );
    expect(f.unconstrainedAllows).toEqual([
      'allow-introspection: no domains, paths or lists condition (tool annotations unavailable)',
    ]);
  });
});

describe('makeBroadPolicyValidator', () => {
  const validate = (rules: CompiledRule[], lists?: DynamicListsFile, optIn = false): void =>
    makeBroadPolicyValidator(WORKSPACE, optIn)(policy(rules), lists, ANNOTATIONS);

  it('rejects a wildcard-domain policy when not opted in', () => {
    const rules = [rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*'] } } })];
    expect(() => validate(rules)).toThrowError(BroadPolicyRejectedError);
    try {
      validate(rules);
    } catch (err) {
      expect((err as BroadPolicyRejectedError).code).toBe('BROAD_POLICY_REJECTED');
    }
  });

  it('rejects an out-of-workspace path when not opted in', () => {
    expect(() => validate([rule({ name: 'r1', if: { paths: { roles: [], within: '/' } } })])).toThrowError(
      BroadPolicyRejectedError,
    );
  });

  it('rejects a TLD-level prefix-wildcard domain when not opted in', () => {
    expect(() => validate([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*.com'] } } })])).toThrowError(
      BroadPolicyRejectedError,
    );
  });

  it('rejects multi-tenant hosting wildcards (*.github.io, *.pages.dev) when not opted in', () => {
    for (const pattern of ['*.github.io', '*.pages.dev']) {
      expect(() => validate([rule({ name: 'r1', if: { domains: { roles: [], allowed: [pattern] } } })])).toThrowError(
        BroadPolicyRejectedError,
      );
    }
  });

  it('rejects a TLD-level prefix wildcard hidden in a list allowance when not opted in', () => {
    expect(() =>
      validate([rule({ name: 'r1', if: { lists: [{ roles: [], allowed: ['*.gov'], matchType: 'domains' }] } })]),
    ).toThrowError(BroadPolicyRejectedError);
  });

  it('passes a narrow policy (bare host + per-registered-domain wildcards) when not opted in', () => {
    expect(() =>
      validate([
        rule({ name: 'r1', if: { domains: { roles: [], allowed: ['example.com'] } } }),
        rule({ name: 'r2', if: { domains: { roles: [], allowed: ['*.github.com', '*.example.co.uk'] } } }),
      ]),
    ).not.toThrow();
  });

  it('rejects an unconstrained fetch allow and names it in the error', () => {
    let caught: unknown;
    try {
      validate([rule({ name: 'allow-any-fetch', if: { server: ['fetch'], tool: ['http_fetch'] } })]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BroadPolicyRejectedError);
    const rejected = caught as BroadPolicyRejectedError;
    expect(rejected.message).toContain('allow-any-fetch: fetch-url on fetch/http_fetch');
    expect(rejected.data?.unconstrainedAllows).toEqual(['allow-any-fetch: fetch-url on fetch/http_fetch']);
  });

  it("accepts a policy whose only '*' is on an escalate rule", () => {
    expect(() =>
      validate([
        rule({
          name: 'allow-docs',
          if: {
            server: ['fetch'],
            tool: ['http_fetch'],
            domains: { roles: ['fetch-url'], allowed: ['docs.python.org'] },
          },
        }),
        rule({
          name: 'escalate-other-urls',
          then: 'escalate',
          if: { server: ['fetch'], tool: ['http_fetch'], domains: { roles: ['fetch-url'], allowed: ['*'] } },
        }),
        rule({
          name: 'escalate-read-documents',
          then: 'escalate',
          if: { server: ['filesystem'], paths: { roles: ['read-path'], within: '/home/someone/Documents' } },
        }),
      ]),
    ).not.toThrow();
  });

  it('rejects a push_files allow without an owner list', () => {
    expect(() =>
      validate([rule({ name: 'allow-push', if: { server: ['github'], tool: ['push_files'] } })]),
    ).toThrowError(/github-owner on github\/push_files/);
  });

  it('passes a broad policy when opted in', () => {
    expect(() =>
      validate(
        [
          rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*'] } } }),
          rule({ name: 'r2', if: { paths: { roles: [], within: '/etc' } } }),
          rule({ name: 'r3', if: { server: ['fetch'] } }),
        ],
        undefined,
        true,
      ),
    ).not.toThrow();
  });

  it('rejects a @list that RESOLVES to a broad wildcard when not opted in', () => {
    // The rule only stores the '@news' symbol; the broad value lives in the
    // resolved dynamic-lists. Without the resolved lists this would slip through.
    const rules = [rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })];
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.com'] } });
    expect(() => validate(rules, lists)).toThrowError(BroadPolicyRejectedError);
    try {
      validate(rules, lists);
    } catch (err) {
      expect((err as BroadPolicyRejectedError).data?.broadenedDomains).toEqual(['*.com (via @news)']);
    }
  });

  it('accepts a @list that resolves only to narrow values when not opted in', () => {
    const rules = [rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })];
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.github.com'] } });
    expect(() => validate(rules, lists)).not.toThrow();
  });

  it('fails closed when called without annotations', () => {
    const validator = makeBroadPolicyValidator(WORKSPACE, false);
    const p = policy([rule({ name: 'r1', if: { server: ['filesystem'], tool: ['list_allowed_directories'] } })]);
    expect(() => validator(p)).toThrowError(BroadPolicyRejectedError);
    expect(() => validator(p, undefined, ANNOTATIONS)).not.toThrow();
  });
});

describe('computeRuleDelta', () => {
  it('counts added / removed / loosened rules', () => {
    const oldP = policy([rule({ name: 'keep', then: 'escalate' }), rule({ name: 'gone', then: 'allow' })]);
    const newP = policy([
      rule({ name: 'keep', then: 'allow' }), // loosened: escalate -> allow
      rule({ name: 'fresh', then: 'allow' }), // added
    ]);
    const delta = computeRuleDelta(oldP, newP, WORKSPACE);
    expect(delta.added).toBe(1);
    expect(delta.removed).toBe(1);
    expect(delta.loosened).toBe(1);
  });

  it('counts a rule as loosened when it gains a public-suffix wildcard or drops its value condition', () => {
    const domains = (allowed: string[]) => ({ domains: { roles: ['fetch-url' as const], allowed } });
    const oldP = policy([
      rule({ name: 'docs', if: { server: ['fetch'], ...domains(['*.github.com']) } }),
      rule({ name: 'fetch', if: { server: ['fetch'], ...domains(['docs.python.org']) } }),
      rule({ name: 'narrow', if: { server: ['fetch'], ...domains(['example.com']) } }),
    ]);
    const newP = policy([
      rule({ name: 'docs', if: { server: ['fetch'], ...domains(['*.github.io']) } }),
      rule({ name: 'fetch', if: { server: ['fetch'] } }),
      rule({ name: 'narrow', if: { server: ['fetch'], ...domains(['*.example.com']) } }),
    ]);
    expect(computeRuleDelta(oldP, newP, WORKSPACE, { annotations: ANNOTATIONS }).loosened).toBe(2);
  });

  it('reports broadenedDomains / outOfWorkspacePaths from the new policy', () => {
    const newP = policy([
      rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*'] } } }),
      rule({ name: 'r2', if: { paths: { roles: [], within: '/srv' } } }),
    ]);
    const delta = computeRuleDelta(policy([]), newP, WORKSPACE);
    expect(delta.broadenedDomains).toEqual(['*']);
    expect(delta.outOfWorkspacePaths).toEqual(['/srv']);
  });

  it('reports unconstrained allows and escalate breadth separately', () => {
    const newP = policy([
      rule({ name: 'allow-any-fetch', if: { server: ['fetch'] } }),
      rule({
        name: 'escalate-other-urls',
        then: 'escalate',
        if: { server: ['fetch'], domains: { roles: ['fetch-url'], allowed: ['*'] } },
      }),
    ]);
    const delta = computeRuleDelta(policy([]), newP, WORKSPACE, { annotations: ANNOTATIONS });
    expect(delta.unconstrainedAllows).toEqual(['allow-any-fetch: fetch-url on fetch/http_fetch']);
    expect(delta.escalateBreadth).toEqual(['escalate-other-urls: *']);
    expect(delta.broadenedDomains).toEqual([]);
    expect(hasBroadAccess(delta)).toBe(true);
  });

  it('treats every rule as added when there is no previous policy', () => {
    const newP = policy([rule({ name: 'a' }), rule({ name: 'b' })]);
    const delta = computeRuleDelta(undefined, newP, WORKSPACE);
    expect(delta.added).toBe(2);
    expect(delta.removed).toBe(0);
  });

  it('counts a rule that gains a TLD-level wildcard as loosened, not only a bare *', () => {
    // An escalate rule keeps its decision but its domain allowance widens to
    // every .com host: the validator calls that broad, so the delta must too.
    const oldP = policy([
      rule({ name: 'fetch', then: 'escalate', if: { domains: { roles: [], allowed: ['a.com'] } } }),
    ]);
    const newP = policy([
      rule({ name: 'fetch', then: 'escalate', if: { domains: { roles: [], allowed: ['*.com'] } } }),
    ]);
    expect(computeRuleDelta(oldP, newP, WORKSPACE).loosened).toBe(1);

    const narrow = policy([
      rule({ name: 'fetch', then: 'escalate', if: { domains: { roles: [], allowed: ['*.github.com'] } } }),
    ]);
    expect(computeRuleDelta(oldP, narrow, WORKSPACE).loosened).toBe(0);
  });

  it('sees breadth that arrives through a dynamic list', () => {
    const viaList = (allowed: string[]) =>
      policy([rule({ name: 'news', then: 'escalate', if: { domains: { roles: [], allowed } } })]);
    const oldLists = dynamicLists({ sites: { values: ['example.org'] } });
    const newLists = dynamicLists({ sites: { values: ['example.org', '*.gov'] } });
    const delta = computeRuleDelta(viaList(['@sites']), viaList(['@sites']), WORKSPACE, {
      oldDynamicLists: oldLists,
      dynamicLists: newLists,
    });
    // The rule text is unchanged, but its list now resolves to a broad wildcard.
    expect(delta.loosened).toBe(1);
    // An escalate rule's breadth is informational (a human approves each call).
    expect(delta.escalateBreadth).toEqual(['news: *.gov (via @sites)']);
    expect(delta.broadenedDomains).toEqual([]);

    // The same list on both sides is not a gain.
    const unchanged = computeRuleDelta(viaList(['@sites']), viaList(['@sites']), WORKSPACE, {
      oldDynamicLists: newLists,
      dynamicLists: newLists,
    });
    expect(unchanged.loosened).toBe(0);
  });
});
