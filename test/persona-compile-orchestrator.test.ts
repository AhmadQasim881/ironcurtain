/**
 * Unit tests for the persona-compile orchestrator (Phase 1b).
 *
 * Exercises the long-running model against a temp IRONCURTAIN_HOME with a fake
 * compile implementation (no pipeline / LLM / network):
 *  - happy-path compileStream emitting started -> progress -> done via the
 *    EventBusProgressReporter;
 *  - COMPILE_IN_PROGRESS dedup (in-memory + FS lock);
 *  - FS-lock cross-process exclusion;
 *  - active -> recent synchronous transition;
 *  - stale-lock startup recovery (dead pid + past wall-clock cap);
 *  - globalLimit queueing + COMPILE_QUEUE_FULL;
 *  - wall-clock-cap abort;
 *  - CREDENTIALS_MISSING preflight;
 *  - the compileStream gate (POLICY_MUTATION_FORBIDDEN) lives in the dispatch
 *    test below.
 *
 * The lock, validator, wall-clock cap and audit record come from the shared
 * compile path (persona-compile-service.ts); CLI compiles are covered in
 * test/persona-compile-service.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PersonaCompileOrchestrator, CompileOrchestratorError } from '../src/persona/persona-compile-orchestrator.js';
import { classifyPersonaCompileError } from '../src/persona/persona-compile-service.js';
import { WebEventBus, type WebEventMap } from '../src/web-ui/web-event-bus.js';
import { createPersonaName, type PersonaName } from '../src/persona/types.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import type { CompilePersonaOptions } from '../src/persona/compile-persona-policy.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-orch-test-${process.pid}`);

function personaGeneratedDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name, 'generated');
}
function lockPath(name: string): string {
  return resolve(personaGeneratedDir(name), '.compile.lock');
}

/** Creates the persona generated dir on disk so the FS lock has a home. */
function makePersonaDir(name: string): PersonaName {
  const branded = createPersonaName(name);
  mkdirSync(personaGeneratedDir(name), { recursive: true });
  // Minimal persona.json + constitution so loadPersona (if reached) succeeds.
  writeFileSync(
    resolve(TEST_HOME, 'personas', name, 'persona.json'),
    JSON.stringify({ name, description: 'x', createdAt: new Date().toISOString() }),
  );
  writeFileSync(resolve(TEST_HOME, 'personas', name, 'constitution.md'), 'principles\n');
  return branded;
}

/** Collects emitted events for assertions. */
function captureEvents(bus: WebEventBus): { events: Array<{ name: string; payload: unknown }> } {
  const events: Array<{ name: string; payload: unknown }> = [];
  bus.subscribe((name, payload) => {
    events.push({ name, payload });
  });
  return { events };
}

/** A controllable fake compile impl returning a policy with `ruleCount` rules. */
function fakeCompile(
  ruleCount: number,
  hooks?: {
    onCall?: (opts: CompilePersonaOptions) => void;
    block?: Promise<void>;
    throwErr?: Error;
  },
): (name: PersonaName, opts: CompilePersonaOptions) => Promise<CompiledPolicyFile> {
  return async (_name, opts) => {
    hooks?.onCall?.(opts);
    if (hooks?.block) await hooks.block;
    if (hooks?.throwErr) throw hooks.throwErr;
    // Drive a progress phase through the injected reporter so the happy-path
    // test can observe a progress event.
    const reporter = opts.reporterFactory?.('filesystem');
    reporter?.update('compiling');
    return {
      generatedAt: new Date().toISOString(),
      constitutionHash: 'h',
      inputHash: 'i',
      rules: Array.from({ length: ruleCount }, (_v, idx) => ({
        name: `rule-${idx}`,
        description: 'd',
        if: { server: ['filesystem'] },
        then: 'allow' as const,
        reason: 'r',
      })),
    } as CompiledPolicyFile;
  };
}

