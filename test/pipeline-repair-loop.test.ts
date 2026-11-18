/**
 * WP-58 regression tests for the compile-verify-repair loop.
 *
 *  - PIP-3: the run's verdict rests on the judge's structured verdict and the
 *    engine, never on the judge's prose. A judge rejection without a failing
 *    scenario is repaired from the judge's analysis or reported explicitly, and
 *    probes from the judge's final round are run before the verdict.
 *  - PIP-4: scenario corrections from the judge are keyed by result (not by
 *    description), never loosen an expectation to allow, and are accepted only
 *    after every scenario is replayed against the current rules.
 *
 * Every test drives the REAL PipelineRunner with scripted fake LLMs (no network).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type {
  CompiledPolicyFile,
  FailedServer,
  StoredToolAnnotationsFile,
  TestScenariosFile,
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
  CONSTITUTION,
  FS_AND_NEWS,
  FS_ONLY,
  FS_SCENARIOS,
  GOOD_FS,
  NEWS,
  NEWS_SCENARIOS,
  NO_CHANGE_PATCH,
  PASS,
  SANDBOX,
  rule,
} from './fixtures/two-server-pipeline-fixture.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeOutputDir(): string {
  const workDir = mkdtempSync(resolve(tmpdir(), 'ic-wp58-'));
  dirs.push(workDir);
  const outputDir = resolve(workDir, 'generated');
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

interface RunOutcome {
  readonly policy?: CompiledPolicyFile;
  readonly error?: unknown;
  readonly logs: string[];
  readonly warnings: string[];
  /** Errors the runner reported through ServerProgressReporter.fail. */
  readonly reportedErrors: Error[];
}

async function run(
  fake: ScriptedPipelineModels,
  outputDir: string,
  annotations: StoredToolAnnotationsFile,
  overrides: Partial<PipelineRunConfig> = {},
): Promise<RunOutcome> {
  const logs: string[] = [];
  const warnings: string[] = [];
  const reportedErrors: Error[] = [];
  const reporter: ServerProgressReporter = {
    update: () => {},
    complete: () => {},
    warn: (message) => warnings.push(message),
    fail: (_phase, error) => reportedErrors.push(error),
    done: () => {},
  };
  const config: PipelineRunConfig = {
    constitutionInput: CONSTITUTION,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: outputDir,
    allowedDirectory: SANDBOX,
    protectedPaths: [],
    preloadedStoredAnnotations: annotations,
    includeHandwrittenScenarios: false,
    quiet: true,
    reporterFactory: () => reporter,
    onProgress: (msg) => logs.push(msg),
    ...overrides,
  };
  try {
    const policy = await new PipelineRunner(fake.models).run(config);
    return { policy, logs, warnings, reportedErrors };
  } catch (error) {
    return { error, logs, warnings, reportedErrors };
  }
}

