/**
 * Shared types for the policy compilation pipeline.
 *
 * These types define the structure of the three persistent artifacts
 * produced by `compile-policy`: tool annotations, compiled policy rules,
 * and test scenarios. They are also used by the refactored PolicyEngine
 * at runtime.
 */

// ---------------------------------------------------------------------------
// Tool Annotations
// ---------------------------------------------------------------------------

// Canonical definition lives in src/types/argument-roles.ts.
// Re-exported here for backward compatibility with pipeline consumers.
import type { ArgumentRole } from '../types/argument-roles.js';
export type { ArgumentRole };
export { isArgumentRole, getArgumentRoleValues } from '../types/argument-roles.js';

// Re-use the runtime decision type under a pipeline-friendly alias.
import type { PolicyDecisionStatus } from '../types/mcp.js';
export type Decision = PolicyDecisionStatus;

import type { PolicyProvenance } from '../policy-artifacts/provenance.js';
export type { PolicyProvenance };

/**
 * What a compiled rule decides. Besides the engine decisions it can say
 * `assess`: allow the call, subject to the outbound content assessment of
 * its outbound-content arguments (message bodies, commit messages, URLs).
 * The engine evaluates an `assess` rule as an allow that carries
 * `EvaluationResult.assessContent`, ranked between allow and escalate; the
 * security pipeline then assesses the content when the user enabled the
 * assessment (`contentAssessment.enabled`) and escalates the call to a human
 * when the content looks encoded or hidden, or the assessment fails. With the
 * assessment disabled an `assess` rule allows like `allow`. The constitution
 * compiler never asks the model for it: `applyOutboundAssessment`
 * (trusted-process/outbound-rules.ts) turns every compiled allow that can
 * match an outbound-channel tool into `assess`, when the policy is compiled
 * and again when the engine loads it.
 */
export type RuleOutcome = Decision | 'assess';

export interface ToolAnnotation {
  toolName: string;
  serverName: string;
  comment: string;
  args: Record<string, ArgumentRole[]>;
}

export interface ToolAnnotationsFile {
  generatedAt: string;
  servers: Record<string, { inputHash: string; tools: ToolAnnotation[] }>;
}

// ---------------------------------------------------------------------------
// Conditional Argument Roles (stored/on-disk format)
// ---------------------------------------------------------------------------

/**
 * A condition on a sibling argument that determines which roles apply.
 * Exactly one of equals/in/is must be set.
 */
export interface RoleCondition {
  readonly arg: string;
  readonly equals?: string | number | boolean;
  readonly in?: ReadonlyArray<string | number | boolean>;
  readonly is?: 'present' | 'absent' | 'truthy' | 'falsy';
}

/**
 * A conditional role assignment: when the condition matches,
 * these roles apply instead of the default.
 */
export interface ConditionalRoleEntry {
  readonly condition: RoleCondition;
  readonly roles: ArgumentRole[];
}

/**
 * Roles for an argument that depend on the values of sibling arguments.
 * The `default` roles apply when no `when` clause matches.
 *
 * Invariant: each `when` entry's `roles` must be a subset of `default`.
 * This ensures conditional resolution can only narrow, never expand.
 */
export interface ConditionalRoles {
  readonly default: ArgumentRole[];
  readonly when: ConditionalRoleEntry[];
}

/**
 * An argument's roles in the stored (on-disk) format: either a static
 * array (backward compatible) or a conditional block with default + when.
 */
export type ArgumentRoleSpec = ArgumentRole[] | ConditionalRoles;

/**
 * Behaviour hints an MCP server declares for a tool (the `annotations` of its
 * tools/list entry), copied at annotation time. They come from the server, so
 * they may only tighten a check: the policy lint (`policy-lint.ts`) treats a
 * tool whose hints say it is not read-only, or destructive, as changing state.
 * A hint never exempts a tool from a check.
 */
export interface McpToolHints {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}

/**
 * A tool annotation as stored in tool-annotations.json.
 * Args may contain conditional role specs that need resolution
 * against actual tool call arguments before use.
 */