/** Waits until `pred()` is true or times out. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  delete process.env['ANTHROPIC_API_KEY'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('happy path', () => {
  it('emits started -> progress -> done and records a success result', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(3) });

    const ack = orch.startCompile(name, 'cli', bus);
    expect(ack).toMatchObject({ accepted: true, name, operationId: expect.any(String) });

    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));

    const names = events.map((e) => e.name);
    expect(names).toContain('persona.compile.started');
    expect(names).toContain('persona.compile.progress');
    expect(names).toContain('persona.compile.done');

    const done = events.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done.result).toEqual({ success: true, ruleCount: 3 });

    // active cleared, recent populated, lock released.
    expect(orch.listCompiles().active).toHaveLength(0);
    const op = orch.getCompile(ack.operationId);
    expect(op?.phase).toBe('done');
    expect(existsSync(lockPath('coder'))).toBe(false);
  });
});

describe('broad-policy validator + ruleDelta wiring', () => {
  /**
   * Stored annotations handed to the hook, as the real pipeline does: the
   * filesystem and git tools here take no resource arguments, while fetch's
   * http_fetch takes a URL.
   */
  const ANNOTATIONS: StoredToolAnnotationsFile = {
    generatedAt: '',
    servers: {
      filesystem: {
        inputHash: 'h',
        tools: [
          { toolName: 'list_allowed_directories', serverName: 'filesystem', comment: '', args: {}, inputSchema: {} },
        ],
      },
      git: {
        inputHash: 'h',
        tools: [{ toolName: 'git_version', serverName: 'git', comment: '', args: {}, inputSchema: {} }],
      },
      fetch: {
        inputHash: 'h',
        tools: [
          {
            toolName: 'http_fetch',
            serverName: 'fetch',
            comment: '',
            args: { url: ['fetch-url'], max_length: ['none'] },
            inputSchema: {},
          },
        ],
      },
    },
  };

  /**
   * A compile impl that returns the given policy AND invokes the orchestrator's
   * validateCompiled hook on it (the real pipeline runs this hook before any
   * write, with the resolved lists and the stored annotations; the fake must
   * mirror that so the broad-policy gate is exercised).
   */
  function validatingCompile(
    policy: CompiledPolicyFile,
  ): (name: PersonaName, opts: CompilePersonaOptions) => Promise<CompiledPolicyFile> {
    return async (_name, opts) => {
      opts.validateCompiled?.(policy, undefined, ANNOTATIONS);
      return policy;
    };
  }

  function readAuditRecords(): Array<{ method: string; persona: string; details: Record<string, unknown> }> {
    const path = resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { method: string; persona: string; details: Record<string, unknown> });
  }

  function makePolicy(rules: CompiledPolicyFile['rules']): CompiledPolicyFile {
    return { generatedAt: '', constitutionHash: 'h', inputHash: 'i', rules };
  }

  function writePersonaJson(name: string, extra: Record<string, unknown> = {}): void {
    writeFileSync(
      resolve(TEST_HOME, 'personas', name, 'persona.json'),
      JSON.stringify({ name, description: 'x', createdAt: new Date().toISOString(), ...extra }),
    );
  }

  it('rejects a wildcard-domain compile (BROAD_POLICY_REJECTED) when not opted in', async () => {
    const name = makePersonaDir('narrow');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const broadPolicy = makePolicy([
      {
        name: 'r1',
        description: 'd',
        principle: 'p',
        if: { domains: { roles: [], allowed: ['*'] } },
        then: 'allow',
        reason: 'r',
      },
    ]);
    const orch = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(broadPolicy) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.failed'));

    const failed = events.find((e) => e.name === 'persona.compile.failed')
      ?.payload as WebEventMap['persona.compile.failed'];
    expect(failed.code).toBe('BROAD_POLICY_REJECTED');
    expect(orch.getCompile(ack.operationId)?.phase).toBe('failed');
    // The refused compile is audited too, not only written ones.
    const record = readAuditRecords().find((r) => r.method === 'compilePersonaPolicy' && r.persona === 'narrow');
    expect(record?.details).toMatchObject({
      outcome: 'rejected',
      errorCode: 'BROAD_POLICY_REJECTED',
      operationId: ack.operationId,
    });
  });

  it('allows a broad compile when the persona is opted in (allowBroadPolicy:true)', async () => {
    const name = makePersonaDir('broad');
    writePersonaJson('broad', { allowBroadPolicy: true });
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const broadPolicy = makePolicy([
      {
        name: 'r1',
        description: 'd',
        principle: 'p',
        if: { domains: { roles: [], allowed: ['*'] } },
        then: 'allow',
        reason: 'r',
      },
    ]);
    const orch = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(broadPolicy) });

    orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
    const done = events.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done.result.success).toBe(true);
  });

  /** The compilePersonaPolicy records in the policy-mutation log, oldest first. */
  function compileRecords(): Array<{ persona: string; details: { broadened?: boolean } }> {
    const path = resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method: string; persona: string; details: { broadened?: boolean } })
      .filter((r) => r.method === 'compilePersonaPolicy');
  }

  it('audits a broad FIRST compile of an opted-in persona as broadened', async () => {
    // There is no previous policy, so no ruleDelta: breadth must still be
    // computed from the new policy itself.
    const name = makePersonaDir('broad-first');
    writePersonaJson('broad-first', { allowBroadPolicy: true });
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const broadPolicy = makePolicy([
      {
        name: 'r1',
        description: 'd',
        principle: 'p',
        if: { domains: { roles: [], allowed: ['*.com'] } },
        then: 'allow',
        reason: 'r',
      },
    ]);
    new PersonaCompileOrchestrator({ compileImpl: validatingCompile(broadPolicy) }).startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));

    const done = events.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done.result.ruleDelta).toBeUndefined();
    expect(compileRecords()).toMatchObject([{ persona: 'broad-first', details: { broadened: true } }]);
  });

  it('audits breadth reached through a dynamic list as broadened', async () => {
    const name = makePersonaDir('broad-list');
    writePersonaJson('broad-list', { allowBroadPolicy: true });
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const listPolicy = makePolicy([
      {
        name: 'r1',
        description: 'd',
        principle: 'p',
        if: { domains: { roles: [], allowed: ['@news'] } },
        then: 'allow',
        reason: 'r',
      },
    ]);
    const lists = {
      generatedAt: '',
      lists: {
        news: { values: ['*.com'], manualAdditions: [], manualRemovals: [], resolvedAt: '', inputHash: 'i' },
      },
    };
    const compileImpl = async (_n: PersonaName, opts: CompilePersonaOptions): Promise<CompiledPolicyFile> => {
      opts.validateCompiled?.(listPolicy, lists, ANNOTATIONS);
      return listPolicy;
    };
    new PersonaCompileOrchestrator({ compileImpl }).startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
    expect(compileRecords()).toMatchObject([{ persona: 'broad-list', details: { broadened: true } }]);
  });

  it('audits a narrow compile as not broadened', async () => {
    const name = makePersonaDir('narrow-first');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const narrowPolicy = makePolicy([
      { name: 'a', description: 'd', principle: 'p', if: { server: ['filesystem'] }, then: 'allow', reason: 'r' },
    ]);
    new PersonaCompileOrchestrator({ compileImpl: validatingCompile(narrowPolicy) }).startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
    expect(compileRecords()).toMatchObject([{ persona: 'narrow-first', details: { broadened: false } }]);
  });

  it('omits ruleDelta on the first compile and includes it once a prior policy exists', async () => {
    const name = makePersonaDir('coder');
    const bus1 = new WebEventBus();
    const { events: e1 } = captureEvents(bus1);
    // A complete rule (principle included): the previous policy is diffed only
    // when it is one sessions would load.
    const p1 = makePolicy([
      { name: 'a', description: 'd', principle: 'p', if: { server: ['filesystem'] }, then: 'allow', reason: 'r' },
    ]);
    const orch = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(p1) });
    orch.startCompile(name, 'cli', bus1);
    await waitFor(() => e1.some((e) => e.name === 'persona.compile.done'));
    const done1 = e1.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done1.result.ruleDelta).toBeUndefined();

    // Persist the first policy so the second compile has a prior to diff.
    writeFileSync(resolve(personaGeneratedDir('coder'), 'compiled-policy.json'), JSON.stringify(p1));

    const bus2 = new WebEventBus();
    const { events: e2 } = captureEvents(bus2);
    const p2 = makePolicy([
      { name: 'a', description: 'd', principle: 'p', if: { server: ['filesystem'] }, then: 'allow', reason: 'r' },
      { name: 'b', description: 'd', principle: 'p', if: { server: ['git'] }, then: 'allow', reason: 'r' },
    ]);
    const orch2 = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(p2) });
    orch2.startCompile(name, 'cli', bus2);
    await waitFor(() => e2.some((e) => e.name === 'persona.compile.done'));
    const done2 = e2.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done2.result.ruleDelta).toBeDefined();
    expect(done2.result.ruleDelta?.added).toBe(1);
    expect(done2.result.ruleDelta?.unconstrainedAllows).toEqual([]);
  });

  it('rejects an allow rule that leaves fetch URLs unconstrained (BROAD_POLICY_REJECTED)', async () => {
    const name = makePersonaDir('fetcher');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const unconstrained = makePolicy([
      {
        name: 'allow-any-fetch',
        description: 'd',
        principle: 'p',
        if: { server: ['fetch'] },
        then: 'allow',
        reason: 'r',
      },
    ]);
    const orch = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(unconstrained) });

    orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.failed'));
    const failed = events.find((e) => e.name === 'persona.compile.failed')
      ?.payload as WebEventMap['persona.compile.failed'];
    expect(failed.code).toBe('BROAD_POLICY_REJECTED');
    expect(failed.error).toContain('allow-any-fetch: fetch-url on fetch/http_fetch');
  });

  it('reports unconstrained allows and escalate breadth in ruleDelta and audits the compile as broadened', async () => {
    const name = makePersonaDir('opted');
    writePersonaJson('opted', { allowBroadPolicy: true });
    writeFileSync(resolve(personaGeneratedDir('opted'), 'compiled-policy.json'), JSON.stringify(makePolicy([])));
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const broad = makePolicy([
      {
        name: 'allow-any-fetch',
        description: 'd',
        principle: 'p',
        if: { server: ['fetch'] },
        then: 'allow',
        reason: 'r',
      },
      {
        name: 'escalate-other-urls',
        description: 'd',
        principle: 'p',
        if: { server: ['fetch'], domains: { roles: ['fetch-url'], allowed: ['*'] } },
        then: 'escalate',
        reason: 'r',
      },
    ]);
    const orch = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(broad) });

    orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
    const done = events.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done.result.ruleDelta?.unconstrainedAllows).toEqual(['allow-any-fetch: fetch-url on fetch/http_fetch']);
    expect(done.result.ruleDelta?.escalateBreadth).toEqual(['escalate-other-urls: *']);
    // The escalate '*' is not broad access: only the allow rule counts.
    expect(done.result.ruleDelta?.broadenedDomains).toEqual([]);

    const record = readAuditRecords().find((r) => r.method === 'compilePersonaPolicy' && r.persona === 'opted');
    expect(record?.details.broadened).toBe(true);
  });

  it('audits the first compile by the policy it wrote: broad for an opted-in broad policy, not for a narrow one', async () => {
    // No previous compiled-policy.json, so there is no rule delta to read the
    // flag from; the audit still has to say whether the new policy is broad.
    const broadName = makePersonaDir('first-broad');
    writePersonaJson('first-broad', { allowBroadPolicy: true });
    const narrowName = makePersonaDir('first-narrow');
    const broad = makePolicy([
      {
        name: 'allow-any-fetch',
        description: 'd',
        principle: 'p',
        if: { server: ['fetch'] },
        then: 'allow',
        reason: 'r',
      },
    ]);
    const narrow = makePolicy([
      {
        name: 'allow-docs',
        description: 'd',
        principle: 'p',
        if: { server: ['fetch'], domains: { roles: ['fetch-url'], allowed: ['docs.python.org'] } },
        then: 'allow',
        reason: 'r',
      },
    ]);

    for (const [name, policy] of [
      [broadName, broad],
      [narrowName, narrow],
    ] as const) {
      const bus = new WebEventBus();
      const { events } = captureEvents(bus);
      new PersonaCompileOrchestrator({ compileImpl: validatingCompile(policy) }).startCompile(name, 'cli', bus);
      await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
      const done = events.find((e) => e.name === 'persona.compile.done')
        ?.payload as WebEventMap['persona.compile.done'];
      expect(done.result.ruleDelta).toBeUndefined();
    }

    const records = readAuditRecords().filter((r) => r.method === 'compilePersonaPolicy');
    expect(records.find((r) => r.persona === 'first-broad')?.details.broadened).toBe(true);
    expect(records.find((r) => r.persona === 'first-narrow')?.details.broadened).toBe(false);
  });
});

