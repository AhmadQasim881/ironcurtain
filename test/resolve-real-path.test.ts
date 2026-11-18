/**
 * resolveRealPath on the real filesystem and under a simulated macOS:
 *
 * - a symlinked ancestor is followed however many missing components follow
 *   it (the old walk gave up after 64 levels and returned the unresolved
 *   path, which let a deep path through a symlink pass sandbox containment);
 * - the ancestor search stays cheap for very long paths;
 * - on macOS the native realpath supplies the on-disk spelling, which policy
 *   and transport then share;
 * - when nothing resolves it throws, and the policy engine and the tool-call
 *   pipeline turn that into a (audited) deny;
 * - resolveDanglingLink (and resolveDanglingLinkTarget), its deny-side
 *   companion, follows the links that resolveRealPath cannot (dangling ones),
 *   like `realpath -m`, and names every link it passes through.
 */

import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PathResolutionError,
  isPathResolutionError,
  isWithinDirectory,
  resolveDanglingLink,
  resolveDanglingLinkTarget,
  resolveRealPath,
} from '../src/types/argument-roles.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { prepareToolArgs } from '../src/trusted-process/path-utils.js';
import {
  handleCallTool,
  type CallToolDeps,
  type ClientState,
  type ProxiedTool,
} from '../src/trusted-process/tool-call-pipeline.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import type { ResolvedSandboxConfig } from '../src/trusted-process/sandbox-integration.js';
import type { CompiledPolicyFile, ToolAnnotation } from '../src/pipeline/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import { testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function simulatePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
});

function request(toolName: string, args: Record<string, unknown>): ToolCallRequest {
  return {
    requestId: 'r',
    serverName: 'filesystem',
    toolName,
    arguments: args,
    timestamp: new Date().toISOString(),
  };
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' });
}

