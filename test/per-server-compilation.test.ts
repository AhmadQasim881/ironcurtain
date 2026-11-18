/**
 * Tests for per-server policy compilation helpers.
 *
 * These are pure function tests for the merge, validation, caching,
 * and filtering helpers used by the per-server compilation path.
 */

import { describe, it, expect } from 'vitest';
import type { CompiledRule, ListDefinition } from '../src/pipeline/types.js';
import { POLICY_COMPILER_EPOCH } from '../src/policy-artifacts/provenance.js';
import {
  computeServerPolicyHash,
  getHandwrittenScenariosForServer,
  mergeServerResults,
  validateServerScoping,
} from '../src/pipeline/pipeline-runner.js';
import { planListMerge } from '../src/pipeline/list-merge.js';

// ---------------------------------------------------------------------------
// validateServerScoping
// ---------------------------------------------------------------------------

describe('validateServerScoping', () => {
  const makeRule = (name: string, server?: string[]): CompiledRule => ({
    name,
    description: 'test',
    principle: 'test',
    if: { server },
    then: 'allow',
    reason: 'test',
  });

  it('passes when all rules are scoped to the expected server', () => {
    const rules = [makeRule('r1', ['filesystem']), makeRule('r2', ['filesystem'])];
    expect(() => validateServerScoping('filesystem', rules)).not.toThrow();
  });

  it('passes with an empty rule set', () => {
    expect(() => validateServerScoping('filesystem', [])).not.toThrow();
  });

  it('throws when a rule is missing the server field', () => {
    const rules = [makeRule('r1', undefined)];
    expect(() => validateServerScoping('filesystem', rules)).toThrow(/missing.*server/i);
  });

  it('throws when a rule is scoped to a different server', () => {
    const rules = [makeRule('r1', ['git'])];
    expect(() => validateServerScoping('filesystem', rules)).toThrow(/missing.*server.*\["filesystem"\]/i);
  });

  it('throws when a rule has multiple servers', () => {
    const rules = [makeRule('r1', ['filesystem', 'git'])];
    expect(() => validateServerScoping('filesystem', rules)).toThrow(/unexpected.*server scope/i);
  });

  it('throws when a rule has an empty server array', () => {
    const rules = [makeRule('r1', [])];
    expect(() => validateServerScoping('filesystem', rules)).toThrow(/missing.*server/i);
  });
});

// ---------------------------------------------------------------------------
// mergeServerResults: dynamic lists across servers (WP-62, PIP-6)
// ---------------------------------------------------------------------------