export interface StoredToolAnnotation extends Omit<ToolAnnotation, 'args'> {
  args: Record<string, ArgumentRoleSpec>;
  /** JSON Schema for the tool's input, captured from the MCP server at annotation time. */
  inputSchema: Record<string, unknown>;
  /**
   * The server's behaviour hints (see {@link McpToolHints}). Absent when the
   * server declared none, and in annotations written before they were captured.
   * `annotate-tools` copies them from the live listing for every tool it
   * writes, including one whose roles it reuses (`annotationKey`).
   */
  mcpHints?: McpToolHints;
  /**
   * Per-tool annotation cache key (`computeToolAnnotationKey` in
   * src/pipeline/tool-annotator.ts): sha256 of the tool's name, description
   * and input schema as the server listed them, and of the annotation prompt
   * and role-registry version. `annotate-tools` reuses this annotation's
   * roles and comment for a live tool with the same key instead of asking
   * the LLM again. Offline tooling only; the policy engine never reads it.
   * Absent on annotations written before it existed (they are re-annotated
   * once).
   */
  annotationKey?: string;
}

/**
 * Who produced a server's annotation entry.
 * - `package`: shipped with IronCurtain in `src/config/generated/` and reviewed.
 * - `user`: written into the user overlay (`~/.ironcurtain/generated/`) by the
 *   user's own `annotate-tools` run.
 */
export type AnnotationEntrySource = 'user' | 'package';

/**
 * One server's entry in a tool-annotations.json file.
 *
 * `inputHash` and `tools` are the original fields. The provenance fields are
 * optional so that files written before they existed still load; an entry
 * without `source` in the user overlay is a "legacy" entry (see
 * `src/config/tool-annotations-overlay.ts` for how it is resolved).
 */
export interface StoredServerAnnotations {
  /** sha256 of the server name, tools/list output and annotation prompt. */
  inputHash: string;
  /**
   * sha256 of the canonical JSON of `tools` when the entry was written.
   * Hand edits such as a role fix change the content but not `inputHash`;
   * this digest is what identifies a revision of the content.
   */
  contentDigest?: string;
  source?: AnnotationEntrySource;
  /** IronCurtain version that wrote (user) or first shipped (package) the entry. */
  producerVersion?: string;
  /**
   * User overlay only: keep this entry even when the package ships a reviewed
   * entry for the same tools. Set by `annotate-tools --server <name> --pin`.
   */
  pinned?: boolean;
  /**
   * Package only: content digests of earlier shipped revisions of this
   * server's entry. A user entry whose content matches one of them is a stale
   * copy of package data, not a user annotation.
   */
  supersededDigests?: string[];
  /**
   * The identity the server reported at `initialize` (name and version)
   * when the entry was written, so drift reports can say which release the
   * annotations describe. Informational: drift is detected by comparing the
   * stored and live tool schemas (`trusted-process/schema-drift.ts`), never
   * by version. Absent for servers that report none and for entries written
   * before it was recorded.
   */
  serverInfo?: { name: string; version: string };
  tools: StoredToolAnnotation[];
}

/**
 * The tool-annotations.json file format.
 * Uses StoredToolAnnotation because the file may contain conditional specs.
 */
export interface StoredToolAnnotationsFile extends Omit<ToolAnnotationsFile, 'servers'> {
  servers: Record<string, StoredServerAnnotations>;
}

// ---------------------------------------------------------------------------
// Compiled Policy
// ---------------------------------------------------------------------------

export interface PathCondition {
  roles: ArgumentRole[];
  within: string;
}

export interface DomainCondition {
  roles: ArgumentRole[];
  allowed: string[];
}

export interface ListCondition {
  roles: ArgumentRole[];
  allowed: string[];
  matchType: ListType;
}

export interface CompiledRuleCondition {
  roles?: ArgumentRole[];
  server?: string[];
  tool?: string[];
  paths?: PathCondition;
  domains?: DomainCondition;
  /**
   * List conditions (domains, emails, identifiers). A `domains` list on a URL
   * role matches the destinations the value resolves to, like `domains`.
   */
  lists?: ListCondition[];
}

export interface CompiledRule {
  name: string;
  description: string;
  principle: string;
  if: CompiledRuleCondition;
  /** See {@link RuleOutcome}; any other value is evaluated as a deny (fail closed). */
  then: RuleOutcome;
  reason: string;
  /**
   * An escalation from this rule is decided by a human and nothing else: the
   * LLM auto-approver is never consulted, no `/approve+` whitelist pattern is
   * offered or matched, and approval front-ends leave it out of "approve
   * all". Only the hardcoded rules for operations that widen the container's
   * egress (`proxy-add-domain-escalate` in `docker/proxy-tools.ts`,
   * `network-egress-escalate` in `trusted-process/egress-policy.ts`) set it;
   * the constitution compiler never emits it, and the runtime loaders reject
   * it in a compiled-policy.json (`src/types/policy-schema.ts`), so a
   * compiled policy file cannot grant or revoke it.
   */
  humanOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Dynamic Lists
// ---------------------------------------------------------------------------

/**
 * Taxonomy of list value types. Each type determines how values are
 * matched against tool call arguments at evaluation time.
 */
export type ListType = 'domains' | 'emails' | 'identifiers';

/**
 * A symbolic list definition emitted by the constitution compiler.
 * The compiler creates these when it encounters categorical references
 * in the constitution text (e.g., "major news sites", "my contacts").
 *
 * Invariant: the `name` matches the @list-name reference in compiled rules.
 * Invariant: the `type` determines matching semantics at evaluation time.
 */
export interface ListDefinition {
  /** Symbolic name, e.g., "major-news-sites". Used as @major-news-sites in rules. */
  readonly name: string;

