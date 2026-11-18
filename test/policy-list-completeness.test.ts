import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  ListCondition,
  ResolvedList,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';

const annotations: StoredToolAnnotationsFile = {
  generatedAt: '',
  servers: {
    fixture: {
      inputHash: '',
      tools: [
        {
          serverName: 'fixture',
          toolName: 'lookup',
          comment: 'ordinary identifiers',
          args: { owner: ['github-owner'], repo: ['github-repo'] },
          inputSchema: {},
        },
      ],
    },
  },
};
const request = {
  requestId: 'fixture',
  serverName: 'fixture',
  toolName: 'lookup',
  arguments: { owner: 'ordinary-owner', repo: 'ordinary-repo' },
  timestamp: '',
};
const fallback: CompiledRule = {
  name: 'ordinary-allow',
  description: '',
  principle: '',
  if: { server: ['fixture'] },
  then: 'allow',
  reason: '',
};
const restricted: CompiledRule = {
  name: 'needs-review',
  description: '',
  principle: '',
  if: {
    server: ['fixture'],
    tool: ['lookup'],
    lists: [{ roles: ['github-owner'], allowed: ['@review'], matchType: 'identifiers' }],
  },
  then: 'escalate',
  reason: '',
};
const policy = (rules: CompiledRule[]): CompiledPolicyFile => ({
  generatedAt: '',
  constitutionHash: '',
  inputHash: '',
  rules,
});
const list = (state?: 'complete' | 'incomplete', values = ['different-owner']): ResolvedList => ({
  values,
  manualAdditions: [],
  manualRemovals: [],
  resolvedAt: '',
  inputHash: 'fixture',
  ...(state ? { resolutionState: state } : {}),
});
const lists = (entry?: ResolvedList): DynamicListsFile => ({ generatedAt: '', lists: entry ? { review: entry } : {} });
const engine = (entry?: ResolvedList, rule = restricted) =>
  new PolicyEngine(policy([rule, fallback]), annotations, [], undefined, undefined, lists(entry));

describe('restrictive dynamic-list completeness', () => {
  it.each(['missing', 'legacy', 'empty', 'partial', 'unresolved'] as const)(
    'preserves escalation when its list is %s',
    (kind) => {
      const entry =
        kind === 'missing'
          ? undefined
          : kind === 'legacy'
            ? list()
            : kind === 'empty'
              ? list('complete', [])
              : kind === 'unresolved'
                ? { ...list('incomplete'), inputHash: '' }
                : list('incomplete');
      expect(engine(entry).evaluate(request)).toMatchObject({ decision: 'escalate', rule: 'needs-review' });
    },
  );

  it('keeps a complete nonempty list selective, including explicit manual removals', () => {
    expect(engine(list('complete')).evaluate(request).decision).toBe('allow');
    expect(engine(list('complete', ['ordinary-owner'])).evaluate(request).decision).toBe('escalate');
    expect(
      engine({ ...list('complete', ['ordinary-owner']), manualRemovals: ['ordinary-owner'] }).evaluate(request)
        .decision,
    ).toBe('escalate');
  });

  it('preserves deny and other role, tool and literal conditions', () => {
    expect(engine(list('incomplete'), { ...restricted, then: 'deny' }).evaluate(request).decision).toBe('deny');
    expect(
      engine(undefined, { ...restricted, if: { ...restricted.if, tool: ['different-tool'] } }).evaluate(request)
        .decision,
    ).toBe('allow');
    const repoCondition: ListCondition = {
      roles: ['github-repo'],
      allowed: ['different-repo'],
      matchType: 'identifiers',
    };
    const withRepo = { ...restricted, if: { ...restricted.if, lists: [...restricted.if.lists!, repoCondition] } };
    expect(engine(undefined, withRepo).evaluate(request).decision).toBe('allow');
    expect(engine(undefined).evaluate({ ...request, arguments: { repo: 'ordinary-repo' } }).decision).toBe('allow');
  });

  it('uses the same conservative matching in a task scope', () => {
    const scoped = new PolicyEngine(policy([fallback]), annotations, [], undefined, undefined, undefined, undefined, {
      compiledPolicy: policy([restricted, fallback]),
      dynamicLists: lists(list('incomplete')),
    });
    expect(scoped.evaluate(request)).toMatchObject({ decision: 'escalate', rule: 'needs-review' });
  });

  it('keeps missing allow references from granting access', () => {
    expect(
      new PolicyEngine(policy([{ ...restricted, then: 'allow' }]), annotations, []).evaluate(request).decision,
    ).toBe('deny');
  });

  it.each(['domains', 'lists'] as const)('keeps incomplete URL %s conditions restrictive', (kind) => {
    const webAnnotations: StoredToolAnnotationsFile = {
      generatedAt: '',
      servers: {
        fixture: {
          inputHash: '',
          tools: [
            { serverName: 'fixture', toolName: 'lookup', comment: '', args: { url: ['fetch-url'] }, inputSchema: {} },
          ],
        },
      },
    };
    const condition = { roles: ['fetch-url'] as ['fetch-url'], allowed: ['@review'] };
    const restriction: CompiledRule = {
      ...restricted,
      if: {
        server: ['fixture'],
        ...(kind === 'domains' ? { domains: condition } : { lists: [{ ...condition, matchType: 'domains' }] }),
      },
    };
    const web = (entry: ResolvedList) =>
      new PolicyEngine(
        policy([restriction, fallback]),
        webAnnotations,
        [],
        undefined,
        new Map([['fixture', ['ordinary.example.com']]]),
        lists(entry),
      );
    const call = { ...request, arguments: { url: 'https://ordinary.example.com/note' } };
    expect(web(list('incomplete', ['different.example.com'])).evaluate(call)).toMatchObject({
      decision: 'escalate',
      rule: 'needs-review',
    });
    expect(web(list('complete', ['different.example.com'])).evaluate(call).decision).toBe('allow');
  });
});
