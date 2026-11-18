/**
 * The shipped git policy against the argument shapes of the locked
 * @cyanheads/git-mcp-server 2.15.3 (see git-live-schema-annotations.integration
 * .test.ts for the check that the shipped annotations match that server).
 *
 * 2.15 renamed git_clone's destination from `localPath` to `path` and
 * git_branch's discriminator from `operation` to `mode`. With the old
 * annotations the destination was unclassified: it reached the server with no
 * protected-path, containment or whitelist check. These tests drive the real
 * PolicyEngine with the shipped compiled policy, annotations and domain
 * allowlists through `handleCallTool`, with a fake MCP client in place of the
 * server, and pin:
 *
 *  - git_clone's `path` is a write-path: protected destinations are denied,
 *    out-of-sandbox ones escalate on write-path, and the reviewer, the
 *    whitelist candidate and the server all see the canonical destination;
 *  - an argument the stored annotation does not classify is denied
 *    ('unannotated-arguments') whatever the live schema accepts;
 *  - relative paths reach the server as the absolute path policy evaluated,
 *    and git's '.' means the tracked session working directory;
 *  - git_set_working_dir alone sets the tracked directory, and
 *    git_clear_working_dir clears it;
 *  - conditional roles key on the live discriminators.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi, type Mock } from 'vitest';

import { extractServerDomainAllowlists } from '../src/config/index.js';
import type { MCPServerConfig } from '../src/config/types.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
  ToolAnnotation,
} from '../src/pipeline/types.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import { requiresPerCallApproval } from '../src/trusted-process/git-structural-rules.js';
import { prepareToolArgs } from '../src/trusted-process/path-utils.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ResolvedSandboxConfig } from '../src/trusted-process/sandbox-integration.js';
import {
  findUnannotatedArguments,
  handleCallTool,
  usesGitSessionWorkingDir,
  type CallToolDeps,
  type ClientState,
  type InProcessEscalationFn,
  type ProxiedTool,
} from '../src/trusted-process/tool-call-pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = resolve(__dirname, '../src/config');
const generatedDir = resolve(configDir, 'generated');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const compiledPolicy = readJson(resolve(generatedDir, 'compiled-policy.json')) as CompiledPolicyFile;
const toolAnnotations = readJson(resolve(generatedDir, 'tool-annotations.json')) as StoredToolAnnotationsFile;
const dynamicLists = readJson(resolve(generatedDir, 'dynamic-lists.json')) as DynamicListsFile;
const mcpServers = readJson(resolve(configDir, 'mcp-servers.json')) as Record<string, MCPServerConfig>;
const gitTools: readonly StoredToolAnnotation[] = toolAnnotations.servers.git.tools;

// Layout mirroring a session: the sandbox lives inside a (temporary)
// IronCurtain home, which is protected; the user's real ~/.ironcurtain is
// protected too. Nothing is ever created under the real home.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-git-live-shape-')));
const icHome = join(root, 'ironcurtain-home');
const sandbox = join(icHome, 'sessions', 's1', 'sandbox');
const outside = join(root, 'outside');
const outsideRepo = join(outside, 'repo');
mkdirSync(sandbox, { recursive: true });
mkdirSync(outsideRepo, { recursive: true });
mkdirSync(join(sandbox, 'repo'), { recursive: true });

const protectedPaths = [resolve(homedir(), '.ironcurtain'), icHome];
const domainAllowlists = extractServerDomainAllowlists(mcpServers);
const engine = new PolicyEngine(
  compiledPolicy,
  toolAnnotations,
  protectedPaths,
  sandbox,
  domainAllowlists,
  dynamicLists,
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function gitTool(name: string): StoredToolAnnotation {
  const tool = gitTools.find((t) => t.toolName === name);
  if (!tool) throw new Error(`no shipped annotation for ${name}`);
  return tool;
}

interface Harness {
  readonly deps: CallToolDeps;
  readonly callTool: Mock;
  readonly log: Mock;
  readonly onEscalation: Mock<InProcessEscalationFn>;
}

/**
 * Pipeline dependencies with the real engine and the shipped (live 2.15.3)
 * tool schemas; the MCP client is a fake that records what the server would
 * receive. Escalations are approved.
 */
