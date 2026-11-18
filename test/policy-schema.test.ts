/**
 * Runtime schema validation of compiled artifacts (WP-61).
 *
 * The runtime loaders used to cast parsed JSON to the artifact types, so a
 * hand-edit typo or version skew failed open at evaluation time:
 * `then: "Escalate"` came back from the engine as a decision the pipeline
 * forwarded like an allow, a misspelled condition key (`tools`) made a rule
 * server-wide, an `if: {}` allow matched every call, and a string where the
 * lists file expects an array was spread into single characters (a bare `*`
 * allowlist entry). These tests pin the fail-closed behaviour: every loader
 * rejects such files with a field-level error naming the file, the engine
 * denies a rule whose decision it does not recognize, the coordinator keeps
 * its engine when a hot-swapped policy is malformed, and doctor reports it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { v4 as uuidv4 } from 'uuid';
import {
  getPackageGeneratedDir,
  loadDynamicListsArtifact,
  loadGeneratedPolicy,
  loadPersonaPolicyArtifacts,
} from '../src/config/index.js';
import { readToolAnnotationsFile, TOOL_ANNOTATIONS_INVALID } from '../src/config/tool-annotations-overlay.js';
import {
  invalidPolicyArtifact,
  isCatchAllCondition,
  isPolicyDecisionStatus,
  isRuleOutcome,
  ruleOutcomeAllows,
  parseCompiledPolicyFile,
  parseDynamicListsFile,
  POLICY_ARTIFACT_INVALID,
  toolAnnotationsFileProblems,
} from '../src/types/policy-schema.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { ToolCallCoordinator } from '../src/trusted-process/tool-call-coordinator.js';
import { checkPolicyArtifacts } from '../src/doctor/checks.js';
import { buildPatchResponseSchema } from '../src/pipeline/constitution-compiler.js';
import * as pipelineShared from '../src/pipeline/pipeline-shared.js';
import { PipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { main as refreshListsMain, refreshDynamicLists } from '../src/pipeline/refresh-lists.js';
import { NoOpCacheStrategy } from '../src/session/prompt-cache.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
} from './fixtures/test-policy.js';
import { createFakePipelineModels } from './fixtures/fake-pipeline-models.js';
import {
  GOLDEN_ALLOWED_DIR,
  GOLDEN_ANNOTATIONS,
  GOLDEN_CONSTITUTION,
  GOLDEN_RESPONSES,
} from './fixtures/golden-pipeline-fixture.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

function rule(partial: Partial<CompiledRule> & Pick<CompiledRule, 'name'>): CompiledRule {
  return {
    description: 'd',
    principle: 'p',
    if: { server: ['github'] },
    then: 'allow',
    reason: 'r',
    ...partial,
  };
}

function policyWith(rules: unknown[]): Record<string, unknown> {
  return { generatedAt: 'test', constitutionHash: 'test', inputHash: 'test', rules };
}

function listsWith(lists: Record<string, unknown>): Record<string, unknown> {
  return { generatedAt: 'test', lists };
}

function resolvedList(values: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { values, manualAdditions: [], manualRemovals: [], resolvedAt: 'test', inputHash: 'test', ...extra };
}

/** Annotations for the engine-level checks: one tool per evaluation path. */
const ANNOTATIONS: StoredToolAnnotationsFile = {
  generatedAt: 'test',
  servers: {
    github: {
      inputHash: 'test',
      tools: [
        { toolName: 'get_me', serverName: 'github', comment: 'no resource roles', args: {}, inputSchema: {} },
        {
          toolName: 'delete_repository',
          serverName: 'github',
          comment: 'deletes',
          args: { owner: ['github-owner'], repo: ['github-repo'] },
          inputSchema: {},
        },
      ],
    },
    fetch: {
      inputHash: 'test',
      tools: [
        {
          toolName: 'http_fetch',
          serverName: 'fetch',
          comment: 'fetch',
          args: { url: ['fetch-url'] },
          inputSchema: {},
        },
      ],
    },
    filesystem: {
      inputHash: 'test',
      tools: [
        {
          toolName: 'read_file',
          serverName: 'filesystem',
          comment: 'read',
          args: { path: ['read-path'] },
          inputSchema: {},
        },
      ],
    },
  },
};