describe('COMPILE_IN_PROGRESS dedup', () => {
  it('rejects a second compile of the same persona while the first runs', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { block }) });

    const first = orch.startCompile(name, 'cli', bus);
    // The first op is now active (lock held).
    await waitFor(() => orch.listCompiles().active.length === 1);

    expect(() => orch.startCompile(name, 'cli', bus)).toThrow(CompileOrchestratorError);
    try {
      orch.startCompile(name, 'cli', bus);
    } catch (err) {
      expect((err as CompileOrchestratorError).code).toBe('COMPILE_IN_PROGRESS');
      expect((err as CompileOrchestratorError).data).toMatchObject({ operationId: first.operationId });
    }

    release();
    await waitFor(() => orch.listCompiles().active.length === 0);
  });
});

describe('FS-lock cross-process exclusion', () => {
  it('rejects when a live lock from another in-memory orchestrator exists', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));

    // Orchestrator A holds the lock (simulating another process via a separate
    // in-memory instance — the FS lock is the cross-process truth).
    const orchA = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { block }) });
    orchA.startCompile(name, 'cli', bus);
    await waitFor(() => existsSync(lockPath('coder')));

    // Orchestrator B has an EMPTY in-memory map, so only the FS lock can stop it.
    const orchB = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1) });
    expect(() => orchB.startCompile(name, 'cli', bus)).toThrow(/already running/i);

    release();
    await waitFor(() => !existsSync(lockPath('coder')));
  });
});

