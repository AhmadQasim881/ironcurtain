/**
 * Arguments that carry a role but hold something other than a string, a
 * number or a flat list of them (TPM-20).
 *
 * Role annotations describe a top-level argument as a whole. Extraction
 * used to read only strings and string arrays, so a path, URL or identifier
 * inside an object or a nested array yielded no value at all: the
 * protected-path deny, the forbidden-destination deny, sandbox containment
 * and every compiled `paths`/`domains`/`lists` condition silently saw
 * nothing, and a role-only or tool-level rule decided the call. Now every
 * string and number inside such a value is checked, and the call escalates
 * to a human (`structural-nested-argument-escalate`, human-only) unless a
 * structural or compiled deny applies.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type {
  CompiledPolicyFile,
  CompiledRule,
  StoredToolAnnotationsFile,
  ToolAnnotation,
} from '../src/pipeline/types.js';
import { argumentValues, isStructuredValue, ownArgument } from '../src/trusted-process/argument-values.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import { PolicyEngine, STRUCTURAL_NESTED_ARGUMENT_ESCALATE } from '../src/trusted-process/policy-engine.js';
import type { ResolvedSandboxConfig } from '../src/trusted-process/sandbox-integration.js';
import {
  handleCallTool,
  type CallToolDeps,
  type ClientState,
  type ProxiedTool,
} from '../src/trusted-process/tool-call-pipeline.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import {
  REAL_TMP,
  TEST_PROTECTED_PATHS,
  testCompiledPolicy,
  testToolAnnotations,
  withInputSchemas,
} from './fixtures/test-policy.js';

const BASE = `${REAL_TMP}/ironcurtain-nested-args-test`;
const SANDBOX = `${BASE}/sandbox`;
const PROTECTED_FILE = TEST_PROTECTED_PATHS[0];

function request(serverName: string, toolName: string, args: Record<string, unknown>): ToolCallRequest {
  return { requestId: 'nested', serverName, toolName, arguments: args, timestamp: new Date().toISOString() };
}

function policy(rules: CompiledRule[]): CompiledPolicyFile {
  return { generatedAt: 'test', constitutionHash: 'test', inputHash: 'test', rules };
}

function rule(name: string, condition: CompiledRule['if'], then: CompiledRule['then']): CompiledRule {
  return { name, description: name, principle: 'test', if: condition, then, reason: name };
}

function tool(serverName: string, toolName: string, args: ToolAnnotation['args']): ToolAnnotation {
  return { serverName, toolName, comment: 'test', args };
}

const annotations = withInputSchemas({
  generatedAt: 'test',
  servers: {
    filesystem: {
      inputHash: 'test',
      tools: [
        tool('filesystem', 'read_file', { path: ['read-path'] }),
        tool('filesystem', 'read_multiple_files', { paths: ['read-path'] }),
        tool('filesystem', 'write_file', { path: ['write-path'], content: ['none'] }),
      ],
    },
    fetch: { inputHash: 'test', tools: [tool('fetch', 'http_fetch', { url: ['fetch-url'], headers: ['none'] })] },
    git: { inputHash: 'test', tools: [tool('git', 'git_clone', { url: ['git-remote-url'], path: ['write-path'] })] },
    github: {
      inputHash: 'test',
      tools: [
        tool('github', 'sub_issue_write', {
          owner: ['github-owner'],
          repo: ['github-repo'],
          sub_issue_id: ['github-resource-id'],
        }),
      ],
    },
  },
});

/** Every read is allowed by a role-only rule: nothing but the structural checks stands in the way. */
const ALLOW_ALL_READS = rule('allow-all-reads', { roles: ['read-path'], server: ['filesystem'] }, 'allow');

function engine(rules: CompiledRule[], protectedPaths: string[] = TEST_PROTECTED_PATHS): PolicyEngine {
  return new PolicyEngine(policy(rules), annotations, protectedPaths, SANDBOX);
}