function scripted(outputDir: string, script: FakePhaseScript): ScriptedPipelineModels {
  return createScriptedPipelineModels(script, resolve(outputDir, '..', 'llm.jsonl'));
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

function callsOf(fake: ScriptedPipelineModels, phase: FakeLlmCall['phase']): FakeLlmCall[] {
  return fake.calls.filter((c) => c.phase === phase);
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function failedServersOf(err: unknown): readonly FailedServer[] {
  return typeof err === 'object' && err !== null
    ? ((err as { failedServers?: readonly FailedServer[] }).failedServers ?? [])
    : [];
}

function claimedSuccess(outcome: RunOutcome): boolean {
  return outcome.logs.some((l) => l.includes('Policy compilation successful'));
}

/** Expectations persisted with a committed (verified) server, by scenario path. */
function committedExpectations(outputDir: string, server: string): Record<string, string> {
  const file = readJson<TestScenariosFile>(serverFile(outputDir, server, 'test-scenarios.json'));
  return Object.fromEntries(file.scenarios.map((s) => [String(s.request.arguments.path), s.expectedDecision]));
}

function decisionFor(policy: CompiledPolicyFile, toolName: string, path: string): string {
  const engine = new PolicyEngine(policy, FS_ONLY, [], SANDBOX);
  return engine.evaluate({ requestId: 'r', serverName: 'fs', toolName, arguments: { path }, timestamp: '' }).decision;
}

const READ_SCENARIO = FS_SCENARIOS.scenarios[0];
const DELETE_SCENARIO = FS_SCENARIOS.scenarios[1];
const DELETE_DESCRIPTION = DELETE_SCENARIO.description;

/** A judge reply with no probes. */
function judgeReply(pass: boolean, analysis: string, failureAttributions: unknown[] = []) {
  return { analysis, pass, failureAttributions, additionalScenarios: [] };
}

function scenarioBlame(scenarioIndex: number, scenarioDescription: string, correctedDecision: string) {
  return {
    scenarioIndex,
    scenarioDescription,
    blame: {
      kind: 'scenario',
      reasoning: 'The rule is right; the expectation is wrong.',
      correctedDecision,
      correctedReasoning: `The constitution calls for ${correctedDecision}.`,
    },
  };
}

function ruleBlame(scenarioIndex: number, scenarioDescription: string) {
  return { scenarioIndex, scenarioDescription, blame: { kind: 'rule', reasoning: 'The rule is wrong.' } };
}

// ---------------------------------------------------------------------------
// PIP-3: the judge's structured verdict, not its prose
// ---------------------------------------------------------------------------

describe('judge verdict (PIP-3)', () => {
  /** The over-permissive allow-all-fs passes this scenario; only the judge objects. */
  const READ_ONLY_SCENARIOS = { scenarios: [READ_SCENARIO] };
  const REJECT_WITH_PASS_PROSE = judgeReply(
    false,
    'All 1 scenarios PASS, but allow-all-fs lets the agent bypass approval and delete files outside the sandbox.',
  );

  it('a judge pass:false whose prose contains "pass" does not report success', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [BAD_FS],
      scenarios: [READ_ONLY_SCENARIOS],
      judge: [REJECT_WITH_PASS_PROSE],
      repair: [NO_CHANGE_PATCH],
    });
    const outcome = await run(fake, outputDir, FS_ONLY);

    expect(outcome.policy).toBeUndefined();
    expect(claimedSuccess(outcome)).toBe(false);
    expect(errorCode(outcome.error)).toBe('ALL_SERVERS_FAILED');
    const [failure] = failedServersOf(outcome.error);
    expect(failure).toMatchObject({ serverName: 'fs', phase: 'verifying' });
    expect(failure.reason).toContain('rejected the policy without a failing scenario');
    expect(failure.reason).toContain('bypass approval');
    expect(existsSync(serverFile(outputDir, 'fs', 'compiled-policy.json'))).toBe(false);

    // The rejection was repaired from the judge's analysis (not dropped unrepaired).
    const repairs = callsOf(fake, 'repair');
    expect(repairs).toHaveLength(3);
    expect(repairs[0].userText).toContain('No scenario fails against the current rules');
    expect(repairs[0].userText).toContain('bypass approval');
    expect(callsOf(fake, 'judge')).toHaveLength(4);
  });

  it('reports the judge analysis in the failure as one escaped line', async () => {
    // Progress displays print a failed server's error message verbatim, and the
    // message quotes the judge's analysis (LLM output).
    const outputDir = makeOutputDir();
    const analysis = 'allow-all-fs is too broad.\nSecond line \u001b[2J\u001b]52;c;cHduZWQ=\u0007 done';
    const fake = scripted(outputDir, {
      compile: [BAD_FS],
      scenarios: [READ_ONLY_SCENARIOS],
      judge: [judgeReply(false, analysis)],
      repair: [NO_CHANGE_PATCH],
    });
    const outcome = await run(fake, outputDir, FS_ONLY);

    expect(errorCode(outcome.error)).toBe('ALL_SERVERS_FAILED');
    expect(outcome.reportedErrors).toHaveLength(1);
    const [reported] = outcome.reportedErrors;
    expect(reported.message).toContain('allow-all-fs is too broad.\\nSecond line \\u001b[2J\\u001b]52;c;');
    // eslint-disable-next-line no-control-regex -- asserting that no raw control character survives
    expect(reported.message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('with two servers, the rejected server is left out and the run does not claim success', async () => {
    const outputDir = makeOutputDir();
    const isFs = (call: FakeLlmCall): boolean => call.system.includes('read_file');
    const outcome = await run(
      scripted(outputDir, {
        compile: [(call: FakeLlmCall) => (call.system.includes('for the "fs" server') ? BAD_FS : NEWS)],
        scenarios: [(call: FakeLlmCall) => (isFs(call) ? READ_ONLY_SCENARIOS : NEWS_SCENARIOS)],
        judge: [(call: FakeLlmCall) => (call.system.includes('allow-all-fs') ? REJECT_WITH_PASS_PROSE : PASS)],
        repair: [NO_CHANGE_PATCH],
      }),
      outputDir,
      FS_AND_NEWS,
    );

    expect(outcome.error).toBeUndefined();
    expect(ruleNames(outcome.policy)).toEqual(['allow-news']);
    expect(outcome.policy?.failedServers?.map((f) => f.serverName)).toEqual(['fs']);
    expect(claimedSuccess(outcome)).toBe(false);
  });

  it('a judge rejection without a failing scenario is repaired from its analysis', async () => {
    const outputDir = makeOutputDir();
    const fixPatch = {
      reasoning: 'Replace the server-wide allow with a read-only allow.',
      operations: [
        { op: 'delete', ruleName: 'allow-all-fs' },
        { op: 'add', rule: rule('allow-fs-reads', 'fs', { tool: ['read_file'] }) },
      ],
    };
    const fake = scripted(outputDir, {
      compile: [BAD_FS],
      scenarios: [READ_ONLY_SCENARIOS],
      judge: [REJECT_WITH_PASS_PROSE, PASS],
      repair: [fixPatch],
    });
    const outcome = await run(fake, outputDir, FS_ONLY);

    expect(outcome.error).toBeUndefined();
    expect(ruleNames(outcome.policy)).toEqual(['allow-fs-reads']);
    expect(callsOf(fake, 'repair')).toHaveLength(1);
    expect(callsOf(fake, 'judge')).toHaveLength(2);
    expect(claimedSuccess(outcome)).toBe(true);
  });

  it("runs the judge's final-round probe before accepting the policy", async () => {
    const outputDir = makeOutputDir();
    const readProbe = (n: number) => ({
      description: `read another file (${n})`,
      request: { serverName: 'fs', toolName: 'read_file', arguments: { path: `/etc/probe-${n}` } },
      expectedDecision: 'allow',
      reasoning: 'Reading anywhere is fine.',
    });
    const deleteProbe = {
      description: 'delete a system file',
      request: { serverName: 'fs', toolName: 'delete_file', arguments: { path: '/etc/shadow-copy' } },
      expectedDecision: 'deny',
      reasoning: 'Deleting outside the sandbox is forbidden.',
    };
    const probing = (probe: unknown) => ({
      analysis: 'All scenarios pass; probing further.',
      pass: true,
      failureAttributions: [],
      additionalScenarios: [probe],
    });
    // Follow-up verifications show the probe as [4] (1 scenario + 3 probes).
    const rejectProbe = judgeReply(false, 'FAIL: allow-all-fs allows deleting system files.', [
      ruleBlame(4, 'delete a system file'),
    ]);
    const fake = scripted(outputDir, {
      compile: [BAD_FS],
      scenarios: [READ_ONLY_SCENARIOS],
      // The initial verification has 3 rounds: the delete probe comes in the last one.
      judge: [probing(readProbe(1)), probing(readProbe(2)), probing(deleteProbe), rejectProbe],
      repair: [NO_CHANGE_PATCH],
    });
    const outcome = await run(fake, outputDir, FS_ONLY);

    expect(outcome.policy).toBeUndefined();
    expect(claimedSuccess(outcome)).toBe(false);
    const repairs = callsOf(fake, 'repair');
    expect(repairs.length).toBeGreaterThan(0);
    // The first repair sees the unreviewed probe failure, marked as such.
    expect(repairs[0].userText).toContain('delete a system file\n  Expected: deny, Got: allow (rule: allow-all-fs)');
    expect(repairs[0].userText).toContain('the judge never reviewed this result');
  });
});

// ---------------------------------------------------------------------------
// PIP-4: scenario corrections are re-verified and fail closed
// ---------------------------------------------------------------------------

describe('scenario corrections (PIP-4)', () => {
  it('a correction that does not match the engine decision is rule-blamed, not accepted', async () => {
    const outputDir = makeOutputDir();
    // BAD_FS allows the delete; the judge "corrects" deny to escalate, which
    // still contradicts the engine's allow.
    for (const judgePass of [false, true]) {
      const fake = scripted(outputDir, {
        compile: [BAD_FS],
        scenarios: [FS_SCENARIOS],
        judge: [
          judgeReply(judgePass, 'The delete expectation is wrong.', [scenarioBlame(2, DELETE_DESCRIPTION, 'escalate')]),
        ],
        repair: [NO_CHANGE_PATCH],
      });
      const outcome = await run(fake, outputDir, FS_ONLY);

      expect(outcome.policy).toBeUndefined();
      expect(errorCode(outcome.error)).toBe('ALL_SERVERS_FAILED');
      expect(existsSync(serverFile(outputDir, 'fs', 'test-scenarios.json'))).toBe(false);
      const repairs = callsOf(fake, 'repair');
      expect(repairs.length).toBeGreaterThan(0);
      expect(repairs[0].userText).toContain(
        `${DELETE_DESCRIPTION}\n  Expected: escalate, Got: allow (rule: allow-all-fs)`,
      );
      expect(outcome.warnings.some((w) => w.includes('does not match the engine'))).toBe(true);
    }
  });

  it('a consistent correction with judge approval passes after a replay, without a repair', async () => {
    const outputDir = makeOutputDir();
    // GOOD_FS default-denies the delete; the scenario wrongly expected escalate.
    const scenarios = { scenarios: [READ_SCENARIO, { ...DELETE_SCENARIO, expectedDecision: 'escalate' }] };
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [scenarios],
      judge: [
        judgeReply(true, 'Rules are right; the delete expectation is wrong.', [
          scenarioBlame(2, DELETE_DESCRIPTION, 'deny'),
        ]),
      ],
    });
    const outcome = await run(fake, outputDir, FS_ONLY);

    expect(outcome.error).toBeUndefined();
    expect(ruleNames(outcome.policy)).toEqual(['allow-fs-reads']);
    expect(callsOf(fake, 'repair')).toHaveLength(0);
    expect(callsOf(fake, 'judge')).toHaveLength(1);
    expect(committedExpectations(outputDir, 'fs')).toEqual({ '/etc/hosts': 'allow', '/etc/passwd': 'deny' });
    expect(outcome.logs).toContain('  Scenarios tested: 2');
  });

  it('after corrections a judge rejection is re-verified, not shortcut to a pass', async () => {
    const outputDir = makeOutputDir();
    const scenarios = { scenarios: [READ_SCENARIO, { ...DELETE_SCENARIO, expectedDecision: 'escalate' }] };
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [scenarios],
      judge: [
        judgeReply(false, 'FAIL [2]: the delete expectation is wrong.', [scenarioBlame(2, DELETE_DESCRIPTION, 'deny')]),
        PASS,
      ],
    });
    const outcome = await run(fake, outputDir, FS_ONLY);

    expect(outcome.error).toBeUndefined();
    expect(callsOf(fake, 'repair')).toHaveLength(0);
    const judges = callsOf(fake, 'judge');
    expect(judges).toHaveLength(2);
    // The second judge saw the corrected expectation pass against the same rules.
    expect(judges[1].userText).toContain(`[2] PASS: ${DELETE_DESCRIPTION} → deny`);
    expect(committedExpectations(outputDir, 'fs')['/etc/passwd']).toBe('deny');
  });

  it('a "both" blame is repaired even when its correction clears the failure and the judge approves', async () => {
    const outputDir = makeOutputDir();
    // GOOD_FS default-denies the delete; the scenario wrongly expected escalate.
    // The judge corrects it to deny AND asks for a rule change (blame "both").
    const scenarios = { scenarios: [READ_SCENARIO, { ...DELETE_SCENARIO, expectedDecision: 'escalate' }] };
    const both = {
      scenarioIndex: 2,
      scenarioDescription: DELETE_DESCRIPTION,
      blame: {
        kind: 'both',
        reasoning: 'allow-fs-reads should not cover /etc/shadow.',
        correctedDecision: 'deny',
        correctedReasoning: 'Deleting outside the sandbox is forbidden.',
      },
    };
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [scenarios],
      judge: [judgeReply(true, 'allow-fs-reads must exclude /etc/shadow.', [both]), PASS],
      repair: [NO_CHANGE_PATCH],
    });
    const outcome = await run(fake, outputDir, FS_ONLY);

    // The rule change the judge asked for goes to the repair compiler before any pass.
    const repairs = callsOf(fake, 'repair');
    expect(repairs).toHaveLength(1);
    expect(repairs[0].userText).toContain('the verifier judge did not approve them');
    expect(repairs[0].userText).toContain('allow-fs-reads must exclude /etc/shadow.');
    expect(callsOf(fake, 'judge')).toHaveLength(2);
    // The follow-up judge approved the (corrected) scenarios.
    expect(outcome.error).toBeUndefined();
    expect(committedExpectations(outputDir, 'fs')['/etc/passwd']).toBe('deny');
  });

  it('a correction that newly expects allow is not applied', async () => {
    const outputDir = makeOutputDir();
    // GOOD_FS allows reads; the scenario expected escalate and the judge wants allow.
    const scenarios = { scenarios: [{ ...READ_SCENARIO, expectedDecision: 'escalate' }, DELETE_SCENARIO] };
    const readDescription = READ_SCENARIO.description;
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [scenarios],
      judge: [judgeReply(true, 'Reads are fine anywhere.', [scenarioBlame(1, readDescription, 'allow')])],
      repair: [NO_CHANGE_PATCH],
    });
    const outcome = await run(fake, outputDir, FS_ONLY);

    expect(outcome.policy).toBeUndefined();
    expect(errorCode(outcome.error)).toBe('ALL_SERVERS_FAILED');
    const repairs = callsOf(fake, 'repair');
    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs[0].userText).toContain(
      `${readDescription}\n  Expected: escalate, Got: allow (rule: allow-fs-reads)`,
    );
    expect(repairs[0].userText).toContain('never loosened to allow automatically');
    // The inspection copy keeps the original expectation.
    const unverified = readJson<TestScenariosFile>(serverFile(outputDir, 'fs', 'test-scenarios.unverified.json'));
    expect(unverified.scenarios.find((s) => s.description === readDescription)?.expectedDecision).toBe('escalate');
  });

  it('two failures that share a description are attributed by index', async () => {
    const outputDir = makeOutputDir();
    const dataDir = '/wp58/data';
    const scratchDir = '/wp58/scratch';
    const rules = {
      rules: [
        rule('allow-fs-reads', 'fs', { tool: ['read_file'] }),
        rule('escalate-data-deletes', 'fs', { paths: { roles: ['delete-path'], within: dataDir } }, 'escalate'),
        rule('allow-scratch-deletes', 'fs', { paths: { roles: ['delete-path'], within: scratchDir } }),
      ],
    };
    const deleteIn = (dir: string) => ({
      ...DELETE_SCENARIO,
      request: { ...DELETE_SCENARIO.request, arguments: { path: `${dir}/file.txt` } },
    });
    // [2] escalates (the expectation is wrong), [3] is allowed (the rule is wrong).
    const scenarios = { scenarios: [READ_SCENARIO, deleteIn(dataDir), deleteIn(scratchDir)] };
    // The scenario blame comes last: keyed by description it used to hide the rule blame.
    const dupReject = judgeReply(false, 'FAIL: deletes in the scratch area must not be allowed.', [
      ruleBlame(3, DELETE_DESCRIPTION),
      scenarioBlame(2, DELETE_DESCRIPTION, 'escalate'),
    ]);
    const fixPatch = {
      reasoning: 'Remove the scratch allow.',
      operations: [{ op: 'delete', ruleName: 'allow-scratch-deletes' }],
    };
    const fake = scripted(outputDir, {
      compile: [rules],
      scenarios: [scenarios],
      judge: [dupReject, PASS],
      repair: [fixPatch],
    });
    const outcome = await run(fake, outputDir, FS_ONLY);

    expect(outcome.error).toBeUndefined();
    const repairs = callsOf(fake, 'repair');
    expect(repairs).toHaveLength(1);
    // Only the rule-blamed failure goes to the repair compiler.
    expect(repairs[0].userText).toContain('Expected: deny, Got: allow (rule: allow-scratch-deletes)');
    expect(repairs[0].userText).not.toContain('rule: escalate-data-deletes');
    expect(ruleNames(outcome.policy)).toEqual(['allow-fs-reads', 'escalate-data-deletes']);
    if (!outcome.policy) throw new Error('no policy');
    expect(decisionFor(outcome.policy, 'delete_file', `${scratchDir}/file.txt`)).toBe('deny');
    // Only the attributed scenario was corrected.
    expect(committedExpectations(outputDir, 'fs')).toEqual({
      '/etc/hosts': 'allow',
      [`${dataDir}/file.txt`]: 'escalate',
      [`${scratchDir}/file.txt`]: 'deny',
    });
  });
});

