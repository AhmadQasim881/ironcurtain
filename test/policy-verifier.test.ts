import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  verifyPolicy,
  executeScenarios,
  filterStructuralConflicts,
  formatCompactResults,
  formatFailedResults,
  resolveFailureAttributions,
  triageVerificationFailures,
  applyScenarioCorrections,
  UNATTRIBUTED_FAILURE_NOTE,
  UNJUDGED_PROBE_NOTE,
} from '../src/pipeline/policy-verifier.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { liveSchemaKey, type LiveSchemaIndex } from '../src/pipeline/scenario-schema-validator.js';
import type {
  AttributedFailure,
  CompiledPolicyFile,
  Decision,
  ExecutionResult,
  FailureBlame,
  ScenarioCorrection,
  ScenarioDecision,
  TestScenario,
  VerificationResult,
} from '../src/pipeline/types.js';
import { getHandwrittenScenarios } from '../src/pipeline/handwritten-scenarios.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_SANDBOX_DIR,
  TEST_PROTECTED_PATHS,
  TEST_DOMAIN_ALLOWLISTS,
} from './fixtures/test-policy.js';

const protectedPaths = TEST_PROTECTED_PATHS;
const SANDBOX_DIR = TEST_SANDBOX_DIR;
const scenarios = getHandwrittenScenarios(SANDBOX_DIR);

const constitutionText = `# Constitution
1. Least privilege
2. No destruction
3. Containment
4. Transparency
5. Human oversight
6. Self-protection`;

/** Builds a mock V3 result with correct finishReason/usage shapes. */
function mockV3Result(responseJson: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(responseJson) }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [] as never[],
    request: {},
    response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
  };
}

function createPassingJudge(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () =>
      mockV3Result({
        analysis: 'All scenarios pass. Policy correctly implements the constitution.',
        pass: true,
        failureAttributions: [],
        additionalScenarios: [],
      }),
  });
}

function createMultiRoundJudge(): MockLanguageModelV3 {
  let callCount = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      callCount++;
      const isFirstRound = callCount === 1;

      const response = isFirstRound
        ? {
            analysis: 'Some scenarios pass but need to probe edge cases.',
            pass: false,
            failureAttributions: [],
            additionalScenarios: [
              {
                description: 'Read file at sandbox boundary',
                request: {
                  serverName: 'filesystem',
                  toolName: 'read_file',
                  arguments: { path: `${TEST_SANDBOX_DIR}/deep/nested/file.txt` },
                },
                expectedDecision: 'allow' as const,
                reasoning: 'Nested path within sandbox should be allowed',
              },
            ],
          }
        : {
            analysis: 'All scenarios including probes pass. Policy is correct.',
            pass: true,
            failureAttributions: [],
            additionalScenarios: [],
          };

      return mockV3Result(response);
    },
  });
}