function harness(options: { schemas?: Record<string, Record<string, unknown>> } = {}): Harness {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  const log = vi.fn();
  const state: ClientState = { client: undefined as unknown as ClientState['client'], roots: [] };
  state.client = {
    callTool,
    sendRootsListChanged: vi.fn(() => {
      state.rootsRefreshed?.();
      return Promise.resolve();
    }),
  } as unknown as ClientState['client'];
  const onEscalation = vi.fn<InProcessEscalationFn>(() => Promise.resolve({ decision: 'approved' }));
  const toolMap = new Map<string, ProxiedTool>(
    gitTools.map((t) => [
      t.toolName,
      { serverName: 'git', name: t.toolName, inputSchema: options.schemas?.[t.toolName] ?? t.inputSchema },
    ]),
  );
  const deps: CallToolDeps = {
    toolMap,
    policyEngine: engine,
    auditLog: { log, assertWritable: vi.fn() } as unknown as CallToolDeps['auditLog'],
    circuitBreaker: { check: vi.fn().mockReturnValue({ allowed: true }) } as unknown as CallToolDeps['circuitBreaker'],
    clientStates: new Map<string, ClientState>([['git', state]]),
    resolvedSandboxConfigs: new Map<string, ResolvedSandboxConfig>([['git', { sandboxed: false, reason: 'opt-out' }]]),
    allowedDirectory: sandbox,
    escalationDir: undefined,
    autoApproveModel: null,
    serverContextMap: new Map(),
    whitelist: createApprovalWhitelist(),
    onEscalation,
  };
  return { deps, callTool, log, onEscalation };
}

/** Arguments the fake server received in its n-th call. */
function sentArgs(callTool: Mock, n = 0): Record<string, unknown> {
  const call = callTool.mock.calls[n] as [{ name: string; arguments: Record<string, unknown> }] | undefined;
  if (!call) throw new Error(`server call ${n} not made`);
  return call[0].arguments;
}

/** Policy-evaluates a git call the way handleCallTool does (normalized args). */
function evaluateGit(toolName: string, args: Record<string, unknown>) {
  const annotation = engine.getAnnotation('git', toolName, args);
  if (!annotation) throw new Error(`no annotation for ${toolName}`);
  const { argsForPolicy } = prepareToolArgs(args, annotation, sandbox);
  return engine.evaluate({ requestId: 't', serverName: 'git', toolName, arguments: argsForPolicy, timestamp: '' });
}

const GITHUB_URL = 'https://github.com/someone/repo.git';

describe('git wrap-up repository snapshot approval', () => {
  const args = { acknowledgement: 'yes', createTag: false };
  const request = {
    requestId: 'wrapup',
    serverName: 'git',
    toolName: 'git_wrapup_instructions',
    arguments: args,
    timestamp: '',
  };

  it('requires a human on every call even with a compiled allow', () => {
    const permissive = new PolicyEngine(
      {
        ...compiledPolicy,
        rules: [
          {
            name: 'allow-wrapup',
            description: 'fixture',
            principle: 'fixture',
            if: { server: ['git'] },
            then: 'allow',
            reason: 'fixture',
          },
        ],
      },
      toolAnnotations,
      [],
      sandbox,
    );
    const result = permissive.evaluate(request, { gitWorkingDirectory: outsideRepo });
    expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-git-repository-escalate', humanOnly: true });
    expect(requiresPerCallApproval(result)).toBe(true);
  });

  it('preserves a compiled denial', () => {
    const denied = new PolicyEngine(
      {
        ...compiledPolicy,
        rules: [
          {
            name: 'deny-wrapup',
            description: 'fixture',
            principle: 'fixture',
            if: { server: ['git'] },
            then: 'deny',
            reason: 'fixture',
          },
        ],
      },
      toolAnnotations,
      [],
      sandbox,
    );
    expect(denied.evaluate(request, { gitWorkingDirectory: outsideRepo })).toMatchObject({
      decision: 'deny',
      rule: 'deny-wrapup',
    });
  });

  it('asks again and keeps evaluation-only context out of backend arguments', async () => {
    const { deps, callTool, onEscalation } = harness();
    deps.serverContextMap.set('git', { workingDirectory: outsideRepo });
    await handleCallTool('git_wrapup_instructions', args, deps);
    await handleCallTool('git_wrapup_instructions', args, deps);
    expect(onEscalation).toHaveBeenCalledTimes(2);
    expect(sentArgs(callTool, 0)).toEqual(args);
    expect(sentArgs(callTool, 1)).toEqual(args);
  });

  it('audits missing implicit context before approval or dispatch', async () => {
    const { deps, callTool, onEscalation, log } = harness();
    const response = await handleCallTool('git_wrapup_instructions', args, deps);
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-git-context-deny' });
    expect(callTool).not.toHaveBeenCalled();
    expect(onEscalation).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ policyDecision: expect.objectContaining({ rule: 'structural-git-context-deny' }) }),
    );
  });

  it('audits a protected descendant refusal using only trusted stored context', async () => {
    const { deps, callTool, onEscalation, log } = harness();
    deps.policyEngine = new PolicyEngine(
      compiledPolicy,
      toolAnnotations,
      [...protectedPaths, join(outsideRepo, 'protected-note')],
      sandbox,
      domainAllowlists,
      dynamicLists,
    );
    deps.serverContextMap.set('git', { workingDirectory: outsideRepo });
    const response = await handleCallTool('git_wrapup_instructions', args, deps);
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-git-protected-repository' });
    expect(callTool).not.toHaveBeenCalled();
    expect(onEscalation).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        policyDecision: expect.objectContaining({ rule: 'structural-git-protected-repository' }),
      }),
    );
  });

  it('keeps Git selectors unchanged when an ordinary repository is admitted', async () => {
    const { deps, callTool } = harness();
    const addArgs = { path: join(sandbox, 'repo'), paths: ['ordinary-note'] };
    await handleCallTool('git_add', addArgs, deps);
    expect(sentArgs(callTool, 0)).toEqual(addArgs);
  });
});