  /** Determines matching semantics and value validation. */
  readonly type: ListType;

  /**
   * The constitution text that motivated this list.
   * Used for provenance tracking and display to users.
   */
  readonly principle: string;

  /**
   * Prompt for the resolver LLM to generate concrete values.
   * Written by the compiler LLM based on the constitution context.
   */
  readonly generationPrompt: string;

  /**
   * When true, the resolver should connect to MCP servers to resolve
   * this list. When false, the resolver uses only LLM knowledge.
   */
  readonly requiresMcp: boolean;

  /**
   * The one MCP server a data-backed list reads. Required when requiresMcp
   * is true (enforced by `getMcpListScopeError`): resolution connects only
   * this server, never "all servers", and never a network-egress server.
   * Unused for knowledge-based lists.
   */
  readonly mcpServerHint?: string;

  /**
   * Merged policies only. Set when the merge renamed the list because
   * several servers define a list of this name differently: `name` is then
   * `<server>--<sourceName>`, and `sourceName` is the name the list has in
   * that server's own artifacts (servers/<server>/compiled-policy.json and
   * dynamic-lists.json), which key its cached values. See
   * src/pipeline/list-merge.ts. Never set by the compiler.
   */
  readonly sourceName?: string;
}

/**
 * A single resolved dynamic list with its values and metadata.
 *
 * The authoritative ListDefinition lives in CompiledPolicyFile.listDefinitions.
 * This type holds only the resolved values and user overrides, avoiding
 * duplication and drift between artifacts.
 *
 * Effective values (what the policy engine expands `@name` to) are
 * `(values + manualAdditions) - manualRemovals`. The overrides the user edits
 * live in a policy's merged dynamic-lists.json; compile-policy and
 * refresh-lists carry them over from the previous file (see
 * src/pipeline/list-merge.ts). Per-server copies under servers/<server>/ hold
 * resolver output only.
 */
export interface ResolvedList {
  /** Only fresh, nonempty resolutions without validation loss are complete.
   * Missing legacy metadata is uncertain until the list is resolved again. */
  readonly resolutionState?: 'complete' | 'incomplete';
  /** The concrete resolved values. */
  readonly values: string[];

  /**
   * User-supplied additions that are always included regardless
   * of what the resolver produces. Survives refresh cycles and recompiles.
   */
  readonly manualAdditions: string[];

  /**
   * User-supplied removals that are always excluded regardless
   * of what the resolver produces. Survives refresh cycles and recompiles.
   */
  readonly manualRemovals: string[];

  /** ISO timestamp of last resolution. */
  readonly resolvedAt: string;

  /**
   * Content hash of inputs that produced this resolution. Empty for an
   * UNRESOLVED entry (a data-backed list skipped by a run without MCP
   * access), which is never a cache hit.
   */
  readonly inputHash: string;
}

/**
 * The dynamic-lists.json artifact.
 */
export interface DynamicListsFile {
  readonly generatedAt: string;
  readonly lists: Record<string, ResolvedList>;
}

/**
 * Phase in which a server's compilation failed. Same vocabulary as the
 * pipeline's progress phases (`CompilationPhase` without 'cached' and 'done').
 */
export type ServerCompilationFailurePhase =
  'compiling' | 'lists' | 'scenarios' | 'repair-scenarios' | 'verifying' | 'repair-compile' | 'repair-verify';

/** A server whose compilation failed and that therefore has no rules in the merged policy. */
export interface FailedServer {
  readonly serverName: string;
  readonly phase: ServerCompilationFailurePhase;
  /** Single-line, display-safe, length-bounded failure reason. */
  readonly reason: string;
}

export interface CompiledPolicyFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string;