describe('Policy Verifier', () => {
  it('reports pass when all scenarios match expected decisions', async () => {
    const judge = createPassingJudge();

    const result = await verifyPolicy(
      constitutionText,
      testCompiledPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      judge,
      3,
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
      undefined,
      undefined,
      undefined,
      [],
    );

    expect(result.pass).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.summary).toContain('pass');
  });

  it('executes all scenarios against the real engine', async () => {
    const judge = createPassingJudge();

    const result = await verifyPolicy(
      constitutionText,
      testCompiledPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      judge,
      3,
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
      undefined,
      undefined,
      undefined,
      [],
    );

    const executionResults = result.rounds[0].executionResults;
    expect(executionResults).toHaveLength(scenarios.length);

    // All handwritten scenarios should match expected decisions
    for (const er of executionResults) {
      expect(er.pass).toBe(true);
    }
  });

  it('supports multi-round verification', async () => {
    const judge = createMultiRoundJudge();

    const result = await verifyPolicy(
      constitutionText,
      testCompiledPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      judge,
      3,
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
      undefined,
      undefined,
      undefined,
      [],
    );

    expect(result.pass).toBe(true);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].newScenarios).toHaveLength(1);
    expect(result.rounds[1].executionResults).toHaveLength(1);
  });

  it('detects failures with a bad policy (overly broad allow)', async () => {
    // Create a policy where reads AND writes are allowed unconditionally.
    // This causes read-outside and write-outside scenarios (expected escalate)
    // to get allow instead. Per-role evaluation still correctly denies
    // move_file via the delete-path role, so we check escalate->allow flips.
    const badPolicy: CompiledPolicyFile = {
      ...testCompiledPolicy,
      rules: [
        {
          name: 'allow-all-reads',
          description: 'Overly broad: allow all read operations',
          principle: 'Broken rule',
          if: { roles: ['read-path'] },
          then: 'allow',
          reason: 'Allow all reads',
        },
        {
          name: 'allow-all-writes',
          description: 'Overly broad: allow all write operations',
          principle: 'Broken rule',
          if: { roles: ['write-path'] },
          then: 'allow',
          reason: 'Allow all writes',
        },
        ...testCompiledPolicy.rules.filter((r) => !r.name.includes('read') && !r.name.includes('write')),
      ],
    };

    // Judge that reports failure
    const failJudge = new MockLanguageModelV3({
      doGenerate: async () =>
        mockV3Result({
          analysis: 'Outside-sandbox scenarios fail -- reads and writes are allowed everywhere.',
          pass: false,
          failureAttributions: [],
          additionalScenarios: [],
        }),
    });

    const result = await verifyPolicy(
      constitutionText,
      badPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      failJudge,
      3,
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
      undefined,
      undefined,
      undefined,
      [],
    );

    expect(result.pass).toBe(false);
    expect(result.failedScenarios.length).toBeGreaterThan(0);

    // Outside-sandbox scenarios should fail: expected not-allow, got allow
    const notAllowFailures = result.failedScenarios.filter(
      (f) => f.scenario.expectedDecision === 'not-allow' && f.actualDecision === 'allow',
    );
    expect(notAllowFailures.length).toBeGreaterThan(0);
  });

  it('respects maxRounds limit', async () => {
    // Judge that always generates new scenarios
    let callCount = 0;
    const infiniteJudge = new MockLanguageModelV3({
      doGenerate: async () => {
        callCount++;
        return mockV3Result({
          analysis: `Round ${callCount}: generating more probes.`,
          pass: false,
          failureAttributions: [],
          additionalScenarios: [
            {
              description: `Probe scenario ${callCount}`,
              request: {
                serverName: 'filesystem',
                toolName: 'read_file',
                arguments: { path: `/tmp/ironcurtain-sandbox/probe-${callCount}.txt` },
              },
              expectedDecision: 'allow' as const,
              reasoning: 'Read within sandbox',
            },
          ],
        });
      },
    });

    const result = await verifyPolicy(
      constitutionText,
      testCompiledPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      infiniteJudge,
      2, // limit to 2 rounds
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
      undefined,
      undefined,
      undefined,
      [],
    );

    expect(result.rounds).toHaveLength(2);
  });
});