it('audits a resource budget refusal before normalization, escalation or dispatch', async () => {
  const { deps, callTool, onEscalation, log } = harness();
  const budgetEngine = new PolicyEngine(
    compiledPolicy,
    toolAnnotations,
    [],
    sandbox,
    domainAllowlists,
    dynamicLists,
    undefined,
    undefined,
    {
      argumentValueLimits: { maxValuesPerArgument: 2 },
    },
  );
  const fixtureDeps: CallToolDeps = {
    ...deps,
    policyEngine: budgetEngine,
    toolMap: new Map([
      ['read_multiple_files', { serverName: 'filesystem', name: 'read_multiple_files', inputSchema: {} }],
    ]),
  };
  const response = await handleCallTool('read_multiple_files', { paths: ['/one', '/two', '/three'] }, fixtureDeps);
  expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-argument-budget-deny' });
  expect(callTool).not.toHaveBeenCalled();
  expect(onEscalation).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ policyDecision: expect.objectContaining({ rule: 'structural-argument-budget-deny' }) }),
  );
});

// ---------------------------------------------------------------------------
// git_clone: the destination is `path`
// ---------------------------------------------------------------------------

describe('git_clone with the live destination argument `path`', () => {
  it('classifies url and path, and nothing under the pre-2.15 name localPath', () => {
    expect(gitTool('git_clone').args).toMatchObject({ url: ['git-remote-url'], path: ['write-path'] });
    expect(gitTool('git_clone').args).not.toHaveProperty('localPath');
  });

  it('denies a clone into ~/.ironcurtain as a protected path, before any escalation', async () => {
    const { deps, callTool, onEscalation, log } = harness();
    const response = await handleCallTool(
      'git_clone',
      { url: 'https://github.com/attacker/payload', path: '~/.ironcurtain/skills/evil' },
      deps,
    );
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-protected-path' });
    expect(onEscalation).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toMatchObject({ policyDecision: { rule: 'structural-protected-path' } });
  });

  it('denies a clone into the IronCurtain home outside the sandbox (policy takeover via generated/)', async () => {
    const { deps, callTool } = harness();
    const response = await handleCallTool('git_clone', { url: GITHUB_URL, path: join(icHome, 'generated') }, deps);
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'structural-protected-path' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('escalates a clone outside the sandbox with write-path among the escalated roles', () => {
    const result = evaluateGit('git_clone', { url: GITHUB_URL, path: join(outside, 'clone') });
    expect(result).toMatchObject({ decision: 'escalate', rule: 'escalate-git-clone' });
    expect(result.escalatedRoles).toEqual(expect.arrayContaining(['write-path', 'git-remote-url']));
  });

  it('escalates a clone into the sandbox on the URL alone (write-path is sandbox-resolved)', () => {
    const result = evaluateGit('git_clone', { url: GITHUB_URL, path: join(sandbox, 'clone') });
    expect(result).toMatchObject({ decision: 'escalate', rule: 'escalate-git-clone' });
    expect(result.escalatedRoles).toEqual(['git-remote-url']);
  });

  it('shows the reviewer the destination and scopes the whitelist candidates to it, then to its directory', async () => {
    const { deps, callTool, onEscalation } = harness();
    const destination = join(outside, 'clone');
    await handleCallTool('git_clone', { url: GITHUB_URL, path: destination }, deps);

    expect(onEscalation).toHaveBeenCalledTimes(1);
    const [request, , , candidates] = onEscalation.mock.calls[0];
    expect(request.arguments.path).toBe(destination);
    expect(candidates?.[0]?.description).toContain(`write-path ${destination}`);
    expect(candidates?.[1]?.description).toContain(`write-path within ${outside} (recursive)`);
    expect(sentArgs(callTool).path).toBe(destination);
  });

  it('clones a relative destination into the sandbox, not into the server process cwd', async () => {
    const { deps, callTool, onEscalation } = harness();
    await handleCallTool('git_clone', { url: GITHUB_URL, path: 'rel-clone' }, deps);

    const [request] = onEscalation.mock.calls[0];
    expect(request.arguments.path).toBe(join(sandbox, 'rel-clone'));
    expect(sentArgs(callTool)).toEqual({ url: GITHUB_URL, path: join(sandbox, 'rel-clone') });
  });
});

// ---------------------------------------------------------------------------
// Arguments the annotation does not classify
// ---------------------------------------------------------------------------

/** git_clone's schema before 2.15 (destination `localPath`), as shipped in the old annotations. */
const LEGACY_CLONE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    localPath: { type: 'string', minLength: 1 },
    branch: { type: 'string' },
    depth: { type: 'integer' },
    bare: { type: 'boolean' },
    mirror: { type: 'boolean' },
  },
  required: ['url', 'localPath'],
};