describe('resolveRealPath on the real filesystem', () => {
  let root: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-resolve-real-path-')));
    mkdirSync(join(root, 'target'));
    mkdirSync(join(root, 'sandbox'));
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'target'), join(root, 'link'));
    symlinkSync(join(root, 'outside'), join(root, 'sandbox', 'escape'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves existing paths and the filesystem root', () => {
    expect(resolveRealPath('/')).toBe('/');
    expect(resolveRealPath(join(root, 'link'))).toBe(join(root, 'target'));
    expect(resolveRealPath(join(root, 'link', 'new.txt'))).toBe(join(root, 'target', 'new.txt'));
  });

  it('follows a symlinked ancestor however many missing components follow it', () => {
    const tail = '/d'.repeat(70) + '/file.txt';
    expect(resolveRealPath(`${root}/link${tail}`)).toBe(`${root}/target${tail}`);
  });

  it('keeps a deep path through an escaping symlink out of the sandbox', () => {
    const sandbox = join(root, 'sandbox');
    const deep = `${sandbox}/escape${'/d'.repeat(70)}/x.txt`;
    expect(isWithinDirectory(deep, sandbox)).toBe(false);

    const engine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, [], sandbox);
    const result = engine.evaluate(request('write_file', { path: deep, content: 'x' }));
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-write-outside-permitted-areas');
  });

  it('stays cheap for paths with very many missing components', () => {
    const tail = '/d'.repeat(20_000);
    const started = Date.now();
    expect(resolveRealPath(`${root}/missing${tail}`)).toBe(`${root}/missing${tail}`);
    expect(resolveRealPath(`${root}/link${tail}`)).toBe(`${root}/target${tail}`);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('resolveRealPath platform behaviour', () => {
  // A case-insensitive volume as macOS's native realpath(3) sees it: lookups
  // ignore case and the on-disk spelling comes back.
  const onDisk = ['/', '/Users', '/Users/me', '/Users/me/Downloads', '/Users/me/Downloads/proj'];
  const byFoldedName = new Map(onDisk.map((p) => [p.toLowerCase(), p]));

  function installCaseInsensitiveNativeRealpath(): void {
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((p) => {
      const hit = byFoldedName.get(String(p).toLowerCase());
      if (hit === undefined) throw enoent(String(p));
      return hit;
    });
  }

  it('uses the native realpath on macOS so existing components keep their on-disk spelling', () => {
    simulatePlatform('darwin');
    installCaseInsensitiveNativeRealpath();

    expect(resolveRealPath('/USERS/me/DOWNLOADS/proj')).toBe('/Users/me/Downloads/proj');
    // A new leaf keeps its own spelling; its existing ancestors are canonicalized.
    expect(resolveRealPath('/users/ME/downloads/New-File.txt')).toBe('/Users/me/Downloads/New-File.txt');
  });

  it('on macOS, a case-variant spelling is no longer falsely denied and reaches transport canonicalized', () => {
    simulatePlatform('darwin');
    installCaseInsensitiveNativeRealpath();

    const policy: CompiledPolicyFile = {
      generatedAt: 'test',
      constitutionHash: 'test',
      inputHash: 'test',
      rules: [
        {
          name: 'allow-read-downloads',
          description: 'reads in Downloads',
          principle: 'test',
          if: { paths: { roles: ['read-path'], within: '/Users/me/Downloads' }, server: ['filesystem'] },
          then: 'allow',
          reason: 'Downloads is readable',
        },
      ],
    };
    const engine = new PolicyEngine(policy, testToolAnnotations, ['/Users/me/.ironcurtain'], '/Users/me/sandbox');
    const result = engine.evaluate(request('read_file', { path: '/users/me/DOWNLOADS/proj/a.txt' }));
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-read-downloads');

    const annotation: ToolAnnotation = {
      toolName: 'read_file',
      serverName: 'filesystem',
      comment: 'reads',
      args: { path: ['read-path'] },
    };
    const prepared = prepareToolArgs({ path: '/users/me/DOWNLOADS/proj/a.txt' }, annotation, '/Users/me/sandbox');
    expect(prepared.argsForTransport.path).toBe('/Users/me/Downloads/proj/a.txt');
    expect(prepared.argsForPolicy.path).toBe('/Users/me/Downloads/proj/a.txt');
  });

  it('does not use the native realpath on Linux', () => {
    simulatePlatform('linux');
    const native = vi.spyOn(fs.realpathSync, 'native');
    resolveRealPath(tmpdir());
    resolveRealPath(join(tmpdir(), 'ic-does-not-exist', 'x'));
    expect(native).not.toHaveBeenCalled();
  });
});

describe('resolveRealPath fails closed', () => {
  function installUnresolvableFilesystem(): void {
    // Simulate macOS so the spied native realpath is the one in use; every
    // lookup fails, including the filesystem root.
    simulatePlatform('darwin');
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((p) => {
      throw Object.assign(new Error(`EIO: i/o error, realpath '${String(p)}'`), { code: 'EIO' });
    });
  }

  it('throws a PathResolutionError instead of returning the unresolved path', () => {
    installUnresolvableFilesystem();
    let thrown: unknown;
    try {
      resolveRealPath('/srv/project/.env');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PathResolutionError);
    expect(isPathResolutionError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: 'PATH_UNRESOLVABLE', name: 'PathResolutionError' });
  });

  it('recognises the error by its code, not by identity', () => {
    expect(isPathResolutionError(Object.assign(new Error('x'), { code: 'PATH_UNRESOLVABLE' }))).toBe(true);
    expect(isPathResolutionError(new Error('x'))).toBe(false);
    expect(isPathResolutionError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isPathResolutionError({ code: 'PATH_UNRESOLVABLE' })).toBe(false);
    expect(isPathResolutionError(undefined)).toBe(false);
  });

  it('makes the policy engine deny the call', () => {
    const engine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, ['/srv/project/.env'], '/srv/sandbox');
    installUnresolvableFilesystem();
    const result = engine.evaluate(request('read_file', { path: '/srv/sandbox/notes.md' }));
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-unresolvable-path');
  });

  it('makes the tool-call pipeline deny and audit the call without reaching the server', async () => {
    const tool: ProxiedTool = { serverName: 'filesystem', name: 'read_file', inputSchema: { type: 'object' } };
    const annotation: ToolAnnotation = {
      toolName: 'read_file',
      serverName: 'filesystem',
      comment: 'reads',
      args: { path: ['read-path'] },
    };
    const evaluate = vi.fn();
    const callTool = vi.fn();
    const log = vi.fn();
    const clientStates = new Map<string, ClientState>([
      ['filesystem', { client: { callTool } as unknown as ClientState['client'], roots: [] }],
    ]);
    const deps: CallToolDeps = {
      toolMap: new Map([['read_file', tool]]),
      policyEngine: {
        getAnnotation: vi.fn().mockReturnValue(annotation),
        getStoredAnnotation: vi.fn().mockReturnValue(annotation),
        evaluate,
        isTrustedServer: vi.fn().mockReturnValue(false),
      } as unknown as CallToolDeps['policyEngine'],
      auditLog: { log, assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
      circuitBreaker: {
        check: vi.fn().mockReturnValue({ allowed: true }),
      } as unknown as CallToolDeps['circuitBreaker'],
      clientStates,
      resolvedSandboxConfigs: new Map<string, ResolvedSandboxConfig>([
        ['filesystem', { sandboxed: false, reason: 'opt-out' }],
      ]),
      allowedDirectory: '/srv/sandbox',
      escalationDir: undefined,
      autoApproveModel: null,
      serverContextMap: new Map(),
      whitelist: createApprovalWhitelist(),
    };

    installUnresolvableFilesystem();
    const response = await handleCallTool('read_file', { path: '/srv/project/.env' }, deps);

    expect(response.isError).toBe(true);
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-unresolvable-path' });
    expect(JSON.stringify(response.content)).toContain('DENIED:');
    expect(evaluate).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      serverName: 'filesystem',
      toolName: 'read_file',
      policyDecision: { status: 'deny', rule: 'structural-unresolvable-path' },
      result: { status: 'denied' },
    });
  });
});

