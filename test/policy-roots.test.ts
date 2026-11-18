import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  extractPolicyRoots,
  extractRequiredServers,
  toMcpRoots,
  directoryForPath,
  pathForRootUri,
  resolveApprovedPath,
  rootUriForPath,
} from '../src/trusted-process/policy-roots.js';
import type { CompiledPolicyFile, CompiledRule } from '../src/pipeline/types.js';

// Real temp directories so tests work on macOS (where /tmp → /private/tmp)
let tempDir: string;
let sandboxDir: string;
let downloadsDir: string;
let desktopDir: string;
let importantDir: string;
let sandboxLink: string;
let testFile: string;
let linkedFile: string;

beforeAll(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'policy-roots-test-')));
  sandboxDir = join(tempDir, 'sandbox');
  downloadsDir = join(tempDir, 'downloads');
  desktopDir = join(tempDir, 'desktop');
  importantDir = join(tempDir, 'important');

  mkdirSync(sandboxDir);
  mkdirSync(downloadsDir);
  mkdirSync(desktopDir);
  mkdirSync(importantDir);

  // Symlink pointing to the sandbox directory
  sandboxLink = join(tempDir, 'sandbox-link');
  symlinkSync(sandboxDir, sandboxLink);

  // Real file + file symlink
  testFile = join(sandboxDir, 'test-file.txt');
  writeFileSync(testFile, 'test');
  linkedFile = join(tempDir, 'linked-file.txt');
  symlinkSync(testFile, linkedFile);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeRule(overrides: {
  name?: string;
  then: 'allow' | 'deny' | 'escalate';
  paths?: { roles: string[]; within: string };
}): CompiledRule {
  return {
    name: overrides.name ?? `test-rule-${Math.random().toString(36).slice(2, 8)}`,
    description: 'test rule',
    principle: 'test',
    if: {
      ...(overrides.paths ? { paths: overrides.paths as CompiledRule['if']['paths'] } : {}),
    },
    then: overrides.then,
    reason: 'test reason',
  };
}

function makePolicyFile(rules: CompiledRule[]): CompiledPolicyFile {
  return {
    generatedAt: new Date().toISOString(),
    constitutionHash: 'test-hash',
    inputHash: 'test-input-hash',
    rules,
  };
}

describe('extractPolicyRoots', () => {
  it('always includes the sandbox directory as the first root', () => {
    const policy = makePolicyFile([]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toEqual([{ path: sandboxDir, name: 'sandbox' }]);
  });

  it('extracts directories from allow rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: downloadsDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(2);
    expect(roots[1].path).toBe(downloadsDir);
  });

  it('extracts directories from escalate rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'escalate',
        paths: { roles: ['read-path'], within: desktopDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(2);
    expect(roots[1].path).toBe(desktopDir);
  });

  it('excludes deny rules', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'deny',
        paths: { roles: ['delete-path'], within: importantDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('excludes catch-all rules without paths.within', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'escalate' }), // no paths condition
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('deduplicates directories referenced by multiple rules', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: downloadsDir },
      }),
      makeRule({
        then: 'allow',
        paths: { roles: ['write-path'], within: downloadsDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(2); // sandbox + Downloads (once)
  });

  it('deduplicates when sandbox matches a rule directory', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: sandboxDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(1); // sandbox only, no duplicate
  });

  it('uses rule name as the root name', () => {
    const policy = makePolicyFile([
      makeRule({
        name: 'allow-rwd-downloads',
        then: 'allow',
        paths: { roles: ['read-path'], within: downloadsDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots[1].name).toBe('allow-rwd-downloads');
  });

  it('resolves relative paths before deduplication', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: './relative/dir' },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots[1].path).toBe(resolve('./relative/dir'));
  });

  it('resolves symlink sandbox path to the real directory', () => {
    const policy = makePolicyFile([]);
    const roots = extractPolicyRoots(policy, sandboxLink);
    expect(roots).toEqual([{ path: sandboxDir, name: 'sandbox' }]);
  });

  it('deduplicates when sandbox symlink and rule point to same real directory', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: sandboxDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxLink);
    expect(roots).toHaveLength(1); // sandbox only, symlink resolved to same real path
  });
});

