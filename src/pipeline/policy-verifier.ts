/**
 * Policy Verifier -- Multi-round verification with real engine execution
 * and LLM judge.
 *
 * The verifier instantiates a real PolicyEngine, runs test scenarios through
 * it, and uses an LLM judge to analyze results, identify gaps, and generate
 * additional probe scenarios. Up to maxRounds judge turns.
 *
 * The verdict rests on structured data only: the judge's `pass` flag in the
 * final round and the engine's results. Free-text analysis never decides it.
 */

import type { LanguageModel, SystemModelMessage } from 'ai';
import { generateText } from 'ai';
import { z } from 'zod';
import {
  DEFAULT_MAX_TOKENS,
  generateWithinOutputCap,
  parseJsonWithSchema,
  schemaToPromptHint,
} from './generate-with-repair.js';
import { PolicyEngine, STRUCTURAL_DOMAIN_ESCALATE_RULE } from '../trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../types/mcp.js';
import { isConditionalRoles } from '../types/argument-roles.js';
import { formatDynamicListsSection } from './scenario-generator.js';
import {
  filterInvalidSchemaScenarios,
  buildScenarioArgsSuperRefine,
  buildToolArgNamesMap,
  formatToolArgNames,
  type LiveSchemaIndex,
} from './scenario-schema-validator.js';
import type {
  CompiledPolicyFile,
  ConditionalRoles,
  DiscardedScenario,
  DynamicListsFile,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
  TestScenario,
  ExecutionResult,
  VerifierRound,
  VerificationResult,
  AttributedFailure,
  FailureBlame,
  ScenarioCorrection,
} from './types.js';
export type { DiscardedScenario };

const DEFAULT_MAX_ROUNDS = 3;

/**
 * Builds the PolicyEngine that verification runs scenarios against. The
 * pipeline runner replays scenarios through this same function, so a replay
 * always sees the decisions verification saw.
 */
export function createVerifierEngine(
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: StoredToolAnnotationsFile,
  protectedPaths: string[],
  allowedDirectory: string | undefined,
  serverDomainAllowlists: ReadonlyMap<string, readonly string[]> | undefined,
  dynamicLists: DynamicListsFile | undefined,
): PolicyEngine {
  return new PolicyEngine(
    compiledPolicy,
    toolAnnotations,
    protectedPaths,
    allowedDirectory,
    serverDomainAllowlists,
    dynamicLists,
  );
}