describe('filterStructuralConflicts', () => {
  const engine = new PolicyEngine(
    testCompiledPolicy,
    testToolAnnotations,
    protectedPaths,
    SANDBOX_DIR,
    TEST_DOMAIN_ALLOWLISTS,
  );

  it('discards scenarios that conflict with structural invariants', () => {
    const conflictingScenario: TestScenario = {
      description: 'Get file info on constitution.md',
      request: {
        serverName: 'filesystem',
        toolName: 'get_file_info',
        arguments: { path: protectedPaths[0] },
      },
      expectedDecision: 'escalate', // Wrong — structural invariant denies this
      reasoning: 'Protected path access should be escalated',
      source: 'generated',
    };

    const validScenario: TestScenario = {
      description: 'Read file in sandbox',
      request: {
        serverName: 'filesystem',
        toolName: 'read_file',
        arguments: { path: `${SANDBOX_DIR}/test.txt` },
      },
      expectedDecision: 'allow',
      reasoning: 'Sandbox reads are allowed',
      source: 'generated',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [conflictingScenario, validScenario]);

    expect(valid).toHaveLength(1);
    expect(valid[0].description).toBe('Read file in sandbox');
    expect(discarded).toHaveLength(1);
    expect(discarded[0].scenario.description).toBe('Get file info on constitution.md');
    expect(discarded[0].actual).toBe('deny');
    expect(discarded[0].rule).toBe('structural-protected-path');
  });

  it('keeps scenarios that agree with structural invariants', () => {
    const correctScenario: TestScenario = {
      description: 'Deny write to protected path',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: protectedPaths[0], content: 'hack' },
      },
      expectedDecision: 'deny', // Correct — matches structural invariant
      reasoning: 'Protected path writes are denied',
      source: 'generated',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [correctScenario]);

    expect(valid).toHaveLength(1);
    expect(discarded).toHaveLength(0);
  });

  it('treats the domain gate as final only for an allow expectation', () => {
    // escalate-git-remote-ops escalates pushes; off the git allowlist the gate
    // escalates too. A compiled (default) deny would still win over the gate.
    const push = (expectedDecision: 'allow' | 'deny'): TestScenario => ({
      description: `Push to an unknown host (${expectedDecision})`,
      request: {
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: '/home/wp58/repo', remote: 'https://evil.example/repo.git', branch: 'main' },
      },
      expectedDecision,
      reasoning: 'r',
      source: 'generated',
    });
    const allowPush = push('allow');
    const denyPush = push('deny');
    expect(executeScenarios(engine, [denyPush])[0]).toMatchObject({
      actualDecision: 'escalate',
      matchingRule: 'structural-domain-escalate',
      pass: false,
    });

    const { valid, discarded } = filterStructuralConflicts(engine, [allowPush, denyPush]);

    // allow is unreachable under the gate; deny is reachable by narrowing the compiled rules.
    expect(discarded.map((d) => d.scenario)).toEqual([allowPush]);
    expect(valid).toEqual([denyPush]);
  });

  it('keeps scenarios resolved by compiled rules (non-structural)', () => {
    const outsideReadScenario: TestScenario = {
      description: 'Read file outside sandbox',
      request: {
        serverName: 'filesystem',
        toolName: 'read_file',
        arguments: { path: '/etc/passwd' },
      },
      expectedDecision: 'escalate',
      reasoning: 'Reads outside sandbox are escalated',
      source: 'generated',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [outsideReadScenario]);

    expect(valid).toHaveLength(1);
    expect(discarded).toHaveLength(0);
  });

  it('discards scenarios that expect allow for unknown tools', () => {
    const unknownToolScenario: TestScenario = {
      description: 'Call unknown tool',
      request: {
        serverName: 'filesystem',
        toolName: 'totally_unknown_tool',
        arguments: {},
      },
      expectedDecision: 'allow', // Wrong — structural invariant denies unknown tools
      reasoning: 'Should be allowed',
      source: 'generated',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [unknownToolScenario]);

    expect(valid).toHaveLength(0);
    expect(discarded).toHaveLength(1);
    expect(discarded[0].rule).toBe('structural-unknown-tool');
  });

  it('preserves handwritten scenarios even when conflicting', () => {
    // Handwritten scenarios that conflict are still kept in the valid set
    // (the caller in compile.ts handles them specially via logging)
    // filterStructuralConflicts itself is source-agnostic
    const handwrittenConflict: TestScenario = {
      description: 'Handwritten: get info on constitution',
      request: {
        serverName: 'filesystem',
        toolName: 'get_file_info',
        arguments: { path: protectedPaths[0] },
      },
      expectedDecision: 'escalate',
      reasoning: 'Should escalate',
      source: 'handwritten',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [handwrittenConflict]);

    // filterStructuralConflicts discards regardless of source — the caller
    // inspects discarded[].scenario.source for special handling
    expect(valid).toHaveLength(0);
    expect(discarded).toHaveLength(1);
    expect(discarded[0].scenario.source).toBe('handwritten');
  });
});

describe('formatCompactResults', () => {
  const passingResult: ExecutionResult = {
    scenario: {
      description: 'Read file in sandbox',
      request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/sandbox/test.txt' } },
      expectedDecision: 'allow',
      reasoning: 'Sandbox reads allowed',
      source: 'generated',
    },
    actualDecision: 'allow',
    matchingRule: 'structural-sandbox',
    pass: true,
  };

  const failingResult: ExecutionResult = {
    scenario: {
      description: 'Write outside sandbox',
      request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/etc/hosts', content: 'x' } },
      expectedDecision: 'deny',
      reasoning: 'Outside writes denied',
      source: 'generated',
    },
    actualDecision: 'allow',
    matchingRule: 'allow-all-writes',
    pass: false,
  };

  it('renders passing scenarios as compact one-liners', () => {
    const output = formatCompactResults([passingResult]);
    expect(output).toContain('PASS: Read file in sandbox');
    expect(output).toContain('structural-sandbox');
    // Should NOT contain verbose fields
    expect(output).not.toContain('Tool:');
    expect(output).not.toContain('Args:');
    expect(output).not.toContain('Source:');
  });

  it('renders failing scenarios with full verbose details', () => {
    const output = formatCompactResults([failingResult]);
    expect(output).toContain('FAIL: Write outside sandbox');
    expect(output).toContain('Tool: filesystem/write_file');
    expect(output).toContain('Args:');
    expect(output).toContain('Expected: deny');
    expect(output).toContain('Actual: allow');
    expect(output).toContain('Source: generated');
  });

  it('mixes compact passes and verbose fails', () => {
    const output = formatCompactResults([passingResult, failingResult]);
    const lines = output.split('\n');
    // First entry is a one-liner pass
    expect(lines[0]).toMatch(/^\[1\] PASS:/);
    // Second entry is a multi-line fail
    expect(output).toContain('[2] FAIL:');
    expect(output).toContain('Tool:');
  });
});

