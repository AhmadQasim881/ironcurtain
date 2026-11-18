/**
 * Offline replay of policy test scenarios against a PolicyEngine.
 *
 * When a server's rules pass verification, the compile pipeline records the
 * decision the engine gave each of the scenarios it stores
 * (`TestScenariosFile.replay`). `ironcurtain doctor` replays them against the
 * current policy engine, tool annotations and dynamic lists: a decision that
 * differs means the policy no longer behaves the way it did when it was
 * verified. Doctor also evaluates the universal handwritten invariants
 * (`src/pipeline/handwritten-scenarios.ts`) against whatever policy is active.
 *
 * Deterministic and offline: no LLM, no MCP server. Runtime leaf: imports
 * only the policy engine and type-only contracts.
 */

import type { Decision, TestScenario, TestScenariosFile } from '../pipeline/types.js';
import type { PolicyEngine } from '../trusted-process/policy-engine.js';

/** The engine's decision for one scenario, and the rule that produced it. */
export interface ScenarioDecision {
  readonly decision: Decision;
  readonly rule: string;
}

/**
 * Evaluates one scenario the way the verifier executes it (same request
 * shape; the request id and timestamp do not influence decisions).
 */
export function evaluateScenario(engine: PolicyEngine, scenario: TestScenario): ScenarioDecision {
  const result = engine.evaluate({
    requestId: 'scenario-replay',
    serverName: scenario.request.serverName,
    toolName: scenario.request.toolName,
    arguments: scenario.request.arguments,
    timestamp: '',
  });
  return { decision: result.decision, rule: result.rule };
}

/** The engine's decision for every scenario, in order (stored as `replay.decisions`). */
export function recordScenarioDecisions(engine: PolicyEngine, scenarios: readonly TestScenario[]): Decision[] {
  return scenarios.map((scenario) => evaluateScenario(engine, scenario).decision);
}

/** A stored scenario whose decision differs from the one recorded at verification. */
export interface ScenarioDecisionChange {
  readonly description: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly recorded: Decision;
  readonly actual: Decision;
  readonly rule: string;
}

export type ScenarioReplayOutcome =
  /** Every recorded scenario was replayed; `changes` lists the ones whose decision differs. */
  | { readonly kind: 'replayed'; readonly replayed: number; readonly changes: readonly ScenarioDecisionChange[] }
  /** The file records no decisions (written before they were recorded). */
  | { readonly kind: 'not-recorded' }
  /** The recorded decisions do not line up with the scenarios (a damaged or hand-edited file). */
  | { readonly kind: 'mismatched' };

/**
 * Replays the scenarios of `file` against `engine` and compares each decision
 * with the one recorded when the rules were verified. The engine must be
 * built with `file.replay.allowedDirectory` as its sandbox: scenario paths
 * refer to the sandbox the pipeline verified with.
 */
export function replayRecordedDecisions(
  engine: PolicyEngine,
  file: Pick<TestScenariosFile, 'scenarios' | 'replay'>,
): ScenarioReplayOutcome {
  const replay = file.replay;
  if (replay === undefined) return { kind: 'not-recorded' };
  if (!Array.isArray(replay.decisions) || replay.decisions.length !== file.scenarios.length) {
    return { kind: 'mismatched' };
  }
  const changes: ScenarioDecisionChange[] = [];
  file.scenarios.forEach((scenario, index) => {
    const recorded = replay.decisions[index];
    const { decision, rule } = evaluateScenario(engine, scenario);
    if (decision !== recorded) {
      changes.push({
        description: scenario.description,
        serverName: scenario.request.serverName,
        toolName: scenario.request.toolName,
        recorded,
        actual: decision,
        rule,
      });
    }
  });
  return { kind: 'replayed', replayed: file.scenarios.length, changes };
}

/** A scenario whose expected decision the engine does not give. */
export interface ScenarioViolation {
  readonly description: string;
  readonly expected: TestScenario['expectedDecision'];
  readonly actual: Decision;
  readonly rule: string;
}

/**
 * Evaluates scenarios with known expectations (the universal handwritten
 * invariants) and returns those the engine does not satisfy. `not-allow` is
 * satisfied by any decision other than `allow`.
 */
export function findScenarioViolations(engine: PolicyEngine, scenarios: readonly TestScenario[]): ScenarioViolation[] {
  const violations: ScenarioViolation[] = [];
  for (const scenario of scenarios) {
    const { decision, rule } = evaluateScenario(engine, scenario);
    const satisfied =
      scenario.expectedDecision === 'not-allow' ? decision !== 'allow' : decision === scenario.expectedDecision;
    if (!satisfied) {
      violations.push({
        description: scenario.description,
        expected: scenario.expectedDecision,
        actual: decision,
        rule,
      });
    }
  }
  return violations;
}