export function executeScenarios(engine: PolicyEngine, scenarios: TestScenario[]): ExecutionResult[] {
  return scenarios.map((scenario) => {
    const request: ToolCallRequest = {
      requestId: `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      serverName: scenario.request.serverName,
      toolName: scenario.request.toolName,
      arguments: scenario.request.arguments,
      timestamp: new Date().toISOString(),
    };
    const result = engine.evaluate(request);
    return {
      scenario,
      actualDecision: result.decision,
      matchingRule: result.rule,
      pass:
        scenario.expectedDecision === 'not-allow'
          ? result.decision !== 'allow'
          : result.decision === scenario.expectedDecision,
    };
  });
}

/** Verbose multi-line format for a single execution result. */
function formatVerboseResult(r: ExecutionResult, index: number): string {
  const status = r.pass ? 'PASS' : 'FAIL';
  return [
    `[${index}] ${status}: ${r.scenario.description}`,
    `  Tool: ${r.scenario.request.serverName}/${r.scenario.request.toolName}`,
    `  Args: ${JSON.stringify(r.scenario.request.arguments)}`,
    `  Expected: ${r.scenario.expectedDecision}`,
    `  Actual: ${r.actualDecision} (rule: ${r.matchingRule})`,
    `  Source: ${r.scenario.source}`,
  ].join('\n');
}

export function formatExecutionResults(results: ExecutionResult[]): string {
  return results.map((r, i) => formatVerboseResult(r, i + 1)).join('\n\n');
}

/**
 * Compact format for verifier prompts: passes are one-liners,
 * fails get full verbose format with tool/args/source details.
 * This reduces token usage ~70% for the common case where most scenarios pass.
 */
export function formatCompactResults(results: ExecutionResult[]): string {
  return results
    .map((r, i) => {
      if (r.pass) {
        return `[${i + 1}] PASS: ${r.scenario.description} → ${r.actualDecision} (rule: ${r.matchingRule})`;
      }
      return formatVerboseResult(r, i + 1);
    })
    .join('\n\n');
}

/**
 * Compact failure-only format for repair instructions.
 * Omits Tool, Args, Source, and PASS/FAIL prefix — the compiler already
 * knows tool signatures from its system prompt, and only failures are sent.
 * A note for a failure (keyed by its scenario) is printed under it. An empty
 * list means no scenario fails, yet the judge did not approve the rules: it
 * rejected them, or asked for a rule change along with a scenario correction.
 */
export function formatFailedResults(results: ExecutionResult[], notes?: ReadonlyMap<TestScenario, string>): string {
  if (results.length === 0) {
    return (
      '(none) No scenario fails against the current rules, but the verifier judge did not approve them: ' +
      'it rejected the policy or asked for a rule change. Fix the problems the judge analysis below describes.'
    );
  }
  return results
    .map((r, i) => {
      const note = notes?.get(r.scenario);
      return (
        `[${i + 1}] ${r.scenario.description}\n  Expected: ${r.scenario.expectedDecision}, Got: ${r.actualDecision} (rule: ${r.matchingRule})` +
        (note ? `\n  Note: ${note}` : '')
      );
    })
    .join('\n');
}

/**
 * Builds the stable system prompt portion for the verifier judge.
 * Contains: role preamble, constitution, compiled rules, structural invariants,
 * decision types, instructions, and available tools.
 * This is the cacheable part — it stays the same across verification rounds.
 */
export function buildJudgeSystemPrompt(
  constitutionText: string,
  compiledPolicy: CompiledPolicyFile,
  protectedPaths: string[],
  availableTools: { serverName: string; toolName: string }[] | undefined,
  dynamicLists: DynamicListsFile | undefined,
  sandboxDirectory: string | undefined,
  storedAnnotations: StoredToolAnnotation[],
): string {
  const rulesText = compiledPolicy.rules
    .map((r, i) => `  ${i + 1}. [${r.name}] if: ${JSON.stringify(r.if)} then: ${r.then} -- ${r.reason}`)
    .join('\n');

  return `You are a security policy verifier. Analyze whether the compiled policy correctly implements the constitution.

## Constitution

${constitutionText}

## Compiled Policy Rules (evaluated in order, first match wins)

${rulesText}

## Structural Invariants (hardcoded, evaluated before compiled rules)

- Unknown tools (no annotation): denied
- Introspection tools (list_allowed_directories): always allowed
- Protected paths (any write/delete targeting these is automatically denied):
${protectedPaths.map((p) => `  - ${p}`).join('\n')}
- Sandbox containment: any tool call where ALL paths are within the sandbox directory${sandboxDirectory ? ` (\`${sandboxDirectory}\`)` : ''} is automatically allowed BEFORE compiled rules are evaluated. An "allow" result for sandbox-internal paths is always correct — do NOT flag it as a failure or generate scenarios to test it.

A \`deny\` result for write/delete operations on these paths is correct structural behavior, not a policy gap. Files with similar names inside the sandbox are NOT protected.
${formatDynamicListsSection(dynamicLists)}
## Decision Types and Default-Deny Model

The policy uses a default-deny model. Compiled rules only contain "allow" and "escalate"
decisions. The engine denies any operation that does not match a compiled rule.

The three possible outcomes (from the engine's perspective) are:
- **allow** -- a compiled rule explicitly permits the operation
- **escalate** -- a compiled rule routes the operation to a human for approval
- **deny** -- either a structural invariant denied the operation, or no compiled rule
  matched (default-deny)

When analyzing FAIL results:
- A "deny" result with rule "default-deny" means no compiled rule matched. This is
  correct for operations the constitution prohibits or does not address. It is WRONG
  if the constitution grants permission (missing allow rule) or requires human judgment
  (missing escalate rule).
- A "deny" result with rule "structural-*" means a hardcoded invariant fired. Structural
  invariants are ground truth and are always correct.
- An "escalate" result means a compiled rule routed the operation for human judgment.
  This is wrong if the constitution explicitly allows the operation (should be "allow")
  or explicitly prohibits it (should be "deny" via default-deny, meaning the escalate
  rule is too broad).

CRITICAL: If a compiled escalate rule matches an operation (even outside the sandbox), the result is "escalate", NOT "deny". The "deny" outcome ONLY occurs when NO compiled rule matches at all (default-deny) or when a structural invariant denies the operation. When generating probe scenarios for operations that have explicit escalate rules (e.g., mutations on tools like git_tag, git_worktree), the expected outcome should be "escalate", not "deny", regardless of whether the path is inside or outside the sandbox.

## Instructions

1. Analyze any FAIL results. For each failure, determine the blame:
   - **"rule"**: The compiled rule is wrong and needs to be fixed. The scenario expectation correctly reflects the constitution.
   - **"scenario"**: The scenario expectation is wrong. The compiled rule is correct per the constitution. Provide the corrected expectedDecision and reasoning.
   - **"both"**: The rule needs adjustment AND the scenario expectation is wrong. Provide the corrected expectedDecision and reasoning.
2. Identify suspicious patterns. Examples (not exhaustive):
   - A broad "allow" rule shadowing a narrow "escalate" rule.
   - An "escalate" rule catching operations that should be default-denied because
     the constitution prohibits them.
   - **Region coverage gap**: a tool has compiled rules that cover some inputs
     (e.g., paths within directory X, or URLs matching pattern Y) but no rule
     covers the complementary inputs (paths outside X, or URLs not matching Y).
     The uncovered region falls through to default-deny. This may be intended
     (constitution is silent or prohibits the complementary region) or unintended
     (constitution requires allow/escalate for that region). Re-read the
     constitution clause that authorized the existing rule to determine which.
     Do NOT assume any specific decision is correct -- consult the constitution.
   - **Name/decision mismatch**: a rule whose name encodes a decision (e.g.
     "escalate-X", "allow-X", "deny-X") whose \`then:\` field is a different
     decision. Either the name is wrong or the decision is wrong; flag both
     possibilities so the compiler can pick the one that matches its intent.
3. Identify missing coverage -- scenarios the constitution implies that were not tested.
4. If you suspect gaps, generate additional test scenarios to probe them.
5. Set "pass" to true ONLY if the compiled rules correctly implement the constitution and coverage is adequate. A FAIL you attribute to the scenario alone (kind "scenario", with a corrected decision equal to the actual decision) does not by itself require "pass": false; a FAIL that needs a rule change does.
6. Return a "failureAttributions" entry for EVERY FAIL result. Set "scenarioIndex" to the [N] number of that FAIL result and "scenarioDescription" to its exact description. Several results can share a description; the index tells them apart.

For additional scenarios, use concrete paths: inside and just outside the directories the compiled rules name, and in the directories the constitution names, whether or not a rule covers them (a rule scoped to the wrong directory is a gap to probe). Do NOT generate additional scenarios with paths inside the sandbox directory${sandboxDirectory ? ` (\`${sandboxDirectory}\`)` : ''} — sandbox containment is handled by a structural invariant before compiled rules run and is always correct. Only generate scenarios for paths OUTSIDE the sandbox.

## Available Tools

IMPORTANT: Only use these exact server/tool combinations in additional scenarios. Do NOT invent tool names.
ALL tools listed here are known/annotated — the "unknown tool → deny" structural invariant CANNOT apply to any of them. NEVER generate scenarios expecting "deny" due to the unknown tool invariant.

${(availableTools ?? []).map((t) => `- ${t.serverName}/${t.toolName}`).join('\n')}

## Valid Tool Arguments

CRITICAL: Only use these argument names in additional scenarios. Using unlisted arguments will cause validation failure.

${formatToolArgNames(storedAnnotations)}
## Response Format

Be concise. Keep the analysis to 2-3 sentences per issue found. Only generate additional scenarios that test genuinely untested gaps -- do not duplicate existing coverage. Limit additional scenarios to at most 5.`;
}

// ---------------------------------------------------------------------------
// Response Schema + Session
// ---------------------------------------------------------------------------

function buildJudgeResponseSchema(
  serverNames: [string, ...string[]],
  toolNames: [string, ...string[]],
  argsSuperRefine?: ReturnType<typeof buildScenarioArgsSuperRefine>,
) {
  const blameSchema = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('rule'),
      reasoning: z.string(),
    }),
    z.object({
      kind: z.literal('scenario'),
      reasoning: z.string(),
      correctedDecision: z.enum(['allow', 'deny', 'escalate']),
      correctedReasoning: z.string(),
    }),
    z.object({
      kind: z.literal('both'),
      reasoning: z.string(),
      correctedDecision: z.enum(['allow', 'deny', 'escalate']),
      correctedReasoning: z.string(),
    }),
  ]);

  return z.object({
    analysis: z.string(),
    pass: z.boolean(),
    failureAttributions: z.array(
      z.object({
        /** The [N] number of the FAIL result in this round's execution results (1-based). */
        scenarioIndex: z.number().int().min(1),
        scenarioDescription: z.string(),
        blame: blameSchema,
      }),
    ),
    additionalScenarios: z.array(
      z
        .object({
          description: z.string(),
          request: z.object({
            serverName: z.enum(serverNames),
            toolName: z.enum(toolNames),
            arguments: z.record(z.string(), z.unknown()),
          }),
          expectedDecision: z.enum(['allow', 'deny', 'escalate']),
          reasoning: z.string(),
        })
        .superRefine(argsSuperRefine ?? (() => {})),
    ),
  });
}

type JudgeOutput = z.infer<ReturnType<typeof buildJudgeResponseSchema>>;

/**
 * Multi-turn verifier session. Maintains conversation history across
 * verification rounds so the LLM has context from prior analysis without
 * re-serializing previousAnalysis and schema hints each round.
 *
 * Follows the same pattern as ConstitutionCompilerSession.
 */
export class PolicyVerifierSession {
  private readonly systemPrompt: string | SystemModelMessage;
  private readonly model: LanguageModel;
  private readonly schema: ReturnType<typeof buildJudgeResponseSchema>;
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private readonly schemaHint: string;
  private turns = 0;
  /**
   * Output-token cap the next request starts at; raised for the rest of the
   * session once a judgment needed the larger truncation-retry cap, so later
   * rounds of similar length are not cut off once each before the retry.
   */
  private outputCap = DEFAULT_MAX_TOKENS;

  constructor(options: {
    system: string | SystemModelMessage;
    model: LanguageModel;
    serverNames: [string, ...string[]];
    toolNames: [string, ...string[]];
    storedAnnotations?: StoredToolAnnotation[];
  }) {
    this.systemPrompt = options.system;
    this.model = options.model;
    const argsSuperRefine = options.storedAnnotations
      ? buildScenarioArgsSuperRefine(buildToolArgNamesMap(options.storedAnnotations))
      : undefined;
    this.schema = buildJudgeResponseSchema(options.serverNames, options.toolNames, argsSuperRefine);
    this.schemaHint = schemaToPromptHint(this.schema);
  }

  /** Execute a judge round with compact results formatting. */
  async judgeRound(executionResults: ExecutionResult[], onProgress?: (message: string) => void): Promise<JudgeOutput> {
    const roundLabel = this.turns + 1;
    const resultsText = formatCompactResults(executionResults);

    // Append schema hint only on the first turn; subsequent turns
    // already have it in conversation history.
    const content =
      `## Execution Results (Round ${roundLabel})\n\n${resultsText}\n\nAnalyze the results and respond following the instructions in the system prompt.` +
      (this.turns === 0 ? this.schemaHint : '');

    this.history.push({ role: 'user', content });

    onProgress?.('Judging...');

    try {
      // A response cut off at its output cap is requested again with a
      // larger one (or fails as truncated), never "repaired" as a schema error.
      const result = await this.request(this.history, onProgress);

      // Try to parse; on schema failure, do one internal retry
      const firstAttempt = this.tryParse(result.text);
      if (firstAttempt.ok) {
        this.history.push({ role: 'assistant', content: result.text });
        this.turns++;
        return firstAttempt.value;
      }

      // First parse failed -- attempt one schema repair round.
      // Build the retry messages without mutating history so that only
      // the successful response is persisted in the conversation.
      onProgress?.('Schema repair 1/1...');

      const retryMessages = [
        ...this.history,
        { role: 'assistant' as const, content: result.text },
        {
          role: 'user' as const,
          content: `Your response failed schema validation:\n${firstAttempt.error}\n\nPlease fix the errors and return valid JSON matching the schema.`,
        },
      ];
      const retryResult = await this.request(retryMessages, onProgress);

      const retryOutput = parseJsonWithSchema(retryResult.text, this.schema);
      this.history.push({ role: 'assistant', content: retryResult.text });
      this.turns++;
      return retryOutput;
    } catch (error) {
      // Remove the dangling user message before re-throwing so the session
      // remains usable (a schema failure, a truncation or an LLM error).
      this.history.pop();
      throw error;
    }
  }

  /**
   * One judge request with the fixed system prompt, under the session's
   * output cap ({@link outputCap}) and retried once with the larger cap when
   * cut off ({@link generateWithinOutputCap}). Throws `OutputTruncatedError`
   * when the larger cap is cut off too.
   */
  private async request(
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
    onProgress?: (message: string) => void,
  ) {
    const { result, maxOutputTokens } = await generateWithinOutputCap(
      (cap) =>
        generateText({ model: this.model, system: this.systemPrompt, messages: [...messages], maxOutputTokens: cap }),
      this.outputCap,
      onProgress,
    );
    this.outputCap = maxOutputTokens;
    return result;
  }

  /** Returns the number of turns completed so far. */
  get turnCount(): number {
    return this.turns;
  }

  /** Attempts to parse LLM output, returning a discriminated result. */
  private tryParse(text: string): { ok: true; value: JudgeOutput } | { ok: false; error: string } {
    try {
      return { ok: true, value: parseJsonWithSchema(text, this.schema) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Verifies a compiled policy: runs the scenarios through the real PolicyEngine,
 * has the LLM judge review the results, and runs the probes the judge asks for
 * in further rounds, up to `maxRounds` judge turns.
 *
 * Verification passes only when the judge's structured `pass` flag in the
 * final round is true AND no executed scenario failed in any round. Probes the
 * judge asks for in the final round are still run (after the same filtering as
 * every probe) and recorded as that round's `unjudgedResults`: a failure among
 * them fails verification, unattributed, because the judge never saw it.
 *
 * `liveSchemas` are the input schemas the reachable MCP servers list right now
 * (`PipelineRunConfig.liveToolSchemas`). Probe arguments are validated against
 * them in preference to the stored schemas, as the pipeline runner validates
 * its scenarios, so verification never runs a call shape the live server
 * rejects. Absent, the stored schemas are used.
 */
export async function verifyPolicy(
  constitutionText: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: StoredToolAnnotationsFile,
  protectedPaths: string[],
  scenarios: TestScenario[],
  llm: LanguageModel,
  maxRounds: number | undefined = DEFAULT_MAX_ROUNDS,
  allowedDirectory: string | undefined,
  onProgress: ((message: string) => void) | undefined,
  serverDomainAllowlists: ReadonlyMap<string, readonly string[]> | undefined,
  dynamicLists: DynamicListsFile | undefined,
  system: string | SystemModelMessage | undefined,
  session: PolicyVerifierSession | undefined,
  storedAnnotations: StoredToolAnnotation[],
  liveSchemas?: LiveSchemaIndex,
): Promise<VerificationResult> {
  const engine = createVerifierEngine(
    compiledPolicy,
    toolAnnotations,
    protectedPaths,
    allowedDirectory,
    serverDomainAllowlists,
    dynamicLists,
  );

  // Reuse provided session or create one from annotations + system prompt
  let effectiveSession: PolicyVerifierSession;
  if (session) {
    effectiveSession = session;
  } else {
    const allAnnotations = Object.values(toolAnnotations.servers).flatMap((s) => s.tools);
    const serverNamesList = [...new Set(allAnnotations.map((a) => a.serverName))] as [string, ...string[]];
    const toolNamesList = [...new Set(allAnnotations.map((a) => a.toolName))] as [string, ...string[]];
    effectiveSession = new PolicyVerifierSession({
      system:
        system ??
        buildJudgeSystemPrompt(
          constitutionText,
          compiledPolicy,
          protectedPaths,
          allAnnotations.map((a) => ({ serverName: a.serverName, toolName: a.toolName })),
          dynamicLists,
          allowedDirectory,
          storedAnnotations,
        ),
      model: llm,
      serverNames: serverNamesList,
      toolNames: toolNamesList,
      storedAnnotations,
    });
  }

  const rounds: VerifierRound[] = [];
  let currentScenarios = scenarios;

  for (let round = 1; round <= maxRounds; round++) {
    // Execute scenarios against the real engine
    const executionResults = executeScenarios(engine, currentScenarios);
    const judgment = await effectiveSession.judgeRound(executionResults, onProgress);
    const newScenarios = filterProbeScenarios(
      engine,
      judgment.additionalScenarios,
      storedAnnotations,
      liveSchemas,
      onProgress,
    );

    rounds.push({
      round,
      executionResults,
      llmAnalysis: judgment.analysis,
      judgePass: judgment.pass,
      newScenarios,
      attributedFailures: resolveFailureAttributions(judgment.failureAttributions, executionResults, onProgress),
    });

    // Nothing new to show the judge: its verdict in this round is final.
    if (newScenarios.length === 0) break;

    // Run additional scenarios in next round
    currentScenarios = newScenarios;
  }

  const lastRound = rounds.at(-1);
  if (!lastRound) {
    return { pass: false, rounds, summary: 'Verification did not complete', failedScenarios: [] };
  }

  // The round limit ended the loop before the judge saw these probes. Run them
  // anyway so the verdict covers them; nobody reviews these results, so any
  // failure among them stays unattributed.
  if (lastRound.newScenarios.length > 0) {
    lastRound.unjudgedResults = executeScenarios(engine, lastRound.newScenarios);
  }

  const failedScenarios = rounds
    .flatMap((r) => [...r.executionResults, ...(r.unjudgedResults ?? [])])
    .filter((r) => !r.pass);
  const unjudgedFailures = (lastRound.unjudgedResults ?? []).filter((r) => !r.pass).length;
  const summary =
    unjudgedFailures > 0
      ? `${lastRound.llmAnalysis}\n\n[verifier: ${unjudgedFailures} probe(s) from the final round failed when run after the round limit; the judge has not reviewed them.]`
      : lastRound.llmAnalysis;

  return {
    pass: lastRound.judgePass && failedScenarios.length === 0,
    rounds,
    summary,
    failedScenarios,
  };
}

/**
 * Turns the judge's additional scenarios into probes, dropping those that
 * cannot test what they claim: arguments that violate the tool's input
 * schema (the live one when `liveSchemas` has it, else the stored one),
 * arguments that leave every conditional role on its default, and
 * expectations that contradict a structural invariant (ground truth).
 */
function filterProbeScenarios(
  engine: PolicyEngine,
  additionalScenarios: JudgeOutput['additionalScenarios'],
  storedAnnotations: StoredToolAnnotation[],
  liveSchemas: LiveSchemaIndex | undefined,
  onProgress: ((message: string) => void) | undefined,
): TestScenario[] {
  const probes: TestScenario[] = additionalScenarios.map((s) => ({ ...s, source: 'generated' as const }));

  const schemaResult = filterInvalidSchemaScenarios(probes, storedAnnotations, liveSchemas);
  for (const d of schemaResult.discarded) {
    onProgress?.(`Discarded probe (schema mismatch): "${d.scenario.description}" — ${d.rule}`);
  }

  // Keyed by scenario object: two probes can share a description.
  const fallbacks = new Map(
    detectAllDefaultRoleFallbacks(schemaResult.valid, storedAnnotations).map((w) => [w.scenario, w]),
  );
  const withRoles = schemaResult.valid.filter((s) => {
    const warning = fallbacks.get(s);
    if (!warning) return true;
    onProgress?.(`Discarded probe (default role fallback): "${s.description}" — ${warning.details.join('; ')}`);
    return false;
  });

  const structural = filterStructuralConflicts(engine, withRoles);
  for (const d of structural.discarded) {
    onProgress?.(
      `Discarded probe (structural conflict): "${d.scenario.description}" — ${d.rule} always returns ${d.actual}`,
    );
  }
  return structural.valid;
}

/** Whitespace-insensitive form of a description, for matching the judge's copy of it. */
function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, ' ');
}

function sameBlame(a: FailureBlame, b: FailureBlame): boolean {
  if (a.kind === 'rule' || b.kind === 'rule') return a.kind === b.kind;
  return a.kind === b.kind && a.correctedDecision === b.correctedDecision;
}

/**
 * Resolves the judge's failure attributions to the FAIL results they name.
 *
 * The description must match a FAIL result of this round; the [N] index the
 * judge gives (`scenarioIndex`, 1-based) picks between FAIL results that share
 * a description. An attribution that names no single FAIL result is dropped,
 * and conflicting attributions for one result become a rule blame. Either way
 * the failure is then treated as the rule's fault, so a vague or contradictory
 * answer from the judge can never clear a failure.
 */
export function resolveFailureAttributions(
  attributions: ReadonlyArray<{ scenarioIndex: number; scenarioDescription: string; blame: FailureBlame }>,
  executionResults: ExecutionResult[],
  onProgress?: (message: string) => void,
): AttributedFailure[] {
  const failingByDescription = new Map<string, number[]>();
  for (const [index, result] of executionResults.entries()) {
    if (result.pass) continue;
    const key = normalizeDescription(result.scenario.description);
    failingByDescription.set(key, [...(failingByDescription.get(key) ?? []), index]);
  }

  const resolved = new Map<number, AttributedFailure>();
  for (const attribution of attributions) {
    const candidates = failingByDescription.get(normalizeDescription(attribution.scenarioDescription)) ?? [];
    const namedIndex = attribution.scenarioIndex - 1;
    const resultIndex =
      candidates.length === 1 ? candidates[0] : candidates.includes(namedIndex) ? namedIndex : undefined;
    if (resultIndex === undefined) {
      onProgress?.(
        `Ignored failure attribution [${attribution.scenarioIndex}] "${attribution.scenarioDescription}": it names no single FAIL result`,
      );
      continue;
    }
    const existing = resolved.get(resultIndex);
    if (!existing) {
      resolved.set(resultIndex, {
        scenarioDescription: attribution.scenarioDescription,
        resultIndex,
        blame: attribution.blame,
      });
    } else if (!sameBlame(existing.blame, attribution.blame)) {
      resolved.set(resultIndex, {
        ...existing,
        blame: { kind: 'rule', reasoning: 'The judge gave conflicting attributions for this failure.' },
      });
    }
  }
  return [...resolved.values()].sort((a, b) => a.resultIndex - b.resultIndex);
}

// ---------------------------------------------------------------------------
// Structural Conflict Filtering
// ---------------------------------------------------------------------------

/**
 * Whether a failing result contradicts a structural invariant, i.e. no rule
 * change could make the scenario pass. Most invariants decide the call
 * outright. The domain gate does not: its escalation is combined with the
 * compiled rules and a compiled (default) deny wins over it, so under the gate
 * only an `allow` expectation is unreachable. A `deny` expectation that fails
 * there is a failure of an over-broad compiled rule, not a structural conflict.
 */
function contradictsStructuralInvariant(result: ExecutionResult): boolean {
  if (result.pass || !result.matchingRule.startsWith('structural-')) return false;
  if (result.matchingRule === STRUCTURAL_DOMAIN_ESCALATE_RULE) return result.scenario.expectedDecision === 'allow';
  return true;
}

/**
 * Filters out scenarios whose expected decision conflicts with a structural
 * invariant result. Structural invariants are ground truth (hardcoded in the
 * engine), so a disagreeing scenario expectation is wrong by definition (see
 * contradictsStructuralInvariant for the domain gate, which is not final).
 *
 * Returns the valid scenarios and the discarded ones (with metadata for
 * logging / feedback).
 */
export function filterStructuralConflicts(
  engine: PolicyEngine,
  scenarios: TestScenario[],
): { valid: TestScenario[]; discarded: DiscardedScenario[] } {
  const results = executeScenarios(engine, scenarios);
  const valid: TestScenario[] = [];
  const discarded: DiscardedScenario[] = [];

  for (const result of results) {
    if (contradictsStructuralInvariant(result)) {
      discarded.push({
        scenario: result.scenario,
        actual: result.actualDecision,
        rule: result.matchingRule,
      });
    } else {
      valid.push(result.scenario);
    }
  }

  return { valid, discarded };
}

// ---------------------------------------------------------------------------
// Default Role Fallback Detection
// ---------------------------------------------------------------------------

/**
 * Warning info for a scenario where all conditional role specs fall to defaults.
 */
export interface DefaultRoleFallbackWarning {
  readonly scenario: TestScenario;
  readonly toolKey: string;
  readonly details: string[];
}

/**
 * Checks whether a scenario's arguments cause ALL conditional role specs
 * to fall to their default (most-restrictive) roles. This happens when
 * the discriminator argument is missing or has a value not matching any
 * `when` clause. The scenario may still produce a valid policy decision,
 * but it likely doesn't test the intended tool mode.
 *
 * @param scenario - The test scenario to check
 * @param storedAnnotations - Raw annotations with conditional role specs
 * @returns A warning if all conditionals fall to defaults, or undefined
 */
export function detectDefaultRoleFallback(
  scenario: TestScenario,
  storedAnnotations: StoredToolAnnotation[],
): DefaultRoleFallbackWarning | undefined {
  const toolKey = `${scenario.request.serverName}/${scenario.request.toolName}`;
  const annotation = storedAnnotations.find(
    (a) => a.serverName === scenario.request.serverName && a.toolName === scenario.request.toolName,
  );
  if (!annotation) return undefined;

  // Find all args with conditional role specs
  const conditionalArgs = Object.entries(annotation.args).filter((entry): entry is [string, ConditionalRoles] =>
    isConditionalRoles(entry[1]),
  );
  if (conditionalArgs.length === 0) return undefined;

  // Check each conditional arg: does ANY when clause match?
  const details: string[] = [];
  for (const [argName, spec] of conditionalArgs) {
    const matchesAny = spec.when.some((entry) => {
      const cond = entry.condition;
      const value = scenario.request.arguments[cond.arg];

      if (cond.equals !== undefined) return value === cond.equals;
      if (cond.in !== undefined) return cond.in.includes(value as string | number | boolean);
      if (cond.is !== undefined) {
        switch (cond.is) {
          case 'present':
            return cond.arg in scenario.request.arguments && value !== null && value !== undefined;
          case 'absent':
            return !(cond.arg in scenario.request.arguments) || value === null || value === undefined;
          case 'truthy':
            return cond.arg in scenario.request.arguments && !!value;
          case 'falsy':
            return !(cond.arg in scenario.request.arguments) || !value;
        }
      }
      return false;
    });

    if (!matchesAny) {
      // Describe what went wrong
      const discriminators = [...new Set(spec.when.map((w) => w.condition.arg))];
      const validValues = spec.when.flatMap((w) => {
        const c = w.condition;
        if (c.equals !== undefined) return [JSON.stringify(c.equals)];
        if (c.in !== undefined) return c.in.map((v) => JSON.stringify(v));
        if (c.is !== undefined) return [`<${c.is}>`];
        return [];
      });
      const discriminatorArg = discriminators[0] ?? argName;
      const actualValue = scenario.request.arguments[discriminatorArg];
      const actualDesc =
        actualValue === undefined
          ? `arg "${discriminatorArg}" is missing`
          : `${discriminatorArg}=${JSON.stringify(actualValue)}`;
      details.push(`${argName}: ${actualDesc}, valid values: [${validValues.join(', ')}]`);
    }
  }

  if (details.length === conditionalArgs.length) {
    return { scenario, toolKey, details };
  }
  return undefined;
}

/**
 * Scans scenarios for default role fallback issues and returns warnings.
 * Only checks scenarios for tools that have conditional role specs.
 */
export function detectAllDefaultRoleFallbacks(
  scenarios: TestScenario[],
  storedAnnotations: StoredToolAnnotation[],
): DefaultRoleFallbackWarning[] {
  // Pre-filter: only check tools that have conditional specs
  const toolsWithConditionals = new Set(
    storedAnnotations
      .filter((a) => Object.values(a.args).some((spec) => isConditionalRoles(spec)))
      .map((a) => `${a.serverName}/${a.toolName}`),
  );

  const warnings: DefaultRoleFallbackWarning[] = [];
  for (const scenario of scenarios) {
    const toolKey = `${scenario.request.serverName}/${scenario.request.toolName}`;
    if (!toolsWithConditionals.has(toolKey)) continue;

    const warning = detectDefaultRoleFallback(scenario, storedAnnotations);
    if (warning) {
      warnings.push(warning);
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Scenario Corrections
// ---------------------------------------------------------------------------

/** Repair-compiler note for a failing probe that was run after the round limit. */
export const UNJUDGED_PROBE_NOTE =
  "A probe from the verifier's final round, run after the round limit: the judge never reviewed this result, " +
  'so its expectation may itself be wrong. Change the rules only if the constitution supports the expected decision.';

/** Repair-compiler note for a failure no judge attribution names unambiguously. */
export const UNATTRIBUTED_FAILURE_NOTE = 'No attribution from the verifier judge names this failure unambiguously.';

/** What the repair loop may do with the failures of one verification. */
export interface FailureTriage {
  /** Corrections to apply, keyed by the scenario object each one replaces. */
  readonly corrections: ReadonlyMap<TestScenario, ScenarioCorrection>;
  /** Notes for the repair compiler on failures that stay rule failures, keyed by scenario. */
  readonly notes: ReadonlyMap<TestScenario, string>;
  /** True when the judge said a rule must change as well as a scenario (blame "both"). */
  readonly ruleChangeRequested: boolean;
  /** Messages for the progress reporter. */
  readonly warnings: readonly string[];
}

/**
 * Decides, for every failure of a verification, whether the judge's
 * attribution may change the scenario's expectation. A failure that is not
 * corrected stays a rule failure. A correction is accepted only when:
 *  - the judge blamed the scenario (kind "scenario" or "both") through an
 *    attribution resolved to that very result (see resolveFailureAttributions);
 *  - the scenario is not handwritten (handwritten scenarios are ground truth);
 *  - it does not newly expect "allow". Loosening an expectation to allow is
 *    never automatic: the failure stays a rule failure, and the repair
 *    compiler gets the judge's argument as a note.
 * A "scenario" correction that differs from the engine's actual decision is
 * applied but cannot clear the failure: the corrected scenario still fails, so
 * it stays a rule failure. Nothing here declares a pass: after applying the
 * corrections the caller must re-run every scenario against the current rules.
 */
export function triageVerificationFailures(result: VerificationResult): FailureTriage {
  const corrections = new Map<TestScenario, ScenarioCorrection>();
  const notes = new Map<TestScenario, string>();
  const warnings: string[] = [];
  let ruleChangeRequested = false;

  for (const round of result.rounds) {
    const attributionByIndex = new Map((round.attributedFailures ?? []).map((a) => [a.resultIndex, a]));
    for (const [index, failure] of round.executionResults.entries()) {
      if (failure.pass) continue;
      const { scenario } = failure;
      const blame = attributionByIndex.get(index)?.blame;
      if (!blame) {
        notes.set(scenario, UNATTRIBUTED_FAILURE_NOTE);
        continue;
      }
      if (blame.kind === 'rule') continue;
      if (blame.kind === 'both') ruleChangeRequested = true;

      if (scenario.source === 'handwritten') {
        warnings.push(
          `Judge blamed handwritten scenario "${scenario.description}"; handwritten scenarios are ground truth, so it stays a rule failure`,
        );
        notes.set(scenario, 'Handwritten ground truth: this expectation cannot change.');
        continue;
      }
      const corrected = blame.correctedDecision;
      if (corrected === scenario.expectedDecision) continue;
      if (corrected === 'allow') {
        warnings.push(
          `Judge proposed loosening "${scenario.description}" from ${scenario.expectedDecision} to allow; ` +
            'not applied automatically, so it stays a rule failure',
        );
        notes.set(
          scenario,
          `The verifier judge proposed changing this expectation to allow (${blame.correctedReasoning}). ` +
            `An expectation is never loosened to allow automatically, so it stays ${scenario.expectedDecision}.`,
        );
        continue;
      }
      corrections.set(scenario, {
        scenarioDescription: scenario.description,
        correctedDecision: corrected,
        correctedReasoning: blame.correctedReasoning,
      });
      if (blame.kind === 'scenario' && corrected !== failure.actualDecision) {
        warnings.push(
          `Judge's correction for "${scenario.description}" (${corrected}) does not match the engine's decision ` +
            `(${failure.actualDecision}); it stays a rule failure`,
        );
      }
    }
    for (const unjudged of round.unjudgedResults ?? []) {
      if (!unjudged.pass) notes.set(unjudged.scenario, UNJUDGED_PROBE_NOTE);
    }
  }

  return { corrections, notes, ruleChangeRequested, warnings };
}

/**
 * Applies corrections to a scenario list by scenario identity (never by
 * description, which two scenarios can share), returning a new array.
 * Handwritten scenarios are never changed.
 */
export function applyScenarioCorrections(
  scenarios: TestScenario[],
  corrections: ReadonlyMap<TestScenario, ScenarioCorrection>,
): TestScenario[] {
  return scenarios.map((s) => {
    const correction = corrections.get(s);
    if (!correction || s.source === 'handwritten') return s;
    return {
      ...s,
      expectedDecision: correction.correctedDecision,
      reasoning: correction.correctedReasoning,
    };
  });
}