describe('toMcpRoots', () => {
  it('converts paths to file:// URIs', () => {
    const mcpRoots = toMcpRoots([
      { path: '/tmp/sandbox', name: 'sandbox' },
      { path: '/home/user/Downloads', name: 'downloads' },
    ]);
    expect(mcpRoots).toEqual([
      { uri: 'file:///tmp/sandbox', name: 'sandbox' },
      { uri: 'file:///home/user/Downloads', name: 'downloads' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(toMcpRoots([])).toEqual([]);
  });

  it('percent-encodes URL syntax so the server sees the exact directory', () => {
    // A bare `file://${path}` turns `x#y` into a fragment: the server would
    // install `/home/user/x` instead of the approved `/home/user/x#y`.
    const [root] = toMcpRoots([{ path: '/home/user/x#y?z', name: 'odd' }]);
    expect(root.uri).toBe('file:///home/user/x%23y%3Fz');
    expect(pathForRootUri(root.uri)).toBe('/home/user/x#y?z');
  });
});

describe('rootUriForPath / pathForRootUri', () => {
  it('round-trips spaces, percent signs and non-ASCII names', () => {
    for (const dir of ['/tmp/a b', '/tmp/100%', '/home/u/naïve', '/']) {
      expect(pathForRootUri(rootUriForPath(dir))).toBe(dir);
    }
  });

  it('returns undefined for URIs that are not local file URIs', () => {
    expect(pathForRootUri('https://example.com/x')).toBeUndefined();
    expect(pathForRootUri('file://remote-host/x')).toBeUndefined();
    expect(pathForRootUri('not a uri')).toBeUndefined();
  });
});

describe('resolveApprovedPath', () => {
  it('resolves relative paths against the base directory, not the process cwd', () => {
    expect(resolveApprovedPath('relative/file.txt', sandboxDir)).toBe(join(sandboxDir, 'relative/file.txt'));
  });

  it('returns undefined for a relative path without a base directory', () => {
    expect(resolveApprovedPath('relative/file.txt')).toBeUndefined();
  });

  it('canonicalizes absolute paths through symlinks', () => {
    expect(resolveApprovedPath(linkedFile, sandboxDir)).toBe(testFile);
  });
});

describe('directoryForPath', () => {
  it('returns dirname for a file path', () => {
    expect(directoryForPath(testFile)).toBe(sandboxDir);
  });

  it('returns the directory itself for a trailing-slash path', () => {
    expect(directoryForPath(desktopDir + '/')).toBe(desktopDir);
  });

  it('returns an existing directory itself, not its parent', () => {
    // Approving a listing of desktopDir must not make all of tempDir a root.
    expect(directoryForPath(desktopDir)).toBe(desktopDir);
  });

  it('returns the parent of a path that does not exist yet', () => {
    expect(directoryForPath(join(desktopDir, 'new-dir'))).toBe(desktopDir);
  });

  it('resolves relative paths against the base directory', () => {
    expect(directoryForPath('relative/file.txt', sandboxDir)).toBe(join(sandboxDir, 'relative'));
    expect(directoryForPath('test-file.txt', sandboxDir)).toBe(sandboxDir);
  });

  it('never resolves a relative path against the process working directory', () => {
    expect(directoryForPath('relative/file.txt')).toBeUndefined();
    expect(directoryForPath('relative/file.txt', sandboxDir)).not.toBe(resolve('relative'));
  });

  it('handles deeply nested file paths', () => {
    expect(directoryForPath('/a/b/c/d/file.txt')).toBe('/a/b/c/d');
  });

  it('handles root-level files', () => {
    expect(directoryForPath('/file.txt')).toBe('/');
  });

  it('resolves symlinks before extracting directory', () => {
    expect(directoryForPath(linkedFile)).toBe(sandboxDir);
  });

  it('resolves a symlinked directory to its target', () => {
    expect(directoryForPath(sandboxLink)).toBe(sandboxDir);
  });
});

// ---------------------------------------------------------------------------
// extractRequiredServers
// ---------------------------------------------------------------------------

function makeServerRule(name: string, server: string[], decision: 'allow' | 'deny' | 'escalate'): CompiledRule {
  return {
    name,
    description: 'test',
    principle: 'test',
    if: { server },
    then: decision,
    reason: 'test',
  };
}

describe('extractRequiredServers', () => {
  it('returns the union of every rule.if.server entry', () => {
    const policy = makePolicyFile([
      makeServerRule('r1', ['filesystem'], 'allow'),
      makeServerRule('r2', ['git'], 'escalate'),
      makeServerRule('r3', ['filesystem', 'fetch'], 'allow'),
    ]);
    expect(extractRequiredServers(policy)).toEqual(new Set(['filesystem', 'git', 'fetch']));
  });

  it('excludes the virtual proxy server even when rules reference it', () => {
    const policy = makePolicyFile([
      makeServerRule('r1', ['filesystem'], 'allow'),
      makeServerRule('r2', ['proxy'], 'allow'),
    ]);
    const servers = extractRequiredServers(policy);
    expect(servers.has('proxy')).toBe(false);
    expect(servers.has('filesystem')).toBe(true);
  });

  it('excludes the virtual network (MITM egress) server, which has no relay to spawn', () => {
    const policy = makePolicyFile([makeServerRule('r1', ['git'], 'allow'), makeServerRule('r2', ['network'], 'allow')]);
    expect(extractRequiredServers(policy)).toEqual(new Set(['git']));
  });

  it('returns an empty set when no rules carry an if.server entry', () => {
    const policy = makePolicyFile([
      {
        name: 'unscoped',
        description: 'test',
        principle: 'test',
        if: {},
        then: 'allow',
        reason: 'test',
      },
    ]);
    expect(extractRequiredServers(policy)).toEqual(new Set());
  });
});