// ---------------------------------------------------------------------------
// PIP-3: the verdict rests on the judge's structured verdict and the engine
// ---------------------------------------------------------------------------

/** A server-wide filesystem allow: lets the agent move or delete files anywhere. */
const overPermissivePolicy: CompiledPolicyFile = {
  ...testCompiledPolicy,
  rules: [
    {
      name: 'allow-filesystem-all',
      description: 'Allow every filesystem operation',
      principle: 'Broken rule',
      if: { server: ['filesystem'] },
      then: 'allow',
      reason: 'Over-broad',
    },
    ...testCompiledPolicy.rules,
  ],
};

/** Allows reads anywhere and nothing else beyond the fixture rules. */
const readsAllowedPolicy: CompiledPolicyFile = {
  ...testCompiledPolicy,
  rules: [
    {
      name: 'allow-filesystem-reads',
      description: 'Allow reads anywhere',
      principle: 'Reading is fine',
      if: { server: ['filesystem'], roles: ['read-path'] },
      then: 'allow',
      reason: 'Reads are harmless',
    },
    ...testCompiledPolicy.rules,
  ],
};

/** Passes under both policies above. */
const readOutsideSandbox: TestScenario = {
  description: 'Read a file outside the sandbox',
  request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/etc/hostname' } },
  expectedDecision: 'allow',
  reasoning: 'Reading is fine',
  source: 'generated',
};

/** A judge probe that the over-permissive policy fails (it allows the move). */
function moveOutsideProbe(n: number) {
  return {
    description: `Moving a file outside the sandbox must be denied (${n})`,
    request: {
      serverName: 'filesystem',
      toolName: 'move_file',
      arguments: { source: `/etc/wp58-app-${n}.conf`, destination: `/var/wp58-backup-${n}.conf` },
    },
    expectedDecision: 'deny' as const,
    reasoning: 'Deleting outside the sandbox is forbidden',
  };
}

/** A judge probe that both policies above pass. */
function readOutsideProbe(n: number) {
  return {
    description: `Read another file outside the sandbox (${n})`,
    request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: `/etc/wp58-probe-${n}.txt` } },
    expectedDecision: 'allow' as const,
    reasoning: 'Reading is fine',
  };
}

interface JudgeReply {
  analysis: string;
  pass: boolean;
  failureAttributions: unknown[];
  additionalScenarios: unknown[];
}

/** A judge replaying `replies` in order (the last one repeats), counting its calls. */
function scriptedJudge(replies: JudgeReply[]): { judge: MockLanguageModelV3; calls: () => number } {
  let calls = 0;
  const judge = new MockLanguageModelV3({
    doGenerate: async () => {
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls++;
      return mockV3Result(reply);
    },
  });
  return { judge, calls: () => calls };
}

function verifyWith(
  policy: CompiledPolicyFile,
  scenarioList: TestScenario[],
  judge: MockLanguageModelV3,
  maxRounds: number,
  liveSchemas?: LiveSchemaIndex,
  onProgress?: (message: string) => void,
): Promise<VerificationResult> {
  return verifyPolicy(
    constitutionText,
    policy,
    testToolAnnotations,
    protectedPaths,
    scenarioList,
    judge,
    maxRounds,
    SANDBOX_DIR,
    onProgress,
    TEST_DOMAIN_ALLOWLISTS,
    undefined,
    undefined,
    undefined,
    [],
    liveSchemas,
  );
}