describe('argumentValues', () => {
  it('reads nothing from an absent value', () => {
    expect(argumentValues(undefined)).toEqual({ values: [], structured: false });
    expect(argumentValues(null)).toEqual({ values: [], structured: false });
  });

  it('reads strings, finite numbers and flat arrays of them as they are', () => {
    expect(argumentValues('/a')).toEqual({ values: ['/a'], structured: false });
    expect(argumentValues(987654)).toEqual({ values: ['987654'], structured: false });
    expect(argumentValues(['/a', 7])).toEqual({ values: ['/a', '7'], structured: false });
    expect(argumentValues([])).toEqual({ values: [], structured: false });
  });

  it('reads every string and number inside any other value, in document order, and flags it', () => {
    expect(argumentValues({ p: '/a', q: [1, { r: '/b' }], s: true })).toEqual({
      values: ['/a', '1', '/b'],
      structured: true,
    });
    expect(argumentValues(['/a', { p: '/b' }])).toEqual({ values: ['/a', '/b'], structured: true });
    expect(argumentValues([['/a']])).toEqual({ values: ['/a'], structured: true });
  });

  it('flags values that hold nothing it can read', () => {
    expect(argumentValues(true)).toEqual({ values: [], structured: true });
    expect(argumentValues({})).toEqual({ values: [], structured: true });
    expect(argumentValues([null])).toEqual({ values: [], structured: true });
    expect(argumentValues(Number.NaN)).toEqual({ values: [], structured: true });
  });

  it('does not read object keys', () => {
    expect(argumentValues({ '/etc/passwd': 'x' }).values).toEqual(['x']);
  });

  it('terminates on cyclic and very deeply nested values', () => {
    const cyclic: Record<string, unknown> = { p: '/a' };
    cyclic.self = cyclic;
    expect(argumentValues(cyclic)).toEqual({ values: ['/a'], structured: true });

    let deep: unknown = '/deep';
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(argumentValues(deep)).toEqual({ values: ['/deep'], structured: true });
  });

  it('flags the same values without collecting them', () => {
    for (const value of [undefined, null, '/a', 7, [], ['/a', 7]]) expect(isStructuredValue(value)).toBe(false);
    for (const value of [true, {}, { p: '/a' }, ['/a', { p: '/b' }], [['/a']], [null], Number.POSITIVE_INFINITY]) {
      expect(isStructuredValue(value)).toBe(true);
      expect(argumentValues(value).structured).toBe(true);
    }
  });

  it('reads only own arguments', () => {
    expect(ownArgument({ path: '/a' }, 'path')).toBe('/a');
    expect(ownArgument({}, 'constructor')).toBeUndefined();
    expect(ownArgument({}, 'toString')).toBeUndefined();
  });
});