describe('mergeServerResults: dynamic lists across servers', () => {
  const makeDef = (name: string, prompt: string, overrides: Partial<ListDefinition> = {}): ListDefinition => ({
    name,
    type: 'domains',
    principle: 'test',
    generationPrompt: prompt,
    requiresMcp: false,
    ...overrides,
  });

  const listRule = (server: string, list: string): CompiledRule => ({
    name: `${server}-uses-${list}`,
    description: 'test',
    principle: 'test',
    if: { server: [server], domains: { roles: ['fetch-url'], allowed: [`@${list}`] } },
    then: 'allow',
    reason: 'test',
  });

  const result = (serverName: string, defs: ListDefinition[]) => ({
    serverName,
    rules: defs.map((d) => listRule(serverName, d.name)),
    listDefinitions: defs,
    scenarios: [],
    inputHash: `hash-${serverName}`,
    constitutionHash: 'c',
  });

  const allowedOf = (rule: CompiledRule): string[] => rule.if.domains?.allowed ?? [];
  const quiet = (): void => {};

  it('shares a list that servers define identically', () => {
    const merged = mergeServerResults(
      [result('zeta', [makeDef('trusted-hosts', 'same')]), result('alpha', [makeDef('trusted-hosts', 'same')])],
      'h',
      undefined,
      quiet,
    );
    expect(merged.listDefinitions?.map((d) => d.name)).toEqual(['trusted-hosts']);
    expect(merged.listDefinitions?.[0].sourceName).toBeUndefined();
    expect(merged.rules.map(allowedOf)).toEqual([['@trusted-hosts'], ['@trusted-hosts']]);
  });

  it('keeps apart a list name that servers define differently, in their rules and definitions', () => {
    const logged: string[] = [];
    const merged = mergeServerResults(
      [
        result('zeta', [makeDef('trusted-hosts', 'docs sites to READ')]),
        result('alpha', [makeDef('trusted-hosts', 'company host we may PUSH to')]),
      ],
      'h',
      undefined,
      (msg) => logged.push(msg),
    );

    expect(merged.listDefinitions).toEqual([
      makeDef('alpha--trusted-hosts', 'company host we may PUSH to', { sourceName: 'trusted-hosts' }),
      makeDef('zeta--trusted-hosts', 'docs sites to READ', { sourceName: 'trusted-hosts' }),
    ]);
    // Each server's rules use its own copy (rules are in alphabetical server order).
    expect(merged.rules.map((r) => [r.if.server, allowedOf(r)])).toEqual([
      [['alpha'], ['@alpha--trusted-hosts']],
      [['zeta'], ['@zeta--trusted-hosts']],
    ]);
    expect(logged.join('\n')).toMatch(/alpha, zeta define list "trusted-hosts" differently/);
  });

  it('rewrites references in lists[] conditions too', () => {
    const def = (prompt: string) => makeDef('my-contacts', prompt, { type: 'emails' });
    const emailRule = (server: string): CompiledRule => ({
      name: `${server}-send`,
      description: 'test',
      principle: 'test',
      if: { server: [server], lists: [{ roles: ['email-address'], allowed: ['@my-contacts'], matchType: 'emails' }] },
      then: 'allow',
      reason: 'test',
    });
    const merged = mergeServerResults(
      [
        { ...result('gmail', [def('a')]), rules: [emailRule('gmail')] },
        { ...result('slack', [def('b')]), rules: [emailRule('slack')] },
      ],
      'h',
      undefined,
      quiet,
    );
    expect(merged.rules.map((r) => r.if.lists?.[0].allowed)).toEqual([
      ['@gmail--my-contacts'],
      ['@slack--my-contacts'],
    ]);
  });

  it('treats a different type, requiresMcp or MCP server as a different definition, but not the principle', () => {
    const differs = (a: ListDefinition, b: ListDefinition): boolean =>
      planListMerge([result('a', [a]), result('b', [b])]).divergent.has('l');
    const base = makeDef('l', 'p');
    expect(differs(base, { ...base, type: 'identifiers' })).toBe(true);
    expect(differs(base, { ...base, requiresMcp: true, mcpServerHint: 'b' })).toBe(true);
    expect(
      differs({ ...base, requiresMcp: true, mcpServerHint: 'x' }, { ...base, requiresMcp: true, mcpServerHint: 'y' }),
    ).toBe(true);
    expect(differs(base, { ...base, principle: 'other words' })).toBe(false);
  });

  it('takes the last definition of a name a server repeats, as its validation and list resolution do', () => {
    const merged = mergeServerResults(
      [result('alpha', [makeDef('l', 'first'), makeDef('l', 'last')])],
      'h',
      undefined,
      quiet,
    );
    expect(merged.listDefinitions?.map((d) => [d.name, d.generationPrompt])).toEqual([['l', 'last']]);
  });

  it('does not depend on the order of the results', () => {
    const results = [result('zeta', [makeDef('l', 'z')]), result('alpha', [makeDef('l', 'a')])];
    const forward = mergeServerResults(results, 'h', undefined, quiet);
    const reverse = mergeServerResults([...results].reverse(), 'h', undefined, quiet);
    expect(reverse.listDefinitions).toEqual(forward.listDefinitions);
    expect(reverse.rules).toEqual(forward.rules);
  });

  it("fails instead of letting a renamed list take another list's name", () => {
    // alpha's and beta's "c" are kept apart as alpha--c and beta--c, but alpha
    // also defines a list literally named "beta--c".
    const results = [
      result('alpha', [makeDef('c', 'one'), makeDef('beta--c', 'other')]),
      result('beta', [makeDef('c', 'two')]),
    ];
    expect(() => mergeServerResults(results, 'h', undefined, quiet)).toThrow(/collision/);
  });

  it('fails when the merged rules do not validate against the merged definitions', () => {
    const broken = { ...result('alpha', []), rules: [listRule('alpha', 'undefined-list')] };
    expect(() => mergeServerResults([broken], 'h', undefined, quiet)).toThrow(/merged policy failed validation/);
  });
});

// ---------------------------------------------------------------------------
// mergeServerResults
// ---------------------------------------------------------------------------

