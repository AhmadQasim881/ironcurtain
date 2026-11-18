/**
 * The one persona compile path (persona-compile-service.ts) and what depends
 * on it (CFG-5):
 *  - `ironcurtain persona compile` runs the broad-policy validator, takes the
 *    compile lock and is audited, like a web-UI compile; `--allow-broad` is
 *    the explicit opt-in;
 *  - CLI and daemon compiles of the same persona serialize on the FS lock;
 *  - opting out of broad policies moves a broad compiled policy aside, so
 *    resolvePersona fails closed;
 *  - resolvePersona refuses a broad policy on disk for a persona that has not
 *    opted in (the LLM-free load-time check);
 *  - the lock itself (atomic publish, takeover-safe release, stale reclaim).
 *
 * The pipeline is replaced by a fake that, like the real one, calls the
 * `validateCompiled` hook with the resolved lists and the stored annotations
 * before writing compiled-policy.json. The load-time checks use the package's
 * real tool annotations (TEST_HOME has no user overlay).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fakePipeline = vi.hoisted(() => ({
  impl: undefined as undefined | ((name: string, opts: unknown) => Promise<unknown>),
}));
vi.mock('../src/persona/compile-persona-policy.js', () => ({
  compilePersonaPolicy: (name: string, opts: unknown) =>
    fakePipeline.impl ? fakePipeline.impl(name, opts) : Promise.reject(new Error('no fake pipeline installed')),
}));

import { main as personaMain } from '../src/persona/persona-command.js';
import {
  acquirePersonaCompileLock,
  getPersonaCompileLockPath,
  runPersonaCompile,
  PersonaCompileError,
} from '../src/persona/persona-compile-service.js';
import { PersonaCompileOrchestrator, CompileOrchestratorError } from '../src/persona/persona-compile-orchestrator.js';
import { REVOKED_POLICY_FILENAME, setPersonaBroadPolicyOptIn } from '../src/persona/persona-service.js';
import { resolvePersona } from '../src/persona/resolve.js';
import { createPersonaName, type PersonaName } from '../src/persona/types.js';
import { BroadPolicyRejectedError } from '../src/persona/broad-policy-validator.js';
import { hashConstitutionText, isScopedPolicyError } from '../src/config/constitution-hash.js';
import { personaDispatch } from '../src/web-ui/dispatch/persona-dispatch.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import type { WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import type { PersonaDetailDto } from '../src/web-ui/web-ui-types.js';
import type { CompilePersonaOptions } from '../src/persona/compile-persona-policy.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-persona-compile-service-test-${process.pid}`);
const PACKAGE_ANNOTATIONS = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/config/generated/tool-annotations.json'),
    'utf-8',
  ),
) as StoredToolAnnotationsFile;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONSTITUTION = 'Fetch documentation pages.\n';

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}
function generatedDir(name: string): string {
  return resolve(personaDir(name), 'generated');
}
function compiledPolicyPath(name: string): string {
  return resolve(generatedDir(name), 'compiled-policy.json');
}

/** A persona as createPersona leaves it (no compiled policy yet). */
function makePersona(name: string, extra: Record<string, unknown> = {}): PersonaName {
  mkdirSync(generatedDir(name), { recursive: true });
  mkdirSync(resolve(personaDir(name), 'workspace'), { recursive: true });
  writePersonaJson(name, extra);
  writeFileSync(resolve(personaDir(name), 'constitution.md'), CONSTITUTION);
  return createPersonaName(name);
}

function writePersonaJson(name: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    resolve(personaDir(name), 'persona.json'),
    JSON.stringify({ name, description: 'd', createdAt: '2026-11-11T00:00:00.000Z', ...extra }),
  );
}

function readPersonaJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(personaDir(name), 'persona.json'), 'utf-8')) as Record<string, unknown>;
}

function rule(name: string, then: CompiledRule['then'], cond: CompiledRule['if']): CompiledRule {
  return { name, description: 'd', principle: 'p', if: cond, then, reason: 'r' };
}