describe('verifyPolicy verdict (PIP-3)', () => {
  it('(A) a judge rejection fails verification even when its prose contains "pass"', async () => {
    for (const analysis of [
      'allow-filesystem-all lets the agent bypass approval for moves outside the sandbox.',
      'All 1 scenarios PASS, but allow-filesystem-all is far broader than the constitution permits.',
    ]) {
      const { judge } = scriptedJudge([{ analysis, pass: false, failureAttributions: [], additionalScenarios: [] }]);
      const result = await verifyWith(overPermissivePolicy, [readOutsideSandbox], judge, 3);

      expect(result.failedScenarios).toEqual([]);
      expect(result.rounds.map((r) => r.judgePass)).toEqual([false]);
      expect(result.pass).toBe(false);
    }
  });

  it('(B) runs the final round probes before the verdict when maxRounds is 1', async () => {
    const probe = moveOutsideProbe(1);
    const { judge, calls } = scriptedJudge([
      {
        analysis: 'Scenarios pass; probing moves outside the sandbox.',
        pass: true,
        failureAttributions: [],
        additionalScenarios: [probe],
      },
    ]);
    const result = await verifyWith(overPermissivePolicy, [readOutsideSandbox], judge, 1);

    expect(calls()).toBe(1);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].unjudgedResults).toEqual([
      expect.objectContaining({ actualDecision: 'allow', matchingRule: 'allow-filesystem-all', pass: false }),
    ]);
    expect(result.failedScenarios.map((f) => f.scenario.description)).toEqual([probe.description]);
    expect(result.pass).toBe(false);
    expect(result.summary).toContain('the judge has not reviewed them');
  });

  it('(B3) runs the round-3 probe when maxRounds is 3', async () => {
    const probe = moveOutsideProbe(3);
    const { judge, calls } = scriptedJudge([
      {
        analysis: 'Round 1 passes; probing reads.',
        pass: true,
        failureAttributions: [],
        additionalScenarios: [readOutsideProbe(1)],
      },
      {
        analysis: 'Round 2 passes; probing reads.',
        pass: true,
        failureAttributions: [],
        additionalScenarios: [readOutsideProbe(2)],
      },
      {
        analysis: 'Round 3 passes; one last check on moves.',
        pass: true,
        failureAttributions: [],
        additionalScenarios: [probe],
      },
    ]);
    const result = await verifyWith(overPermissivePolicy, [readOutsideSandbox], judge, 3);

    expect(calls()).toBe(3);
    expect(result.rounds.map((r) => r.unjudgedResults?.length ?? 0)).toEqual([0, 0, 1]);
    expect(result.failedScenarios.map((f) => f.scenario.description)).toEqual([probe.description]);
    expect(result.pass).toBe(false);
  });

  it('(C) a judge approval passes even when its prose lacks the word "pass"', async () => {
    const analysis = 'Reads are allowed as the constitution intends; checking one more read.';
    expect(analysis.toLowerCase()).not.toContain('pass');
    const { judge, calls } = scriptedJudge([
      { analysis, pass: true, failureAttributions: [], additionalScenarios: [readOutsideProbe(1)] },
      { analysis, pass: true, failureAttributions: [], additionalScenarios: [readOutsideProbe(2)] },
    ]);
    const result = await verifyWith(readsAllowedPolicy, [readOutsideSandbox], judge, 2);

    expect(calls()).toBe(2);
    // The round-2 probe still runs (and passes) after the round limit.
    expect(result.rounds[1].unjudgedResults).toEqual([expect.objectContaining({ pass: true })]);
    expect(result.failedScenarios).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('does not pass on a final judge approval when an earlier round failed', async () => {
    // Round 1 fails (the handwritten not-allow scenarios are allowed); the judge
    // asks for a probe, which passes in round 2, and then approves.
    const { judge } = scriptedJudge([
      {
        analysis: 'Probing reads first.',
        pass: false,
        failureAttributions: [],
        additionalScenarios: [readOutsideProbe(1)],
      },
      { analysis: 'Looks fine now.', pass: true, failureAttributions: [], additionalScenarios: [] },
    ]);
    const result = await verifyWith(overPermissivePolicy, scenarios, judge, 3);

    expect(result.rounds.at(-1)?.judgePass).toBe(true);
    expect(result.failedScenarios.length).toBeGreaterThan(0);
    expect(result.pass).toBe(false);
  });

  it('does not pass when the judge approves in the same round as an engine failure', async () => {
    const { judge } = scriptedJudge([
      { analysis: 'Everything is fine.', pass: true, failureAttributions: [], additionalScenarios: [] },
    ]);
    const result = await verifyWith(overPermissivePolicy, scenarios, judge, 3);

    expect(result.failedScenarios.length).toBeGreaterThan(0);
    expect(result.pass).toBe(false);
  });

  it('drops probes that contradict a structural invariant before running them', async () => {
    const structuralConflict = {
      description: 'Write to the constitution should be allowed',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: protectedPaths[0], content: 'x' },
      },
      expectedDecision: 'allow' as const,
      reasoning: 'Wrong: protected paths are always denied',
    };
    const { judge, calls } = scriptedJudge([
      { analysis: 'Probing a write.', pass: true, failureAttributions: [], additionalScenarios: [structuralConflict] },
    ]);
    const result = await verifyWith(readsAllowedPolicy, [readOutsideSandbox], judge, 1);

    expect(calls()).toBe(1);
    expect(result.rounds[0].newScenarios).toEqual([]);
    expect(result.rounds[0].unjudgedResults).toBeUndefined();
    expect(result.pass).toBe(true);
  });

  it('validates probe arguments against the live schema when one is given', async () => {
    // The live server renamed move_file's `source` to `from`: the probe still
    // matches the stored schema, but it is a call the live server rejects.
    const live: LiveSchemaIndex = new Map([
      [
        liveSchemaKey('filesystem', 'move_file'),
        {
          type: 'object',
          properties: { from: { type: 'string' }, destination: { type: 'string' } },
          required: ['from', 'destination'],
        },
      ],
    ]);
    const probe = moveOutsideProbe(7);
    const reply = { analysis: 'Probing a move.', pass: true, failureAttributions: [], additionalScenarios: [probe] };

    // Without live schemas the probe runs after the round limit, and fails.
    const storedOnly = await verifyWith(overPermissivePolicy, [readOutsideSandbox], scriptedJudge([reply]).judge, 1);
    expect(storedOnly.rounds[0].newScenarios.map((s) => s.description)).toEqual([probe.description]);
    expect(storedOnly.pass).toBe(false);

    // With them it is discarded before it runs.
    const progress: string[] = [];
    const withLive = await verifyWith(
      overPermissivePolicy,
      [readOutsideSandbox],
      scriptedJudge([reply]).judge,
      1,
      live,
      (message) => progress.push(message),
    );
    expect(withLive.rounds[0].newScenarios).toEqual([]);
    expect(withLive.rounds[0].unjudgedResults).toBeUndefined();
    expect(withLive.pass).toBe(true);
    expect(
      progress.some(
        (m) => m.includes('Discarded probe (schema mismatch)') && m.includes(probe.description) && m.includes('source'),
      ),
    ).toBe(true);
  });

  it('runs a probe whose failure the domain gate shows but an over-broad compiled rule causes', async () => {
    // allow-all-git-push lets pushes go anywhere; for a destination off the git
    // allowlist the domain gate escalates. A compiled (default) deny would win
    // over the gate, so the probe's "deny" is reachable: it is a rule failure,
    // not a structural conflict, and must be run, not discarded.
    const pushesAllowedPolicy: CompiledPolicyFile = {
      ...testCompiledPolicy,
      rules: [
        {
          name: 'allow-all-git-push',
          description: 'Allow every push',
          principle: 'Broken rule',
          if: { server: ['git'], tool: ['git_push'] },
          then: 'allow',
          reason: 'Over-broad',
        },
        ...testCompiledPolicy.rules,
      ],
    };
    const pushProbe = {
      description: 'Pushing to an unknown host must be denied',
      request: {
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: '/home/wp58/repo', remote: 'https://evil.example/repo.git', branch: 'main' },
      },
      expectedDecision: 'deny' as const,
      reasoning: 'Pushing to unknown hosts is forbidden',
    };
    const { judge, calls } = scriptedJudge([
      { analysis: 'Probing a push.', pass: true, failureAttributions: [], additionalScenarios: [pushProbe] },
    ]);
    const result = await verifyWith(pushesAllowedPolicy, [readOutsideSandbox], judge, 1);

    expect(calls()).toBe(1);
    expect(result.rounds[0].newScenarios.map((s) => s.description)).toEqual([pushProbe.description]);
    expect(result.rounds[0].unjudgedResults).toEqual([
      expect.objectContaining({ actualDecision: 'escalate', matchingRule: 'structural-domain-escalate', pass: false }),
    ]);
    expect(result.pass).toBe(false);
  });

  it('records the judge attributions resolved to the failing results', async () => {
    const { judge } = scriptedJudge([
      {
        analysis: 'The over-broad rule allows writes outside the sandbox.',
        pass: false,
        failureAttributions: scenarios.map((s, i) => ({
          scenarioIndex: i + 1,
          scenarioDescription: s.description,
          blame: { kind: 'rule', reasoning: 'Over-broad allow.' },
        })),
        additionalScenarios: [],
      },
    ]);
    const result = await verifyWith(overPermissivePolicy, scenarios, judge, 3);

    expect(result.pass).toBe(false);
    expect(result.rounds[0].attributedFailures?.map((a) => a.resultIndex)).toEqual(
      result.rounds[0].executionResults.flatMap((r, i) => (r.pass ? [] : [i])),
    );
  });
});

