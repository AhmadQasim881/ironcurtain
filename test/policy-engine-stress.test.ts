/**
 * Policy Engine Stress Test — comprehensive coverage of edge cases.
 *
 * Each test group creates its own minimal CompiledPolicyFile and
 * StoredToolAnnotationsFile inline (not shared fixtures) to isolate behavior
 * and make each group self-documenting.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, type PathLike } from 'node:fs';
import { join } from 'node:path';
import { PolicyEngine, domainMatchesAllowlist } from '../src/trusted-process/policy-engine.js';
import type {
  ArgumentRole,
  CompiledPolicyFile,
  DynamicListsFile,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import { TEST_SANDBOX_DIR, REAL_TMP, argsSchema } from './fixtures/test-policy.js';

// Every realpath call is recorded and then made for real, so the whole suite
// runs on the real filesystem with unchanged decisions; the "Path resolution
// per evaluation" group reads the log. resolveRealPath uses the native
// variant on macOS, so both are wrapped.
const realpathLog = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realpathSync = Object.assign(
    (path: PathLike): string => {
      realpathLog.calls.push(String(path));
      return actual.realpathSync(path);
    },
    {
      native: (path: PathLike): string => {
        realpathLog.calls.push(String(path));
        return actual.realpathSync.native(path);
      },
    },
  );
  return { ...actual, realpathSync };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SANDBOX_DIR = TEST_SANDBOX_DIR;

function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: 'test-id',
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: `${SANDBOX_DIR}/test.txt` },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Shorthand for a minimal CompiledPolicyFile. */
function makePolicy(rules: CompiledPolicyFile['rules']): CompiledPolicyFile {
  return { generatedAt: 'test', constitutionHash: 'test', inputHash: 'test', rules };
}

/** Shorthand for a minimal StoredToolAnnotationsFile. */
function makeAnnotations(servers: Record<string, StoredToolAnnotation[]>): StoredToolAnnotationsFile {
  const result: StoredToolAnnotationsFile = { generatedAt: 'test', servers: {} };
  for (const [name, tools] of Object.entries(servers)) {
    result.servers[name] = { inputHash: 'test', tools };
  }
  return result;
}

/** Shorthand for a StoredToolAnnotation whose input schema declares exactly its arguments. */
function makeTool(serverName: string, toolName: string, args: Record<string, ArgumentRole[]>): StoredToolAnnotation {
  return { toolName, serverName, comment: 'test', args, inputSchema: argsSchema(args) };
}

// ---------------------------------------------------------------------------
// Role-agnostic rule evaluation
// ---------------------------------------------------------------------------