describe('active -> recent synchronous transition', () => {
  it('keeps an operation findable in exactly one of active/recent', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(2) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => orch.getCompile(ack.operationId)?.phase === 'done');

    const { active, recent } = orch.listCompiles();
    const inActive = active.some((o) => o.operationId === ack.operationId);
    const inRecent = recent.some((o) => o.operationId === ack.operationId);
    expect(inActive).toBe(false);
    expect(inRecent).toBe(true);
  });
});

describe('stale-lock startup recovery', () => {
  it('reclaims a dead-pid lock and emits a synthetic failed event', () => {
    makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    // Dead pid (very high, unlikely to exist).
    writeFileSync(
      lockPath('coder'),
      JSON.stringify({ operationId: 'op-dead', startedAt: new Date().toISOString(), pid: 2_000_000_000 }),
    );

    const orch = new PersonaCompileOrchestrator();
    orch.recoverStaleLocks(bus);

    expect(existsSync(lockPath('coder'))).toBe(false);
    const failed = events.find((e) => e.name === 'persona.compile.failed');
    expect((failed?.payload as { operationId: string }).operationId).toBe('op-dead');
  });

  it('reclaims a past-wall-clock-cap lock even for a live pid', () => {
    makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    // Live pid (this process) but startedAt far in the past => past the cap.
    writeFileSync(
      lockPath('coder'),
      JSON.stringify({
        operationId: 'op-old',
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        pid: process.pid,
      }),
    );

    const orch = new PersonaCompileOrchestrator({ wallClockCapMs: 1000 });
    orch.recoverStaleLocks(bus);

    expect(existsSync(lockPath('coder'))).toBe(false);
    expect(events.some((e) => e.name === 'persona.compile.failed')).toBe(true);
  });

  it('leaves a live, within-cap lock untouched', () => {
    makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    writeFileSync(
      lockPath('coder'),
      JSON.stringify({ operationId: 'op-live', startedAt: new Date().toISOString(), pid: process.pid }),
    );

    const orch = new PersonaCompileOrchestrator();
    orch.recoverStaleLocks(bus);

    expect(existsSync(lockPath('coder'))).toBe(true);
    expect(events.some((e) => e.name === 'persona.compile.failed')).toBe(false);
  });
});