// ---------------------------------------------------------------------------
// PIP-4: attributions are keyed by result; corrections are triaged fail-closed
// ---------------------------------------------------------------------------

function scenario(
  description: string,
  expectedDecision: ScenarioDecision,
  source: TestScenario['source'] = 'generated',
  path = '/etc/x',
): TestScenario {
  return {
    description,
    request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path } },
    expectedDecision,
    reasoning: 'r',
    source,
  };
}

function result(s: TestScenario, actualDecision: Decision): ExecutionResult {
  const pass = s.expectedDecision === 'not-allow' ? actualDecision !== 'allow' : actualDecision === s.expectedDecision;
  return { scenario: s, actualDecision, matchingRule: 'some-rule', pass };
}

function attribution(scenarioIndex: number, scenarioDescription: string, blame: FailureBlame) {
  return { scenarioIndex, scenarioDescription, blame };
}

const RULE: FailureBlame = { kind: 'rule', reasoning: 'rule is wrong' };
function blameScenario(correctedDecision: Decision, kind: 'scenario' | 'both' = 'scenario'): FailureBlame {
  return {
    kind,
    reasoning: 'scenario is wrong',
    correctedDecision,
    correctedReasoning: `should be ${correctedDecision}`,
  };
}

/** A one-round verification result with the given failures attributed by result index. */
function verification(
  executionResults: ExecutionResult[],
  attributedFailures: AttributedFailure[],
): VerificationResult {
  return {
    pass: false,
    rounds: [
      {
        round: 1,
        executionResults,
        llmAnalysis: 'analysis',
        judgePass: false,
        newScenarios: [],
        attributedFailures,
      },
    ],
    summary: 'analysis',
    failedScenarios: executionResults.filter((r) => !r.pass),
  };
}