describe('mergeServerResults', () => {
  const makeResult = (serverName: string, ruleCount: number, listDefs: ListDefinition[] = []) => ({
    serverName,
    rules: Array.from({ length: ruleCount }, (_, i) => ({
      name: `${serverName}-rule-${i}`,
      description: 'test',
      principle: 'test',
      if: { server: [serverName] },
      then: 'allow' as const,
      reason: 'test',
    })),
    listDefinitions: listDefs,
    scenarios: [],
    inputHash: `hash-${serverName}`,
    constitutionHash: 'const-hash',
  });

  it('merges rules in alphabetical server order', () => {
    const results = [makeResult('git', 2), makeResult('filesystem', 1)];
    const merged = mergeServerResults(results, 'const-hash');

    // filesystem comes before git alphabetically
    expect(merged.rules[0].name).toBe('filesystem-rule-0');
    expect(merged.rules[1].name).toBe('git-rule-0');
    expect(merged.rules[2].name).toBe('git-rule-1');
  });

  it('produces a deterministic inputHash from server hashes', () => {
    const results = [makeResult('git', 1), makeResult('filesystem', 1)];
    const merged1 = mergeServerResults(results, 'h');
    const merged2 = mergeServerResults([...results].reverse(), 'h');
    // Same servers regardless of input order -> same hash
    expect(merged1.inputHash).toBe(merged2.inputHash);
  });

  it('includes constitutionHash', () => {
    const results = [makeResult('fs', 1)];
    const merged = mergeServerResults(results, 'my-hash');
    expect(merged.constitutionHash).toBe('my-hash');
  });

  it('sets listDefinitions only when non-empty', () => {
    const noLists = mergeServerResults([makeResult('fs', 1)], 'h');
    expect(noLists.listDefinitions).toBeUndefined();

    const withLists = mergeServerResults(
      [
        makeResult('fs', 1, [
          { name: 'list-a', type: 'domains', principle: 'p', generationPrompt: 'gp', requiresMcp: false },
        ]),
      ],
      'h',
    );
    expect(withLists.listDefinitions).toHaveLength(1);
  });

  it('handles empty results array', () => {
    const merged = mergeServerResults([], 'h');
    expect(merged.rules).toEqual([]);
    expect(merged.listDefinitions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeServerPolicyHash
// ---------------------------------------------------------------------------

describe('computeServerPolicyHash', () => {
  const annotations = [
    {
      toolName: 'read_file',
      serverName: 'filesystem',
      comment: 'reads a file',

      args: { path: ['read-path' as const] },
    },
  ];

  it('produces consistent hashes for identical inputs', () => {
    const h1 = computeServerPolicyHash('fs', 'constitution', annotations, 'prompt');
    const h2 = computeServerPolicyHash('fs', 'constitution', annotations, 'prompt');
    expect(h1).toBe(h2);
  });

  it('changes when server name changes', () => {
    const h1 = computeServerPolicyHash('fs', 'c', annotations, 'p');
    const h2 = computeServerPolicyHash('git', 'c', annotations, 'p');
    expect(h1).not.toBe(h2);
  });

  it('changes when constitution changes', () => {
    const h1 = computeServerPolicyHash('fs', 'constitution-v1', annotations, 'p');
    const h2 = computeServerPolicyHash('fs', 'constitution-v2', annotations, 'p');
    expect(h1).not.toBe(h2);
  });

  it('changes when annotations change', () => {
    const h1 = computeServerPolicyHash('fs', 'c', annotations, 'p');
    const h2 = computeServerPolicyHash('fs', 'c', [{ ...annotations[0], comment: 'different' }], 'p');
    expect(h1).not.toBe(h2);
  });

  it('changes when prompt template changes', () => {
    const h1 = computeServerPolicyHash('fs', 'c', annotations, 'prompt-v1');
    const h2 = computeServerPolicyHash('fs', 'c', annotations, 'prompt-v2');
    expect(h1).not.toBe(h2);
  });

  it('includes the policy-compiler epoch: bumping it invalidates every cached server', () => {
    const current = computeServerPolicyHash('fs', 'c', annotations, 'p');
    expect(computeServerPolicyHash('fs', 'c', annotations, 'p', POLICY_COMPILER_EPOCH)).toBe(current);
    expect(computeServerPolicyHash('fs', 'c', annotations, 'p', POLICY_COMPILER_EPOCH + 1)).not.toBe(current);
  });
});

// ---------------------------------------------------------------------------
// getHandwrittenScenariosForServer
// ---------------------------------------------------------------------------

describe('getHandwrittenScenariosForServer', () => {
  const sandbox = '/tmp/sandbox';

  it('returns filesystem scenarios for the filesystem server', () => {
    const scenarios = getHandwrittenScenariosForServer('filesystem', sandbox);
    expect(scenarios.length).toBeGreaterThan(0);
    for (const s of scenarios) {
      expect(s.request.serverName).toBe('filesystem');
    }
  });

  it('returns empty array for servers with no handwritten scenarios', () => {
    const scenarios = getHandwrittenScenariosForServer('git', sandbox);
    expect(scenarios).toEqual([]);
  });

  it('returns empty array for nonexistent server names', () => {
    const scenarios = getHandwrittenScenariosForServer('nonexistent', sandbox);
    expect(scenarios).toEqual([]);
  });

  it('uses the sandbox directory in scenario arguments', () => {
    const scenarios = getHandwrittenScenariosForServer('filesystem', '/my/sandbox');
    const hasPathWithSandbox = scenarios.some((s) => JSON.stringify(s.request.arguments).includes('/my/sandbox'));
    expect(hasPathWithSandbox).toBe(true);
  });
});