describe('arguments the stored annotation does not classify', () => {
  it('denies a localPath key as unannotated when the live schema still declares it', async () => {
    // A server whose schema drifted the other way (an older or newer release
    // than the annotations describe): the live-schema check passes, so only
    // the annotation guard stands between the value and the server.
    const { deps, callTool, onEscalation, log } = harness({ schemas: { git_clone: LEGACY_CLONE_SCHEMA } });
    const response = await handleCallTool(
      'git_clone',
      { url: 'https://github.com/attacker/payload', localPath: '~/.config/autostart' },
      deps,
    );

    expect(response.isError).toBe(true);
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'unannotated-arguments' });
    const text = (response.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('Unannotated argument(s): "localPath"');
    expect(text).toContain("'ironcurtain annotate-tools --server git'");
    expect(onEscalation).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      serverName: 'git',
      toolName: 'git_clone',
      policyDecision: { status: 'deny', rule: 'unannotated-arguments' },
      result: { status: 'denied' },
    });
  });

  it('denies unannotated keys when the live schema opts out of key validation', async () => {
    for (const schema of [
      { type: 'object' },
      { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: true },
      { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: {} },
    ]) {
      const { deps, callTool } = harness({ schemas: { git_status: schema } });
      const response = await handleCallTool('git_status', { path: join(sandbox, 'repo'), gitDir: '/etc' }, deps);
      expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'unannotated-arguments' });
      expect(callTool).not.toHaveBeenCalled();
    }
  });

  it('names unannotated keys terminal-safe and bounded in the denial reason', async () => {
    const { deps, log } = harness({ schemas: { git_status: { type: 'object' } } });
    const args: Record<string, unknown> = { path: join(sandbox, 'repo'), '\u001b]52;c;x\u0007': 1, '\u202eevil': 2 };
    for (let i = 0; i < 12; i++) args[`k${i}`] = i;

    const response = await handleCallTool('git_status', args, deps);

    const text = (response.content as Array<{ text: string }>)[0].text;
    for (const raw of ['\u001b', '\u0007', '\u202e']) expect(text.includes(raw)).toBe(false);
    expect(text).toContain('"\\u001b]52;c;x\\u0007"');
    expect(text).toContain('\\u202eevil');
    expect(text).toContain('(and 4 more)');
    // The audit entry keeps the complete arguments.
    expect(Object.keys(log.mock.calls[0][0].arguments as Record<string, unknown>)).toHaveLength(15);
  });

  it('reports localPath against the strict live 2.15.3 schema as an unknown argument, naming path', async () => {
    const { deps, callTool } = harness();
    const response = await handleCallTool('git_clone', { url: GITHUB_URL, localPath: join(outside, 'x') }, deps);
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'invalid-arguments' });
    expect((response.content as Array<{ text: string }>)[0].text).toContain('"path"');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('lets fully annotated calls through to policy', async () => {
    const { deps, callTool } = harness();
    const response = await handleCallTool('git_status', { path: join(sandbox, 'repo'), includeUntracked: true }, deps);
    expect(response._policyDecision).toMatchObject({ status: 'allow' });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('findUnannotatedArguments checks own keys and fails closed without an annotation', () => {
    const stored = gitTool('git_status');
    expect(findUnannotatedArguments({ path: '/x', includeUntracked: true }, stored)).toEqual([]);
    // Inherited Object.prototype names are not annotations.
    expect(findUnannotatedArguments({ path: '/x', constructor: 'x', toString: 'y' }, stored)).toEqual([
      'constructor',
      'toString',
    ]);
    expect(findUnannotatedArguments(JSON.parse('{"__proto__": "/etc"}') as Record<string, unknown>, stored)).toEqual([
      '__proto__',
    ]);
    expect(findUnannotatedArguments({ path: '/x' }, undefined)).toEqual(['path']);
    expect(findUnannotatedArguments({}, undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Relative paths and git's '.'
// ---------------------------------------------------------------------------

describe("relative repository paths and git's '.'", () => {
  it('sends a relative path to the server as the absolute path policy evaluated', async () => {
    const { deps, callTool } = harness();
    const response = await handleCallTool('git_status', { path: 'sub' }, deps);
    expect(response._policyDecision).toMatchObject({ status: 'allow', rule: 'structural-sandbox-allow' });
    expect(sentArgs(callTool).path).toBe(join(sandbox, 'sub'));

    await handleCallTool('git_clean', { path: './', force: true }, deps);
    expect(sentArgs(callTool, 1).path).toBe(sandbox);
  });

  it('evaluates a relative path that climbs out of the sandbox as the outside path', async () => {
    const { deps, callTool } = harness();
    const response = await handleCallTool('git_clean', { path: '../../../../outside/repo', force: true }, deps);
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'default-deny' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("evaluates '.' against an out-of-sandbox tracked working directory", async () => {
    const { deps, callTool, log } = harness();
    deps.serverContextMap.set('git', { workingDirectory: outsideRepo });

    const response = await handleCallTool('git_clean', { path: '.', force: true }, deps);

    // Previously '.' was resolved against the sandbox for policy
    // (structural-sandbox-allow) while git cleaned the tracked directory.
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'default-deny' });
    expect(callTool).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0].arguments.path).toBe(outsideRepo);

    const reset = await handleCallTool('git_reset', { path: '.', mode: 'hard' }, deps);
    expect(reset._policyDecision).toMatchObject({ status: 'deny', rule: 'default-deny' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("sends '.' to the server as the tracked directory when policy allows it", async () => {
    const { deps, callTool } = harness();
    deps.serverContextMap.set('git', { workingDirectory: join(sandbox, 'repo') });

    const response = await handleCallTool('git_status', { path: '.' }, deps);
    expect(response._policyDecision).toMatchObject({ status: 'allow' });
    expect(sentArgs(callTool).path).toBe(join(sandbox, 'repo'));
  });

  it("denies '.' when no working directory is tracked", async () => {
    const { deps, callTool, log } = harness();
    const response = await handleCallTool('git_status', { path: '.' }, deps);
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'git-path-enrichment-failed' });
    expect(callTool).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('usesGitSessionWorkingDir recognizes only absent, blank and exact-dot paths', () => {
    expect(usesGitSessionWorkingDir({})).toBe(true);
    expect(usesGitSessionWorkingDir({ path: '' })).toBe(true);
    expect(usesGitSessionWorkingDir({ path: '  ' })).toBe(true);
    expect(usesGitSessionWorkingDir({ path: '.' })).toBe(true);
    expect(usesGitSessionWorkingDir({ path: 42 })).toBe(true);
    expect(usesGitSessionWorkingDir({ path: './' })).toBe(false);
    expect(usesGitSessionWorkingDir({ path: 'sub' })).toBe(false);
    expect(usesGitSessionWorkingDir({ path: '/repo' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tracked session working directory
// ---------------------------------------------------------------------------

describe('tracked git session working directory', () => {
  it('follows git_set_working_dir (canonical path), not git_clone, and is cleared by git_clear_working_dir', async () => {
    const { deps, callTool } = harness();

    await handleCallTool('git_set_working_dir', { path: 'repo' }, deps);
    expect(sentArgs(callTool, 0).path).toBe(join(sandbox, 'repo'));
    expect(deps.serverContextMap.get('git')?.workingDirectory).toBe(join(sandbox, 'repo'));

    await handleCallTool('git_status', {}, deps);
    expect(sentArgs(callTool, 1).path).toBe(join(sandbox, 'repo'));

    // A clone (approved) does not change the server's session directory.
    await handleCallTool('git_clone', { url: GITHUB_URL, path: join(sandbox, 'clone') }, deps);
    expect(sentArgs(callTool, 2).path).toBe(join(sandbox, 'clone'));
    expect(deps.serverContextMap.get('git')?.workingDirectory).toBe(join(sandbox, 'repo'));

    const cleared = await handleCallTool('git_clear_working_dir', { confirm: 'Y' }, deps);
    expect(cleared._policyDecision).toMatchObject({ status: 'allow', rule: 'allow-git-clear-working-dir' });
    expect(deps.serverContextMap.get('git')?.workingDirectory).toBeUndefined();

    const after = await handleCallTool('git_status', { path: '.' }, deps);
    expect(after._policyDecision).toMatchObject({ status: 'deny', rule: 'git-path-enrichment-failed' });
    expect(callTool).toHaveBeenCalledTimes(4);
  });

  it('keeps the tracked directory when git_clear_working_dir fails on the server', async () => {
    const { deps, callTool } = harness();
    deps.serverContextMap.set('git', { workingDirectory: join(sandbox, 'repo') });
    callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'failed' }], isError: true });

    await handleCallTool('git_clear_working_dir', { confirm: 'Y' }, deps);
    expect(deps.serverContextMap.get('git')?.workingDirectory).toBe(join(sandbox, 'repo'));
  });
});

// ---------------------------------------------------------------------------
// Conditional roles keyed on the live discriminators
// ---------------------------------------------------------------------------

describe('conditional roles keyed on live arguments', () => {
  const pathRoles = (toolName: string, args: Record<string, unknown>): string[] =>
    (engine.getAnnotation('git', toolName, args) as ToolAnnotation).args.path;

  it('resolves git_branch mode=list to read-path only', () => {
    expect(pathRoles('git_branch', { mode: 'list' })).toEqual(['read-path']);
    expect(pathRoles('git_branch', { mode: 'show-current' })).toEqual(['read-path']);
    expect(pathRoles('git_branch', { mode: 'create', branchName: 'f' })).toEqual(['read-path', 'write-history']);
    expect(pathRoles('git_branch', { mode: 'rename', branchName: 'f', newBranchName: 'g' })).toEqual([
      'read-path',
      'write-history',
    ]);
    expect(pathRoles('git_branch', { mode: 'delete', branchName: 'f' })).toEqual(['read-path', 'delete-history']);
    // Unrecognized or absent discriminator: the most restrictive default.
    expect(pathRoles('git_branch', {})).toEqual(['read-path', 'write-history', 'delete-history']);
    expect(pathRoles('git_branch', { operation: 'list' })).toEqual(['read-path', 'write-history', 'delete-history']);

    const args = gitTool('git_branch').args;
    expect(args.branchName).toEqual(['branch-name']);
    expect(args.newBranchName).toEqual(['branch-name']);
  });

  it('treats git_tag mode=verify as read-only', () => {
    expect(pathRoles('git_tag', { mode: 'verify', tagName: 'v1' })).toEqual(['read-path']);
    expect(pathRoles('git_tag', { mode: 'list' })).toEqual(['read-path']);
    expect(pathRoles('git_tag', { mode: 'create', tagName: 'v1' })).toEqual(['read-path', 'write-history']);
    expect(pathRoles('git_tag', { mode: 'delete', tagName: 'v1' })).toEqual(['read-path', 'delete-history']);
  });

  it('gives git_remote url the git-remote-url role only when it sets a remote URL', () => {
    const urlRoles = (args: Record<string, unknown>): string[] =>
      (engine.getAnnotation('git', 'git_remote', args) as ToolAnnotation).args.url;
    expect(urlRoles({ mode: 'add', name: 'up', url: GITHUB_URL })).toEqual(['git-remote-url']);
    expect(urlRoles({ mode: 'set-url', name: 'origin', url: GITHUB_URL })).toEqual(['git-remote-url']);
    expect(urlRoles({ mode: 'list' })).toEqual(['none']);
    expect(urlRoles({ mode: 'get-url', name: 'origin' })).toEqual(['none']);
    expect(urlRoles({})).toEqual(['none']);
  });

  it('applies the shipped policy to git_remote: URL changes escalate, listing stays allowed', () => {
    const repo = join(sandbox, 'repo');
    expect(evaluateGit('git_remote', { path: repo, mode: 'add', name: 'up', url: GITHUB_URL })).toMatchObject({
      decision: 'escalate',
      rule: 'escalate-git-remote-url',
      escalatedRoles: ['git-remote-url'],
    });
    expect(evaluateGit('git_remote', { path: repo, mode: 'set-url', name: 'origin', url: GITHUB_URL })).toMatchObject({
      decision: 'escalate',
      rule: 'escalate-git-remote-url',
    });
    expect(
      evaluateGit('git_remote', { path: repo, mode: 'add', name: 'x', url: 'https://evil.example/r.git' }),
    ).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
    expect(evaluateGit('git_remote', { path: repo })).toMatchObject({ decision: 'allow' });
    expect(evaluateGit('git_remote', { path: repo, mode: 'list' })).toMatchObject({ decision: 'allow' });
    expect(evaluateGit('git_remote', { path: repo, mode: 'remove', name: 'up' })).toMatchObject({ decision: 'allow' });
  });

  it('lets a role-scoped policy allow read-only branch listing outside the sandbox', () => {
    const readOnlyBranches: CompiledPolicyFile = {
      generatedAt: 'test',
      constitutionHash: 'test',
      inputHash: 'test',
      rules: [
        {
          name: 'allow-git-branch-read',
          description: 'Allow read-only git_branch in the outside repo',
          principle: 'test',
          if: { server: ['git'], tool: ['git_branch'], paths: { roles: ['read-path'], within: outside } },
          then: 'allow',
          reason: 'read-only',
        },
      ],
    };
    const scoped = new PolicyEngine(readOnlyBranches, toolAnnotations, [], sandbox);
    const evaluate = (args: Record<string, unknown>) =>
      scoped.evaluate({ requestId: 't', serverName: 'git', toolName: 'git_branch', arguments: args, timestamp: '' });

    expect(evaluate({ path: outsideRepo, mode: 'list' })).toMatchObject({ decision: 'allow' });
    expect(evaluate({ path: outsideRepo, mode: 'show-current' })).toMatchObject({ decision: 'allow' });
    expect(evaluate({ path: outsideRepo, mode: 'create', branchName: 'x' })).toMatchObject({ decision: 'deny' });
    expect(evaluate({ path: outsideRepo, mode: 'delete', branchName: 'x' })).toMatchObject({ decision: 'deny' });
  });
});

// ---------------------------------------------------------------------------
// The untrusted domain gate never overrides a deny of any role of the call
// ---------------------------------------------------------------------------

describe('untrusted domain gate and the other roles of the call', () => {
  const EVIL_URL = 'https://evil.example/x.git';
  const allowed = join(root, 'allowed');
  mkdirSync(join(allowed, 'repo'), { recursive: true });

  const allowPullInAllowed: CompiledPolicyFile['rules'][number] = {
    name: 'allow-git-pull-in-allowed',
    description: 'Allow git_pull into repositories under the allowed directory',
    principle: 'test',
    if: {
      server: ['git'],
      tool: ['git_pull'],
      paths: { roles: ['read-path', 'write-history'], within: allowed },
    },
    then: 'allow',
    reason: 'test',
  };

  /** git_pull evaluated by an engine with the shipped annotations and allowlists and only `rules`. */
  function pullEngine(rules: CompiledPolicyFile['rules']) {
    const policy: CompiledPolicyFile = { generatedAt: 'test', constitutionHash: 'test', inputHash: 'test', rules };
    const scoped = new PolicyEngine(policy, toolAnnotations, [], sandbox, domainAllowlists);
    return (args: Record<string, unknown>) =>
      scoped.evaluate({ requestId: 't', serverName: 'git', toolName: 'git_pull', arguments: args, timestamp: '' });
  }

  it('keeps git_remote add/set-url on a repository outside every permitted directory denied', async () => {
    // Before git_remote's url was classified, these were default-denied. With
    // the url a git-remote-url, an untrusted domain must not turn them into a
    // human-approvable (and whitelistable) escalation.
    for (const args of [
      { path: outsideRepo, mode: 'add', name: 'x', url: EVIL_URL },
      { path: outsideRepo, mode: 'set-url', name: 'origin', url: EVIL_URL },
      { path: outsideRepo, mode: 'add', name: 'x', url: GITHUB_URL },
    ]) {
      expect(evaluateGit('git_remote', args)).toMatchObject({ decision: 'deny', rule: 'default-deny' });
    }

    const { deps, callTool, onEscalation } = harness();
    const response = await handleCallTool(
      'git_remote',
      { path: outsideRepo, mode: 'set-url', name: 'origin', url: EVIL_URL },
      deps,
    );
    expect(response._policyDecision).toMatchObject({ status: 'deny', rule: 'default-deny' });
    expect(onEscalation).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('still escalates an untrusted URL when the other roles are allowed', () => {
    expect(
      evaluateGit('git_remote', { path: join(sandbox, 'repo'), mode: 'add', name: 'x', url: EVIL_URL }),
    ).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate', escalatedRoles: ['git-remote-url'] });
    // The gate's escalation stands even where compiled rules would allow the URL role.
    expect(evaluateGit('git_clone', { url: EVIL_URL, path: join(sandbox, 'clone') })).toMatchObject({
      decision: 'escalate',
      rule: 'structural-domain-escalate',
      escalatedRoles: ['git-remote-url'],
    });
  });

  it('adds the roles compiled rules escalate, so the whitelist candidate constrains the destination', async () => {
    const destination = join(outside, 'clone');
    const result = evaluateGit('git_clone', { url: EVIL_URL, path: destination });
    expect(result).toMatchObject({ decision: 'escalate', rule: 'structural-domain-escalate' });
    expect(result.escalatedRoles).toEqual(expect.arrayContaining(['git-remote-url', 'write-path']));

    const { deps, onEscalation } = harness();
    await handleCallTool('git_clone', { url: EVIL_URL, path: destination }, deps);
    const [, , , candidates] = onEscalation.mock.calls[0];
    expect(candidates?.[0]?.description).toContain(`write-path ${destination}`);
    expect(candidates?.[1]?.description).toContain(`write-path within ${outside} (recursive)`);
  });

  it('denies a git_pull into a directory a role-scoped policy does not permit, even from an untrusted remote', () => {
    // The policy permits pulling from any remote into the allowed directory,
    // so the domain gate is what escalates an untrusted remote there.
    const pull = pullEngine([
      allowPullInAllowed,
      {
        name: 'allow-git-pull-any-remote',
        description: 'Allow git_pull from any remote',
        principle: 'test',
        if: { server: ['git'], tool: ['git_pull'], roles: ['git-remote-url'] },
        then: 'allow',
        reason: 'test',
      },
    ]);

    expect(pull({ path: outsideRepo, remote: EVIL_URL })).toMatchObject({ decision: 'deny', rule: 'default-deny' });
    expect(pull({ path: join(allowed, 'repo'), remote: EVIL_URL })).toMatchObject({
      decision: 'escalate',
      rule: 'structural-domain-escalate',
      escalatedRoles: ['git-remote-url'],
    });

    // An omitted remote is evaluated as `origin`, the remote git-mcp-server
    // uses, and origin is never resolved outside the sandbox. That
    // unverifiable-remote escalation must not mask the deny either.
    expect(pull({ path: outsideRepo })).toMatchObject({ decision: 'deny', rule: 'default-deny' });
    const fromAllowed = pull({ path: join(allowed, 'repo') });
    expect(fromAllowed).toMatchObject({
      decision: 'escalate',
      rule: 'structural-domain-escalate',
      escalatedRoles: ['git-remote-url'],
    });
    expect(fromAllowed.reason).toContain('Cannot verify where git remote "origin" connects');
  });

  it('denies a remote no rule of a role-scoped policy covers, however it fares at the gate', () => {
    // The gate's URL role is not left out of compiled evaluation: a remote
    // the policy does not cover is default-denied whether it is trusted or
    // not, instead of becoming approvable by failing the gate.
    const pull = pullEngine([allowPullInAllowed]);
    const repo = join(allowed, 'repo');

    expect(pull({ path: repo, remote: GITHUB_URL })).toMatchObject({ decision: 'deny', rule: 'default-deny' });
    expect(pull({ path: repo, remote: EVIL_URL })).toMatchObject({ decision: 'deny', rule: 'default-deny' });
    expect(pull({ path: repo })).toMatchObject({ decision: 'deny', rule: 'default-deny' });
  });
});