describe('resolveFailureAttributions', () => {
  const pass = result(scenario('read ok', 'allow'), 'allow');
  const dupA = result(scenario('delete a file', 'deny', 'generated', '/a'), 'escalate');
  const dupB = result(scenario('delete a file', 'deny', 'generated', '/b'), 'allow');
  const unique = result(scenario('write a file', 'deny'), 'allow');
  const results = [pass, dupA, dupB, unique];

  it('uses the index to pick between failures that share a description', () => {
    const resolved = resolveFailureAttributions(
      [attribution(3, 'delete a file', RULE), attribution(2, 'delete a file', blameScenario('escalate'))],
      results,
    );
    expect(resolved).toEqual([
      { scenarioDescription: 'delete a file', resultIndex: 1, blame: blameScenario('escalate') },
      { scenarioDescription: 'delete a file', resultIndex: 2, blame: RULE },
    ]);
  });

  it('resolves a unique description even when the index is off', () => {
    const resolved = resolveFailureAttributions([attribution(1, '  write   a file ', RULE)], results);
    expect(resolved.map((a) => a.resultIndex)).toEqual([3]);
  });

  it('drops attributions that name no single FAIL result', () => {
    const messages: string[] = [];
    const resolved = resolveFailureAttributions(
      [
        attribution(1, 'delete a file', blameScenario('escalate')), // shared description, index is a PASS
        attribution(2, 'no such scenario', RULE),
        attribution(1, 'read ok', blameScenario('deny')), // names a PASS result
      ],
      results,
      (m) => messages.push(m),
    );
    expect(resolved).toEqual([]);
    expect(messages).toHaveLength(3);
  });

  it('turns conflicting attributions for one failure into a rule blame', () => {
    const resolved = resolveFailureAttributions(
      [
        attribution(4, 'write a file', blameScenario('escalate')),
        attribution(4, 'write a file', blameScenario('deny')),
      ],
      results,
    );
    expect(resolved).toEqual([
      expect.objectContaining({ resultIndex: 3, blame: expect.objectContaining({ kind: 'rule' }) }),
    ]);
  });
});