/** Allows every URL: leaves fetch's URL argument unconstrained. */
const UNCONSTRAINED_FETCH = rule('allow-any-fetch', 'allow', { server: ['fetch'], tool: ['http_fetch'] });
/** Allows `*`, literally. */
const WILDCARD_FETCH = rule('allow-all-hosts', 'allow', {
  server: ['fetch'],
  tool: ['http_fetch'],
  domains: { roles: ['fetch-url'], allowed: ['*'] },
});
/** Allows the hosts of the `news` list. */
const LISTED_FETCH = rule('allow-news', 'allow', {
  server: ['fetch'],
  tool: ['http_fetch'],
  domains: { roles: ['fetch-url'], allowed: ['@news'] },
});
const NARROW_FETCH = rule('allow-python-docs', 'allow', {
  server: ['fetch'],
  tool: ['http_fetch'],
  domains: { roles: ['fetch-url'], allowed: ['docs.python.org'] },
});

/** A policy as compiled from the fixture constitution (so it resolves as fresh). */
function policyOf(rules: CompiledRule[], extra: Partial<CompiledPolicyFile> = {}): CompiledPolicyFile {
  return { generatedAt: 'test', constitutionHash: hashConstitutionText(CONSTITUTION), inputHash: 'i', rules, ...extra };
}

function listsOf(values: string[]): DynamicListsFile {
  return {
    generatedAt: 'test',
    lists: { news: { values, manualAdditions: [], manualRemovals: [], resolvedAt: 'test', inputHash: 'test' } },
  };
}

/**
 * A fake pipeline: hands `validateCompiled` the policy, lists and the package
 * annotations, then (only if that passes) writes the artifacts like the real
 * runner (lists first, compiled policy last). `gate` holds the compile open.
 */
function installFakePipeline(
  policy: CompiledPolicyFile,
  opts: { lists?: DynamicListsFile; gate?: Promise<void>; before?: () => void } = {},
): { calls: number; seen: CompilePersonaOptions[] } {
  const record = { calls: 0, seen: [] as CompilePersonaOptions[] };
  fakePipeline.impl = async (name, rawOpts) => {
    const compileOpts = rawOpts as CompilePersonaOptions;
    record.calls += 1;
    record.seen.push(compileOpts);
    if (opts.gate) await opts.gate;
    opts.before?.();
    compileOpts.validateCompiled?.(policy, opts.lists, PACKAGE_ANNOTATIONS);
    if (opts.lists) writeFileSync(resolve(generatedDir(name), 'dynamic-lists.json'), JSON.stringify(opts.lists));
    writeFileSync(compiledPolicyPath(name), JSON.stringify(policy));
    return policy;
  };
  return record;
}

interface AuditRecord {
  actor: string;
  method: string;
  persona: string;
  details: Record<string, unknown>;
}

