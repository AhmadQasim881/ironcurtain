/**
 * Unit tests for protected-path matching (src/trusted-process/protected-paths.ts):
 * the deny-side fold, the per-entry sandbox exemption and protected entries
 * that are dangling symbolic links.
 *
 * Apart from the dangling-link group, which builds its links in a fresh temp
 * directory, every path here is a string under a non-existent directory below
 * the real temp dir, so resolveRealPath canonicalizes only the temp dir and
 * keeps the rest verbatim. The tests therefore run identically on
 * case-sensitive and case-insensitive filesystems.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { foldPathForComparison, isProtectedPath } from '../src/trusted-process/protected-paths.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { validateWorkspacePath } from '../src/session/workspace-validation.js';
import { computeProtectedPaths, getPackageGeneratedDir } from '../src/config/index.js';
import { getPackageConfigDir } from '../src/config/paths.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import {
  handleCallTool,
  type CallToolDeps,
  type ClientState,
  type ProxiedTool,
} from '../src/trusted-process/tool-call-pipeline.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import type { ResolvedSandboxConfig } from '../src/trusted-process/sandbox-integration.js';
import type { ToolAnnotation } from '../src/pipeline/types.js';
import { REAL_TMP, testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';

const BASE = `${REAL_TMP}/ironcurtain-protected-paths-test`;

describe('foldPathForComparison', () => {
  it('folds ASCII case', () => {
    expect(foldPathForComparison('/P/.ENV')).toBe(foldPathForComparison('/p/.env'));
    expect(foldPathForComparison('/P/MCP-Servers.JSON')).toBe('/p/mcp-servers.json');
  });

  it('merges NFC and NFD spellings', () => {
    expect(foldPathForComparison('/x/Cafe\u0301')).toBe(foldPathForComparison('/x/Caf\u00e9'));
    expect(foldPathForComparison('/x/CAFE\u0301')).toBe(foldPathForComparison('/x/caf\u00e9'));
  });

  it('applies full case folding beyond toLowerCase', () => {
    // sharp s, capital sharp s and "ss"
    expect(foldPathForComparison('/home/ru\u1e9e')).toBe('/home/russ');
    expect(foldPathForComparison('/home/ru\u00df')).toBe('/home/russ');
    // long s, Kelvin sign, Angstrom sign, ligature
    expect(foldPathForComparison('/x/.en\u017f')).toBe(foldPathForComparison('/x/.ens'));
    expect(foldPathForComparison('/x/\u212aey')).toBe('/x/key');
    expect(foldPathForComparison('/x/\u212b')).toBe(foldPathForComparison('/x/\u00e5'));
    expect(foldPathForComparison('/x/\ufb03x')).toBe('/x/ffix');
  });

  it('drops default-ignorable code points', () => {
    expect(foldPathForComparison('/x/.e\u200dnv')).toBe('/x/.env');
    expect(foldPathForComparison('/x/\ufeff.env')).toBe('/x/.env');
    expect(foldPathForComparison('/x/.e\u00adnv')).toBe('/x/.env');
  });

  it('never creates or removes a path separator', () => {
    for (const lookalike of ['\uff0f', '\u2215', '\u2044']) {
      const folded = foldPathForComparison(`/a${lookalike}b`);
      expect(folded.split('/')).toHaveLength(2);
    }
  });

  it('is idempotent', () => {
    for (const p of ['/A/Cafe\u0301/.ENV', '/home/ru\u1e9e', '/x/\u1fbc', '/x/a\u03a3']) {
      const once = foldPathForComparison(p);
      expect(foldPathForComparison(once)).toBe(once);
    }
  });
});

describe('isProtectedPath', () => {
  describe('matching', () => {
    const entry = `${BASE}/project/.env`;

    it('matches the entry itself and paths inside a protected directory', () => {
      expect(isProtectedPath(entry, [entry])).toBe(true);
      expect(isProtectedPath(`${BASE}/home/.ironcurtain/config.json`, [`${BASE}/home/.ironcurtain`])).toBe(true);
    });

    it('does not match a sibling that merely shares a prefix', () => {
      expect(isProtectedPath(`${BASE}/project/.env.example`, [entry])).toBe(false);
      expect(isProtectedPath(`${BASE}/home/.ironcurtain2/x`, [`${BASE}/home/.ironcurtain`])).toBe(false);
    });

    it('matches case variants of the leaf and of ancestors', () => {
      expect(isProtectedPath(`${BASE}/project/.ENV`, [entry])).toBe(true);
      expect(isProtectedPath(`${BASE}/project/.Env`, [entry])).toBe(true);
      expect(isProtectedPath(`${BASE}/PROJECT/.env`, [entry])).toBe(true);
      expect(isProtectedPath(`${BASE}/home/.IronCurtain/config.json`, [`${BASE}/home/.ironcurtain`])).toBe(true);
    });

    it('matches an NFD spelling of an NFC entry and the reverse', () => {
      expect(isProtectedPath(`${BASE}/Cafe\u0301/.env`, [`${BASE}/Caf\u00e9/.env`])).toBe(true);
      expect(isProtectedPath(`${BASE}/Caf\u00e9/.env`, [`${BASE}/Cafe\u0301/.env`])).toBe(true);
      expect(isProtectedPath(`${BASE}/CAFE\u0301/.ENV`, [`${BASE}/Caf\u00e9/.env`])).toBe(true);
    });
  });

  describe('per-entry sandbox exemption', () => {
    const home = `${BASE}/home/.ironcurtain`;
    const sandbox = `${home}/sessions/s1/sandbox`;

    it('exempts paths inside a sandbox that lies strictly inside the entry', () => {
      expect(isProtectedPath(`${sandbox}/notes.md`, [home], sandbox)).toBe(false);
      expect(isProtectedPath(sandbox, [home], sandbox)).toBe(false);
    });

    it('keeps the rest of the ancestor entry protected', () => {
      expect(isProtectedPath(`${home}/config.json`, [home], sandbox)).toBe(true);
      expect(isProtectedPath(`${home}/sessions/s1/audit.jsonl`, [home], sandbox)).toBe(true);
      expect(isProtectedPath(`${home}/sessions/s2/sandbox/x`, [home], sandbox)).toBe(true);
    });

    it('keeps an entry inside the sandbox protected', () => {
      const workspace = `${BASE}/workspace`;
      expect(isProtectedPath(`${workspace}/.env`, [`${workspace}/.env`], workspace)).toBe(true);
      expect(isProtectedPath(`${workspace}/gen/compiled-policy.json`, [`${workspace}/gen`], workspace)).toBe(true);
      expect(isProtectedPath(`${workspace}/src/app.ts`, [`${workspace}/.env`], workspace)).toBe(false);
    });

    it('keeps an entry equal to the sandbox protected', () => {
      const workspace = `${BASE}/workspace`;
      expect(isProtectedPath(`${workspace}/src/app.ts`, [workspace], workspace)).toBe(true);
    });

    it('evaluates the exemption per entry, so a nested entry wins over an exempted ancestor', () => {
      const nested = `${sandbox}/.env`;
      expect(isProtectedPath(nested, [home, nested], sandbox)).toBe(true);
      expect(isProtectedPath(`${sandbox}/other`, [home, nested], sandbox)).toBe(false);
    });

    it('compares the exemption exactly: a case variant of the sandbox is not exempt', () => {
      // On a case-sensitive volume .../SANDBOX is a different directory inside
      // the protected home; folding the carve-out would unprotect it.
      expect(isProtectedPath(`${home}/sessions/s1/SANDBOX/x`, [home], sandbox)).toBe(true);
    });

    it('does not exempt anything without a sandbox', () => {
      expect(isProtectedPath(`${sandbox}/notes.md`, [home])).toBe(true);
    });
  });
});

describe('protected-path deny through the tool-call pipeline', () => {
  // The approval whitelist only ever turns `escalate` into `allow`. A case
  // variant of a protected file used to evaluate to `escalate`, so a directory
  // whitelist approved earlier for the project silently allowed it.
  const project = `${BASE}/pipeline-project`;
  const writeAnnotation: ToolAnnotation = {
    toolName: 'write_file',
    serverName: 'filesystem',
    comment: 'writes',
    args: { path: ['write-path'], content: ['none'] },
  };

  it('denies a case variant of a protected .env even when a directory whitelist covers its folder', async () => {
    const whitelist = createApprovalWhitelist();
    whitelist.add({
      serverName: 'filesystem',
      toolName: 'write_file',
      constraints: [{ kind: 'directory', role: 'write-path', directory: project }],
      createdAt: new Date().toISOString(),
      sourceEscalationId: 'esc-1',
      originalReason: 'Writes outside sandbox require human approval.',
      description: 'write_file within the project',
    });
    // The whitelist itself would match the variant path...
    expect(
      whitelist.match('filesystem', 'write_file', { path: `${project}/.ENV` }, writeAnnotation, {
        escalatedRoles: ['write-path'],
      }).matched,
    ).toBe(true);

    const callTool = vi.fn();
    const log = vi.fn();
    const tool: ProxiedTool = { serverName: 'filesystem', name: 'write_file', inputSchema: { type: 'object' } };
    const deps: CallToolDeps = {
      toolMap: new Map([['write_file', tool]]),
      policyEngine: new PolicyEngine(
        testCompiledPolicy,
        testToolAnnotations,
        [`${project}/.env`],
        `${BASE}/pipeline-sandbox`,
      ),
      auditLog: { log, assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
      circuitBreaker: {
        check: vi.fn().mockReturnValue({ allowed: true }),
      } as unknown as CallToolDeps['circuitBreaker'],
      clientStates: new Map<string, ClientState>([
        ['filesystem', { client: { callTool } as unknown as ClientState['client'], roots: [] }],
      ]),
      resolvedSandboxConfigs: new Map<string, ResolvedSandboxConfig>([
        ['filesystem', { sandboxed: false, reason: 'opt-out' }],
      ]),
      allowedDirectory: `${BASE}/pipeline-sandbox`,
      escalationDir: undefined,
      autoApproveModel: null,
      serverContextMap: new Map(),
      whitelist,
    };

    // ...but the policy decision is now a structural deny, which it never sees.
    const response = await handleCallTool('write_file', { path: `${project}/.ENV`, content: 'NODE_OPTIONS=x' }, deps);
    expect(response.isError).toBe(true);
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-protected-path' });
    expect(callTool).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      policyDecision: { status: 'deny', rule: 'structural-protected-path' },
      result: { status: 'denied' },
    });
    expect(log.mock.calls[0][0].whitelistApproved).toBeUndefined();
  });
});

describe('protected entries that are dangling symbolic links', () => {
  // A protected name can be a symbolic link whose target is missing: a
  // dotfile-manager link such as ~/.npmrc, an mcp-servers.json kept
  // elsewhere, a link onto an unmounted volume. Matching only the link's own
  // name let the agent create the target inside its workspace, and the next
  // host run then read the planted file through the link.
  let root: string;
  let home: string;
  let workspace: string;
  const savedEnv = { HOME: process.env.HOME, IRONCURTAIN_HOME: process.env.IRONCURTAIN_HOME };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-dangling-protected-')));
    home = join(root, 'home');
    workspace = join(root, 'workspace');
    mkdirSync(join(home, '.ironcurtain'), { recursive: true });
    mkdirSync(workspace);
    // Both targets are missing, so both links dangle.
    symlinkSync(join(workspace, 'planted.json'), join(home, '.ironcurtain', 'mcp-servers.json'));
    symlinkSync(join(workspace, 'aws'), join(home, '.aws'));
    process.env.HOME = home;
    delete process.env.IRONCURTAIN_HOME;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** The protected-path list loadConfig() computes for this home, without loading user config. */
  function loadConfigProtectedPaths(): string[] {
    return computeProtectedPaths({
      constitutionPath: resolve(getPackageConfigDir(), 'constitution.md'),
      generatedDir: getPackageGeneratedDir(),
      packageGeneratedDir: getPackageGeneratedDir(),
      mcpServersPath: resolve(getPackageConfigDir(), 'mcp-servers.json'),
      auditLogPath: './audit.jsonl',
    });
  }

  function writeFile(path: string): ToolCallRequest {
    return {
      requestId: 'r',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path, content: '{}' },
      timestamp: new Date().toISOString(),
    };
  }

  it('retains an extra protected name and follows its current target after a link changes', () => {
    const name = join(home, 'protected-note');
    const first = join(workspace, 'first-note');
    const second = join(workspace, 'second-note');
    writeFileSync(first, 'ordinary fixture');
    writeFileSync(second, 'ordinary fixture');
    symlinkSync(first, name);
    const paths = computeProtectedPaths({
      constitutionPath: resolve(getPackageConfigDir(), 'constitution.md'),
      generatedDir: getPackageGeneratedDir(),
      packageGeneratedDir: getPackageGeneratedDir(),
      mcpServersPath: resolve(getPackageConfigDir(), 'mcp-servers.json'),
      auditLogPath: './audit.jsonl',
      credentialProtection: { extraPaths: [name] },
    });
    expect(paths).toContain(name);
    expect(paths).toContain(first);
    const engine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, paths, workspace);
    unlinkSync(name);
    symlinkSync(second, name);
    expect(engine.evaluate(writeFile(second))).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
  });

  it('checks controlling links even when the protected target already exists', () => {
    const elsewhere = join(root, 'ordinary');
    mkdirSync(elsewhere);
    const target = join(elsewhere, 'note');
    writeFileSync(target, 'ordinary fixture');
    const link = join(workspace, 'note-link');
    const name = join(home, 'protected-note');
    symlinkSync(target, link);
    symlinkSync(link, name);
    expect(() => validateWorkspacePath(workspace, [name])).toThrow('a symbolic link that protected path');
    const engine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, [name], workspace);
    // A lexical move destination replaces the controlling directory entry.
    expect(
      engine.evaluate({
        ...writeFile(link),
        toolName: 'move_file',
        arguments: { source: join(workspace, 'other'), destination: link },
      }),
    ).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
  });

  it('denies writes that would create the target of a dangling protected link', () => {
    const protectedPaths = loadConfigProtectedPaths();
    // The links themselves are the listed entries (they do not resolve).
    expect(protectedPaths).toContain(join(home, '.ironcurtain', 'mcp-servers.json'));
    expect(protectedPaths).toContain(join(home, '.aws'));

    const engine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, protectedPaths, workspace);
    for (const target of [
      join(workspace, 'planted.json'),
      join(workspace, 'aws'),
      join(workspace, 'aws', 'credentials'),
    ]) {
      expect(engine.evaluate(writeFile(target))).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
    }
    // The rest of the workspace stays writable.
    expect(engine.evaluate(writeFile(join(workspace, 'notes.md')))).toMatchObject({
      decision: 'allow',
      rule: 'structural-sandbox-allow',
    });
  });

  it('refuses a workspace that holds the target of a dangling protected link', () => {
    expect(() => validateWorkspacePath(workspace, loadConfigProtectedPaths())).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_UNSAFE' }),
    );
    // Each link on its own is enough.
    expect(() => validateWorkspacePath(workspace, [join(home, '.ironcurtain', 'mcp-servers.json')])).toThrow(
      `contains protected path: ${join(workspace, 'planted.json')}`,
    );
    expect(() => validateWorkspacePath(workspace, [join(home, '.aws')])).toThrow(
      `contains protected path: ${join(workspace, 'aws')}`,
    );
    // A sibling of the targets that holds neither is still a valid workspace.
    const project = join(root, 'project');
    mkdirSync(project);
    expect(validateWorkspacePath(project, loadConfigProtectedPaths())).toBe(project);
  });

  it('follows a dangling ancestor of a deeper entry', () => {
    // ~/.kube -> <workspace>/kube (missing): the entry ~/.kube/config leads to <workspace>/kube/config.
    symlinkSync(join(workspace, 'kube'), join(home, '.kube'));
    const entry = join(home, '.kube', 'config');
    expect(isProtectedPath(join(workspace, 'kube', 'config'), [entry], workspace)).toBe(true);
    expect(isProtectedPath(join(workspace, 'kube', 'other'), [entry], workspace)).toBe(false);
    expect(() => validateWorkspacePath(workspace, [entry])).toThrow(
      `contains protected path: ${join(workspace, 'kube', 'config')}`,
    );
  });

  it('resolves the link when the call is made, so a dangling link created later protects its target', () => {
    const entry = join(home, '.netrc');
    const engine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, [entry], workspace);
    const target = join(workspace, 'netrc');
    expect(engine.evaluate(writeFile(target)).decision).toBe('allow');

    symlinkSync(target, entry);
    expect(engine.evaluate(writeFile(target))).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
  });

  it('follows relative and chained dangling links', () => {
    // ~/.npmrc -> rc/npmrc (relative to ~), ~/rc -> ../workspace/rc (missing).
    symlinkSync('rc/npmrc', join(home, '.npmrc'));
    symlinkSync('../workspace/rc', join(home, 'rc'));
    const entry = join(home, '.npmrc');
    expect(isProtectedPath(join(workspace, 'rc', 'npmrc'), [entry], workspace)).toBe(true);
    expect(isProtectedPath(join(workspace, 'rc', 'other'), [entry], workspace)).toBe(false);
  });

  // The target can lie outside the workspace while the way to it does not: a
  // link inside the workspace that the agent replaces decides where the
  // protected name leads, as surely as a file it creates at the target.
  it('refuses a workspace that holds another link on the way to the target', () => {
    // ~/.npmrc -> <workspace>/rc/npmrc, where <workspace>/rc links to a
    // directory outside the workspace that has no npmrc.
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(workspace, 'rc'));
    symlinkSync(join(workspace, 'rc', 'npmrc'), join(home, '.npmrc'));
    // ~/.netrc -> <workspace>/netrc, itself a link to a missing file outside.
    symlinkSync(join(root, 'missing', 'netrc'), join(workspace, 'netrc'));
    symlinkSync(join(workspace, 'netrc'), join(home, '.netrc'));

    const npmrc = join(home, '.npmrc');
    const netrc = join(home, '.netrc');
    expect(() => validateWorkspacePath(workspace, [npmrc])).toThrow(
      `contains ${join(workspace, 'rc')}, a symbolic link that protected path ${npmrc} leads through`,
    );
    expect(() => validateWorkspacePath(workspace, [netrc])).toThrow(
      `contains ${join(workspace, 'netrc')}, a symbolic link that protected path ${netrc} leads through`,
    );
    // A directory such a link leads into is refused only when it holds the
    // target, not merely for lying below a link's destination.
    const below = join(elsewhere, 'project');
    mkdirSync(below);
    expect(validateWorkspacePath(below, [npmrc, netrc])).toBe(below);
    expect(() => validateWorkspacePath(elsewhere, [npmrc])).toThrow(
      `contains protected path: ${join(elsewhere, 'npmrc')}`,
    );
  });

  it('denies replacing a dangling link that a protected entry leads through', () => {
    // ~/.netrc -> <workspace>/netrc -> <root>/missing/netrc. Writing or moving
    // a file onto <workspace>/netrc would replace that link, and ~/.netrc
    // would then read the file.
    const link = join(workspace, 'netrc');
    symlinkSync(join(root, 'missing', 'netrc'), link);
    symlinkSync(link, join(home, '.netrc'));
    const engine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, [join(home, '.netrc')], workspace);

    const denied = { decision: 'deny', rule: 'structural-protected-path' };
    expect(engine.evaluate(writeFile(link))).toMatchObject(denied);
    expect(engine.evaluate(writeFile(join(root, 'missing', 'netrc')))).toMatchObject(denied);
    expect(
      engine.evaluate({
        requestId: 'r',
        serverName: 'filesystem',
        toolName: 'move_file',
        arguments: { source: join(workspace, 'notes.md'), destination: link },
        timestamp: new Date().toISOString(),
      }),
    ).toMatchObject(denied);
    expect(engine.evaluate(writeFile(join(workspace, 'notes.md')))).toMatchObject({ decision: 'allow' });
  });
});