describe('Role-agnostic rules after structural resolution', () => {
  const annotations = makeAnnotations({
    git: [
      makeTool('git', 'git_push', {
        path: ['none'],
        remote: ['git-remote-url'],
        branch: ['branch-name'],
      }),
      makeTool('git', 'git_pull', {
        path: ['none'],
        remote: ['git-remote-url'],
        branch: ['branch-name'],
      }),
      makeTool('git', 'git_clone', {
        url: ['git-remote-url'],
        path: ['write-path'],
      }),
      makeTool('git', 'git_status', { path: ['read-path'] }),
    ],
  });

  const domainAllowlists = new Map([['git', ['github.com', '*.github.com']]]);

  it('escalates via role-agnostic rule when all roles are domain-resolved', () => {
    const policy = makePolicy([
      {
        name: 'escalate-git-push',
        description: 'Escalate push',
        principle: 'test',
        if: { server: ['git'], tool: ['git_push'] },
        then: 'escalate',
        reason: 'Push requires approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-git-push');
  });

  it('allows via role-agnostic rule when all roles are domain-resolved', () => {
    const policy = makePolicy([
      {
        name: 'allow-git-pull',
        description: 'Allow pull',
        principle: 'test',
        if: { server: ['git'], tool: ['git_pull'] },
        then: 'allow',
        reason: 'Pull is allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_pull',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-git-pull');
  });

  it('default-denies when no compiled rule matches (no structural fallback for non-filesystem)', () => {
    const policy = makePolicy([
      {
        name: 'escalate-unrelated',
        description: 'Escalate fetch',
        principle: 'test',
        if: { server: ['fetch'], tool: ['http_fetch'] },
        then: 'escalate',
        reason: 'Fetch needs approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    // No compiled rule matches git_push → default deny (no structural sandbox-allow for git)
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('default-deny');
  });

  it('escalates via role-agnostic rule when all roles are sandbox+domain-resolved', () => {
    const policy = makePolicy([
      {
        name: 'escalate-git-clone',
        description: 'Escalate clone',
        principle: 'test',
        if: { server: ['git'], tool: ['git_clone'] },
        then: 'escalate',
        reason: 'Clone requires approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );

    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-git-clone');
  });

  it('sandbox-resolves write-path for git_clone when URL roles present (path in sandbox)', () => {
    const policy = makePolicy([
      {
        name: 'escalate-write-path',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes need approval',
      },
      {
        name: 'allow-urls',
        description: 'Allow URLs',
        principle: 'test',
        if: { roles: ['git-remote-url'] },
        then: 'allow',
        reason: 'URLs allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );

    // git_clone has URL roles → sandbox extension applies.
    // write-path is sandbox-resolved (path in sandbox). Only git-remote-url evaluated.
    // allow-urls matches git-remote-url → allow.
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-urls');
  });

  it('evaluates both roles for git_clone when path is outside sandbox', () => {
    const policy = makePolicy([
      {
        name: 'escalate-write-path',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes need approval',
      },
      {
        name: 'allow-urls',
        description: 'Allow URLs',
        principle: 'test',
        if: { roles: ['git-remote-url'] },
        then: 'allow',
        reason: 'URLs allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: '/some/external/path' },
      }),
    );

    // Path is outside sandbox → write-path NOT sandbox-resolved. Both roles evaluated.
    // write-path → escalate, git-remote-url → allow, most restrictive wins.
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-write-path');
  });

  it('uses first-match-wins ordering for role-agnostic rules', () => {
    const policy = makePolicy([
      {
        name: 'allow-git-push',
        description: 'Allow push',
        principle: 'test',
        if: { server: ['git'], tool: ['git_push'] },
        then: 'allow',
        reason: 'Push is allowed',
      },
      {
        name: 'escalate-git-push',
        description: 'Escalate push',
        principle: 'test',
        if: { server: ['git'], tool: ['git_push'] },
        then: 'escalate',
        reason: 'Push requires approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-git-push');
  });

  it('skips rules with paths condition in role-agnostic evaluation', () => {
    const policy = makePolicy([
      {
        name: 'allow-in-dir',
        description: 'Allow in dir',
        principle: 'test',
        if: { paths: { roles: ['write-path'], within: SANDBOX_DIR } },
        then: 'allow',
        reason: 'In sandbox',
      },
      {
        name: 'escalate-clone',
        description: 'Escalate clone',
        principle: 'test',
        if: { server: ['git'], tool: ['git_clone'] },
        then: 'escalate',
        reason: 'Clone needs approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );

    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-clone');
  });

  it('evaluates domains condition in compiled rules for non-filesystem servers', () => {
    const policy = makePolicy([
      {
        name: 'allow-github-domain',
        description: 'Allow GitHub',
        principle: 'test',
        if: { domains: { roles: ['git-remote-url'], allowed: ['github.com'] } },
        then: 'allow',
        reason: 'GitHub is trusted',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    // Non-filesystem: roles go to compiled rule evaluation, domains condition matches
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-github-domain');
  });

  it('matches a domains lists condition by the destination a git remote URL resolves to', () => {
    const listPolicy = (allowed: string[]) =>
      makePolicy([
        {
          name: 'allow-listed',
          description: 'Allow listed',
          principle: 'test',
          if: { lists: [{ roles: ['git-remote-url'], allowed, matchType: 'domains' }] },
          then: 'allow',
          reason: 'Listed',
        },
      ]);
    const request = makeRequest({
      serverName: 'git',
      toolName: 'git_push',
      arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
    });

    // Non-filesystem: no structural sandbox-allow. Roles go to compiled rule
    // evaluation, where a domains list on a URL role compares the resolved
    // destination (github.com/user/repo), as a domains condition does. It
    // used to compare the raw URL, so this rule never matched a URL at all.
    const listed = new PolicyEngine(listPolicy(['github.com']), annotations, [], SANDBOX_DIR, domainAllowlists);
    expect(listed.evaluate(request)).toMatchObject({ decision: 'allow', rule: 'allow-listed' });

    // A destination the list does not name: default deny.
    const other = new PolicyEngine(listPolicy(['gitlab.com']), annotations, [], SANDBOX_DIR, domainAllowlists);
    expect(other.evaluate(request)).toMatchObject({ decision: 'deny', rule: 'default-deny' });
  });
});

// ---------------------------------------------------------------------------
// Protected path check: edge cases
// ---------------------------------------------------------------------------

describe('Protected path edge cases', () => {
  const annotations = makeAnnotations({
    filesystem: [makeTool('filesystem', 'read_file', { path: ['read-path'] })],
  });

  it('does NOT deny path that is only a prefix of protected path', () => {
    const engine = new PolicyEngine(
      makePolicy([{ name: 'deny-all', description: 'd', principle: 't', if: {}, then: 'deny', reason: 'default' }]),
      annotations,
      ['/home/user/secret'],
    );
    const result = engine.evaluate(makeRequest({ arguments: { path: '/home/user/secret2' } }));
    expect(result.rule).not.toBe('structural-protected-path');
  });

  it('denies path equal to protected path', () => {
    const engine = new PolicyEngine(makePolicy([]), annotations, ['/home/user/secret']);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/home/user/secret' } }));
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-protected-path');
  });

  it('denies path inside protected directory', () => {
    const engine = new PolicyEngine(makePolicy([]), annotations, ['/home/user/secret']);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/home/user/secret/file.txt' } }));
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-protected-path');
  });

  it('denies path with .. that resolves to protected path', () => {
    const engine = new PolicyEngine(makePolicy([]), annotations, ['/home/user/secret']);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/home/user/other/../secret/file.txt' } }));
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-protected-path');
  });
});

// ---------------------------------------------------------------------------
// Filesystem sandbox containment: edge cases
// ---------------------------------------------------------------------------

describe('Sandbox containment edge cases', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'read_file', { path: ['read-path'] }),
      makeTool('filesystem', 'write_file', { path: ['write-path'], content: ['none'] }),
    ],
    git: [
      makeTool('git', 'git_reset', {
        path: ['read-path', 'write-history'],
        mode: ['none'],
      }),
      makeTool('git', 'git_branch', {
        path: ['read-path', 'write-history', 'delete-history'],
        name: ['branch-name'],
        delete: ['none'],
      }),
      makeTool('git', 'git_status', { path: ['read-path'] }),
    ],
  });

  const policy = makePolicy([
    {
      name: 'escalate-destructive',
      description: 'Escalate destructive ops',
      principle: 'test',
      if: { server: ['git'], tool: ['git_reset', 'git_branch'] },
      then: 'escalate',
      reason: 'Destructive ops need approval',
    },
    {
      name: 'allow-git-read',
      description: 'Allow git reads',
      principle: 'test',
      if: { server: ['git'], tool: ['git_status'] },
      then: 'allow',
      reason: 'Reads are safe',
    },
    {
      name: 'escalate-reads',
      description: 'Escalate reads outside sandbox',
      principle: 'test',
      if: { roles: ['read-path'] },
      then: 'escalate',
      reason: 'Reads outside sandbox need approval',
    },
    {
      name: 'deny-all',
      description: 'Default deny',
      principle: 'test',
      if: {},
      then: 'deny',
      reason: 'Default deny',
    },
  ]);

  it('allows path with .. in middle that resolves inside sandbox', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        arguments: { path: `${SANDBOX_DIR}/subdir/../test.txt` },
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('write-history role IS sandbox-resolved (sandbox-safe by design; .git writes escalate separately)', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_reset',
        arguments: { path: `${SANDBOX_DIR}/repo`, mode: 'hard' },
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('delete-history role IS sandbox-resolved (sandbox-safe by design; .git writes escalate separately)', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_branch',
        arguments: { path: `${SANDBOX_DIR}/repo`, name: 'old', delete: true },
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('all path roles sandbox-resolved when within sandbox', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_reset',
        arguments: { path: `${SANDBOX_DIR}/repo`, mode: 'soft' },
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('tool with only opaque roles evaluates role-agnostic rules', () => {
    const opaqueAnnotations = makeAnnotations({
      myserver: [makeTool('myserver', 'my_tool', { flag: ['none'], count: ['none'] })],
    });

    const opaquePolicy = makePolicy([
      {
        name: 'allow-my-tool',
        description: 'Allow my_tool',
        principle: 'test',
        if: { server: ['myserver'], tool: ['my_tool'] },
        then: 'allow',
        reason: 'Allowed',
      },
    ]);

    const engine = new PolicyEngine(opaquePolicy, opaqueAnnotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'myserver',
        toolName: 'my_tool',
        arguments: { flag: true, count: 5 },
      }),
    );

    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-my-tool');
  });
});

// ---------------------------------------------------------------------------
// Untrusted domain gate: edge cases
// ---------------------------------------------------------------------------

describe('Domain allowlist edge cases', () => {
  const gitAnnotations = makeAnnotations({
    git: [
      makeTool('git', 'git_clone', {
        url: ['git-remote-url'],
        path: ['write-path'],
      }),
    ],
  });

  const defaultPolicy = makePolicy([
    {
      name: 'deny-all',
      description: 'Default deny',
      principle: 'test',
      if: {},
      then: 'deny',
      reason: 'Default deny',
    },
  ]);

  it('IP addresses with * wildcard escalate (SSRF protection)', () => {
    expect(domainMatchesAllowlist('127.0.0.1', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('10.0.0.1', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('169.254.169.254', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('192.168.1.1', ['*'])).toBe(false);
  });

  it('IPv6 with * wildcard escalates (SSRF protection)', () => {
    expect(domainMatchesAllowlist('::1', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('[::1]', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('fe80::1', ['*'])).toBe(false);
  });

  it('explicit IP in allowlist allows (SSRF opt-in)', () => {
    expect(domainMatchesAllowlist('192.168.1.100', ['192.168.1.100'])).toBe(true);
    expect(domainMatchesAllowlist('192.168.1.100', ['*', '192.168.1.100'])).toBe(true);
  });

  it('URL with port number extracts hostname correctly', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com:443/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('URL with non-standard port extracts hostname correctly', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com:8080/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('URL with userinfo extracts hostname correctly', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://user:pass@github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('case-insensitive domain extraction (HTTPS://GITHUB.COM)', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'HTTPS://GITHUB.COM/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('SSH git URL extracts domain correctly', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'git@github.com:user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('server without domain allowlist falls through to compiled rule evaluation', () => {
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://evil.com/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('empty domain allowlist escalates everything the compiled policy does not deny', () => {
    const allowlists = new Map([['git', [] as string[]]]);
    const escalateClonePolicy = makePolicy([
      {
        name: 'escalate-clone',
        description: 'Escalate clones',
        principle: 'test',
        if: { server: ['git'], tool: ['git_clone'] },
        then: 'escalate',
        reason: 'Clones need approval',
      },
    ]);
    const engine = new PolicyEngine(escalateClonePolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('structural-domain-escalate');
  });

  it('empty domain allowlist never turns a compiled deny into an escalation', () => {
    // The gate used to return early, so even an explicit deny-all policy
    // became an approvable escalation for every URL call.
    const allowlists = new Map([['git', [] as string[]]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('deny-all');
  });
});

// ---------------------------------------------------------------------------
// Compiled rule evaluation: rule matching
// ---------------------------------------------------------------------------

describe('Compiled rule evaluation: rule matching', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'read_file', { path: ['read-path'] }),
      makeTool('filesystem', 'write_file', { path: ['write-path'], content: ['none'] }),
      makeTool('filesystem', 'list_dirs', {}),
    ],
    myserver: [makeTool('myserver', 'my_tool', { data: ['none'] })],
  });

  it('first-match-wins: earlier rule takes precedence', () => {
    const policy = makePolicy([
      {
        name: 'allow-all-reads',
        description: 'Allow reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'allow',
        reason: 'Reads allowed',
      },
      {
        name: 'deny-all-reads',
        description: 'Deny reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'deny',
        reason: 'Reads denied',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/etc/file.txt' } }));
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-all-reads');
  });

  it('paths.within condition with nested directories', () => {
    const policy = makePolicy([
      {
        name: 'allow-reads-in-dir',
        description: 'Allow reads in /tmp/permitted',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/permitted` } },
        then: 'allow',
        reason: 'In permitted dir',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Default deny',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);

    const inDir = engine.evaluate(makeRequest({ arguments: { path: `${REAL_TMP}/permitted/deep/nested/file.txt` } }));
    expect(inDir.decision).toBe('allow');

    const outDir = engine.evaluate(makeRequest({ arguments: { path: `${REAL_TMP}/other/file.txt` } }));
    expect(outDir.decision).toBe('deny');
  });

  it('roles condition matches tool with that role', () => {
    const policy = makePolicy([
      {
        name: 'escalate-writes',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes need approval',
      },
      {
        name: 'allow-all',
        description: 'Allow all',
        principle: 'test',
        if: {},
        then: 'allow',
        reason: 'Allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);

    const writeResult = engine.evaluate(
      makeRequest({
        toolName: 'write_file',
        arguments: { path: '/etc/config.yaml', content: 'data' },
      }),
    );
    expect(writeResult.decision).toBe('escalate');

    const readResult = engine.evaluate(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: '/etc/config.yaml' },
      }),
    );
    expect(readResult.decision).toBe('allow');
  });

  it('combined conditions: server + tool all must match', () => {
    const policy = makePolicy([
      {
        name: 'allow-specific',
        description: 'Allow specific combo',
        principle: 'test',
        if: { server: ['filesystem'], tool: ['read_file'] },
        then: 'allow',
        reason: 'Specific match',
      },
      {
        name: 'deny-all',
        description: 'Deny all',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);

    const match = engine.evaluate(makeRequest({ arguments: { path: '/etc/file.txt' } }));
    expect(match.decision).toBe('allow');

    const wrongServer = engine.evaluate(
      makeRequest({
        serverName: 'myserver',
        toolName: 'my_tool',
        arguments: { data: 'test' },
      }),
    );
    expect(wrongServer.decision).toBe('deny');
  });

  it('default deny when no rules match', () => {
    const policy = makePolicy([
      {
        name: 'allow-writes-only',
        description: 'Allow writes only',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'allow',
        reason: 'Only writes allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/etc/file.txt' } }));
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('default-deny');
  });
});

// ---------------------------------------------------------------------------
// Compiled rule evaluation: multi-role evaluation
// ---------------------------------------------------------------------------

describe('Multi-role evaluation', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'complex_op', {
        source: ['read-path', 'delete-path'],
        destination: ['write-path'],
      }),
      makeTool('filesystem', 'edit_file', {
        path: ['read-path', 'write-path'],
        edits: ['none'],
      }),
    ],
  });

  it('deny > escalate: one role deny + another escalate → deny', () => {
    const policy = makePolicy([
      {
        name: 'deny-deletes',
        description: 'Deny deletes',
        principle: 'test',
        if: { roles: ['delete-path'] },
        then: 'deny',
        reason: 'Deletes forbidden',
      },
      {
        name: 'escalate-writes',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes need approval',
      },
      {
        name: 'allow-reads',
        description: 'Allow reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'allow',
        reason: 'Reads allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'complex_op',
        arguments: { source: '/etc/a.txt', destination: `${REAL_TMP}/b.txt` },
      }),
    );
    expect(result.decision).toBe('deny');
  });

  it('escalate > allow: one role escalate + another allow → escalate', () => {
    const policy = makePolicy([
      {
        name: 'escalate-writes',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes need approval',
      },
      {
        name: 'allow-reads',
        description: 'Allow reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'allow',
        reason: 'Reads allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'edit_file',
        arguments: { path: '/etc/config.txt', edits: [] },
      }),
    );
    expect(result.decision).toBe('escalate');
  });

  it('all roles allow → allow', () => {
    const policy = makePolicy([
      {
        name: 'allow-all-roles',
        description: 'Allow all',
        principle: 'test',
        if: {},
        then: 'allow',
        reason: 'All allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'edit_file',
        arguments: { path: '/etc/config.txt', edits: [] },
      }),
    );
    expect(result.decision).toBe('allow');
  });

  it('3-role tool: most restrictive across all roles wins', () => {
    const policy = makePolicy([
      {
        name: 'allow-reads',
        description: 'Allow reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'allow',
        reason: 'Reads allowed',
      },
      {
        name: 'escalate-writes',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes escalated',
      },
      {
        name: 'deny-deletes',
        description: 'Deny deletes',
        principle: 'test',
        if: { roles: ['delete-path'] },
        then: 'deny',
        reason: 'Deletes denied',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'complex_op',
        arguments: { source: '/etc/a.txt', destination: `${REAL_TMP}/b.txt` },
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('deny-deletes');
  });
});

// ---------------------------------------------------------------------------
// Compiled rule evaluation: per-element multi-path evaluation
// ---------------------------------------------------------------------------

describe('Per-element multi-path evaluation', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'read_multiple_files', { paths: ['read-path'] }),
      makeTool('filesystem', 'read_file', { path: ['read-path'] }),
    ],
  });

  it('multiple paths spanning different rules: most restrictive wins', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow reads in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/dir-a` } },
        then: 'allow',
        reason: 'In dir-a',
      },
      {
        name: 'escalate-dir-b',
        description: 'Escalate reads in dir-b',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/dir-b` } },
        then: 'escalate',
        reason: 'In dir-b',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: { paths: [`${REAL_TMP}/dir-a/f1.txt`, `${REAL_TMP}/dir-b/f2.txt`] },
      }),
    );
    expect(result.decision).toBe('escalate');
  });

  it('one path undischarged (no matching rule) → default deny', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow reads in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/dir-a` } },
        then: 'allow',
        reason: 'In dir-a',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: { paths: [`${REAL_TMP}/dir-a/f1.txt`, `${REAL_TMP}/unknown/f2.txt`] },
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('default-deny');
  });

  it('all paths discharged by different rules → most restrictive wins', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow reads in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/dir-a` } },
        then: 'allow',
        reason: 'In dir-a',
      },
      {
        name: 'allow-dir-b',
        description: 'Allow reads in dir-b',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/dir-b` } },
        then: 'allow',
        reason: 'In dir-b',
      },
      {
        name: 'escalate-dir-c',
        description: 'Escalate reads in dir-c',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/dir-c` } },
        then: 'escalate',
        reason: 'In dir-c',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: {
          paths: [`${REAL_TMP}/dir-a/f1.txt`, `${REAL_TMP}/dir-b/f2.txt`, `${REAL_TMP}/dir-c/f3.txt`],
        },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-dir-c');
  });

  it('single-path argument → normal flow (no per-element evaluation)', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow reads in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/dir-a` } },
        then: 'allow',
        reason: 'In dir-a',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: `${REAL_TMP}/dir-a/file.txt` },
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-dir-a');
  });

  it('role-agnostic catch-all discharges all remaining paths', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/dir-a` } },
        then: 'allow',
        reason: 'In dir-a',
      },
      {
        name: 'escalate-all',
        description: 'Escalate everything',
        principle: 'test',
        if: {},
        then: 'escalate',
        reason: 'Escalated',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: { paths: [`${REAL_TMP}/dir-a/f1.txt`, `${REAL_TMP}/unknown/f2.txt`] },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-all');
  });
});

// ---------------------------------------------------------------------------
// Compiled rule evaluation: lists condition matching
// ---------------------------------------------------------------------------

describe('Lists condition matching', () => {
  // Use the github-owner role (an identifier-category resource role) as a
  // stand-in for email-recipient since custom roles can't be added to the
  // registry. The list matching logic is the same regardless of role name.
  // A url-category role would not do: the structural domain gate treats a
  // fetch-url value that is not an http(s) URL as unverifiable.
  const emailAnnotations = makeAnnotations({
    email: [
      makeTool('email', 'send_email', {
        to: ['github-owner'],
        subject: ['none'],
        body: ['none'],
      }),
    ],
  });

  it('lists condition with matchType domains and wildcard matching', () => {
    const fetchAnnotations = makeAnnotations({
      fetch: [makeTool('fetch', 'fetch_url', { url: ['fetch-url'] })],
    });

    const policy = makePolicy([
      {
        name: 'allow-listed-domains',
        description: 'Allow listed domains',
        principle: 'test',
        if: {
          tool: ['fetch_url'],
          domains: { roles: ['fetch-url'], allowed: ['github.com', '*.github.com'] },
        },
        then: 'allow',
        reason: 'Domain is allowed',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, fetchAnnotations, []);

    const match = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://api.github.com/repos' },
      }),
    );
    expect(match.decision).toBe('allow');

    const noMatch = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://evil.com/steal' },
      }),
    );
    expect(noMatch.decision).toBe('deny');
  });

  it('lists condition with matchType emails case-insensitive', () => {
    const policy = makePolicy([
      {
        name: 'allow-listed-emails',
        description: 'Allow listed emails',
        principle: 'test',
        if: {
          tool: ['send_email'],
          lists: [
            {
              roles: ['github-owner'],
              allowed: ['alice@example.com', 'bob@example.com'],
              matchType: 'emails',
            },
          ],
        },
        then: 'allow',
        reason: 'Recipient is allowed',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, emailAnnotations, []);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'email',
        toolName: 'send_email',
        arguments: { to: 'ALICE@EXAMPLE.COM', subject: 'Hi', body: 'Hello' },
      }),
    );
    expect(result.decision).toBe('allow');

    const deny = engine.evaluate(
      makeRequest({
        serverName: 'email',
        toolName: 'send_email',
        arguments: { to: 'evil@hacker.com', subject: 'Hi', body: 'Hello' },
      }),
    );
    expect(deny.decision).toBe('deny');
  });

  it('lists condition with matchType identifiers exact match', () => {
    const idAnnotations = makeAnnotations({
      myserver: [makeTool('myserver', 'my_tool', { id: ['github-owner'] })],
    });

    const policy = makePolicy([
      {
        name: 'allow-listed-ids',
        description: 'Allow listed IDs',
        principle: 'test',
        if: {
          tool: ['my_tool'],
          lists: [
            {
              roles: ['github-owner'],
              allowed: ['proj-123', 'proj-456'],
              matchType: 'identifiers',
            },
          ],
        },
        then: 'allow',
        reason: 'ID is allowed',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, idAnnotations, []);

    const match = engine.evaluate(
      makeRequest({
        serverName: 'myserver',
        toolName: 'my_tool',
        arguments: { id: 'proj-123' },
      }),
    );
    expect(match.decision).toBe('allow');

    // Case-sensitive: 'PROJ-123' ≠ 'proj-123'
    const noMatch = engine.evaluate(
      makeRequest({
        serverName: 'myserver',
        toolName: 'my_tool',
        arguments: { id: 'PROJ-123' },
      }),
    );
    expect(noMatch.decision).toBe('deny');
  });

  it('zero extracted values → condition not satisfied, rule does not match', () => {
    const fetchAnnotations = makeAnnotations({
      fetch: [makeTool('fetch', 'fetch_url', { url: ['fetch-url'] })],
    });

    const policy = makePolicy([
      {
        name: 'allow-listed',
        description: 'Allow listed',
        principle: 'test',
        if: {
          lists: [
            {
              roles: ['git-remote-url'],
              allowed: ['github.com'],
              matchType: 'domains',
            },
          ],
        },
        then: 'allow',
        reason: 'Listed',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, fetchAnnotations, []);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://example.com' },
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('deny-all');
  });
});

// ---------------------------------------------------------------------------
// Argument edge cases
// ---------------------------------------------------------------------------

describe('Argument edge cases', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'read_file', { path: ['read-path'] }),
      makeTool('filesystem', 'read_multiple_files', { paths: ['read-path'] }),
      makeTool('filesystem', 'list_dirs', {}),
    ],
  });

  const policy = makePolicy([
    {
      name: 'allow-pure',
      description: 'Allow pure tools',
      principle: 'test',
      if: { tool: ['list_dirs'] },
      then: 'allow',
      reason: 'Pure tools safe',
    },
    {
      name: 'escalate-reads',
      description: 'Escalate reads',
      principle: 'test',
      if: { roles: ['read-path'] },
      then: 'escalate',
      reason: 'Reads need approval',
    },
    {
      name: 'deny-all',
      description: 'Default deny',
      principle: 'test',
      if: {},
      then: 'deny',
      reason: 'Denied',
    },
  ]);

  it('empty arguments: tool with no roles triggers role-agnostic rules', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'list_dirs',
        arguments: {},
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-pure');
  });

  it('argument value is a number → extraction handles gracefully', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',

        arguments: { path: 42 },
      }),
    );
    expect(result.decision).toBeDefined();
  });

  it('argument value is null → extraction handles gracefully', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',

        arguments: { path: null },
      }),
    );
    expect(result.decision).toBeDefined();
  });

  it('argument value is an array of mixed types → every value checked, and a human decides', () => {
    // The null element makes the value one policy cannot evaluate value by
    // value: its strings and numbers are still judged (here by
    // escalate-reads), and the call goes to a human (see
    // policy-engine-nested-args.test.ts).
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: { paths: ['/etc/file.txt', 42, null, `${REAL_TMP}/other.txt`] },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('structural-nested-argument-escalate');
    expect(result.humanOnly).toBe(true);
  });

  it('argument value is undefined → extraction handles gracefully', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',

        arguments: { path: undefined },
      }),
    );
    expect(result.decision).toBeDefined();
  });

  it('unknown tool is denied', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'nonexistent_tool',
        arguments: { something: 'value' },
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-unknown-tool');
  });

  it('empty string path is not treated as a filesystem path by heuristic', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: '' },
      }),
    );
    expect(result.decision).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dynamic list expansion
// ---------------------------------------------------------------------------

describe('Dynamic list expansion', () => {
  const fetchAnnotations = makeAnnotations({
    fetch: [makeTool('fetch', 'fetch_url', { url: ['fetch-url'] })],
  });

  it('expands @list-name in domains.allowed at load time', () => {
    const policy = makePolicy([
      {
        name: 'allow-listed-domains',
        description: 'Allow listed',
        principle: 'test',
        if: {
          tool: ['fetch_url'],
          domains: { roles: ['fetch-url'], allowed: ['@trusted-domains'] },
        },
        then: 'allow',
        reason: 'Domain is trusted',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const dynamicLists: DynamicListsFile = {
      generatedAt: 'test',
      lists: {
        'trusted-domains': {
          values: ['github.com', 'gitlab.com'],
          manualAdditions: ['bitbucket.org'],
          manualRemovals: ['gitlab.com'],
          resolvedAt: 'test',
          inputHash: 'test',
        },
      },
    };

    const engine = new PolicyEngine(policy, fetchAnnotations, [], undefined, undefined, dynamicLists);

    const github = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://github.com/repo' },
      }),
    );
    expect(github.decision).toBe('allow');

    const bitbucket = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://bitbucket.org/repo' },
      }),
    );
    expect(bitbucket.decision).toBe('allow');

    const gitlab = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://gitlab.com/repo' },
      }),
    );
    expect(gitlab.decision).toBe('deny');

    const evil = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://evil.com/steal' },
      }),
    );
    expect(evil.decision).toBe('deny');
  });

  it('denies (fail closed) when @list-name references a missing list', () => {
    const policy = makePolicy([
      {
        name: 'allow-listed',
        description: 'Allow listed',
        principle: 'test',
        if: {
          domains: { roles: ['fetch-url'], allowed: ['@nonexistent'] },
        },
        then: 'allow',
        reason: 'Listed',
      },
    ]);

    const dynamicLists: DynamicListsFile = {
      generatedAt: 'test',
      lists: {},
    };

    // A missing @list resolves to the empty allowlist (=> deny) instead of
    // throwing, so policy load never crashes on a dangling reference.
    const engine = new PolicyEngine(policy, fetchAnnotations, [], undefined, undefined, dynamicLists);
    // toolName MUST match the annotation ("fetch_url"); a wrong name would deny
    // via the unknown-tool invariant and never exercise the missing-@list path.
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch_url',
      arguments: { url: 'https://example.com' },
      timestamp: '',
    });
    expect(result.decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Path resolution per evaluation (realpath calls)
// ---------------------------------------------------------------------------

describe('Path resolution per evaluation', () => {
  // Real directories and files, so every resolution is exactly one realpath
  // call and the counts below are exact.
  let base: string;
  let sandbox: string;
  let permitted: string;
  let outside: string;
  let sandboxFiles: string[];
  let protectedEntries: string[];

  beforeAll(() => {
    base = mkdtempSync(join(REAL_TMP, 'ironcurtain-stress-realpath-'));
    sandbox = join(base, 'sandbox');
    permitted = join(base, 'permitted');
    outside = join(base, 'outside');
    for (const dir of [sandbox, permitted, outside, join(base, 'home', '.ironcurtain'), join(base, 'home', '.aws')]) {
      mkdirSync(dir, { recursive: true });
    }
    sandboxFiles = Array.from({ length: 20 }, (_, i) => join(sandbox, `f${i}.txt`));
    for (const file of [...sandboxFiles, join(permitted, 'r.txt'), join(outside, 'o.txt')]) writeFileSync(file, 'x');
    writeFileSync(join(base, 'home', '.ironcurtain', 'config.json'), '{}');
    mkdirSync(join(base, 'project'));
    writeFileSync(join(base, 'project', '.env'), 'KEY=value');
    protectedEntries = [
      join(base, 'home', '.ironcurtain'),
      join(base, 'home', '.aws'),
      join(base, 'project', '.env'),
      join(base, 'home', '.ironcurtain', 'config.json'),
    ];
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'read_file', { path: ['read-path'] }),
      makeTool('filesystem', 'read_multiple_files', { paths: ['read-path'] }),
      makeTool('filesystem', 'edit_file', { path: ['read-path', 'write-path'], edits: ['none'] }),
    ],
  });

  function makeEngine(within: string = permitted, entries: string[] = protectedEntries): PolicyEngine {
    return new PolicyEngine(
      makePolicy([
        {
          name: 'allow-permitted-reads',
          description: 'Allow reads in the permitted directory',
          principle: 'test',
          if: { paths: { roles: ['read-path'], within }, server: ['filesystem'] },
          then: 'allow',
          reason: 'Permitted',
        },
        {
          name: 'escalate-other-reads',
          description: 'Escalate other reads',
          principle: 'test',
          if: { roles: ['read-path'], server: ['filesystem'] },
          then: 'escalate',
          reason: 'Reads need approval',
        },
      ]),
      annotations,
      entries,
      sandbox,
    );
  }

  /** Evaluates one call and returns its decision with the realpath inputs it made. */
  function evaluateCounting(
    engine: PolicyEngine,
    toolName: string,
    args: Record<string, unknown>,
  ): { result: ReturnType<PolicyEngine['evaluate']>; calls: string[] } {
    realpathLog.calls.length = 0;
    const result = engine.evaluate(makeRequest({ toolName, arguments: args }));
    return { result, calls: [...realpathLog.calls] };
  }

  it('resolves the sandbox and every rule directory once, when the engine is built', () => {
    realpathLog.calls.length = 0;
    const engine = makeEngine();
    expect(realpathLog.calls).toEqual(expect.arrayContaining([sandbox, permitted]));

    const { result, calls } = evaluateCounting(engine, 'read_file', { path: join(permitted, 'r.txt') });
    expect(result).toMatchObject({ decision: 'allow', rule: 'allow-permitted-reads' });
    expect(calls).not.toContain(sandbox);
    expect(calls).not.toContain(permitted);
  });

  it('resolves a single path once, plus each protected entry once', () => {
    // Before: the path was resolved again by the protected-path check and by
    // sandbox containment, and the sandbox at every comparison (9 calls).
    const { result, calls } = evaluateCounting(makeEngine(), 'read_file', { path: sandboxFiles[0] });
    expect(result).toMatchObject({ decision: 'allow', rule: 'structural-sandbox-allow' });
    expect([...calls].sort()).toEqual([sandboxFiles[0], ...protectedEntries].sort());
  });

  it('resolves a multi-path call once per path, not once per path and protected entry', () => {
    // Before: 20 paths x (protected check: path, sandbox, 4 entries; sandbox
    // containment: path, sandbox) + 20 = 180 calls.
    const { result, calls } = evaluateCounting(makeEngine(), 'read_multiple_files', { paths: sandboxFiles });
    expect(result).toMatchObject({ decision: 'allow', rule: 'structural-sandbox-allow' });
    expect(calls).toHaveLength(sandboxFiles.length + protectedEntries.length);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it('resolves a path that several roles and rules compare only once', () => {
    // read-path is discharged by allow-permitted-reads, write-path by no rule.
    const path = join(permitted, 'r.txt');
    const { result, calls } = evaluateCounting(makeEngine(), 'edit_file', { path, edits: [] });
    expect(result).toMatchObject({ decision: 'deny', rule: 'default-deny' });
    expect([...calls].sort()).toEqual([path, ...protectedEntries].sort());
  });

  it('makes no realpath call for a call without paths', () => {
    expect(evaluateCounting(makeEngine(), 'read_multiple_files', { paths: [] }).calls).toEqual([]);
  });

  it('resolves protected entries when the call is made, so a symlink created later protects its target', () => {
    // The entry does not exist when the engine is built; a symlink created
    // there afterwards points at a file the policy otherwise allows reading.
    const lateEntry = join(base, 'project', '.env.late');
    const secret = join(permitted, 'secret.txt');
    writeFileSync(secret, 'TOKEN=1');
    const engine = makeEngine(permitted, [lateEntry]);
    expect(evaluateCounting(engine, 'read_file', { path: secret }).result.decision).toBe('allow');

    symlinkSync(secret, lateEntry);
    expect(evaluateCounting(engine, 'read_file', { path: secret }).result).toMatchObject({
      decision: 'deny',
      rule: 'structural-protected-path',
    });
  });

  it('keeps a rule directory created after the engine was built where it was named', () => {
    // A plain directory created later resolves to the precomputed path...
    const later = join(base, 'later');
    const engine = makeEngine(later);
    mkdirSync(later);
    writeFileSync(join(later, 'l.txt'), 'x');
    expect(evaluateCounting(engine, 'read_file', { path: join(later, 'l.txt') }).result).toMatchObject({
      decision: 'allow',
      rule: 'allow-permitted-reads',
    });

    // ...while a symlink created there later is not followed: the rule keeps
    // naming the location it named when the engine was built.
    const linked = join(base, 'linked');
    const linkedEngine = makeEngine(linked);
    symlinkSync(outside, linked);
    expect(evaluateCounting(linkedEngine, 'read_file', { path: join(linked, 'o.txt') }).result).toMatchObject({
      decision: 'escalate',
      rule: 'escalate-other-reads',
    });
  });
});