function readAudit(): AuditRecord[] {
  const path = resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

/** Runs `ironcurtain persona ...` and returns its stderr lines and exit status. */
async function runCli(args: string[]): Promise<{ lines: string[]; exitCode: number }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '));
  });
  process.exitCode = undefined;
  try {
    await personaMain(args);
  } finally {
    spy.mockRestore();
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return { lines, exitCode };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function captureEvents(bus: WebEventBus): Array<{ name: string; payload: unknown }> {
  const events: Array<{ name: string; payload: unknown }> = [];
  bus.subscribe((name, payload) => events.push({ name, payload }));
  return events;
}

/** Writes a fresh compiled policy (and optional lists) as if compiled from the persona's constitution. */
function writeCompiled(name: string, rules: CompiledRule[], lists?: DynamicListsFile): void {
  writePersonaPolicy(personaDir(name), { rules }, CONSTITUTION);
  if (lists) writeFileSync(resolve(generatedDir(name), 'dynamic-lists.json'), JSON.stringify(lists));
}

function expectScopedCode(fn: () => unknown, code: 'POLICY_MISSING' | 'POLICY_STALE' | 'POLICY_TOO_BROAD'): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `expected ${code}`).toBeInstanceOf(Error);
  expect(isScopedPolicyError(thrown, code), `expected ${code}, got: ${String(thrown)}`).toBe(true);
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
  fakePipeline.impl = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env['IRONCURTAIN_HOME'];
  delete process.env['ANTHROPIC_API_KEY'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLI compiles take the shared path
// ---------------------------------------------------------------------------

describe('ironcurtain persona compile', () => {
  it('refuses a broad result without the opt-in: nothing written, findings printed, audited as rejected', async () => {
    makePersona('web');
    const pipeline = installFakePipeline(policyOf([UNCONSTRAINED_FETCH]));

    const { lines, exitCode } = await runCli(['compile', 'web']);

    expect(pipeline.calls).toBe(1);
    expect(exitCode).toBe(1);
    expect(existsSync(compiledPolicyPath('web'))).toBe(false);
    const output = lines.join('\n');
    expect(output).toContain('not written');
    expect(output).toContain('allow-any-fetch: fetch-url on fetch/http_fetch');
    expect(output).toContain('ironcurtain persona compile web --allow-broad');
    expect(output).not.toContain('Done.');
    expect(readPersonaJson('web')).not.toHaveProperty('allowBroadPolicy');

    const records = readAudit().filter((r) => r.method === 'compilePersonaPolicy');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actor: 'cli',
      persona: 'web',
      details: { outcome: 'rejected', errorCode: 'BROAD_POLICY_REJECTED', broadened: true },
    });
  });

  it('runs the compile under the lock with an operation id and live MCP lists', async () => {
    makePersona('web');
    const pipeline = installFakePipeline(policyOf([NARROW_FETCH]));

    const { exitCode } = await runCli(['compile', 'web']);

    expect(exitCode).toBe(0);
    const [seen] = pipeline.seen;
    expect(seen.allowMcpLists).toBe(true);
    expect(seen.validateCompiled).toBeTypeOf('function');
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    const record = readAudit().find((r) => r.method === 'compilePersonaPolicy');
    expect(record?.details).toMatchObject({ outcome: 'written', broadened: false, operationId: seen.operationId });
    // Released afterwards.
    expect(existsSync(getPersonaCompileLockPath(createPersonaName('web')))).toBe(false);
  });

  it('--allow-broad sets the opt-in, then writes and audits the broad policy', async () => {
    makePersona('web');
    installFakePipeline(policyOf([UNCONSTRAINED_FETCH]));

    const { lines, exitCode } = await runCli(['compile', '--allow-broad', 'web']);

    expect(exitCode).toBe(0);
    expect(readPersonaJson('web').allowBroadPolicy).toBe(true);
    expect(existsSync(compiledPolicyPath('web'))).toBe(true);
    // The broad access is still shown.
    expect(lines.join('\n')).toContain('allowed by the persona');
    const records = readAudit();
    expect(records.map((r) => r.method)).toEqual(['setPersonaBroadPolicyOptIn', 'compilePersonaPolicy']);
    expect(records[1].details).toMatchObject({ outcome: 'written', broadened: true });
    expect(() => resolvePersona('web')).not.toThrow();
  });

  it.each([
    ['no rules at all', {}],
    ['a rule without its condition', { ...policyOf([]), rules: [{ name: NARROW_FETCH.name, then: 'allow' }] }],
  ])('reports a compile that replaced a malformed policy (%s) as written, not failed', async (_label, previous) => {
    makePersona('web');
    writeFileSync(compiledPolicyPath('web'), JSON.stringify(previous));
    installFakePipeline(policyOf([NARROW_FETCH]));

    const { lines, exitCode } = await runCli(['compile', 'web']);

    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('Done.');
    expect(JSON.parse(readFileSync(compiledPolicyPath('web'), 'utf-8'))).toEqual(policyOf([NARROW_FETCH]));
    const records = readAudit().filter((r) => r.method === 'compilePersonaPolicy');
    expect(records.map((r) => r.details.outcome)).toEqual(['written']);
  });

  it('exits 2 and names the servers when the policy was written without some of them', async () => {
    makePersona('web');
    installFakePipeline(
      policyOf([NARROW_FETCH], { failedServers: [{ serverName: 'github', phase: 'verifying', reason: 'x' }] }),
    );

    const { lines, exitCode } = await runCli(['compile', 'web']);

    expect(exitCode).toBe(2);
    expect(existsSync(compiledPolicyPath('web'))).toBe(true);
    expect(lines.join('\n')).toMatch(/1 server\(s\) failed .*: github/);
  });
});