function request(serverName: string, toolName: string, args: Record<string, unknown>): ToolCallRequest {
  return { requestId: 'r', serverName, toolName, arguments: args, timestamp: '' };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'policy-schema-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes JSON files into a fresh directory under the test root. */
function policyDir(name: string, files: Record<string, unknown>): string {
  const dir = resolve(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(resolve(dir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function errorFrom(fn: () => unknown): Error & Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err as Error & Record<string, unknown>;
    throw new Error(`expected an Error, got ${String(err)}`, { cause: err });
  }
  throw new Error('expected the call to throw');
}

/** Loads a persona-style policy dir (compiled policy + optional lists). */
function loadDir(dir: string): ReturnType<typeof loadPersonaPolicyArtifacts> {
  return loadPersonaPolicyArtifacts(dir);
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

describe('malformed artifacts fail loading with a field-level error', () => {
  it("then: 'allw' fails with the file path and the offending field", () => {
    const dir = policyDir('allw', {
      'compiled-policy.json': policyWith([rule({ name: 'fine' }), rule({ name: 'typo', then: 'allw' as never })]),
    });
    const err = errorFrom(() => loadDir(dir));

    expect(err.code).toBe(POLICY_ARTIFACT_INVALID);
    expect(invalidPolicyArtifact(err)).toBe('compiled-policy');
    expect(err.path).toBe(resolve(dir, 'compiled-policy.json'));
    expect(err.message).toContain(resolve(dir, 'compiled-policy.json'));
    expect(err.message).toContain('rules[1].then: "allw" is not one of "allow", "assess", "escalate", "deny"');
  });

  it("then: 'Escalate' (the audit repro) no longer loads as a decision the pipeline would forward", () => {
    const dir = policyDir('escalate-case', {
      'compiled-policy.json': policyWith([rule({ name: 'oops', then: 'Escalate' as never })]),
    });
    expect(() => loadDir(dir)).toThrow(/rules\[0\]\.then: "Escalate" is not one of/);
  });

  it("a misspelled 'tools' condition key fails instead of making the rule server-wide", () => {
    // Not a literal argument, so TypeScript's excess-property check lets the typo through, as JSON would.
    const misspelled = { name: 'allow-read', if: { server: ['github'], tools: ['get_me'] } };
    const dir = policyDir('tools-typo', { 'compiled-policy.json': policyWith([rule(misspelled)]) });

    const err = errorFrom(() =>
      loadGeneratedPolicy({ policyDir: dir, toolAnnotationsDir: dir, fallbackDir: getPackageGeneratedDir() }),
    );
    expect(err.code).toBe(POLICY_ARTIFACT_INVALID);
    expect(err.message).toContain('rules[0].if.tools: unknown field');
  });

  it('a non-array list value fails instead of being spread into single characters', () => {
    const dir = policyDir('lists-string', {
      'compiled-policy.json': policyWith([
        rule({ name: 'news', if: { server: ['fetch'], domains: { roles: ['fetch-url'], allowed: ['@news'] } } }),
      ]),
      'dynamic-lists.json': listsWith({ news: resolvedList(['bbc.com'], { manualAdditions: '*.bbc.co.uk' }) }),
    });

    const err = errorFrom(() => loadDir(dir));
    expect(err.code).toBe(POLICY_ARTIFACT_INVALID);
    expect(invalidPolicyArtifact(err)).toBe('dynamic-lists');
    expect(err.path).toBe(resolve(dir, 'dynamic-lists.json'));
    expect(err.message).toContain('lists.news.manualAdditions: expected an array, got "*.bbc.co.uk"');
  });

  it('a non-array "values" fails too', () => {
    expect(() =>
      parseDynamicListsFile(listsWith({ news: resolvedList([], { values: 'bbc.com' }) }), '/x/dynamic-lists.json'),
    ).toThrow(/lists\.news\.values: expected an array, got "bbc\.com"/);
  });

  it('the stress-suite catch-all deny rule still loads and still denies', () => {
    // test/policy-engine-stress.test.ts builds { if: {}, then: 'deny' } in
    // memory; the same rule must also load from disk.
    const dir = policyDir('deny-all', {
      'compiled-policy.json': policyWith([
        { name: 'deny-all', description: 'd', principle: 't', if: {}, then: 'deny', reason: 'default' },
      ]),
    });
    const { compiledPolicy } = loadDir(dir);
    const engine = new PolicyEngine(compiledPolicy, ANNOTATIONS, []);
    const result = engine.evaluate(request('github', 'get_me', {}));
    expect(result).toMatchObject({ decision: 'deny', rule: 'deny-all' });
  });

  it('an unknown decision maps to deny in the engine', () => {
    const unknown = (then: string, partial: Partial<CompiledRule> & Pick<CompiledRule, 'name'>): CompiledRule =>
      rule({ ...partial, then: then as CompiledRule['then'] });
    const engine = new PolicyEngine(
      {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          // No resource roles: the unscoped first-match scan.
          unknown('Escalate', { name: 'unscoped', if: { server: ['github'], tool: ['get_me'] } }),
          // URL role without paths: the per-role linear scan.
          unknown('allw', { name: 'per-role', if: { server: ['fetch'] } }),
          // Path role: per-path discharge.
          unknown('ALLOW', { name: 'per-path', if: { roles: ['read-path'] } }),
        ],
      },
      ANNOTATIONS,
      [],
      TEST_SANDBOX_DIR,
    );

    expect(engine.evaluate(request('github', 'get_me', {}))).toMatchObject({ decision: 'deny', rule: 'unscoped' });
    expect(engine.evaluate(request('fetch', 'http_fetch', { url: 'https://example.com/' }))).toMatchObject({
      decision: 'deny',
      rule: 'per-role',
    });
    expect(engine.evaluate(request('filesystem', 'read_file', { path: '/etc/hostname' }))).toMatchObject({
      decision: 'deny',
      rule: 'per-path',
    });
  });
});

// ---------------------------------------------------------------------------
// compiled-policy.json
// ---------------------------------------------------------------------------

describe('compiled-policy.json schema', () => {
  it.each([
    'src/config/generated/compiled-policy.json',
    'src/config/generated-readonly/compiled-policy.json',
    'src/config/generated-coding/compiled-policy.json',
    'test/golden/compiled-policy.json',
  ])('accepts the shipped policy %s unchanged', (file) => {
    const path = resolve(PROJECT_ROOT, file);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as CompiledPolicyFile;
    expect(parseCompiledPolicyFile(raw, path)).toEqual(raw);
  });

  it('accepts allow, assess, escalate and deny', () => {
    const policy = policyWith([
      rule({ name: 'a', then: 'allow' }),
      rule({ name: 's', then: 'assess' }),
      rule({ name: 'e', then: 'escalate' }),
      rule({ name: 'd', then: 'deny' }),
    ]);
    expect(parseCompiledPolicyFile(policy, '/x').rules.map((r) => r.then)).toEqual([
      'allow',
      'assess',
      'escalate',
      'deny',
    ]);
  });

  it.each(['allow', 'assess', 'escalate'] as const)('rejects a catch-all %s rule', (then) => {
    expect(() =>
      parseCompiledPolicyFile(policyWith([rule({ name: 'oops-empty', if: {}, then })]), '/x/compiled-policy.json'),
    ).toThrow(new RegExp(`rules\\[0\\]\\.if: matches every call, which is not allowed for an "${then}" rule`));
  });

  it('treats an empty lists array as no constraint', () => {
    expect(() => parseCompiledPolicyFile(policyWith([rule({ name: 'x', if: { lists: [] } })]), '/x')).toThrow(
      /rules\[0\]\.if: matches every call/,
    );
    expect(isCatchAllCondition({ lists: [] })).toBe(true);
    expect(isCatchAllCondition({ roles: [] })).toBe(false);
    expect(isCatchAllCondition({ server: ['github'], lists: [] })).toBe(false);
  });

  it('rejects unknown keys in a rule, including humanOnly (hardcoded rules only)', () => {
    const withHumanOnly = { ...rule({ name: 'x', then: 'escalate' }), humanOnly: true };
    const withUnless = { ...rule({ name: 'y' }), unless: { tool: ['delete_repository'] } };
    const err = errorFrom(() => parseCompiledPolicyFile(policyWith([withHumanOnly, withUnless]), '/x'));
    expect(err.message).toContain('rules[0].humanOnly: unknown field');
    expect(err.message).toContain('rules[1].unless: unknown field');
  });

  it('rejects unknown keys inside paths, domains and lists conditions', () => {
    const policy = policyWith([
      rule({ name: 'p', if: { paths: { roles: ['read-path'], within: '/tmp', recursive: true } as never } }),
      rule({ name: 'd', if: { domains: { roles: ['fetch-url'], allowed: ['a.com'], except: ['b.com'] } as never } }),
      rule({
        name: 'l',
        if: { lists: [{ roles: ['email-address'], allowed: ['a@b.c'], matchType: 'emails', any: true }] as never },
      }),
    ]);
    const err = errorFrom(() => parseCompiledPolicyFile(policy, '/x'));
    expect(err.message).toContain('rules[0].if.paths.recursive: unknown field');
    expect(err.message).toContain('rules[1].if.domains.except: unknown field');
    expect(err.message).toContain('rules[2].if.lists[0].any: unknown field');
  });

  it('rejects unregistered roles and list match types', () => {
    const policy = policyWith([
      rule({ name: 'r', if: { roles: ['write-pth' as never] } }),
      rule({ name: 'm', if: { lists: [{ roles: ['email-address'], allowed: ['x'], matchType: 'email' as never }] } }),
    ]);
    const err = errorFrom(() => parseCompiledPolicyFile(policy, '/x'));
    expect(err.message).toContain('rules[0].if.roles[0]: "write-pth" is not one of "read-path"');
    expect(err.message).toContain(
      'rules[1].if.lists[0].matchType: "email" is not one of "domains", "emails", "identifiers"',
    );
  });

  it('requires paths.within to be absolute or home-relative', () => {
    const withinRule = (within: string) => rule({ name: within, if: { paths: { roles: ['read-path'], within } } });
    expect(() => parseCompiledPolicyFile(policyWith([withinRule('Documents')]), '/x')).toThrow(
      /rules\[0\]\.if\.paths\.within: must be an absolute path or start with ~\//,
    );
    expect(() =>
      parseCompiledPolicyFile(
        policyWith([withinRule('/home/u/Documents'), withinRule('~/Downloads'), withinRule('~')]),
        '/x',
      ),
    ).not.toThrow();
  });

  it('rejects wrong value types in a condition', () => {
    const err = errorFrom(() =>
      parseCompiledPolicyFile(
        policyWith([rule({ name: 'x', if: { server: 'github' as never, tool: null as never } })]),
        '/x',
      ),
    );
    expect(err.message).toContain('rules[0].if.server: expected an array, got "github"');
    expect(err.message).toContain('rules[0].if.tool: expected an array, got null');
  });

  it('requires the metadata IronCurtain always writes, and names each missing field', () => {
    const err = errorFrom(() => parseCompiledPolicyFile({ rules: [] }, '/x/compiled-policy.json'));
    expect(err.message).toContain('generatedAt: missing (expected a string)');
    expect(err.message).toContain('constitutionHash: missing (expected a string)');
    expect(err.message).toContain('inputHash: missing (expected a string)');
    expect(() => parseCompiledPolicyFile([], '/x')).toThrow(/\(top level\): expected an object, got an array/);
  });

  it('keeps unknown top-level keys (informational metadata)', () => {
    const parsed = parseCompiledPolicyFile({ ...policyWith([]), provenance: { epoch: 2 } }, '/x');
    expect(parsed).toMatchObject({ provenance: { epoch: 2 } });
  });

  it('reports invalid JSON with the file path instead of a bare SyntaxError', () => {
    const dir = policyDir('broken', { 'compiled-policy.json': '{broken' });
    const err = errorFrom(() => loadDir(dir));
    expect(err.code).toBe(POLICY_ARTIFACT_INVALID);
    expect(err.message).toContain(`${resolve(dir, 'compiled-policy.json')} is not a valid compiled policy`);
    expect(err.message).toContain('not valid JSON');
  });

  it('still reports a missing file as ENOENT', () => {
    expect(errorFrom(() => loadDir(resolve(root, 'absent'))).code).toBe('ENOENT');
  });

  it('bounds the report and escapes control and bidi characters', () => {
    const hostile = [{ ...rule({ name: 'k' }), ['\u001b[2Jx']: 1 }, rule({ name: 'v', then: '‮allow' as never })];
    const rules = Array.from({ length: 25 }, (_, i) => rule({ name: `r${i}`, then: 'nope' as never }));
    const err = errorFrom(() => parseCompiledPolicyFile(policyWith([...hostile, ...rules]), '/x'));

    expect(err.message).toContain('rules[0]["\\u001b[2Jx"]: unknown field');
    expect(err.message).toContain('rules[1].then: "\\u202eallow" is not one of');
    expect(err.message).not.toContain('\u001b');
    expect(err.message).not.toContain('‮');
    // Heading, 20 listed problems, and the count of the rest.
    expect(err.message.split('\n')).toHaveLength(22);
    expect(err.message).toContain('  - ... and 7 more');
  });

  it('validates informational arrays by type', () => {
    expect(() =>
      parseCompiledPolicyFile(
        { ...policyWith([]), failedServers: [{ serverName: 'git', phase: 'exploding', reason: 'r' }] },
        '/x',
      ),
    ).toThrow(/failedServers\[0\]\.phase: "exploding" is not one of/);
  });
});

// ---------------------------------------------------------------------------
// dynamic-lists.json
// ---------------------------------------------------------------------------

describe('dynamic-lists.json schema', () => {
  it.each([
    'src/config/generated/dynamic-lists.json',
    'src/config/generated-coding/dynamic-lists.json',
    'test/golden/dynamic-lists.json',
  ])('accepts the shipped lists %s unchanged', (file) => {
    const path = resolve(PROJECT_ROOT, file);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as DynamicListsFile;
    expect(parseDynamicListsFile(raw, path)).toEqual(raw);
  });

  it('fills in missing manual override arrays, which users add by hand', () => {
    const dir = policyDir('defaults', {
      'compiled-policy.json': policyWith([
        rule({ name: 'news', if: { server: ['fetch'], domains: { roles: ['fetch-url'], allowed: ['@news'] } } }),
      ]),
      'dynamic-lists.json': listsWith({ news: { values: ['*.bbc.co.uk'], resolvedAt: 'test', inputHash: 'test' } }),
    });
    const { compiledPolicy, dynamicLists } = loadDir(dir);
    expect(dynamicLists?.lists.news).toMatchObject({ manualAdditions: [], manualRemovals: [] });

    // Constructing the engine used to throw "list.manualAdditions is not iterable".
    const engine = new PolicyEngine(compiledPolicy, ANNOTATIONS, [], undefined, undefined, dynamicLists);
    expect(engine.evaluate(request('fetch', 'http_fetch', { url: 'https://www.bbc.co.uk/news' })).decision).toBe(
      'allow',
    );
    expect(engine.evaluate(request('fetch', 'http_fetch', { url: 'https://evil.example/' })).decision).toBe('deny');
  });

  it('rejects a misspelled override key instead of silently keeping a removed value', () => {
    expect(() =>
      parseDynamicListsFile(listsWith({ news: resolvedList(['a.com'], { manualRemoval: ['a.com'] }) }), '/x'),
    ).toThrow(/lists\.news\.manualRemoval: unknown field/);
  });

  it('rejects non-string entries', () => {
    expect(() =>
      parseDynamicListsFile(listsWith({ news: resolvedList(['a.com'], { manualRemovals: [42] }) }), '/x'),
    ).toThrow(/lists\.news\.manualRemovals\[0\]: expected a string, got 42/);
  });

  it('validates a list named __proto__ like any other', () => {
    const raw = JSON.parse('{"generatedAt":"t","lists":{"__proto__":{"values":"x","resolvedAt":"t","inputHash":"t"}}}');
    expect(() => parseDynamicListsFile(raw, '/x')).toThrow(/lists\.__proto__\.values: expected an array/);
    const ok = JSON.parse(
      '{"generatedAt":"t","lists":{"__proto__":{"values":["a"],"resolvedAt":"t","inputHash":"t"}}}',
    );
    const parsed = parseDynamicListsFile(ok, '/x');
    expect(Object.hasOwn(parsed.lists, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed.lists)).toBe(Object.prototype);
  });
});

// ---------------------------------------------------------------------------
// tool-annotations.json
// ---------------------------------------------------------------------------

describe('tool-annotations.json schema', () => {
  function annotationsWithArgs(args: unknown, extraTools: unknown[] = []): Record<string, unknown> {
    return {
      generatedAt: 'test',
      servers: {
        git: {
          inputHash: 'h',
          tools: [{ toolName: 'git_branch', serverName: 'git', comment: 'c', args }, ...extraTools],
        },
      },
    };
  }

  it('accepts the shipped annotations', () => {
    const path = resolve(getPackageGeneratedDir(), 'tool-annotations.json');
    expect(toolAnnotationsFileProblems(JSON.parse(readFileSync(path, 'utf-8')))).toEqual([]);
  });

  it('rejects an unregistered role with a coded, field-level error', () => {
    const dir = policyDir('bad-role', { 'tool-annotations.json': annotationsWithArgs({ path: ['read-pth'] }) });
    const err = errorFrom(() => readToolAnnotationsFile(resolve(dir, 'tool-annotations.json')));
    expect(err.code).toBe(TOOL_ANNOTATIONS_INVALID);
    expect(err.message).toContain('servers.git.tools[0].args.path[0]: "read-pth" is not one of "read-path"');
  });

  it('rejects a bare role string and a misspelled conditional block', () => {
    const problems = toolAnnotationsFileProblems(
      annotationsWithArgs({ path: 'read-path', name: { defualt: ['branch-name'], when: [] } }),
    );
    expect(problems).toContain('servers.git.tools[0].args.path: expected an array or an object, got "read-path"');
    expect(problems).toContain('servers.git.tools[0].args.name.defualt: unknown field');
    expect(problems).toContain('servers.git.tools[0].args.name.default: missing (expected an array)');
  });

  it('rejects a condition with no operator or two operators', () => {
    const conditional = (condition: unknown) => ({
      operation: ['none'],
      name: { default: ['branch-name'], when: [{ condition, roles: ['none'] }] },
    });
    expect(toolAnnotationsFileProblems(annotationsWithArgs(conditional({ arg: 'operation', eqauls: 'list' })))).toEqual(
      expect.arrayContaining(['servers.git.tools[0].args.name.when[0].condition.eqauls: unknown field']),
    );
    expect(
      toolAnnotationsFileProblems(
        annotationsWithArgs(conditional({ arg: 'operation', equals: 'list', is: 'present' })),
      ),
    ).toContain('servers.git.tools[0].args.name.when[0].condition: must set exactly one of "equals", "in" or "is"');
  });

  it('rejects a condition on an argument the tool does not annotate (it would always read as absent)', () => {
    const problems = toolAnnotationsFileProblems(
      annotationsWithArgs({
        operation: ['none'],
        name: { default: ['branch-name'], when: [{ condition: { arg: 'opreation', is: 'absent' }, roles: ['none'] }] },
      }),
    );
    expect(problems).toEqual([
      'servers.git.tools[0].args.name.when[0].condition.arg: names no annotated argument of this tool ("opreation")',
    ]);
  });

  it('rejects a tool annotated twice for one server', () => {
    const problems = toolAnnotationsFileProblems(
      annotationsWithArgs({ path: ['read-path'] }, [{ toolName: 'git_branch', args: { path: ['none'] } }]),
    );
    expect(problems).toEqual([
      'servers.git.tools[1].toolName: annotates "git_branch" a second time (first at tools[0])',
    ]);
  });

  it('validates a server named __proto__ like any other', () => {
    const raw = JSON.parse('{"servers":{"__proto__":{"inputHash":5,"tools":[]}}}');
    expect(toolAnnotationsFileProblems(raw)).toEqual(['servers.__proto__.inputHash: expected a string, got 5']);
  });

  it('returns the file as it is on disk (unknown informational keys kept)', () => {
    const file = annotationsWithArgs({ path: ['read-path'] });
    (file.servers as Record<string, Record<string, unknown>>).git.futureField = 1;
    const dir = policyDir('kept', { 'tool-annotations.json': file });
    expect(readToolAnnotationsFile(resolve(dir, 'tool-annotations.json'))).toEqual(file);
  });
});

// ---------------------------------------------------------------------------
// Engine defense in depth
// ---------------------------------------------------------------------------

describe('PolicyEngine defense in depth', () => {
  it('isPolicyDecisionStatus accepts exactly the three decisions', () => {
    expect(['allow', 'escalate', 'deny'].every(isPolicyDecisionStatus)).toBe(true);
    for (const value of ['Escalate', 'allw', '', 'toString', 'assess', undefined, null, 1]) {
      expect(isPolicyDecisionStatus(value)).toBe(false);
    }
  });

  it('isRuleOutcome accepts exactly the four rule outcomes; allow and assess let a call through', () => {
    expect(['allow', 'assess', 'escalate', 'deny'].every(isRuleOutcome)).toBe(true);
    for (const value of ['Assess', 'allw', '', 'toString', undefined, null, 1]) {
      expect(isRuleOutcome(value)).toBe(false);
      expect(ruleOutcomeAllows(value)).toBe(false);
    }
    expect(['allow', 'assess', 'escalate', 'deny'].filter(ruleOutcomeAllows)).toEqual(['allow', 'assess']);
  });

  it('an unknown decision never outranks or masks a real one', () => {
    const engine = new PolicyEngine(
      {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          rule({ name: 'owner-ok', if: { server: ['github'], roles: ['github-owner'] }, then: 'allow' }),
          rule({ name: 'repo-typo', if: { server: ['github'], roles: ['github-repo'] }, then: 'escalte' as never }),
        ],
      },
      ANNOTATIONS,
      [],
    );
    expect(engine.evaluate(request('github', 'delete_repository', { owner: 'me', repo: 'r' }))).toMatchObject({
      decision: 'deny',
      rule: 'repo-typo',
    });
  });

  it('an @list naming an Object.prototype member expands to nothing instead of crashing', () => {
    const policy: CompiledPolicyFile = {
      generatedAt: 'test',
      constitutionHash: 'test',
      inputHash: 'test',
      rules: [
        rule({ name: 'odd', if: { server: ['fetch'], domains: { roles: ['fetch-url'], allowed: ['@constructor'] } } }),
      ],
    };
    const lists = parseDynamicListsFile(listsWith({ news: resolvedList(['a.com']) }), '/x');
    const engine = new PolicyEngine(policy, ANNOTATIONS, [], undefined, undefined, lists);
    expect(engine.evaluate(request('fetch', 'http_fetch', { url: 'https://a.com/' })).decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Coordinator hot-swap and doctor
// ---------------------------------------------------------------------------

describe('ToolCallCoordinator.loadPolicy with a malformed policy', () => {
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.IRONCURTAIN_HOME;
    // A persona policy dir must be <home>/personas/<name>/generated (validatePolicyDir).
    process.env.IRONCURTAIN_HOME = root;
    mkdirSync(TEST_SANDBOX_DIR, { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
  });

  it.each([
    ['an unknown decision', { 'compiled-policy.json': policyWith([rule({ name: 'x', then: 'allw' as never })]) }],
    [
      'a malformed lists file',
      {
        'compiled-policy.json': policyWith([]),
        'dynamic-lists.json': listsWith({ news: resolvedList([], { values: 'x' }) }),
      },
    ],
  ])('rejects %s and keeps the current engine', async (_label, files) => {
    const dir = policyDir(`personas/reviewer-${uuidv4()}/generated`, files);
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: resolve(root, 'audit.jsonl'),
    });
    const before = coordinator.getPolicyEngine();
    try {
      await expect(coordinator.loadPolicy({ persona: 'reviewer', policyDir: dir })).rejects.toMatchObject({
        code: POLICY_ARTIFACT_INVALID,
      });
      expect(coordinator.getPolicyEngine()).toBe(before);
    } finally {
      await coordinator.close();
    }
  });
});

describe('doctor surfaces schema errors', () => {
  function check(dir: string) {
    return checkPolicyArtifacts({ generatedDir: dir, toolAnnotationsDir: dir } as IronCurtainConfig).results[0];
  }

  it('fails with the offending field and points at compile-policy for the compiled policy', () => {
    const dir = policyDir('doctor-policy', {
      'compiled-policy.json': policyWith([rule({ name: 'x', if: { tools: ['get_me'] } as never })]),
    });
    const result = check(dir);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('rules[0].if.tools: unknown field');
    expect(result.hint).toMatch(/compile-policy` to regenerate compiled-policy\.json/);
  });

  it('points at the hand edit for a malformed lists file', () => {
    const dir = policyDir('doctor-lists', {
      'compiled-policy.json': policyWith([]),
      'dynamic-lists.json': listsWith({ news: resolvedList([], { manualAdditions: '*.bbc.co.uk' }) }),
    });
    const result = check(dir);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('lists.news.manualAdditions: expected an array');
    expect(result.hint).toContain('"manualAdditions"');
  });

  it('reports valid artifacts as present and valid', () => {
    const dir = policyDir('doctor-ok', { 'compiled-policy.json': policyWith([rule({ name: 'ok' })]) });
    expect(check(dir)).toMatchObject({ status: 'ok', message: 'present and valid' });
  });
});

describe('the compiler shares the catch-all definition', () => {
  it('rejects a rule whose only condition is an empty lists array', () => {
    const schema = buildPatchResponseSchema(['github'], ['get_me'], ['existing']);
    const patch = (cond: Record<string, unknown>) => ({
      reasoning: 'r',
      operations: [
        { op: 'add', rule: { name: 'n', description: 'd', principle: 'p', if: cond, then: 'allow', reason: 'r' } },
      ],
    });
    expect(schema.safeParse(patch({ lists: [] })).success).toBe(false);
    expect(schema.safeParse(patch({ server: ['github'] })).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// List resolution reads lists files through the schema
// ---------------------------------------------------------------------------

/**
 * The brief's repro, through list resolution instead of the engine: the
 * resolver carries each list's manual overrides into the values it writes,
 * so a hand-edited `"manualAdditions": "*.bbc.co.uk"` read with a bare cast
 * was spread into `*`, `.`, `b`, ... inside `values`. The runtime loaders
 * then refused the file for the string, but once the user fixed that field
 * the bare `*` in `values` passed and allowed every domain.
 */
describe('list resolution refuses a malformed lists file instead of spreading it into values', () => {
  const LIST_NAME = 'trusted-news-sites';
  const malformedLists = (): string =>
    JSON.stringify(
      listsWith({ [LIST_NAME]: resolvedList(['bbc.com', '*.bbc.com'], { manualAdditions: '*.bbc.co.uk' }) }),
      null,
      2,
    );

  function listModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ values: ['bbc.com'] }) }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        warnings: [],
        request: {},
        response: { id: 'test-id', modelId: 'test-model', timestamp: new Date(0) },
      }),
    });
  }

  it('loadDynamicListsArtifact validates, and never falls back past a malformed primary file', () => {
    const fallback = policyDir('lists-fallback', {
      'dynamic-lists.json': listsWith({ [LIST_NAME]: resolvedList([]) }),
    });
    const primary = policyDir('lists-primary', { 'dynamic-lists.json': malformedLists() });
    const err = errorFrom(() => loadDynamicListsArtifact(primary, fallback));
    expect(err.code).toBe(POLICY_ARTIFACT_INVALID);
    expect(err.message).toContain(`lists.${LIST_NAME}.manualAdditions: expected an array, got "*.bbc.co.uk"`);
    expect(loadDynamicListsArtifact(resolve(root, 'none'), fallback)?.lists[LIST_NAME]?.values).toEqual([]);
    expect(loadDynamicListsArtifact(resolve(root, 'none'))).toBeUndefined();
  });

  describe('refresh-lists', () => {
    let savedHome: string | undefined;

    beforeEach(() => {
      savedHome = process.env.IRONCURTAIN_HOME;
      process.env.IRONCURTAIN_HOME = root;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = savedHome;
    });

    it('stops with a field-level error and leaves the file as it is', async () => {
      const generated = policyDir('generated', {
        'compiled-policy.json': {
          ...policyWith([
            rule({
              name: 'news',
              if: { server: ['fetch'], domains: { roles: ['fetch-url'], allowed: [`@${LIST_NAME}`] } },
            }),
          ]),
          listDefinitions: [
            { name: LIST_NAME, type: 'domains', principle: 'p', generationPrompt: 'news sites', requiresMcp: false },
          ],
        },
        'dynamic-lists.json': malformedLists(),
      });
      const listsPath = resolve(generated, 'dynamic-lists.json');
      const model = listModel();
      vi.spyOn(pipelineShared, 'createPipelineLlm').mockResolvedValue({
        model,
        baseLlm: model,
        logContext: { stepName: '' },
        logPath: resolve(root, 'llm.jsonl'),
        cacheStrategy: new NoOpCacheStrategy(),
      });

      // Planning the refresh (the daemon's refresh-lists, and the CLI's first
      // step) throws the coded error before any model is set up...
      await expect(refreshDynamicLists({ target: { kind: 'global' }, withMcp: false })).rejects.toMatchObject({
        code: POLICY_ARTIFACT_INVALID,
        message: expect.stringContaining(`lists.${LIST_NAME}.manualAdditions: expected an array`) as unknown,
      });
      // ...which the CLI reports with the field, exiting non-zero.
      const printed: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(' '));
      });
      const previousExitCode = process.exitCode;
      try {
        await refreshListsMain([]);
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
      }
      expect(printed.join('\n')).toContain(`lists.${LIST_NAME}.manualAdditions: expected an array`);
      expect(model.doGenerateCalls).toHaveLength(0);
      expect(readFileSync(listsPath, 'utf-8')).toBe(malformedLists());
    });
  });

  it('compile-policy fails the server whose per-server lists file is malformed', async () => {
    const outputDir = resolve(root, 'generated');
    const serverDir = resolve(outputDir, 'servers', 'fetch');
    mkdirSync(serverDir, { recursive: true });
    const listsPath = resolve(serverDir, 'dynamic-lists.json');
    writeFileSync(listsPath, malformedLists());

    const silent = { update: () => {}, complete: () => {}, warn: () => {}, fail: () => {}, done: () => {} };
    const runner = new PipelineRunner(createFakePipelineModels(GOLDEN_RESPONSES, resolve(root, 'llm.jsonl')));
    const outcome = await runner
      .run({
        constitutionInput: GOLDEN_CONSTITUTION,
        constitutionKind: 'constitution',
        outputDir,
        toolAnnotationsDir: outputDir,
        allowedDirectory: GOLDEN_ALLOWED_DIR,
        protectedPaths: [],
        preloadedStoredAnnotations: GOLDEN_ANNOTATIONS,
        includeHandwrittenScenarios: false,
        quiet: true,
        reporterFactory: () => silent,
        onProgress: () => {},
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(outcome).toMatchObject({
      code: 'ALL_SERVERS_FAILED',
      failedServers: [
        {
          serverName: 'fetch',
          reason: expect.stringContaining(`lists.${LIST_NAME}.manualAdditions: expected an array`) as unknown,
        },
      ],
    });
    expect(readFileSync(listsPath, 'utf-8')).toBe(malformedLists());
    expect(existsSync(resolve(outputDir, 'dynamic-lists.json'))).toBe(false);
  });
});