describe('PolicyEngine: role-bearing arguments holding nested values', () => {
  it('escalates a nested {path: {p: "/etc/passwd"}} argument to a human', () => {
    // A role-only allow used to decide this call: the nested path yielded no
    // value, so nothing structural looked at it.
    const result = engine([ALLOW_ALL_READS]).evaluate(
      request('filesystem', 'read_file', { path: { p: '/etc/passwd' } }),
    );
    expect(result).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_NESTED_ARGUMENT_ESCALATE,
      escalatedRoles: ['read-path'],
      humanOnly: true,
    });
  });

  it('escalates it to a human under the fixture policy too', () => {
    const fixtureEngine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, TEST_PROTECTED_PATHS, SANDBOX);
    const result = fixtureEngine.evaluate(request('filesystem', 'read_file', { path: { p: '/etc/passwd' } }));
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_NESTED_ARGUMENT_ESCALATE, humanOnly: true });
    expect(result.escalatedRoles).toContain('read-path');
  });

  it('escalates an array that holds an object or a nested array', () => {
    const e = engine([ALLOW_ALL_READS]);
    for (const paths of [
      [`${SANDBOX}/a.txt`, { p: '/etc/passwd' }],
      [`${SANDBOX}/a.txt`, ['/etc/passwd']],
    ]) {
      expect(e.evaluate(request('filesystem', 'read_multiple_files', { paths }))).toMatchObject({
        decision: 'escalate',
        rule: STRUCTURAL_NESTED_ARGUMENT_ESCALATE,
        humanOnly: true,
      });
    }
  });

  it('escalates a boolean where a path is expected', () => {
    expect(engine([ALLOW_ALL_READS]).evaluate(request('filesystem', 'read_file', { path: true }))).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_NESTED_ARGUMENT_ESCALATE,
      humanOnly: true,
    });
  });

  it('denies a protected path nested inside an argument', () => {
    const e = engine([ALLOW_ALL_READS]);
    for (const args of [
      { path: { p: PROTECTED_FILE } },
      { path: { deeper: [{ p: PROTECTED_FILE }] } },
      { paths: [`${SANDBOX}/a.txt`, [PROTECTED_FILE]] },
    ]) {
      const toolName = 'paths' in args ? 'read_multiple_files' : 'read_file';
      expect(e.evaluate(request('filesystem', toolName, args))).toMatchObject({
        decision: 'deny',
        rule: 'structural-protected-path',
      });
    }
  });

  it('sends a protected path used as an object key to a human, never decides it alone', () => {
    // Object keys are not read (see argumentValues), so the protected-path
    // deny does not see this one, and the values beside it are inside the
    // sandbox or absent while reads are allowed. The structure still has to
    // reach a human: nothing may allow it on the values it was read for.
    const e = engine([ALLOW_ALL_READS]);
    for (const path of [
      { [PROTECTED_FILE]: `${SANDBOX}/a.txt` },
      { [PROTECTED_FILE]: true },
      { [PROTECTED_FILE]: {} },
    ]) {
      expect(e.evaluate(request('filesystem', 'read_file', { path }))).toMatchObject({
        decision: 'escalate',
        rule: STRUCTURAL_NESTED_ARGUMENT_ESCALATE,
        humanOnly: true,
      });
    }
  });

  it('does not sandbox-allow a nested value that points into the sandbox', () => {
    const result = engine([]).evaluate(
      request('filesystem', 'write_file', { path: { p: `${SANDBOX}/notes.txt` }, content: 'x' }),
    );
    expect(result).toMatchObject({ decision: 'escalate', rule: STRUCTURAL_NESTED_ARGUMENT_ESCALATE, humanOnly: true });
  });

  it('lets a compiled deny win over the escalation', () => {
    // No rule covers reads outside the sandbox: the nested path default-denies.
    expect(engine([]).evaluate(request('filesystem', 'read_file', { path: { p: '/etc/passwd' } }))).toMatchObject({
      decision: 'deny',
      rule: 'default-deny',
    });
  });

  it('denies a nested cloud-metadata fetch destination', () => {
    const allowFetch = rule('allow-fetch', { server: ['fetch'], tool: ['http_fetch'] }, 'allow');
    const e = engine([allowFetch]);
    for (const url of [
      { u: 'http://169.254.169.254/latest/meta-data/' },
      ['https://example.com/', { u: 'http://localhost:8080/' }],
    ]) {
      expect(e.evaluate(request('fetch', 'http_fetch', { url }))).toMatchObject({
        decision: 'deny',
        rule: 'structural-local-destination-deny',
      });
    }
  });

  it('reads a local git source nested in a remote argument as a read of that path', () => {
    const protectedRepo = `${BASE}/protected-repo`;
    const e = new PolicyEngine(
      policy([rule('allow-clone', { server: ['git'], tool: ['git_clone'] }, 'allow')]),
      annotations,
      [protectedRepo],
      SANDBOX,
    );
    const result = e.evaluate(
      request('git', 'git_clone', { url: { source: protectedRepo }, path: `${SANDBOX}/clone` }),
    );
    expect(result).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
  });

  it('leaves flat and absent values alone', () => {
    const e = engine([ALLOW_ALL_READS]);
    const flat = e.evaluate(
      request('filesystem', 'read_multiple_files', { paths: [`${SANDBOX}/a.txt`, `${SANDBOX}/b.txt`] }),
    );
    expect(flat).toMatchObject({ decision: 'allow', rule: 'structural-sandbox-allow' });
    expect(flat.humanOnly).toBeUndefined();

    const absent = e.evaluate(request('filesystem', 'write_file', { path: `${SANDBOX}/a.txt`, content: { x: 1 } }));
    // `content` has no role, so its shape is the server's business.
    expect(absent).toMatchObject({ decision: 'allow', rule: 'structural-sandbox-allow' });
  });

  it('evaluates a numeric identifier by its decimal form instead of ignoring it', () => {
    // An escalate-if-listed rule never saw a numeric ID, so the tool-level
    // allow below it decided the call.
    const e = engine([
      rule(
        'escalate-listed-sub-issues',
        {
          server: ['github'],
          lists: [{ roles: ['github-resource-id'], allowed: ['987654'], matchType: 'identifiers' }],
        },
        'escalate',
      ),
      rule('allow-sub-issues', { server: ['github'], tool: ['sub_issue_write'] }, 'allow'),
    ]);
    const listed = e.evaluate(
      request('github', 'sub_issue_write', { owner: 'me', repo: 'proj', sub_issue_id: 987654 }),
    );
    expect(listed).toMatchObject({
      decision: 'escalate',
      rule: 'escalate-listed-sub-issues',
      escalatedRoles: ['github-resource-id'],
    });
    expect(listed.humanOnly).toBeUndefined();

    const other = e.evaluate(request('github', 'sub_issue_write', { owner: 'me', repo: 'proj', sub_issue_id: 1 }));
    expect(other).toMatchObject({ decision: 'allow', rule: 'allow-sub-issues' });
  });
});

