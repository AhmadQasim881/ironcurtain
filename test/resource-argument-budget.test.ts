import { afterEach, describe, expect, it, vi } from 'vitest';
import * as argumentRoles from '../src/types/argument-roles.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { prepareToolArgs } from '../src/trusted-process/path-utils.js';
import {
  ARGUMENT_VALUE_LIMITS,
  assertArgumentValueBudget,
  boundedToolArgumentsJson,
  hasBoundedArgumentStructure,
} from '../src/trusted-process/argument-budget.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile, ToolAnnotation } from '../src/pipeline/types.js';

const annotation: ToolAnnotation = {
  serverName: 'filesystem',
  toolName: 'read_multiple_files',
  comment: 'fixture',
  args: { paths: ['read-path'], others: ['read-path'] },
};
const annotations: StoredToolAnnotationsFile = {
  generatedAt: 'fixture',
  servers: { filesystem: { inputHash: 'fixture', tools: [{ ...annotation, inputSchema: {} }] } },
};
const policy: CompiledPolicyFile = {
  generatedAt: 'fixture',
  constitutionHash: 'fixture',
  inputHash: 'fixture',
  rules: [
    {
      name: 'fixture-allow',
      description: 'fixture',
      principle: 'fixture',
      if: { server: ['filesystem'] },
      then: 'allow',
      reason: 'fixture',
    },
  ],
};
const limits = { maxValuesPerArgument: 2, maxValuesPerCall: 3 };

afterEach(() => vi.restoreAllMocks());

describe('whole-call argument structure', () => {
  it('counts containers and leaves across fields, with the root included', () => {
    // Root, both arrays, one object and its scalar property consume five nodes.
    const edits = Array.from({ length: ARGUMENT_VALUE_LIMITS.maxNodes - 5 }, () => false);
    const args = { edits, tags: [{ note: 'x'.repeat(20_000) }] };
    expect(hasBoundedArgumentStructure(args)).toBe(true);
    edits.push(false);
    expect(hasBoundedArgumentStructure(args)).toBe(false);
  });

  it('allows depth 32 from the argument root and refuses the next level', () => {
    let args: Record<string, unknown> = {};
    for (let i = 0; i < ARGUMENT_VALUE_LIMITS.maxDepth; i++) args = { child: args };
    expect(hasBoundedArgumentStructure(args)).toBe(true);
    expect(hasBoundedArgumentStructure({ child: args })).toBe(false);
  });
});

describe('bounded resource evaluation before filesystem work', () => {
  it('denies a direct engine call above a small per-argument limit before resolving paths', () => {
    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, undefined, undefined, undefined, {
      argumentValueLimits: limits,
    });
    const resolve = vi.spyOn(argumentRoles, 'resolveRealPath');
    expect(
      engine.evaluate({
        requestId: 'fixture',
        serverName: 'filesystem',
        toolName: 'read_multiple_files',
        arguments: { paths: ['/one', '/two', '/three'] },
        timestamp: '',
      }),
    ).toMatchObject({ decision: 'deny', rule: 'structural-argument-budget-deny' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('bounds total values across arguments before normalization', () => {
    const resolve = vi.spyOn(argumentRoles, 'resolveRealPath');
    expect(() =>
      prepareToolArgs(
        { paths: ['/one', '/two'], others: ['/three', '/four'] },
        annotation,
        undefined,
        undefined,
        limits,
      ),
    ).toThrow('resource evaluation limits');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps ordinary values and bounds structured values without recursive extraction', () => {
    expect(() => assertArgumentValueBudget({ paths: ['/one', '/two'] }, annotation, limits)).not.toThrow();
    expect(() =>
      assertArgumentValueBudget({ paths: { first: '/one', next: ['/two', '/three'] } }, annotation, limits),
    ).toThrow('resource evaluation limits');
    expect(() => assertArgumentValueBudget({ paths: 'ordinary' }, annotation, { maxValueChars: 4 })).toThrow(
      'resource evaluation limits',
    );
  });

  it('checks serialized UTF-8 bytes before JSON parsing with a tiny fixture cap', () => {
    expect(boundedToolArgumentsJson('{}', 4)).toBe('{}');
    expect(() => boundedToolArgumentsJson('"éé"', 5)).toThrow('resource evaluation limits');
    expect(() => boundedToolArgumentsJson({})).toThrow('JSON text');
  });

  it('refuses a cyclic direct-call object before recursive value extraction', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.child = cyclic;
    expect(() => assertArgumentValueBudget({ paths: cyclic }, annotation)).toThrow('resource evaluation limits');
    expect(() =>
      assertArgumentValueBudget({ paths: { ordinary: { note: '/one' } } }, annotation, { maxDepth: 1 }),
    ).toThrow('resource evaluation limits');
  });
});