  /**
   * How the policy was built: compiler epoch, policy-engine semantics and
   * verifier versions, producing IronCurtain version, policy model, and the
   * digest of the tool annotations each server's rules were compiled against.
   * Stamped by every compile; loaders compare it with the running IronCurtain
   * (see src/policy-artifacts/provenance.ts). Absent in policies compiled
   * before it existed, which loaders report as stale. Not read by the
   * PolicyEngine.
   */
  provenance?: PolicyProvenance;

  rules: CompiledRule[];

  /** List definitions emitted by the compiler. Empty if no dynamic lists needed. */
  listDefinitions?: ListDefinition[];

  /** Servers skipped by the pre-filter (all calls denied by default). */
  skippedServers?: Array<{
    readonly serverName: string;
    readonly reason: string;
  }>;

  /**
   * Servers whose compilation failed (LLM or network error, invalid rules,
   * verification still failing after every repair). They have no rules in this
   * policy, so every call to them is denied by default until a compile
   * succeeds. Informational: the PolicyEngine does not read it. Absent when
   * every compiled server succeeded.
   */
  failedServers?: FailedServer[];
}

/**
 * A caller's check on a freshly compiled, merged policy, run before any
 * artifact is written; throwing rejects the compile and leaves the previous
 * artifacts in place. It receives the resolved dynamic lists (undefined when
 * the policy defines none) and the stored tool annotations the policy was
 * compiled against, so it can tell which tools, and which argument roles, each
 * rule reaches. The persona broad-policy validator is the main implementation.
 */
export type CompiledPolicyValidator = (
  policy: CompiledPolicyFile,
  dynamicLists: DynamicListsFile | undefined,
  annotations: StoredToolAnnotationsFile,
) => void;

/**
 * Per-server compiled policy artifact.
 *
 * The cache-eligible copy lives at generated/servers/{serverName}/compiled-policy.json
 * and is written only after the rules passed verification, with `verified: true`.
 * Early, in-repair and failed rules go to compiled-policy.unverified.json with
 * `verified: false` (see src/pipeline/server-artifacts.ts).
 *
 * The cache key is split in three: `inputHash` (the compiler's inputs; a
 * mismatch recompiles), `rulesHash` (the verified rules themselves; a mismatch
 * means the file changed after verification and recompiles), and
 * `scenarioHash` (the scenario-generation inputs of the verified rules; a
 * mismatch keeps the rules and re-verifies them against fresh scenarios).
 */
export interface ServerCompiledPolicyFile {
  readonly generatedAt: string;
  readonly serverName: string;
  readonly constitutionHash: string;
  /** Hash of the compiler's inputs (`computeServerPolicyHash`), including the compiler epoch. */
  readonly inputHash: string;
  readonly rules: CompiledRule[];
  readonly listDefinitions?: ListDefinition[];
  /**
   * True only when these exact rules passed verification. Written in the same
   * atomic write as the rules. The per-server cache serves a file only when
   * this is `true`; files from older versions lack the field and count as
   * unverified.
   */
  readonly verified: boolean;
  /** When verification passed (present only when `verified` is true). */
  readonly verifiedAt?: string;
  /**
   * Verified commits only: canonical digest of `rules` and `listDefinitions`
   * as written (`computeServerRulesHash`). A commit whose rules no longer
   * match it is not served.
   */
  readonly rulesHash?: string;
  /**
   * Verified commits only: hash of the scenario-generation inputs computed
   * from the FINAL (verified, possibly repaired) rules and their resolved
   * lists. A later run recomputes it from the cached rules; a match lets it
   * serve them without any LLM call.
   */
  readonly scenarioHash?: string;
  /** Verified commits only: `ENGINE_SEMANTICS_VERSION` the rules were verified under. */
  readonly engineSemanticsVersion?: number;
  /** Verified commits only: `PIPELINE_VERIFIER_VERSION` of the verification. */
  readonly verifierVersion?: number;
  /**
   * Verified commits only: the policy model that compiled the rules, when
   * known. It also generated the scenarios and judged the rules unless
   * `verifierModelId` names another model.
   */
  readonly policyModelId?: string;
  /**
   * Verified commits only: the separate verifier model (`policyVerifierModelId`)
   * that generated the scenarios and judged the rules. Absent when the policy
   * model did both.
   */
  readonly verifierModelId?: string;
}

// ---------------------------------------------------------------------------
// Test Scenarios
// ---------------------------------------------------------------------------

/**
 * Expected decision for a test scenario.
 * 'not-allow' means any non-allow decision (deny or escalate) is acceptable.
 * Used by handwritten scenarios where the exact enforcement mechanism may vary.
 */
export type ScenarioDecision = Decision | 'not-allow';