describe('gsheets protected-range editors (shipped annotations)', () => {
  const generatedDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/config/generated');
  const shippedAnnotations = JSON.parse(
    readFileSync(resolve(generatedDir, 'tool-annotations.json'), 'utf-8'),
  ) as StoredToolAnnotationsFile;
  const shippedPolicy = JSON.parse(
    readFileSync(resolve(generatedDir, 'compiled-policy.json'), 'utf-8'),
  ) as CompiledPolicyFile;

  const ADD_RANGE = {
    spreadsheetId: 'sheet',
    sheetId: 0,
    startRow: 0,
    endRow: 1,
    startColumn: 0,
    endColumn: 1,
    editors: { users: ['ceo@competitor.com'], groups: [], domainUsersCanEdit: false },
  };

  it('escalates to a human where an escalate-if-listed policy used to allow', () => {
    // The verifier's reproduction: escalate when an editor is listed,
    // otherwise allow. `editors` is an object, so the list never saw it.
    const e = new PolicyEngine(
      policy([
        rule(
          'escalate-competitor-editors',
          {
            server: ['google-workspace'],
            lists: [{ roles: ['email-address'], allowed: ['ceo@competitor.com'], matchType: 'emails' }],
          },
          'escalate',
        ),
        rule(
          'allow-protected-ranges',
          { server: ['google-workspace'], tool: ['gsheets_add_protected_range'] },
          'allow',
        ),
      ]),
      shippedAnnotations,
      [],
      SANDBOX,
    );
    expect(e.evaluate(request('google-workspace', 'gsheets_add_protected_range', ADD_RANGE))).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_NESTED_ARGUMENT_ESCALATE,
      humanOnly: true,
    });
    // Unlisted editors too: `domainUsersCanEdit` beside them is no value a
    // list can judge, so the structure always reaches a human.
    const unlisted = { ...ADD_RANGE, editors: { users: ['friend@example.com'], domainUsersCanEdit: true } };
    expect(e.evaluate(request('google-workspace', 'gsheets_add_protected_range', unlisted))).toMatchObject({
      decision: 'escalate',
      rule: STRUCTURAL_NESTED_ARGUMENT_ESCALATE,
      humanOnly: true,
    });
  });

  it('stays denied under the shipped policy, which has no google-workspace rules', () => {
    const e = new PolicyEngine(shippedPolicy, shippedAnnotations, [], SANDBOX);
    expect(e.evaluate(request('google-workspace', 'gsheets_add_protected_range', ADD_RANGE))).toMatchObject({
      decision: 'deny',
      rule: 'default-deny',
    });
  });
});

describe('a nested-argument escalation through the tool-call pipeline', () => {
  it('goes to a human: no whitelist pattern discharges it and none is offered', async () => {
    const permitted = `${BASE}/permitted`;
    // A pattern that covers the nested path's directory for read-path...
    const whitelist = createApprovalWhitelist();
    whitelist.add({
      serverName: 'filesystem',
      toolName: 'read_file',
      constraints: [{ kind: 'directory', role: 'read-path', directory: permitted }],
      createdAt: new Date().toISOString(),
      sourceEscalationId: 'esc-1',
      originalReason: 'Reads outside the sandbox require approval.',
      description: 'read_file within permitted',
    });

    const callTool = vi.fn();
    const onEscalation = vi.fn().mockResolvedValue({ decision: 'denied' });
    const readFile: ProxiedTool = { serverName: 'filesystem', name: 'read_file', inputSchema: { type: 'object' } };
    const deps: CallToolDeps = {
      toolMap: new Map([['read_file', readFile]]),
      policyEngine: new PolicyEngine(testCompiledPolicy, testToolAnnotations, TEST_PROTECTED_PATHS, SANDBOX),
      auditLog: { log: vi.fn(), assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
      circuitBreaker: {
        check: vi.fn().mockReturnValue({ allowed: true }),
      } as unknown as CallToolDeps['circuitBreaker'],
      clientStates: new Map<string, ClientState>([
        ['filesystem', { client: { callTool } as unknown as ClientState['client'], roots: [] }],
      ]),
      resolvedSandboxConfigs: new Map<string, ResolvedSandboxConfig>([
        ['filesystem', { sandboxed: false, reason: 'opt-out' }],
      ]),
      allowedDirectory: SANDBOX,
      escalationDir: undefined,
      autoApproveModel: null,
      serverContextMap: new Map(),
      whitelist,
      onEscalation,
    };

    const response = await handleCallTool('read_file', { path: { p: `${permitted}/notes.txt` } }, deps);

    // ...is not consulted: the human decides, and denies.
    expect(onEscalation).toHaveBeenCalledTimes(1);
    // The handler's details carry the human-only flag beside the wait's id,
    // persona and abort signal (InProcessEscalationDetails).
    const [, , , candidates, details] = onEscalation.mock.calls[0] as unknown[];
    expect(candidates).toBeUndefined();
    expect(details).toMatchObject({ humanOnly: true, escalationId: expect.any(String) as unknown });
    expect(callTool).not.toHaveBeenCalled();
    expect(response.isError).toBe(true);
  });
});