describe('resolveDanglingLink and resolveDanglingLinkTarget', () => {
  let root: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-dangling-link-')));
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'file'), 'x');
    symlinkSync(join(root, 'dir'), join(root, 'dir-link'));
    symlinkSync(join(root, 'dir', 'file'), join(root, 'file-link'));
    // Dangling: absolute, relative, through a missing directory, chained.
    symlinkSync(join(root, 'dir', 'gone.json'), join(root, 'abs'));
    symlinkSync('dir/gone.json', join(root, 'rel'));
    symlinkSync(join(root, 'dir', 'gone-dir'), join(root, 'dir-gone'));
    symlinkSync('rel', join(root, 'chain'));
    symlinkSync('../dir/./sub/../gone.json', join(root, 'dir', 'dotted'));
    // A link to an existing directory on the way to a dangling one.
    symlinkSync('dir-link/gone-again', join(root, 'via-link'));
    // Links whose target text could be mistaken for something else.
    symlinkSync('missing', join(root, 'named-missing'));
    symlinkSync(join(root, 'dir', 'gone-3'), join(root, 'missing'));
    // A loop and a chain of links longer than the kernel follows.
    symlinkSync('loop-b', join(root, 'loop-a'));
    symlinkSync('loop-a', join(root, 'loop-b'));
    for (let i = 0; i < 41; i++) symlinkSync(`hop-${i + 1}`, join(root, `hop-${i}`));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('adds nothing for a path that exists or that no link leads anywhere else', () => {
    expect(resolveDanglingLinkTarget(join(root, 'dir', 'file'))).toBeUndefined();
    expect(resolveDanglingLinkTarget(join(root, 'dir'))).toBeUndefined();
    expect(resolveDanglingLinkTarget(join(root, 'dir', 'missing', 'deeper'))).toBeUndefined();
    expect(resolveDanglingLinkTarget('/')).toBeUndefined();
    // A link that resolves leads where its realpath does, which is what the
    // callers pass in (and then nothing is added).
    expect(resolveDanglingLinkTarget(join(root, 'file-link'))).toBe(resolveRealPath(join(root, 'file-link')));
    expect(resolveDanglingLinkTarget(resolveRealPath(join(root, 'file-link')))).toBeUndefined();
    expect(resolveDanglingLinkTarget(resolveRealPath(join(root, 'dir-link', 'new.txt')))).toBeUndefined();
  });

  it('follows a dangling link, absolute or relative to its directory', () => {
    expect(resolveDanglingLinkTarget(join(root, 'abs'))).toBe(join(root, 'dir', 'gone.json'));
    expect(resolveDanglingLinkTarget(join(root, 'rel'))).toBe(join(root, 'dir', 'gone.json'));
    expect(resolveDanglingLinkTarget(join(root, 'dir', 'dotted'))).toBe(join(root, 'dir', 'gone.json'));
  });

  it('follows a dangling ancestor and keeps the components below it', () => {
    expect(resolveDanglingLinkTarget(join(root, 'dir-gone', 'credentials'))).toBe(
      join(root, 'dir', 'gone-dir', 'credentials'),
    );
    expect(resolveDanglingLinkTarget(join(root, 'dir-gone', 'a', 'b'))).toBe(join(root, 'dir', 'gone-dir', 'a', 'b'));
  });

  it('follows chains, including links to existing directories on the way', () => {
    expect(resolveDanglingLinkTarget(join(root, 'chain'))).toBe(join(root, 'dir', 'gone.json'));
    expect(resolveDanglingLinkTarget(join(root, 'via-link'))).toBe(join(root, 'dir', 'gone-again'));
    expect(resolveDanglingLinkTarget(join(root, 'named-missing'))).toBe(join(root, 'dir', 'gone-3'));
  });

  it('follows at most 40 links and stops at a loop without throwing', () => {
    // hop-0 -> hop-1 -> ... -> hop-41 (missing): 41 links, one more than a lookup follows.
    expect(resolveDanglingLinkTarget(join(root, 'hop-1'))).toBe(join(root, 'hop-41'));
    expect(resolveDanglingLinkTarget(join(root, 'hop-0'))).toBe(join(root, 'hop-40'));
    // loop-a -> loop-b -> loop-a ...: after 40 links the walk is back at
    // loop-a and keeps it as a name, so no other target is added (nothing
    // can be read through a loop either).
    expect(resolveDanglingLinkTarget(join(root, 'loop-a'))).toBeUndefined();
  });

  it('reports every other link followed on the way, each once', () => {
    expect(resolveDanglingLink(join(root, 'dir', 'file'))).toBeUndefined();
    expect(resolveDanglingLink(join(root, 'dir', 'missing', 'deeper'))).toBeUndefined();
    // The path itself is not repeated among the links.
    expect(resolveDanglingLink(join(root, 'abs'))).toEqual({ target: join(root, 'dir', 'gone.json'), links: [] });
    expect(resolveDanglingLink(join(root, 'chain'))).toEqual({
      target: join(root, 'dir', 'gone.json'),
      links: [join(root, 'rel')],
    });
    expect(resolveDanglingLink(join(root, 'via-link'))).toEqual({
      target: join(root, 'dir', 'gone-again'),
      links: [join(root, 'dir-link')],
    });
    expect(resolveDanglingLink(join(root, 'dir-gone', 'credentials'))).toEqual({
      target: join(root, 'dir', 'gone-dir', 'credentials'),
      links: [join(root, 'dir-gone')],
    });
    // A loop leads nowhere else, but its other link still decides where
    // loop-a leads once it is replaced.
    expect(resolveDanglingLink(join(root, 'loop-a'))).toEqual({ target: undefined, links: [join(root, 'loop-b')] });
  });
});