describe('globalLimit queueing + COMPILE_QUEUE_FULL', () => {
  it('marks operations queued when the global gate is saturated and rejects past the cap', async () => {
    const bus = new WebEventBus();
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    // queueCap=1: 2 running (gate) + 1 queued allowed; the 4th is rejected.
    const orch = new PersonaCompileOrchestrator({
      compileImpl: fakeCompile(1, { block }),
      queueCap: 1,
    });

    // Two distinct personas saturate the gate (GLOBAL_CONCURRENCY=2).
    const a = makePersonaDir('a');
    const b = makePersonaDir('b');
    const c = makePersonaDir('c');
    const d = makePersonaDir('d');

    orch.startCompile(a, 'cli', bus);
    orch.startCompile(b, 'cli', bus);
    await waitFor(() => orch.listCompiles().active.length === 2);

    // Third enqueues (queued:true), depth within cap.
    const ackC = orch.startCompile(c, 'cli', bus);
    expect(ackC.queued).toBe(true);

    // Fourth exceeds the queue cap.
    expect(() => orch.startCompile(d, 'cli', bus)).toThrow(CompileOrchestratorError);
    try {
      orch.startCompile(d, 'cli', bus);
    } catch (err) {
      expect((err as CompileOrchestratorError).code).toBe('COMPILE_QUEUE_FULL');
    }

    release();
    await waitFor(() => orch.listCompiles().active.length === 0, 4000);
  });

  it("re-stamps a queued compile's lock when it starts, so the lock ages with the run, not the wait", async () => {
    const bus = new WebEventBus();
    let releaseRunning!: () => void;
    const running = new Promise<void>((r) => (releaseRunning = r));
    let releaseQueued!: () => void;
    const queued = new Promise<void>((r) => (releaseQueued = r));
    const a = makePersonaDir('a');
    const b = makePersonaDir('b');
    const c = makePersonaDir('c');
    const orch = new PersonaCompileOrchestrator({
      compileImpl: async (name) => {
        await (name === c ? queued : running);
        return fakeCompile(1)(name, {});
      },
    });
    orch.startCompile(a, 'cli', bus);
    orch.startCompile(b, 'cli', bus);
    await waitFor(() => orch.listCompiles().active.length === 2);
    expect(orch.startCompile(c, 'cli', bus).queued).toBe(true);
    const lockedAt = (JSON.parse(readFileSync(lockPath('c'), 'utf-8')) as { startedAt: string }).startedAt;
    await new Promise((r) => setTimeout(r, 15));

    releaseRunning();
    await waitFor(
      () => (JSON.parse(readFileSync(lockPath('c'), 'utf-8')) as { startedAt: string }).startedAt !== lockedAt,
    );
    expect(
      Date.parse((JSON.parse(readFileSync(lockPath('c'), 'utf-8')) as { startedAt: string }).startedAt),
    ).toBeGreaterThan(Date.parse(lockedAt));

    releaseQueued();
    await waitFor(() => orch.listCompiles().active.length === 0, 4000);
    expect(existsSync(lockPath('c'))).toBe(false);
  });
});