// ---------------------------------------------------------------------------
// Live tool schemas (WP-27): every check and every replay validates the same way
// ---------------------------------------------------------------------------

describe('live tool schemas', () => {
  // The live fs server renamed delete_file's `path` to `target`. A delete that
  // passes `path` still matches the stored schema, but the live server rejects
  // that call, so neither verification nor any replay may run it.
  const LIVE_RENAMED_DELETE = new Map<string, Record<string, unknown>>([
    ['fs__delete_file', { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }],
  ]);
  /** GOOD_FS default-denies deletes, so this scenario fails whenever it is run. */
  const STALE_DELETE = {
    ...DELETE_SCENARIO,
    description: 'delete a file with the stale argument name',
    expectedDecision: 'escalate',
  };
  const SCENARIOS_WITH_STALE_DELETE = { scenarios: [READ_SCENARIO, STALE_DELETE] };
  /** The scenario-repair turn cannot use `target` (only stored names), so it replaces nothing. */
  const NO_REPLACEMENT = { scenarios: [] };

  it('the commit replay leaves out a scenario the live schema rejects, as verification did', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [SCENARIOS_WITH_STALE_DELETE],
      scenarioRepair: [NO_REPLACEMENT],
      judge: [PASS],
    });
    const outcome = await run(fake, outputDir, FS_ONLY, { liveToolSchemas: LIVE_RENAMED_DELETE });

    expect(outcome.error).toBeUndefined();
    expect(ruleNames(outcome.policy)).toEqual(['allow-fs-reads']);
    const judges = callsOf(fake, 'judge');
    expect(judges).toHaveLength(1);
    expect(judges[0].userText).not.toContain(STALE_DELETE.description);
    expect(
      outcome.warnings.some((w) => w.includes('Discarded (schema mismatch)') && w.includes(STALE_DELETE.description)),
    ).toBe(true);
    // The replay ran exactly the one scenario verification ran.
    expect(outcome.logs).toContain('  Scenarios tested: 1');
  });

  it('a follow-up verification leaves out a scenario the live schema rejects', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [SCENARIOS_WITH_STALE_DELETE],
      scenarioRepair: [NO_REPLACEMENT],
      // A rejection without a failing scenario: repaired, then verified again.
      judge: [judgeReply(false, 'Coverage of deletes is too thin.'), PASS],
      repair: [NO_CHANGE_PATCH],
    });
    const outcome = await run(fake, outputDir, FS_ONLY, { liveToolSchemas: LIVE_RENAMED_DELETE });

    expect(outcome.error).toBeUndefined();
    expect(callsOf(fake, 'repair')).toHaveLength(1);
    const judges = callsOf(fake, 'judge');
    expect(judges).toHaveLength(2);
    for (const judge of judges) expect(judge.userText).not.toContain(STALE_DELETE.description);
    expect(outcome.logs).toContain('  Scenarios tested: 1');
  });

  /** A judge approval that asks for a probe the live schema rejects (it would fail if run). */
  const PROBING_STALE_DELETE = {
    analysis: 'Reads are fine; probing a delete.',
    pass: true,
    failureAttributions: [],
    additionalScenarios: [
      {
        description: 'probe a delete with the stale argument name',
        request: { serverName: 'fs', toolName: 'delete_file', arguments: { path: '/etc/shadow-copy' } },
        expectedDecision: 'escalate',
        reasoning: 'Deletes need approval.',
      },
    ],
  };

  it('verification drops a judge probe the live schema rejects instead of running it', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [{ scenarios: [READ_SCENARIO] }],
      judge: [PROBING_STALE_DELETE, PASS],
    });
    const outcome = await run(fake, outputDir, FS_ONLY, { liveToolSchemas: LIVE_RENAMED_DELETE });

    expect(outcome.error).toBeUndefined();
    // Dropped inside verifyPolicy: no further round ran it and nothing failed.
    expect(callsOf(fake, 'judge')).toHaveLength(1);
    expect(outcome.warnings.some((w) => w.includes('Verification FAILED'))).toBe(false);
    expect(outcome.logs).toContain('  Scenarios tested: 1');
  });

  it('a follow-up verification drops a judge probe the live schema rejects instead of running it', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [{ scenarios: [READ_SCENARIO] }],
      judge: [judgeReply(false, 'Coverage of deletes is too thin.'), PROBING_STALE_DELETE, PASS],
      repair: [NO_CHANGE_PATCH],
    });
    const outcome = await run(fake, outputDir, FS_ONLY, { liveToolSchemas: LIVE_RENAMED_DELETE });

    expect(outcome.error).toBeUndefined();
    expect(callsOf(fake, 'repair')).toHaveLength(1);
    // The follow-up verification ended after its first round: the probe never ran.
    expect(callsOf(fake, 'judge')).toHaveLength(2);
    expect(outcome.logs).toContain('  Scenarios tested: 1');
  });
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

describe('run summary', () => {
  it('counts only scenarios run against the final rules as tested', async () => {
    const outputDir = makeOutputDir();
    const first = await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
    );
    expect(first.logs).toContain('  Scenarios tested: 2');

    // Served from the verified cache: nothing is run in this run.
    const cached = await run(createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl')), outputDir, FS_ONLY);
    expect(cached.error).toBeUndefined();
    expect(cached.logs).toContain('  Scenarios tested: 0 (1 server(s) from cache, verified in an earlier run)');
  });
});