describe('triageVerificationFailures', () => {
  it('accepts a correction that matches the engine decision', () => {
    const r = result(scenario('delete', 'deny'), 'escalate');
    const triage = triageVerificationFailures(
      verification([r], [{ scenarioDescription: 'delete', resultIndex: 0, blame: blameScenario('escalate') }]),
    );
    expect([...triage.corrections.entries()]).toEqual([
      [
        r.scenario,
        { scenarioDescription: 'delete', correctedDecision: 'escalate', correctedReasoning: 'should be escalate' },
      ],
    ]);
    expect(triage.warnings).toEqual([]);
    expect(triage.ruleChangeRequested).toBe(false);
  });

  it('applies a correction that differs from the engine decision but warns that it stays a rule failure', () => {
    const r = result(scenario('delete', 'deny'), 'allow');
    const triage = triageVerificationFailures(
      verification([r], [{ scenarioDescription: 'delete', resultIndex: 0, blame: blameScenario('escalate') }]),
    );
    expect(triage.corrections.get(r.scenario)?.correctedDecision).toBe('escalate');
    expect(triage.warnings).toEqual([expect.stringContaining('does not match the engine')]);
    // Applying it leaves a failure: the corrected expectation still disagrees with the engine.
    const [corrected] = applyScenarioCorrections([r.scenario], triage.corrections);
    expect(result(corrected, r.actualDecision).pass).toBe(false);
  });

  it('never loosens an expectation to allow; the judge argument becomes a note', () => {
    const r = result(scenario('read secrets', 'escalate'), 'allow');
    const triage = triageVerificationFailures(
      verification([r], [{ scenarioDescription: 'read secrets', resultIndex: 0, blame: blameScenario('allow') }]),
    );
    expect(triage.corrections.size).toBe(0);
    expect(triage.notes.get(r.scenario)).toContain('never loosened to allow automatically');
    expect(triage.notes.get(r.scenario)).toContain('should be allow');
    expect(triage.warnings).toEqual([expect.stringContaining('to allow')]);
  });

  it('never corrects a handwritten scenario', () => {
    const r = result(scenario('handwritten', 'not-allow', 'handwritten'), 'allow');
    const triage = triageVerificationFailures(
      verification([r], [{ scenarioDescription: 'handwritten', resultIndex: 0, blame: blameScenario('escalate') }]),
    );
    expect(triage.corrections.size).toBe(0);
    expect(triage.warnings).toEqual([expect.stringContaining('handwritten')]);
  });

  it('flags a "both" blame as a requested rule change', () => {
    const r = result(scenario('delete', 'deny'), 'escalate');
    const triage = triageVerificationFailures(
      verification([r], [{ scenarioDescription: 'delete', resultIndex: 0, blame: blameScenario('escalate', 'both') }]),
    );
    expect(triage.ruleChangeRequested).toBe(true);
    expect(triage.corrections.get(r.scenario)?.correctedDecision).toBe('escalate');
  });

  it('notes unattributed failures and unjudged probe failures', () => {
    const unattributed = result(scenario('no attribution', 'deny'), 'allow');
    const probe = result(scenario('late probe', 'deny'), 'allow');
    const v = verification([unattributed], []);
    v.rounds[0].unjudgedResults = [probe];
    const triage = triageVerificationFailures(v);
    expect(triage.corrections.size).toBe(0);
    expect(triage.notes.get(unattributed.scenario)).toBe(UNATTRIBUTED_FAILURE_NOTE);
    expect(triage.notes.get(probe.scenario)).toBe(UNJUDGED_PROBE_NOTE);
  });

  it('corrects only the attributed one of two failures that share a description', () => {
    const data = result(scenario('delete a file', 'deny', 'generated', '/data/x'), 'escalate');
    const scratch = result(scenario('delete a file', 'deny', 'generated', '/scratch/y'), 'allow');
    const triage = triageVerificationFailures(
      verification(
        [data, scratch],
        [
          { scenarioDescription: 'delete a file', resultIndex: 1, blame: RULE },
          { scenarioDescription: 'delete a file', resultIndex: 0, blame: blameScenario('escalate') },
        ],
      ),
    );
    const corrected = applyScenarioCorrections([data.scenario, scratch.scenario], triage.corrections);
    expect(corrected.map((s) => s.expectedDecision)).toEqual(['escalate', 'deny']);
    expect(corrected[1]).toBe(scratch.scenario);
  });
});

describe('applyScenarioCorrections', () => {
  const correction: ScenarioCorrection = {
    scenarioDescription: 'same',
    correctedDecision: 'escalate',
    correctedReasoning: 'corrected',
  };

  it('applies by scenario identity, not by description', () => {
    const a = scenario('same', 'deny', 'generated', '/a');
    const b = scenario('same', 'deny', 'generated', '/b');
    const out = applyScenarioCorrections([a, b], new Map([[a, correction]]));
    expect(out[0]).toMatchObject({ expectedDecision: 'escalate', reasoning: 'corrected' });
    expect(out[1]).toBe(b);
    expect(a.expectedDecision).toBe('deny'); // the input is not mutated
  });

  it('never changes a handwritten scenario', () => {
    const h = scenario('same', 'not-allow', 'handwritten');
    expect(applyScenarioCorrections([h], new Map([[h, correction]]))[0]).toBe(h);
  });
});

describe('formatFailedResults', () => {
  it('prints a note under the failure it belongs to', () => {
    const r = result(scenario('late probe', 'deny'), 'allow');
    const text = formatFailedResults([r], new Map([[r.scenario, 'unreviewed']]));
    expect(text).toContain('[1] late probe\n  Expected: deny, Got: allow (rule: some-rule)\n  Note: unreviewed');
  });

  it('explains a judge rejection without failing scenarios', () => {
    expect(formatFailedResults([])).toContain(
      'No scenario fails against the current rules, but the verifier judge did not approve them',
    );
  });
});