describe('wall-clock-cap abort', () => {
  it('aborts the in-flight compile when the cap fires and records a failure', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);

    // Compile that resolves only when its signal aborts.
    const compileImpl = (_n: PersonaName, opts: CompilePersonaOptions): Promise<CompiledPolicyFile> =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted by cap')));
      });

    const orch = new PersonaCompileOrchestrator({ compileImpl, wallClockCapMs: 50 });
    const ack = orch.startCompile(name, 'cli', bus);

    await waitFor(() => events.some((e) => e.name === 'persona.compile.failed'), 3000);
    const op = orch.getCompile(ack.operationId);
    expect(op?.phase).toBe('failed');
    expect(existsSync(lockPath('coder'))).toBe(false);
  });
});

describe('CREDENTIALS_MISSING preflight', () => {
  it('rejects synchronously and releases the lock when no API key is present', () => {
    const name = makePersonaDir('coder');
    delete process.env['ANTHROPIC_API_KEY'];
    const bus = new WebEventBus();
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1) });

    try {
      orch.startCompile(name, 'cli', bus);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CompileOrchestratorError).code).toBe('CREDENTIALS_MISSING');
    }
    // Lock released — a later compile (with creds) is not blocked.
    expect(existsSync(lockPath('coder'))).toBe(false);
  });

  it("also checks a separate verifier model's provider credential (policyVerifierModelId)", async () => {
    const savedOpenAi = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      const name = makePersonaDir('coder');
      writeFileSync(
        resolve(TEST_HOME, 'config.json'),
        JSON.stringify({ policyModelId: 'anthropic:claude-sonnet-4-6', policyVerifierModelId: 'openai:gpt-5' }),
      );
      const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1) });

      let error: unknown;
      try {
        orch.startCompile(name, 'cli', new WebEventBus());
      } catch (err) {
        error = err;
      }
      expect((error as CompileOrchestratorError | undefined)?.code).toBe('CREDENTIALS_MISSING');
      expect((error as Error).message).toContain('OPENAI_API_KEY');
      expect(existsSync(lockPath('coder'))).toBe(false);

      process.env['OPENAI_API_KEY'] = 'sk-test';
      const bus = new WebEventBus();
      const { events } = captureEvents(bus);
      expect(() => orch.startCompile(name, 'cli', bus)).not.toThrow();
      await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
    } finally {
      if (savedOpenAi === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = savedOpenAi;
    }
  });
});