// ---------------------------------------------------------------------------
// CLI and daemon compiles serialize
// ---------------------------------------------------------------------------

describe('CLI and daemon compiles of one persona', () => {
  it('refuse a CLI compile while the daemon compiles the persona', async () => {
    const name = makePersona('shared');
    const gate = deferred();
    const orch = new PersonaCompileOrchestrator({
      compileImpl: async () => {
        await gate.promise;
        return policyOf([NARROW_FETCH]);
      },
    });
    const bus = new WebEventBus();
    const events = captureEvents(bus);
    const ack = orch.startCompile(name, 'ws#1', bus);
    const cliPipeline = installFakePipeline(policyOf([NARROW_FETCH]));

    const { lines, exitCode } = await runCli(['compile', 'shared']);

    expect(exitCode).toBe(1);
    expect(cliPipeline.calls).toBe(0);
    expect(lines.join('\n')).toContain(`already running (operation ${ack.operationId})`);
    // --allow-broad is refused the same way, and leaves the opt-in alone.
    expect((await runCli(['compile', 'shared', '--allow-broad'])).exitCode).toBe(1);
    expect(readPersonaJson('shared')).not.toHaveProperty('allowBroadPolicy');
    // The refused attempts compiled nothing, so they are not audited.
    expect(readAudit().filter((r) => r.actor === 'cli')).toEqual([]);

    gate.release();
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
  });

  it('refuse a daemon compile while a CLI compile runs, until it ends', async () => {
    const name = makePersona('shared');
    const gate = deferred();
    installFakePipeline(policyOf([NARROW_FETCH]), { gate: gate.promise });
    const cli = runCli(['compile', 'shared']);
    await waitFor(() => existsSync(getPersonaCompileLockPath(name)));
    const holder = JSON.parse(readFileSync(getPersonaCompileLockPath(name), 'utf-8')) as { operationId: string };

    const orch = new PersonaCompileOrchestrator({ compileImpl: () => Promise.resolve(policyOf([NARROW_FETCH])) });
    let thrown: unknown;
    try {
      orch.startCompile(name, 'ws#1', new WebEventBus());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CompileOrchestratorError);
    expect((thrown as CompileOrchestratorError).code).toBe('COMPILE_IN_PROGRESS');
    expect((thrown as CompileOrchestratorError).data).toEqual({ operationId: holder.operationId });

    gate.release();
    expect((await cli).exitCode).toBe(0);
    // Once the CLI compile ended, the daemon may compile.
    const bus = new WebEventBus();
    const events = captureEvents(bus);
    orch.startCompile(name, 'ws#1', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
  });
});

// ---------------------------------------------------------------------------
// Opting out revokes
// ---------------------------------------------------------------------------

describe('setPersonaBroadPolicyOptIn(false)', () => {
  it('moves a broad compiled policy aside, so resolvePersona fails closed', () => {
    const name = makePersona('opted', { allowBroadPolicy: true });
    writeCompiled('opted', [WILDCARD_FETCH]);
    expect(() => resolvePersona('opted')).not.toThrow();

    const detail = setPersonaBroadPolicyOptIn(name, false, 'test');

    expect(detail.allowBroadPolicy).toBe(false);
    expect(detail.hasPolicy).toBe(false);
    expect(existsSync(compiledPolicyPath('opted'))).toBe(false);
    expect(existsSync(resolve(generatedDir('opted'), REVOKED_POLICY_FILENAME))).toBe(true);
    expectScopedCode(() => resolvePersona('opted'), 'POLICY_MISSING');
    const record = readAudit().find((r) => r.method === 'setPersonaBroadPolicyOptIn');
    expect(record?.details).toMatchObject({ enabled: false, policyRevoked: true });
  });

  it('judges @list references by their resolved values', () => {
    const name = makePersona('lists', { allowBroadPolicy: true });
    writeCompiled('lists', [LISTED_FETCH], listsOf(['*.com']));

    expect(setPersonaBroadPolicyOptIn(name, false, 'test').hasPolicy).toBe(false);
    expectScopedCode(() => resolvePersona('lists'), 'POLICY_MISSING');
  });

  it('keeps a narrow compiled policy', () => {
    const name = makePersona('narrow', { allowBroadPolicy: true });
    writeCompiled('narrow', [NARROW_FETCH, LISTED_FETCH], listsOf(['docs.python.org']));

    expect(setPersonaBroadPolicyOptIn(name, false, 'test').hasPolicy).toBe(true);
    expect(() => resolvePersona('narrow')).not.toThrow();
    const record = readAudit().find((r) => r.method === 'setPersonaBroadPolicyOptIn');
    expect(record?.details).not.toHaveProperty('policyRevoked');
  });

  it('is refused while the persona compiles, changing nothing', async () => {
    const name = makePersona('busy', { allowBroadPolicy: true });
    writeCompiled('busy', [WILDCARD_FETCH]);
    const gate = deferred();
    const orch = new PersonaCompileOrchestrator({
      compileImpl: async () => {
        await gate.promise;
        return policyOf([WILDCARD_FETCH]);
      },
    });
    const bus = new WebEventBus();
    const events = captureEvents(bus);
    orch.startCompile(name, 'ws#1', bus);

    expect(() => setPersonaBroadPolicyOptIn(name, false, 'test')).toThrow(PersonaCompileError);
    expect(readPersonaJson('busy').allowBroadPolicy).toBe(true);
    expect(existsSync(compiledPolicyPath('busy'))).toBe(true);

    gate.release();
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
  });

  it('over the web UI: emits personas.changed, and maps a running compile to COMPILE_IN_PROGRESS', async () => {
    const name = makePersona('ws', { allowBroadPolicy: true });
    writeCompiled('ws', [WILDCARD_FETCH]);
    const bus = new WebEventBus();
    const events = captureEvents(bus);
    const ctx = { eventBus: bus, allowPolicyMutation: true } as unknown as WorkflowDispatchContext;

    const lock = acquirePersonaCompileLock(name, 'cli-op');
    await expect(
      personaDispatch(ctx, 'personas.setBroadPolicyOptIn', { name: 'ws', enabled: false }),
    ).rejects.toMatchObject({ code: 'COMPILE_IN_PROGRESS', data: { operationId: 'cli-op' } });
    lock.release();

    const detail = (await personaDispatch(ctx, 'personas.setBroadPolicyOptIn', {
      name: 'ws',
      enabled: false,
    })) as PersonaDetailDto;
    expect(detail.hasPolicy).toBe(false);
    expect(events.some((e) => e.name === 'personas.changed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The opt-in is judged when the result is
// ---------------------------------------------------------------------------

describe('runPersonaCompile', () => {
  it('judges the result against the opt-in as it is when the compile ends', async () => {
    const name = makePersona('late', { allowBroadPolicy: true });
    // persona.json loses the opt-in while the compile runs.
    installFakePipeline(policyOf([WILDCARD_FETCH]), { before: () => writePersonaJson('late') });

    await expect(runPersonaCompile(name, 'test', { allowMcpLists: false })).rejects.toBeInstanceOf(
      BroadPolicyRejectedError,
    );
    expect(existsSync(compiledPolicyPath('late'))).toBe(false);
  });

  it('counts only an explicit true as the opt-in: a persona.json with another value is refused', async () => {
    // persona.json is validated (persona-definition.ts): a string opt-in is
    // never coerced, so the persona cannot be compiled at all.
    const name = makePersona('stringly', { allowBroadPolicy: 'true' });
    installFakePipeline(policyOf([WILDCARD_FETCH]));

    await expect(runPersonaCompile(name, 'test', { allowMcpLists: false })).rejects.toMatchObject({
      code: 'PERSONA_INVALID',
    });
    expect(existsSync(compiledPolicyPath(name))).toBe(false);
  });

  it('audits a failed compile and releases the lock', async () => {
    const name = makePersona('broken');
    fakePipeline.impl = () => Promise.reject(Object.assign(new Error('needs mcp'), { code: 'MCP_LISTS_DISALLOWED' }));

    await expect(runPersonaCompile(name, 'test', { allowMcpLists: false })).rejects.toThrow('needs mcp');

    expect(existsSync(getPersonaCompileLockPath(name))).toBe(false);
    expect(readAudit().find((r) => r.method === 'compilePersonaPolicy')?.details).toMatchObject({
      outcome: 'failed',
      errorCode: 'LIST_REQUIRES_MCP',
    });
  });

  it('judges each side of the rule delta with its own resolved lists', async () => {
    const name = makePersona('relisted', { allowBroadPolicy: true });
    installFakePipeline(policyOf([LISTED_FETCH]), { lists: listsOf(['example.org']) });
    await runPersonaCompile(name, 'test', { allowMcpLists: false });

    // The rule text is unchanged, but its list now resolves to a broad wildcard.
    installFakePipeline(policyOf([LISTED_FETCH]), { lists: listsOf(['example.org', '*.gov']) });
    const widened = await runPersonaCompile(name, 'test', { allowMcpLists: false });
    expect(widened.ruleDelta?.loosened).toBe(1);

    // The same broad list on both sides gains nothing: the previous rule is
    // judged with the lists it was written with (read before the compile
    // replaced them), not with none.
    installFakePipeline(policyOf([LISTED_FETCH]), { lists: listsOf(['example.org', '*.gov']) });
    const unchanged = await runPersonaCompile(name, 'test', { allowMcpLists: false });
    expect(unchanged.ruleDelta?.loosened).toBe(0);
    expect(unchanged.ruleDelta?.broadenedDomains).not.toEqual([]);
  });

  it('judges breadth with the lists on disk when the compile did not call the hook', async () => {
    const name = makePersona('hookless');
    // A compile implementation that writes without calling validateCompiled
    // (the real pipeline always calls it before writing): the audit record
    // and the findings still see the `@news` list it wrote.
    const policy = policyOf([LISTED_FETCH]);
    const compileImpl = (persona: PersonaName): Promise<CompiledPolicyFile> => {
      writeFileSync(resolve(generatedDir(persona), 'dynamic-lists.json'), JSON.stringify(listsOf(['*.com'])));
      writeFileSync(compiledPolicyPath(persona), JSON.stringify(policy));
      return Promise.resolve(policy);
    };

    const outcome = await runPersonaCompile(name, 'test', { allowMcpLists: false, compileImpl });

    expect(outcome.findings.broadenedDomains).not.toEqual([]);
    expect(readAudit().find((r) => r.method === 'compilePersonaPolicy')?.details).toMatchObject({
      outcome: 'written',
      broadened: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Load-time check
// ---------------------------------------------------------------------------

describe('resolvePersona and broad policies', () => {
  it('refuses a broad policy on disk when the persona has not opted in, even with allowStalePolicy', () => {
    makePersona('legacy');
    // E.g. compiled by an older CLI that never ran the validator.
    writeCompiled('legacy', [UNCONSTRAINED_FETCH]);

    expectScopedCode(() => resolvePersona('legacy'), 'POLICY_TOO_BROAD');
    // A stale override does not reach the breadth check's refusal.
    writeFileSync(resolve(personaDir('legacy'), 'constitution.md'), 'Edited.\n');
    expectScopedCode(() => resolvePersona('legacy', { allowStalePolicy: true }), 'POLICY_TOO_BROAD');
  });

  it('names what is broad and how to fix it', () => {
    makePersona('legacy');
    writeCompiled('legacy', [UNCONSTRAINED_FETCH]);
    expect(() => resolvePersona('legacy')).toThrow(
      /allow-any-fetch: fetch-url on fetch\/http_fetch.*ironcurtain persona compile legacy --allow-broad/,
    );
  });

  it('judges @list references by their resolved values', () => {
    makePersona('listy');
    writeCompiled('listy', [LISTED_FETCH], listsOf(['*']));
    expectScopedCode(() => resolvePersona('listy'), 'POLICY_TOO_BROAD');

    writeCompiled('listy', [LISTED_FETCH], listsOf(['docs.python.org']));
    expect(() => resolvePersona('listy')).not.toThrow();
  });

  it('accepts the policy once the persona opted in, and only an explicit true counts', () => {
    makePersona('legacy', { allowBroadPolicy: true });
    writeCompiled('legacy', [WILDCARD_FETCH]);
    expect(() => resolvePersona('legacy')).not.toThrow();

    // A string opt-in is not an opt-in: the whole persona.json is refused.
    writePersonaJson('legacy', { allowBroadPolicy: 'true' });
    expect(() => resolvePersona('legacy')).toThrow(expect.objectContaining({ code: 'PERSONA_INVALID' }));
  });

  it('accepts narrow allow rules and escalate rules of any breadth', () => {
    makePersona('narrow');
    writeCompiled('narrow', [
      NARROW_FETCH,
      rule('escalate-other-hosts', 'escalate', {
        server: ['fetch'],
        domains: { roles: ['fetch-url'], allowed: ['*'] },
      }),
    ]);
    expect(() => resolvePersona('narrow')).not.toThrow();
  });

  it('`persona show` reports a broad policy the persona has not opted in to', async () => {
    makePersona('legacy');
    writeCompiled('legacy', [UNCONSTRAINED_FETCH]);

    const { lines } = await runCli(['show', 'legacy']);

    expect(lines).toContain('Broad policies: not allowed');
    expect(lines.find((l) => l.includes('Broad access without the opt-in'))).toContain(
      'allow-any-fetch: fetch-url on fetch/http_fetch',
    );
  });
});

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

describe('persona compile lock', () => {
  it('publishes complete content and leaves no temp files', () => {
    const name = makePersona('lock');
    const lock = acquirePersonaCompileLock(name, 'op-1');

    const content = JSON.parse(readFileSync(getPersonaCompileLockPath(name), 'utf-8')) as Record<string, unknown>;
    expect(content).toMatchObject({ operationId: 'op-1', pid: process.pid });
    expect(readdirSync(generatedDir('lock'))).toEqual(['.compile.lock']);

    expect(() => acquirePersonaCompileLock(name, 'op-2')).toThrow(/already running/);
    lock.release();
    expect(existsSync(getPersonaCompileLockPath(name))).toBe(false);
  });

  it("does not remove a lock that another holder took over after this one's went stale", () => {
    const name = makePersona('lock');
    const lock = acquirePersonaCompileLock(name, 'op-1');
    const takeover = { operationId: 'op-2', startedAt: new Date().toISOString(), pid: process.pid };
    writeFileSync(getPersonaCompileLockPath(name), JSON.stringify(takeover));

    expect(() => lock.refresh()).toThrow(PersonaCompileError);
    lock.release();

    expect(JSON.parse(readFileSync(getPersonaCompileLockPath(name), 'utf-8'))).toEqual(takeover);
  });

  it("reclaims a dead holder's lock", () => {
    const name = makePersona('lock');
    writeFileSync(
      getPersonaCompileLockPath(name),
      JSON.stringify({ operationId: 'op-dead', startedAt: new Date().toISOString(), pid: 2_000_000_000 }),
    );

    const lock = acquirePersonaCompileLock(name, 'op-new');

    expect(JSON.parse(readFileSync(getPersonaCompileLockPath(name), 'utf-8'))).toMatchObject({
      operationId: 'op-new',
    });
    expect(readdirSync(generatedDir('lock'))).toEqual(['.compile.lock']);
    lock.release();
  });

  it('refresh re-stamps startedAt, so a queued compile is measured from when it runs', async () => {
    const name = makePersona('lock');
    const lock = acquirePersonaCompileLock(name, 'op-1');
    const before = (JSON.parse(readFileSync(getPersonaCompileLockPath(name), 'utf-8')) as { startedAt: string })
      .startedAt;
    await new Promise((r) => setTimeout(r, 10));

    lock.refresh();

    const after = JSON.parse(readFileSync(getPersonaCompileLockPath(name), 'utf-8')) as {
      operationId: string;
      startedAt: string;
    };
    expect(after.operationId).toBe('op-1');
    expect(Date.parse(after.startedAt)).toBeGreaterThan(Date.parse(before));
    lock.release();
  });

  it('never creates a persona skeleton for a persona that does not exist', () => {
    expect(() => acquirePersonaCompileLock(createPersonaName('ghost'), 'op-1')).toThrow();
    expect(existsSync(personaDir('ghost'))).toBe(false);
  });
});