export interface TestScenario {
  description: string;
  request: {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  expectedDecision: ScenarioDecision;
  reasoning: string;
  source: 'generated' | 'handwritten';
}

export interface TestScenariosFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string;
  scenarios: TestScenario[];
  /**
   * The decision the policy engine gave each scenario when the rules passed
   * verification, for offline replay by `ironcurtain doctor` (see
   * src/policy-artifacts/scenario-replay.ts). Absent in files written before
   * decisions were recorded.
   */
  replay?: ScenarioReplayRecord;
}

/** Decisions recorded at verification time, aligned with `TestScenariosFile.scenarios`. */
export interface ScenarioReplayRecord {
  /**
   * Sandbox directory the scenarios were evaluated with. Replay uses it too:
   * scenario paths refer to this directory, not to a session's sandbox.
   */
  readonly allowedDirectory: string;
  /** `decisions[i]` is the engine's decision for `scenarios[i]`. */
  readonly decisions: Decision[];
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  scenario: TestScenario;
  actualDecision: Decision;
  matchingRule: string;
  pass: boolean;
}

export interface DiscardedScenario {
  scenario: TestScenario;
  actual: ExecutionResult['actualDecision'];
  rule: string;
}

export interface VerifierRound {
  round: number;
  /** Results the judge saw in this round. */
  executionResults: ExecutionResult[];
  llmAnalysis: string;
  /** The judge's structured verdict for this round (its `pass` field). */
  judgePass: boolean;
  /** Probes the judge asked for, after schema, default-role-fallback and structural filtering. */
  newScenarios: TestScenario[];
  /**
   * The judge's failure attributions for this round, each resolved to the FAIL
   * result it names (`resultIndex`). Attributions that name no FAIL result of
   * this round are dropped, so those failures count as unattributed.
   */
  attributedFailures?: AttributedFailure[];
  /**
   * Set on the final round when the round limit ended verification before the
   * judge saw its probes: the results of running them afterwards. The judge
   * never reviewed these results, so their failures are unattributed.
   */
  unjudgedResults?: ExecutionResult[];
}

export interface VerificationResult {
  /**
   * True only when the judge's structured verdict in the final round was a pass
   * AND no executed scenario failed in any round (unjudged probes included).
   */
  pass: boolean;
  rounds: VerifierRound[];
  summary: string;
  /** Every failing result across all rounds, unjudged probe results included. */
  failedScenarios: ExecutionResult[];
}

// ---------------------------------------------------------------------------
// Blame Attribution (dual-channel repair)
// ---------------------------------------------------------------------------

export type FailureBlame =
  | { kind: 'rule'; reasoning: string }
  | { kind: 'scenario'; reasoning: string; correctedDecision: Decision; correctedReasoning: string }
  | { kind: 'both'; reasoning: string; correctedDecision: Decision; correctedReasoning: string };

export interface AttributedFailure {
  /** The description the judge gave; it matches the FAIL result's description. */
  scenarioDescription: string;
  /**
   * 0-based index into the round's `executionResults` of the FAIL result this
   * attribution applies to. Attributions are keyed by result, not by
   * description, because two scenarios can share a description.
   */
  resultIndex: number;
  blame: FailureBlame;
}

export interface ScenarioCorrection {
  scenarioDescription: string;
  correctedDecision: Decision;
  correctedReasoning: string;
}

// ---------------------------------------------------------------------------
// Repair Context (compile-verify-repair loop)
// ---------------------------------------------------------------------------

export interface RepairContext {
  /**
   * Failing scenarios the repair must fix. Empty when the judge rejected the
   * policy although no scenario failed; the judge analysis then says why.
   */
  failedScenarios: ExecutionResult[];
  /**
   * Notes on individual failures, keyed by their scenario: for example a probe
   * the judge never reviewed, or a correction the pipeline refused to apply.
   */
  failureNotes?: ReadonlyMap<TestScenario, string>;
  judgeAnalysis: string;
  attemptNumber: number;
  existingListDefinitions?: ListDefinition[];
  handwrittenScenarios?: TestScenario[];
}

// ---------------------------------------------------------------------------
// Point-Fix Repair (patch-based rule repair)
// ---------------------------------------------------------------------------

export type RulePatchOp =
  | { op: 'update'; ruleName: string; rule: CompiledRule }
  | { op: 'add'; afterRule?: string; rule: CompiledRule }
  | { op: 'delete'; ruleName: string };

export interface RulePatch {
  reasoning: string;
  operations: RulePatchOp[];
  listDefinitions?: ListDefinition[];
}