describe('LIST_REQUIRES_MCP classification', () => {
  it('maps an MCP_LISTS_DISALLOWED compile error to LIST_REQUIRES_MCP', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const mcpErr = Object.assign(new Error('needs mcp'), { code: 'MCP_LISTS_DISALLOWED' });
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { throwErr: mcpErr }) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.failed'));
    const op = orch.getCompile(ack.operationId);
    expect(op?.error?.code).toBe('LIST_REQUIRES_MCP');
  });
});

// The merged policy failed the policy lint (pipeline PolicyLintError, code
// POLICY_LINT_FAILED): nothing was written, and the findings say what to change.
describe('POLICY_LINT_FAILED classification', () => {
  it('maps a lint failure to its own code, with the findings in the message', () => {
    const result = classifyPersonaCompileError({ code: 'POLICY_LINT_FAILED', errors: ['rule r: broad domain *.com'] });

    expect(result.code).toBe('POLICY_LINT_FAILED');
    expect(result.message).toContain('rule r: broad domain *.com');
    expect(result.message).not.toBe('Persona compilation failed.');
  });

  it('names the first three findings, escapes control characters and bounds the length', () => {
    const findings = [
      'Rule "a" allows *.com \u001b[2J',
      `Rule "b" ${'x'.repeat(5_000)}`,
      'Rule "c" allows every tool of server(s) "fetch"',
      'Rule "d" is the fourth finding',
      'Rule "e" is the fifth finding',
    ];

    const { message } = classifyPersonaCompileError(
      Object.assign(new Error('The compiled policy failed the policy checks'), {
        code: 'POLICY_LINT_FAILED',
        errors: findings,
      }),
    );

    expect(message).toContain('Rule "a" allows *.com \\u001b[2J');
    expect(message).not.toContain('\u001b');
    expect(message).toContain('Rule "c" allows every tool');
    expect(message).not.toContain('fourth finding');
    expect(message).toContain('2 more');
    expect(message.length).toBeLessThan(2_000);
  });

  it('reports a lint failure on the failed event and the operation record', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const lintErr = Object.assign(new Error('The compiled policy failed the policy checks; nothing was written'), {
      code: 'POLICY_LINT_FAILED',
      errors: ['Rule "allow-all": broad domain *.com'],
    });
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { throwErr: lintErr }) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.failed'));

    const failed = events.find((e) => e.name === 'persona.compile.failed')
      ?.payload as WebEventMap['persona.compile.failed'];
    expect(failed.code).toBe('POLICY_LINT_FAILED');
    expect(failed.error).toContain('Rule "allow-all": broad domain *.com');
    expect(orch.getCompile(ack.operationId)?.error?.code).toBe('POLICY_LINT_FAILED');
  });
});

