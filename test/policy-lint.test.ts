/**
 * Unit tests for the deterministic policy lint (src/pipeline/policy-lint.ts),
 * one block per rule class (PIP-5).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BROAD_DOMAINS_DIRECTIVE,
  constitutionAllowsBroadDomains,
  lintCompiledRules,
  type PolicyLintCode,
  type PolicyLintOptions,
} from '../src/pipeline/policy-lint.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  CompiledRuleCondition,
  DynamicListsFile,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const root = mkdtempSync(resolve(tmpdir(), 'ic-policy-lint-'));
const HOME = resolve(root, 'home', 'alice');
const SANDBOX = resolve(HOME, '.ironcurtain', 'sandbox');
const PROTECTED = [resolve(HOME, '.ironcurtain'), resolve(HOME, '.ssh'), resolve(root, 'srv', 'secrets')];
mkdirSync(SANDBOX, { recursive: true });
mkdirSync(resolve(HOME, 'Downloads'), { recursive: true });
mkdirSync(resolve(root, 'srv', 'data'), { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const SCHEMA = { type: 'object' };

function tool(
  serverName: string,
  toolName: string,
  args: StoredToolAnnotation['args'],
  mcpHints?: StoredToolAnnotation['mcpHints'],
): StoredToolAnnotation {
  return { serverName, toolName, comment: toolName, args, inputSchema: SCHEMA, ...(mcpHints ? { mcpHints } : {}) };
}

const ANNOTATIONS: StoredToolAnnotation[] = [
  tool('filesystem', 'read_file', { path: ['read-path'] }),
  tool('filesystem', 'write_file', { path: ['write-path'], content: ['none'] }),
  tool('filesystem', 'edit_file', { path: ['read-path', 'write-path'], edits: ['none'] }),
  tool('filesystem', 'list_allowed_directories', {}),
  tool('git', 'git_branch', {
    path: {
      default: ['read-path', 'write-history', 'delete-history'],
      when: [{ condition: { arg: 'mode', equals: 'list' }, roles: ['read-path'] }],
    },
    mode: ['none'],
  }),
  tool('git', 'git_push', { path: ['read-path'], remote: ['git-remote-url'] }),
  tool('fetch', 'http_fetch', { url: ['fetch-url'] }),
  tool('fetch', 'web_search', { query: ['none'] }),
  tool(
    'github',
    'get_issue',
    { owner: ['github-owner'], repo: ['github-repo'], issue: ['none'] },
    { readOnlyHint: true },
  ),
  tool(
    'github',
    'merge_pull_request',
    { owner: ['github-owner'], repo: ['github-repo'], pullNumber: ['none'] },
    { readOnlyHint: false },
  ),
  tool(
    'github',
    'delete_file',
    { owner: ['github-owner'], repo: ['github-repo'], path: ['none'] },
    { destructiveHint: true },
  ),
  tool('github', 'unhinted_write', { owner: ['github-owner'], repo: ['github-repo'] }),
  tool('gw', 'gmail_send_message', { to: ['email-address'], body: ['email-body'] }, { readOnlyHint: false }),
  tool('gw', 'gmail_list', { query: ['none'] }, { readOnlyHint: true }),
];

function rule(name: string, cond: CompiledRuleCondition, then: CompiledRule['then'] = 'allow'): CompiledRule {
  return { name, description: 'd', principle: 'p', if: cond, then, reason: 'r' };
}

function lint(rules: CompiledRule[], options: Partial<PolicyLintOptions> = {}) {
  return lintCompiledRules(rules, {
    annotations: ANNOTATIONS,
    protectedPaths: PROTECTED,
    allowedDirectory: SANDBOX,
    homeDir: HOME,
    ...options,
  });
}

function errorCodes(rules: CompiledRule[], options: Partial<PolicyLintOptions> = {}): PolicyLintCode[] {
  return lint(rules, options).errors.map((e) => e.code);
}

// ---------------------------------------------------------------------------
// Duplicate names
// ---------------------------------------------------------------------------

describe('duplicate-rule-name', () => {
  it('rejects two rules for the same server with the same name, of any decision', () => {
    const result = lint([
      rule('read-docs', { server: ['filesystem'], tool: ['read_file'] }),
      rule('read-docs', { server: ['filesystem'], tool: ['edit_file'] }, 'escalate'),
    ]);
    expect(result.errors.map((e) => e.code)).toEqual(['duplicate-rule-name']);
    expect(result.errors[0].message).toContain('"read-docs"');
  });

  it('accepts the same name for different servers (merged policies)', () => {
    expect(
      errorCodes([
        rule('allow-read', { server: ['filesystem'], tool: ['read_file'] }),
        rule('allow-read', { server: ['github'], tool: ['get_issue'] }),
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Server-wide allows
// ---------------------------------------------------------------------------

describe('server-wide-allow', () => {
  it('rejects an allow with no tool and no constraint', () => {
    const result = lint([rule('allow-github', { server: ['github'] })]);
    expect(result.errors.map((e) => e.code)).toContain('server-wide-allow');
    expect(result.errors.find((e) => e.code === 'server-wide-allow')?.message).toContain('"github"');
  });

  it('treats a roles filter with only non-resource roles as no constraint', () => {
    expect(errorCodes([rule('allow-gw', { server: ['gw'], roles: ['none'] })])).toContain('server-wide-allow');
  });

  it('treats a roles filter that also names a non-resource role as no constraint', () => {
    // "none" widens the filter to every tool with such an argument; gw tools
    // have no resource roles, so the engine allows them for every input.
    const result = lint([rule('allow-gw', { server: ['gw'], roles: ['read-path', 'none'] })]);
    expect(result.errors.map((e) => e.code)).toEqual(['server-wide-allow']);
    expect(result.errors[0].message).toContain('its roles filter names none');
  });

  it('accepts a server-wide escalate', () => {
    expect(errorCodes([rule('escalate-github', { server: ['github'] }, 'escalate')])).toEqual([]);
  });

  it('accepts an allow scoped by a resource role, a tool list or a value constraint', () => {
    expect(errorCodes([rule('read-anywhere', { server: ['filesystem'], roles: ['read-path'] })])).toEqual([]);
    expect(errorCodes([rule('read-issues', { server: ['github'], tool: ['get_issue'] })])).toEqual([]);
    expect(
      errorCodes([
        rule('downloads', { server: ['filesystem'], paths: { roles: ['read-path'], within: `${HOME}/Downloads` } }),
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Write / delete / history roles without paths.within
// ---------------------------------------------------------------------------

describe('unconstrained-mutation-allow', () => {
  it('rejects a role-agnostic allow on a tool with a write role', () => {
    const result = lint([rule('allow-write', { server: ['filesystem'], tool: ['write_file'] })]);
    expect(result.errors.map((e) => e.code)).toEqual(['unconstrained-mutation-allow']);
    expect(result.errors[0].message).toContain('write-path');
    expect(result.errors[0].message).toContain('filesystem/write_file');
  });

  it('rejects a role-agnostic allow on a multi-mode tool (roles of every mode count)', () => {
    const result = lint([rule('allow-branch', { server: ['git'], tool: ['git_branch'] })]);
    expect(result.errors.map((e) => e.code)).toEqual(['unconstrained-mutation-allow']);
    expect(result.errors[0].message).toContain('write-history');
    expect(result.errors[0].message).toContain('delete-history');
  });

  it('rejects an allow naming a mutation role without paths', () => {
    expect(errorCodes([rule('write-anywhere', { server: ['filesystem'], roles: ['write-path'] })])).toEqual([
      'unconstrained-mutation-allow',
    ]);
  });

  it('accepts an allow limited to read roles on a tool that also writes', () => {
    expect(
      errorCodes([rule('read-edit', { server: ['filesystem'], tool: ['edit_file'], roles: ['read-path'] })]),
    ).toEqual([]);
  });

  it('accepts a directory-scoped write allow and an unconstrained escalate', () => {
    expect(
      errorCodes([
        rule('write-data', {
          server: ['filesystem'],
          tool: ['write_file'],
          paths: { roles: ['write-path'], within: resolve(root, 'srv', 'data') },
        }),
        rule('escalate-writes', { server: ['filesystem'], roles: ['write-path'] }, 'escalate'),
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conditions on roles they cannot constrain
// ---------------------------------------------------------------------------

describe('condition-role-mismatch', () => {
  // The engine applies a condition to whatever role it names. A path has no
  // hostname, so a "domain" condition of "" (or "*") on a path role matches
  // every path; an owner name under "paths" resolves below the working
  // directory. Each of these looked constrained to the lint before.
  const write = (cond: Partial<CompiledRuleCondition>): CompiledRule =>
    rule('write-anywhere', { server: ['filesystem'], tool: ['write_file'], ...cond });

  it('rejects a domains condition on a path role, which matches every path', () => {
    const codes = errorCodes([write({ domains: { roles: ['write-path'], allowed: [''] } })]);
    expect(codes).toContain('condition-role-mismatch');
    expect(codes).toContain('unconstrained-mutation-allow');
  });

  it('rejects it with the broad-domains opt-in too ("*" is not a domain grant on a path)', () => {
    const optIn = { allowBroadDomains: true };
    expect(errorCodes([write({ domains: { roles: ['write-path'], allowed: ['*'] } })], optIn)).toEqual([
      'condition-role-mismatch',
      'unconstrained-mutation-allow',
    ]);
    expect(
      errorCodes([write({ lists: [{ roles: ['write-path'], allowed: ['*'], matchType: 'domains' }] })], optIn),
    ).toEqual(['condition-role-mismatch', 'unconstrained-mutation-allow']);
  });

  it('rejects a list on a path role (raw values, no symlink resolution)', () => {
    const result = lint([
      write({ lists: [{ roles: ['write-path'], allowed: [`${HOME}/notes.txt`], matchType: 'identifiers' }] }),
    ]);
    expect(result.errors.map((e) => e.code)).toEqual(['condition-role-mismatch', 'unconstrained-mutation-allow']);
    expect(result.errors[1].message).toContain('with no paths.within');
  });

  it('rejects paths or domains on identifier roles, which then match every owner', () => {
    const merge = (cond: Partial<CompiledRuleCondition>): CompiledRule =>
      rule('merge-any', { server: ['github'], tool: ['merge_pull_request'], ...cond });
    const result = lint([merge({ paths: { roles: ['github-owner', 'github-repo'], within: process.cwd() } })]);
    expect(result.errors.map((e) => e.code)).toEqual(['condition-role-mismatch']);
    expect(result.errors[0].message).toContain('"paths" on github-owner, github-repo');
    expect(
      errorCodes([merge({ domains: { roles: ['github-owner', 'github-repo'], allowed: ['*'] } })], {
        allowBroadDomains: true,
      }),
    ).toEqual(['condition-role-mismatch']);
  });

  it('accepts each condition on its own kind of role, and any condition in an escalate rule', () => {
    expect(
      errorCodes([
        rule('own-repos', {
          server: ['github'],
          tool: ['merge_pull_request'],
          lists: [
            { roles: ['github-owner'], allowed: ['provos'], matchType: 'identifiers' },
            { roles: ['github-repo'], allowed: ['ironcurtain'], matchType: 'identifiers' },
          ],
        }),
        rule('send-to-team', {
          server: ['gw'],
          tool: ['gmail_send_message'],
          lists: [{ roles: ['email-address'], allowed: ['team@example.com'], matchType: 'emails' }],
        }),
        rule('fetch-docs', {
          server: ['fetch'],
          tool: ['http_fetch'],
          domains: { roles: ['fetch-url'], allowed: ['docs.python.org'] },
        }),
        rule('read-data', {
          server: ['filesystem'],
          paths: { roles: ['read-path'], within: resolve(root, 'srv', 'data') },
        }),
        rule(
          'escalate-odd',
          { server: ['filesystem'], tool: ['write_file'], domains: { roles: ['write-path'], allowed: ['*'] } },
          'escalate',
        ),
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Side-effect tools (MCP hints, tighten-only)
// ---------------------------------------------------------------------------

describe('side-effect-tool-allow', () => {
  it('rejects allowing a tool the server marks as not read-only, for every input', () => {
    const result = lint([rule('allow-merge', { server: ['github'], tool: ['merge_pull_request'] })]);
    expect(result.errors.map((e) => e.code)).toEqual(['side-effect-tool-allow']);
    expect(result.errors[0].message).toContain('github/merge_pull_request');
  });

  it('rejects allowing a destructive tool, and a remote mutation without resource roles', () => {
    expect(errorCodes([rule('allow-delete', { server: ['github'], tool: ['delete_file'] })])).toEqual([
      'side-effect-tool-allow',
    ]);
    expect(errorCodes([rule('allow-send', { server: ['gw'], tool: ['gmail_send_message'] })])).toEqual([
      'side-effect-tool-allow',
    ]);
  });

  it('catches an allow that lists every mutating tool of a server', () => {
    const result = lint([rule('allow-writes', { server: ['github'], tool: ['merge_pull_request', 'delete_file'] })]);
    expect(result.errors.map((e) => e.code)).toEqual(['side-effect-tool-allow']);
    expect(result.errors[0].message).toContain('github/merge_pull_request');
    expect(result.errors[0].message).toContain('github/delete_file');
  });

  it('catches one tool allowed through two role-filtered rules', () => {
    const result = lint([
      rule('owner', { server: ['github'], tool: ['merge_pull_request'], roles: ['github-owner'] }),
      rule('repo', { server: ['github'], tool: ['merge_pull_request'], roles: ['github-repo'] }),
    ]);
    expect(result.errors.map((e) => [e.code, e.rule])).toEqual([
      ['side-effect-tool-allow', 'owner'],
      ['side-effect-tool-allow', 'repo'],
    ]);
  });

  it('accepts read-only tools, constrained allows and allows shadowed by an earlier escalate', () => {
    expect(errorCodes([rule('read', { server: ['github'], tool: ['get_issue'] })])).toEqual([]);
    expect(
      errorCodes([
        rule('own-repos', {
          server: ['github'],
          tool: ['merge_pull_request'],
          lists: [{ roles: ['github-owner'], allowed: ['provos'], matchType: 'identifiers' }],
        }),
        rule('any-repo', { server: ['github'], tool: ['merge_pull_request'], roles: ['github-repo'] }),
      ]),
    ).toEqual([]);
    expect(
      errorCodes([
        rule('escalate-merge', { server: ['github'], tool: ['merge_pull_request'] }, 'escalate'),
        rule('allow-github', { server: ['github'], tool: ['get_issue', 'merge_pull_request'] }),
      ]),
    ).toEqual([]);
    expect(
      errorCodes([
        rule('send-to-team', {
          server: ['gw'],
          tool: ['gmail_send_message'],
          lists: [{ roles: ['email-address'], allowed: ['team@example.com'], matchType: 'emails' }],
        }),
      ]),
    ).toEqual([]);
  });

  it('never relaxes on hints: a missing hint adds nothing, a read-only hint exempts nothing', () => {
    expect(errorCodes([rule('allow-unhinted', { server: ['github'], tool: ['unhinted_write'] })])).toEqual([]);
    const readOnlyHinted = [tool('filesystem', 'write_file', { path: ['write-path'] }, { readOnlyHint: true })];
    expect(
      errorCodes([rule('allow-write', { server: ['filesystem'], tool: ['write_file'] })], {
        annotations: readOnlyHinted,
      }),
    ).toEqual(['unconstrained-mutation-allow']);
  });
});

// ---------------------------------------------------------------------------
// Broad paths for write / delete / history allows
// ---------------------------------------------------------------------------

describe('broad-path-allow', () => {
  const writeWithin = (within: string): CompiledRule =>
    rule('write-dir', { server: ['filesystem'], tool: ['write_file'], paths: { roles: ['write-path'], within } });

  it.each([
    ['the home directory', () => HOME],
    ['a tilde home directory', () => '~'],
    ['/home', () => '/home'],
    ['/Users', () => '/Users'],
    ["another user's home", () => '/home/bob'],
    ['the filesystem root', () => '/'],
    ['an ancestor of the home directory', () => resolve(root, 'home')],
    ['a directory containing a protected path', () => resolve(root, 'srv')],
  ])('rejects a write allow within %s', (_label, within) => {
    // '~' expands to os.homedir(); the other cases use the fixture home.
    const options = within() === '~' ? { homeDir: undefined } : {};
    expect(errorCodes([writeWithin(within())], options)).toEqual(['broad-path-allow']);
  });

  it('names the protected path a broad directory contains', () => {
    const result = lint([writeWithin(resolve(root, 'srv'))]);
    expect(result.errors[0].message).toContain(resolve(root, 'srv', 'secrets'));
  });

  it('accepts a specific directory', () => {
    expect(errorCodes([writeWithin(`${HOME}/Downloads`)])).toEqual([]);
    expect(errorCodes([writeWithin(resolve(root, 'srv', 'data'))])).toEqual([]);
  });

  it('does not lint read breadth or escalate rules', () => {
    expect(
      errorCodes([
        rule('read-home', {
          server: ['filesystem'],
          tool: ['read_file'],
          paths: { roles: ['read-path'], within: HOME },
        }),
        rule(
          'escalate-home-writes',
          { server: ['filesystem'], tool: ['write_file'], paths: { roles: ['write-path'], within: HOME } },
          'escalate',
        ),
      ]),
    ).toEqual([]);
  });

  it('checks history roles too', () => {
    expect(
      errorCodes([
        rule('branch-home', {
          server: ['git'],
          tool: ['git_branch'],
          paths: { roles: ['read-path', 'write-history', 'delete-history'], within: HOME },
        }),
      ]),
    ).toEqual(['broad-path-allow']);
  });
});

// ---------------------------------------------------------------------------
// Broad domains
// ---------------------------------------------------------------------------

describe('broad-domain-allow', () => {
  const fetchAllowed = (allowed: string[], then: CompiledRule['then'] = 'allow'): CompiledRule =>
    rule('fetch', { server: ['fetch'], tool: ['http_fetch'], domains: { roles: ['fetch-url'], allowed } }, then);

  it.each([['*'], ['*.com'], ['*.co.uk'], ['*.github.io'], ['*.pages.dev']])('rejects allowing %s', (pattern) => {
    const result = lint([fetchAllowed(['docs.python.org', pattern])]);
    expect(result.errors.map((e) => e.code)).toEqual(['broad-domain-allow']);
    expect(result.errors[0].message).toContain(JSON.stringify(pattern));
  });

  it('accepts registrable domains and wildcards under one', () => {
    expect(errorCodes([fetchAllowed(['github.com', '*.github.com', '*.example.co.uk'])])).toEqual([]);
  });

  it('accepts "*" in an escalate rule', () => {
    expect(errorCodes([fetchAllowed(['*'], 'escalate')])).toEqual([]);
  });

  it('expands @lists to their effective values', () => {
    const lists: DynamicListsFile = {
      generatedAt: '',
      lists: {
        'dev-sites': {
          values: ['docs.python.org', '*.pages.dev'],
          manualAdditions: [],
          manualRemovals: [],
          resolvedAt: '',
          inputHash: 'h',
        },
      },
    };
    const result = lint([fetchAllowed(['@dev-sites'])], { dynamicLists: lists });
    expect(result.errors.map((e) => e.code)).toEqual(['broad-domain-allow']);
    expect(result.errors[0].message).toContain('via @dev-sites');

    const removed: DynamicListsFile = {
      ...lists,
      lists: { 'dev-sites': { ...lists.lists['dev-sites'], manualRemovals: ['*.pages.dev'] } },
    };
    expect(errorCodes([fetchAllowed(['@dev-sites'])], { dynamicLists: removed })).toEqual([]);
    // A manual addition counts like any other value.
    const added: DynamicListsFile = {
      ...lists,
      lists: { 'dev-sites': { ...lists.lists['dev-sites'], values: ['docs.python.org'], manualAdditions: ['*'] } },
    };
    expect(errorCodes([fetchAllowed(['@dev-sites'])], { dynamicLists: added })).toEqual(['broad-domain-allow']);
  });

  it('checks domain-typed list conditions, not identifier lists', () => {
    const withList = (matchType: 'domains' | 'identifiers'): CompiledRule =>
      rule('fetch-list', {
        server: ['fetch'],
        tool: ['http_fetch'],
        lists: [{ roles: ['fetch-url'], allowed: ['*'], matchType }],
      });
    expect(errorCodes([withList('domains')])).toEqual(['broad-domain-allow']);
    expect(errorCodes([withList('identifiers')])).toEqual([]);
  });

  it('rejects allowing a URL role with no domains condition (broader than "*")', () => {
    const fetchAny = lint([rule('fetch-any', { server: ['fetch'], tool: ['http_fetch'] })]);
    expect(fetchAny.errors.map((e) => e.code)).toEqual(['broad-domain-allow']);
    expect(fetchAny.errors[0].message).toContain('fetch-url');
    expect(errorCodes([rule('push-any', { server: ['git'], tool: ['git_push'], roles: ['git-remote-url'] })])).toEqual([
      'broad-domain-allow',
    ]);
    expect(
      errorCodes([
        rule('push-github', {
          server: ['git'],
          tool: ['git_push'],
          domains: { roles: ['git-remote-url'], allowed: ['github.com'] },
        }),
      ]),
    ).toEqual([]);
  });

  it('accepts all of it with the explicit opt-in', () => {
    expect(
      errorCodes(
        [
          fetchAllowed(['*', '*.github.io']),
          rule('fetch-any', { server: ['fetch'], tool: ['web_search', 'http_fetch'] }),
        ],
        {
          allowBroadDomains: true,
        },
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe('warnings', () => {
  it('warns about a rule inside a protected path (the engine denies it first)', () => {
    const result = lint([
      rule('read-ssh', { server: ['filesystem'], paths: { roles: ['read-path'], within: `${HOME}/.ssh/keys` } }),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['protected-path-rule']);
  });

  it('does not warn about the sandbox inside a protected path, but notes filesystem rules there are redundant', () => {
    const result = lint([
      rule('git-sandbox', {
        server: ['git'],
        tool: ['git_branch'],
        paths: { roles: ['read-path', 'write-history'], within: SANDBOX },
      }),
      rule('fs-sandbox', { server: ['filesystem'], paths: { roles: ['write-path'], within: `${SANDBOX}/out` } }),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => [w.code, w.rule])).toEqual([['sandbox-path-rule', 'fs-sandbox']]);
  });
});

// ---------------------------------------------------------------------------
// The shipped policies and the opt-in directive
// ---------------------------------------------------------------------------

describe('shipped compiled policies', () => {
  const configDir = resolve(import.meta.dirname, '..', 'src', 'config');
  const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(configDir, path), 'utf-8'));
  const annotations = Object.values(
    (readJson('generated/tool-annotations.json') as StoredToolAnnotationsFile).servers,
  ).flatMap((server) => server.tools);

  // The merged policies (what a session loads), together with the shipped
  // list values: the engine expands them at load time, so a broad list value
  // is as broad as a broad rule.
  it.each(['generated', 'generated-readonly', 'generated-coding'])('%s passes the policy lint', (dir) => {
    const policy = readJson(`${dir}/compiled-policy.json`) as CompiledPolicyFile;
    const listsPath = resolve(configDir, dir, 'dynamic-lists.json');
    const dynamicLists = existsSync(listsPath)
      ? (readJson(`${dir}/dynamic-lists.json`) as DynamicListsFile)
      : undefined;
    const result = lintCompiledRules(policy.rules, { annotations, protectedPaths: [], dynamicLists });
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });
});

describe('constitutionAllowsBroadDomains', () => {
  it('accepts the directive on a line of its own', () => {
    expect(constitutionAllowsBroadDomains(`# Policy\n\n${BROAD_DOMAINS_DIRECTIVE}\n- fetch anything\n`)).toBe(true);
    expect(constitutionAllowsBroadDomains('  <!--ironcurtain:allow-broad-domains-->  ')).toBe(true);
  });

  it('ignores a mention inside other text, and its absence', () => {
    expect(constitutionAllowsBroadDomains(`Do not add ${BROAD_DOMAINS_DIRECTIVE} here.`)).toBe(false);
    expect(constitutionAllowsBroadDomains('# Policy\n- allow-broad-domains\n')).toBe(false);
  });
});
