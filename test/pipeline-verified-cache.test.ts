/**
 * WP-15 regression tests for the per-server compile cache and failure handling.
 *
 *  - PIP-2: the per-server cache serves only rules that PASSED verification. A
 *    re-run after a judge rejection, or after a run whose verification was
 *    interrupted, must not promote the rejected / never-verified rules.
 *  - PIP-19: rules persisted during the repair loop are the repaired ones.
 *  - PIP-9: servers that fail are recorded in `failedServers`; an aborted run
 *    surfaces the abort instead of per-server failures.
 *  - PIP-10: a serverFilter run leaves the merged policy untouched by default.
 *
 * Every test drives the REAL PipelineRunner with scripted fake LLMs (no
 * network). Follow-up runs use an LLM that throws on any call, so a run that
 * resolves without calling it can only have been served from cache.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as pipelineShared from '../src/pipeline/pipeline-shared.js';
import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import { computeServerRulesHash } from '../src/pipeline/server-artifacts.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type {
  CompiledPolicyFile,
  FailedServer,
  ServerCompiledPolicyFile,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';
import {
  createScriptedPipelineModels,
  createThrowingPipelineModels,
  type FakeLlmCall,
  type FakePhaseScript,
  type ScriptedPipelineModels,
} from './fixtures/fake-pipeline-models.js';
import {
  BAD_FS,
  BAD_FS_GOOD_NEWS,
  CONSTITUTION,
  FS_AND_CHANGED_NEWS,
  FS_AND_NEWS,
  FS_ONLY,
  FS_SCENARIOS,
  GOOD_BOTH,
  GOOD_FS,
  NEWS,
  NEWS_SCENARIOS,
  NO_CHANGE_PATCH,
  PASS,
  REJECT_FS,
  SANDBOX,
  rule,
} from './fixtures/two-server-pipeline-fixture.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeOutputDir(): string {
  const workDir = mkdtempSync(resolve(tmpdir(), 'ic-wp15-'));
  dirs.push(workDir);
  const outputDir = resolve(workDir, 'generated');
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

const noopReporter: ServerProgressReporter = {
  update: () => {},
  complete: () => {},
  warn: () => {},
  fail: () => {},
  done: () => {},
};

function runConfig(
  outputDir: string,
  annotations: StoredToolAnnotationsFile,
  logs: string[],
  overrides: Partial<PipelineRunConfig> = {},
): PipelineRunConfig {
  return {
    constitutionInput: CONSTITUTION,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: outputDir,
    allowedDirectory: SANDBOX,
    protectedPaths: [],
    preloadedStoredAnnotations: annotations,
    includeHandwrittenScenarios: false,
    quiet: true,
    reporterFactory: () => noopReporter,
    onProgress: (msg) => logs.push(msg),
    ...overrides,
  };
}

interface RunOutcome {
  readonly policy?: CompiledPolicyFile;
  readonly error?: unknown;
  readonly logs: string[];
}

async function run(
  fake: ScriptedPipelineModels,
  outputDir: string,
  annotations: StoredToolAnnotationsFile,
  overrides: Partial<PipelineRunConfig> = {},
): Promise<RunOutcome> {
  const logs: string[] = [];
  const config = runConfig(outputDir, annotations, logs, overrides);
  try {
    const policy = await new PipelineRunner(fake.models).run(config);
    return { policy, logs };
  } catch (error) {
    return { error, logs };
  }
}

function scripted(outputDir: string, script: FakePhaseScript): ScriptedPipelineModels {
  return createScriptedPipelineModels(script, resolve(outputDir, '..', 'llm.jsonl'));
}

function throwing(outputDir: string): ScriptedPipelineModels {
  return createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-side typing for JSON artifacts
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function serverFile(outputDir: string, server: string, file: string): string {
  return resolve(outputDir, 'servers', server, file);
}

function ruleNames(policy: { rules: Array<{ name: string }> } | undefined): string[] {
  return (policy?.rules ?? []).map((r) => r.name);
}

/** Decision the merged policy gives for `fs/delete_file /etc/passwd`. */
function deleteDecision(policy: CompiledPolicyFile, annotations: StoredToolAnnotationsFile): string {
  const engine = new PolicyEngine(policy, annotations, [], SANDBOX);
  return engine.evaluate({
    requestId: 'r',
    serverName: 'fs',
    toolName: 'delete_file',
    arguments: { path: '/etc/passwd' },
    timestamp: '',
  }).decision;
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function failedServersOf(err: unknown): readonly FailedServer[] | undefined {
  return typeof err === 'object' && err !== null
    ? (err as { failedServers?: readonly FailedServer[] }).failedServers
    : undefined;
}

function callsOf(fake: ScriptedPipelineModels, phase: FakeLlmCall['phase']): FakeLlmCall[] {
  return fake.calls.filter((c) => c.phase === phase);
}

// ---------------------------------------------------------------------------
// PIP-2: only verified rules are served from cache
// ---------------------------------------------------------------------------

describe('per-server cache serves only verified rules (PIP-2)', () => {
  it('serves a verified commit from cache with no LLM call (control)', async () => {
    const outputDir = makeOutputDir();
    const first = await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
    );
    expect(ruleNames(first.policy)).toEqual(['allow-fs-reads']);

    const committed = readJson<ServerCompiledPolicyFile>(serverFile(outputDir, 'fs', 'compiled-policy.json'));
    expect(committed.verified).toBe(true);
    expect(typeof committed.verifiedAt).toBe('string');
    expect(existsSync(serverFile(outputDir, 'fs', 'compiled-policy.unverified.json'))).toBe(false);

    const down = throwing(outputDir);
    const second = await run(down, outputDir, FS_ONLY);
    expect(second.error).toBeUndefined();
    expect(down.calls).toHaveLength(0);
    expect(ruleNames(second.policy)).toEqual(['allow-fs-reads']);
  });

  it('(a) a server the judge rejects through every repair is not promoted by an identical re-run', async () => {
    const outputDir = makeOutputDir();
    const fake1 = scripted(outputDir, {
      compile: [BAD_FS],
      scenarios: [FS_SCENARIOS],
      judge: [REJECT_FS],
      repair: [NO_CHANGE_PATCH],
    });
    const run1 = await run(fake1, outputDir, FS_ONLY);
    const inspectionPath = serverFile(outputDir, 'fs', 'compiled-policy.unverified.json');
    const afterRun1 = {
      committed: existsSync(serverFile(outputDir, 'fs', 'compiled-policy.json')),
      committedScenarios: existsSync(serverFile(outputDir, 'fs', 'test-scenarios.json')),
      inspectionScenarios: existsSync(serverFile(outputDir, 'fs', 'test-scenarios.unverified.json')),
      merged: existsSync(resolve(outputDir, 'compiled-policy.json')),
    };
    const inspection = existsSync(inspectionPath) ? readJson<ServerCompiledPolicyFile>(inspectionPath) : undefined;

    // Run 2, identical inputs, LLM down.
    const down = throwing(outputDir);
    const run2 = await run(down, outputDir, FS_ONLY);

    // The regression: run 2 must try to compile (no cache hit) and must not
    // resolve with run 1's rejected rules.
    expect(run1.policy).toBeUndefined();
    expect(run2.policy).toBeUndefined();
    expect(callsOf(down, 'compile').length).toBeGreaterThan(0);

    // Run 1 went through the repair loop and was rejected after the last repair.
    expect(callsOf(fake1, 'repair').length).toBeGreaterThan(0);
    expect(callsOf(fake1, 'judge')).toHaveLength(callsOf(fake1, 'repair').length + 1);
    expect(errorCode(run1.error)).toBe('ALL_SERVERS_FAILED');
    expect(failedServersOf(run1.error)).toEqual([expect.objectContaining({ serverName: 'fs', phase: 'verifying' })]);
    expect(errorCode(run2.error)).toBe('ALL_SERVERS_FAILED');
    expect(failedServersOf(run2.error)).toEqual([expect.objectContaining({ serverName: 'fs', phase: 'compiling' })]);

    // Run 1 wrote nothing cache-eligible; the rejected rules are inspection copies only.
    expect(afterRun1).toEqual({
      committed: false,
      committedScenarios: false,
      inspectionScenarios: true,
      merged: false,
    });
    expect(inspection?.verified).toBe(false);
    expect(ruleNames(inspection)).toEqual(['allow-all-fs']);
  });

  it('(a) with two servers: the failed server is reported and its rejected rules are never promoted', async () => {
    const outputDir = makeOutputDir();
    const run1 = await run(scripted(outputDir, BAD_FS_GOOD_NEWS), outputDir, FS_AND_NEWS);
    const merged1 = readJson<CompiledPolicyFile>(resolve(outputDir, 'compiled-policy.json'));

    const down = throwing(outputDir);
    const run2 = await run(down, outputDir, FS_AND_NEWS);
    const merged2 = readJson<CompiledPolicyFile>(resolve(outputDir, 'compiled-policy.json'));

    // The regression: the re-run must not promote the rejected fs rules.
    expect(ruleNames(run2.policy)).not.toContain('allow-all-fs');
    expect(deleteDecision(merged2, FS_AND_NEWS)).toBe('deny');

    expect(run1.error).toBeUndefined();
    expect(ruleNames(run1.policy)).toEqual(['allow-news']);
    expect(run1.policy?.failedServers).toEqual([
      expect.objectContaining({ serverName: 'fs', phase: 'verifying', reason: expect.any(String) }),
    ]);
    // The merged artifact on disk records the failure too, and the run does not claim success.
    expect(merged1.failedServers?.map((f) => f.serverName)).toEqual(['fs']);
    expect(deleteDecision(merged1, FS_AND_NEWS)).toBe('deny');
    expect(run1.logs.some((l) => l.includes('Policy compilation successful'))).toBe(false);
    expect(run1.logs.some((l) => l.includes('finished with 1 failed server(s)'))).toBe(true);

    // news is served from its verified commit; fs had none, so it was recompiled (and failed).
    expect(down.calls.length).toBeGreaterThan(0);
    expect(down.calls.every((c) => c.phase === 'compile' && c.system.includes('for the "fs" server'))).toBe(true);
    expect(run2.error).toBeUndefined();
    expect(ruleNames(run2.policy)).toEqual(['allow-news']);
    expect(run2.policy?.failedServers).toEqual([expect.objectContaining({ serverName: 'fs', phase: 'compiling' })]);
  });

  it('(b) a run whose protectedPaths changed and whose judge threw is not promoted next run', async () => {
    const outputDir = makeOutputDir();
    const protected0 = ['/wp15/protected-0'];
    const protected1 = ['/wp15/protected-0', '/wp15/protected-1'];

    const run0 = await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
      { protectedPaths: protected0 },
    );
    expect(ruleNames(run0.policy)).toEqual(['allow-fs-reads']);

    // protectedPaths is in the compiler prompt but not the scenario prompt: the
    // new rules are compiled, scenarios come from the verified commit (in
    // memory), and the judge call fails mid-verification.
    const fake1 = scripted(outputDir, {
      compile: [BAD_FS],
      judge: [new Error('simulated network error during verification')],
    });
    const run1 = await run(fake1, outputDir, FS_ONLY, { protectedPaths: protected1 });
    const inspectionPath = serverFile(outputDir, 'fs', 'compiled-policy.unverified.json');
    const afterRun1 = {
      committed: existsSync(serverFile(outputDir, 'fs', 'compiled-policy.json')),
      committedScenarios: existsSync(serverFile(outputDir, 'fs', 'test-scenarios.json')),
      mergedRules: ruleNames(readJson<CompiledPolicyFile>(resolve(outputDir, 'compiled-policy.json'))),
    };
    const inspection = existsSync(inspectionPath) ? readJson<ServerCompiledPolicyFile>(inspectionPath) : undefined;

    const down = throwing(outputDir);
    const run2 = await run(down, outputDir, FS_ONLY, { protectedPaths: protected1 });

    // The regression: run 1's never-verified rules must not be promoted.
    expect(run2.policy).toBeUndefined();
    expect(callsOf(down, 'compile').length).toBeGreaterThan(0);
    expect(errorCode(run2.error)).toBe('ALL_SERVERS_FAILED');

    expect(callsOf(fake1, 'scenarios')).toHaveLength(0);
    expect(callsOf(fake1, 'judge').length).toBeGreaterThan(0);
    expect(errorCode(run1.error)).toBe('ALL_SERVERS_FAILED');
    expect(failedServersOf(run1.error)).toEqual([expect.objectContaining({ serverName: 'fs', phase: 'verifying' })]);

    // Run 1 removed the old verified pair before writing anything, the
    // never-verified rules exist only as the unverified copy, and the failed
    // run wrote no merged policy (run 0's stays active).
    expect(afterRun1).toEqual({ committed: false, committedScenarios: false, mergedRules: ['allow-fs-reads'] });
    expect(inspection?.verified).toBe(false);
    expect(ruleNames(inspection)).toEqual(['allow-all-fs']);
  });

  it('treats a per-server file without the verified marker (older versions) as unverified', async () => {
    const outputDir = makeOutputDir();
    await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
    );

    // Rewrite the committed file the way pre-WP-15 versions wrote it.
    const path = serverFile(outputDir, 'fs', 'compiled-policy.json');
    const legacy: Record<string, unknown> = { ...readJson<ServerCompiledPolicyFile>(path) };
    delete legacy.verified;
    delete legacy.verifiedAt;
    writeFileSync(path, JSON.stringify(legacy, null, 2));

    const down = throwing(outputDir);
    const rerun = await run(down, outputDir, FS_ONLY);
    expect(callsOf(down, 'compile').length).toBeGreaterThan(0);
    expect(rerun.policy).toBeUndefined();
  });

  it('recompiles instead of serving a verified file whose rules are scoped to another server', async () => {
    const outputDir = makeOutputDir();
    await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
    );

    // Hand-edit the committed file: same verified marker, rule now scoped to news.
    const path = serverFile(outputDir, 'fs', 'compiled-policy.json');
    const committed = readJson<ServerCompiledPolicyFile>(path);
    const tampered = { ...committed, rules: [{ ...committed.rules[0], if: { server: ['news'] } }] };
    writeFileSync(path, JSON.stringify(tampered, null, 2));

    const down = throwing(outputDir);
    const rerun = await run(down, outputDir, FS_ONLY);
    expect(callsOf(down, 'compile').length).toBeGreaterThan(0);
    expect(rerun.policy).toBeUndefined();
  });

  // WP-61 (PIP-13, cache reuse): cached rules are merged without being
  // compiled again. Served as they are, these edits would produce a merged
  // compiled-policy.json the runtime loaders refuse, and every unchanged
  // re-run would write it again.
  it.each([
    [
      'an unknown decision',
      { then: 'Allow' },
      'rules[0].then: "Allow" is not one of "allow", "assess", "escalate", "deny"',
    ],
    [
      'a misspelled condition key',
      { if: { server: ['fs'], tools: ['read_file'] } },
      'rules[0].if.tools: unknown field',
    ],
  ])(
    'recompiles instead of serving a verified file whose rules have %s',
    async (_label, edit: Record<string, unknown>, problem) => {
      const outputDir = makeOutputDir();
      await run(
        scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
        outputDir,
        FS_ONLY,
      );

      // Hand-edit the committed file: still verified and scoped to fs. Its
      // rulesHash is re-stamped for the edited rules (as a file an older or
      // faulty compiler wrote and verified would carry), so the commit's own
      // integrity check passes and only the runtime schema check stops it.
      // (Without the re-stamp, the rulesHash mismatch alone makes the commit
      // unverified: see the WP-60 cache tests.)
      const path = serverFile(outputDir, 'fs', 'compiled-policy.json');
      const committed = readJson<ServerCompiledPolicyFile>(path);
      const rules = [{ ...committed.rules[0], ...edit }] as ServerCompiledPolicyFile['rules'];
      writeFileSync(
        path,
        JSON.stringify(
          { ...committed, rules, rulesHash: computeServerRulesHash(rules, committed.listDefinitions) },
          null,
          2,
        ),
      );

      const warnings: string[] = [];
      const down = throwing(outputDir);
      const rerun = await run(down, outputDir, FS_ONLY, {
        reporterFactory: () => ({ ...noopReporter, warn: (message) => warnings.push(message) }),
      });
      expect(callsOf(down, 'compile').length).toBeGreaterThan(0);
      expect(rerun.policy).toBeUndefined();
      expect(warnings.join('\n')).toContain('cached rules rejected, recompiling');
      expect(warnings.join('\n')).toContain(problem);
    },
  );

  it('writes the verified marker only after verification passes, in the same write as the rules', async () => {
    const outputDir = makeOutputDir();
    // Record per-server writes and judge calls in one timeline.
    const timeline: Array<{ kind: 'write'; file: string; data: unknown } | { kind: 'judge' }> = [];
    const realWriteArtifact = pipelineShared.writeArtifact;
    vi.spyOn(pipelineShared, 'writeArtifact').mockImplementation((dir, filename, data) => {
      if (dir === resolve(outputDir, 'servers', 'fs')) timeline.push({ kind: 'write', file: filename, data });
      realWriteArtifact(dir, filename, data);
    });

    // Initial verify rejects (a missing escalate rule); one repair adds it; re-verify passes.
    const escalatingScenarios = {
      scenarios: [
        FS_SCENARIOS.scenarios[0],
        { ...FS_SCENARIOS.scenarios[1], expectedDecision: 'escalate', reasoning: 'Deletes need approval.' },
      ],
    };
    const addEscalate = {
      reasoning: 'Deletes need approval.',
      operations: [{ op: 'add', rule: rule('escalate-fs-deletes', 'fs', { tool: ['delete_file'] }, 'escalate') }],
    };
    const reject = {
      ...REJECT_FS,
      analysis: 'FAIL: deletes must escalate.',
      failureAttributions: [
        {
          scenarioIndex: 2,
          scenarioDescription: 'delete a file outside the sandbox',
          blame: { kind: 'rule', reasoning: 'Missing escalate rule.' },
        },
      ],
    };
    const judgeReplies = [reject, PASS].map((reply) => () => {
      timeline.push({ kind: 'judge' });
      return reply;
    });

    const result = await run(
      scripted(outputDir, {
        compile: [GOOD_FS],
        scenarios: [escalatingScenarios],
        judge: judgeReplies,
        repair: [addEscalate],
      }),
      outputDir,
      FS_ONLY,
    );
    expect(result.error).toBeUndefined();

    const committed = timeline.filter(
      (e): e is { kind: 'write'; file: string; data: unknown } =>
        e.kind === 'write' && e.file === 'compiled-policy.json',
    );
    expect(committed).toHaveLength(1);
    const committedPolicy = committed[0].data as ServerCompiledPolicyFile;
    expect(committedPolicy.verified).toBe(true);
    expect(ruleNames(committedPolicy).sort()).toEqual(['allow-fs-reads', 'escalate-fs-deletes']);

    const commitIndex = timeline.indexOf(committed[0]);
    const lastJudgeIndex = timeline.map((e) => e.kind).lastIndexOf('judge');
    expect(commitIndex).toBeGreaterThan(lastJudgeIndex);
    const scenariosIndex = timeline.findIndex((e) => e.kind === 'write' && e.file === 'test-scenarios.json');
    expect(scenariosIndex).toBeGreaterThan(lastJudgeIndex);
    expect(scenariosIndex).toBeLessThan(commitIndex);

    // Every earlier persist went to the unverified copy with verified: false.
    for (const entry of timeline.slice(0, commitIndex)) {
      if (entry.kind !== 'write' || entry.file === 'dynamic-lists.json' || entry.file === 'test-scenarios.json')
        continue;
      expect(entry.file).toBe('compiled-policy.unverified.json');
      expect((entry.data as ServerCompiledPolicyFile).verified).toBe(false);
    }
    expect(existsSync(serverFile(outputDir, 'fs', 'compiled-policy.unverified.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PIP-19: the in-loop persist uses the repaired rules
// ---------------------------------------------------------------------------

describe('repair-loop persistence (PIP-19)', () => {
  it('persists the repaired rules (not the initial ones) before re-verifying', async () => {
    const outputDir = makeOutputDir();
    const escalatingScenarios = {
      scenarios: [
        FS_SCENARIOS.scenarios[0],
        { ...FS_SCENARIOS.scenarios[1], expectedDecision: 'escalate', reasoning: 'Deletes need approval.' },
      ],
    };
    const reject = {
      analysis: 'FAIL: deletes must escalate.',
      pass: false,
      failureAttributions: [
        {
          scenarioIndex: 2,
          scenarioDescription: 'delete a file outside the sandbox',
          blame: { kind: 'rule', reasoning: 'Missing escalate rule.' },
        },
      ],
      additionalScenarios: [],
    };
    let onDiskDuringReverify: string[] | undefined;

    const result = await run(
      scripted(outputDir, {
        compile: [GOOD_FS],
        scenarios: [escalatingScenarios],
        judge: [
          reject,
          () => {
            // The repair-verify judge call runs after the in-loop persist. Read
            // whichever per-server policy file exists (older versions persisted
            // to compiled-policy.json) so this pins the persisted CONTENT.
            const unverified = serverFile(outputDir, 'fs', 'compiled-policy.unverified.json');
            const persisted = existsSync(unverified) ? unverified : serverFile(outputDir, 'fs', 'compiled-policy.json');
            onDiskDuringReverify = ruleNames(readJson<ServerCompiledPolicyFile>(persisted));
            return PASS;
          },
        ],
        repair: [
          {
            reasoning: 'Deletes need approval.',
            operations: [{ op: 'add', rule: rule('escalate-fs-deletes', 'fs', { tool: ['delete_file'] }, 'escalate') }],
          },
        ],
      }),
      outputDir,
      FS_ONLY,
    );

    expect(result.error).toBeUndefined();
    expect(onDiskDuringReverify).toContain('escalate-fs-deletes');
    expect(onDiskDuringReverify).toContain('allow-fs-reads');
  });
});

// ---------------------------------------------------------------------------
// PIP-9: aborts are not per-server failures
// ---------------------------------------------------------------------------

describe('failure reporting (PIP-9)', () => {
  it('an aborted run surfaces the abort, not "all servers failed", and writes no merged policy', async () => {
    const outputDir = makeOutputDir();
    const controller = new AbortController();
    const stop = new Error('stop requested');
    const result = await run(
      scripted(outputDir, {
        ...BAD_FS_GOOD_NEWS,
        judge: [
          () => {
            controller.abort(stop);
            throw new Error('request aborted');
          },
        ],
      }),
      outputDir,
      FS_AND_NEWS,
      { signal: controller.signal },
    );
    expect(result.error).toBe(stop);
    expect(errorCode(result.error)).toBeUndefined();
    expect(existsSync(resolve(outputDir, 'compiled-policy.json'))).toBe(false);
  });

  it('records the failing phase and a bounded single-line reason', async () => {
    const outputDir = makeOutputDir();
    const longMultiline = `compiler exploded\n${'x'.repeat(2000)}`;
    const result = await run(
      scripted(outputDir, {
        compile: [
          (call: FakeLlmCall) => (call.system.includes('for the "fs" server') ? new Error(longMultiline) : NEWS),
        ],
        scenarios: [NEWS_SCENARIOS],
        judge: [PASS],
      }),
      outputDir,
      FS_AND_NEWS,
    );
    const failure = result.policy?.failedServers?.[0];
    expect(failure).toMatchObject({ serverName: 'fs', phase: 'compiling' });
    expect(failure?.reason).toContain('compiler exploded');
    expect(failure?.reason).not.toContain('\n');
    expect(failure?.reason.length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// PIP-10: serverFilter leaves the merged policy alone
// ---------------------------------------------------------------------------

describe('serverFilter runs (PIP-10)', () => {
  it('writes only servers/<name>/ and keeps every other server in the merged policy', async () => {
    const outputDir = makeOutputDir();
    const full = await run(scripted(outputDir, GOOD_BOTH), outputDir, FS_AND_NEWS);
    expect(ruleNames(full.policy)).toEqual(['allow-fs-reads', 'allow-news']);
    const mergedBefore = readFileSync(resolve(outputDir, 'compiled-policy.json'), 'utf-8');
    const newsBefore = readJson<ServerCompiledPolicyFile>(serverFile(outputDir, 'news', 'compiled-policy.json'));

    const fake = scripted(outputDir, GOOD_BOTH);
    const filtered = await run(fake, outputDir, FS_AND_CHANGED_NEWS, { serverFilter: ['news'] });

    expect(filtered.error).toBeUndefined();
    expect(fake.calls.some((c) => c.phase === 'compile')).toBe(true); // news really recompiled
    expect(ruleNames(filtered.policy)).toEqual(['allow-news']);
    expect(readFileSync(resolve(outputDir, 'compiled-policy.json'), 'utf-8')).toBe(mergedBefore);
    const newsAfter = readJson<ServerCompiledPolicyFile>(serverFile(outputDir, 'news', 'compiled-policy.json'));
    expect(newsAfter.verified).toBe(true);
    expect(newsAfter.inputHash).not.toBe(newsBefore.inputHash);
    expect(filtered.logs.some((l) => l.includes('Merged policy not modified'))).toBe(true);
  });

  it('writes the merged artifacts when writeMergedArtifacts is explicitly true', async () => {
    const outputDir = makeOutputDir();
    await run(scripted(outputDir, GOOD_BOTH), outputDir, FS_AND_NEWS);

    const filtered = await run(scripted(outputDir, GOOD_BOTH), outputDir, FS_AND_NEWS, {
      serverFilter: ['news'],
      writeMergedArtifacts: true,
    });
    expect(filtered.error).toBeUndefined();
    expect(ruleNames(readJson<CompiledPolicyFile>(resolve(outputDir, 'compiled-policy.json')))).toEqual(['allow-news']);
  });
});