describe('per-operation LLM log path', () => {
  it('passes operationId + allowMcpLists:false + quiet to the compile impl', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    let seen: CompilePersonaOptions | undefined;
    const orch = new PersonaCompileOrchestrator({
      compileImpl: fakeCompile(1, { onCall: (opts) => (seen = opts) }),
    });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => orch.getCompile(ack.operationId)?.phase === 'done');
    expect(seen?.operationId).toBe(ack.operationId);
    expect(seen?.allowMcpLists).toBe(false);
    expect(seen?.quiet).toBe(true);
  });
});

// Sanity: the lock file contains the live pid + operationId while held.
describe('lock file content', () => {
  it('writes operationId + pid into the lock while a compile is running', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { block }) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => existsSync(lockPath('coder')));
    const content = JSON.parse(readFileSync(lockPath('coder'), 'utf-8'));
    expect(content.operationId).toBe(ack.operationId);
    expect(content.pid).toBe(process.pid);

    release();
    await waitFor(() => !existsSync(lockPath('coder')));
  });
});

// WP-15: partial and total per-server failures are visible on the WS path.
describe('failed servers', () => {
  const failedFs = {
    serverName: 'fs',
    phase: 'verifying' as const,
    reason: 'Verification still failing after 3 repair attempt(s).',
  };

  function partialPolicy(): CompiledPolicyFile {
    return {
      generatedAt: '',
      constitutionHash: 'h',
      inputHash: 'i',
      rules: [
        { name: 'allow-news', description: 'd', principle: 'p', if: { server: ['news'] }, then: 'allow', reason: 'r' },
      ],
      failedServers: [failedFs],
    };
  }

  it('carries failedServers on the done result and event of a partial compile', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const orch = new PersonaCompileOrchestrator({ compileImpl: () => Promise.resolve(partialPolicy()) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));

    const done = events.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done.result).toEqual({ success: true, ruleCount: 1, failedServers: [failedFs] });
    expect(orch.getCompile(ack.operationId)?.result?.failedServers).toEqual([failedFs]);
  });

  it('names the failed servers when every server failed', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const allFailed = Object.assign(new Error('All 1 server(s) failed compilation'), {
      code: 'ALL_SERVERS_FAILED',
      failedServers: [failedFs],
    });
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { throwErr: allFailed }) });

    orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.failed'));

    const failed = events.find((e) => e.name === 'persona.compile.failed')
      ?.payload as WebEventMap['persona.compile.failed'];
    expect(failed.code).toBe('INTERNAL_ERROR');
    expect(failed.error).toContain('fs (verifying)');
    // The raw reason stays out of the operator-facing message.
    expect(failed.error).not.toContain('repair attempt');
  });

  it("reports a server's failure as a progress event", async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const orch = new PersonaCompileOrchestrator({
      compileImpl: (_n, opts) => {
        opts.reporterFactory?.('fs').fail('verifying', new Error('judge rejected\nthe rules'));
        return Promise.resolve(partialPolicy());
      },
    });

    orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));

    const progress = events
      .filter((e) => e.name === 'persona.compile.progress')
      .map((e) => e.payload as WebEventMap['persona.compile.progress']);
    expect(progress).toContainEqual(
      expect.objectContaining({ serverName: 'fs', phase: 'verifying', detail: 'Failed: judge rejected\\nthe rules' }),
    );
  });
});
