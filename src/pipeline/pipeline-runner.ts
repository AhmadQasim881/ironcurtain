/**
 * PipelineRunner -- Encapsulates the full policy compilation pipeline.
 *
 * Provides a reusable abstraction over the compile-verify-repair loop.
 * Used by:
 * - compile.ts CLI (constitutionKind: 'constitution') -- per-server compilation
 * - compileTaskPolicy() (constitutionKind: 'task-policy') -- per-server whitelist
 * - compileTaskScopePolicy() (constitutionKind: 'task-policy', compile only:
 *   `skipVerification`) -- the task scope of a `--task-scoped` session
 *
 * Each MCP server is compiled independently with its own compile-verify-repair
 * cycle, then results are merged. This enables incremental recompilation and
 * better per-server rule quality.
 */

import { resolve } from 'node:path';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { LanguageModel, SystemModelMessage } from 'ai';
import chalk from 'chalk';
import pLimit from 'p-limit';
import {
  extractServerDomainAllowlists,
  findAnnotationServerDrift,
  getCwdDerivedProtectedPaths,
  loadDynamicListsArtifact,
  safeForDisplay,
} from '../config/index.js';
import { createLanguageModel } from '../config/model-provider.js';
import type { MCPServerConfig } from '../config/types.js';
import { loadUserConfig } from '../config/user-config.js';
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import {
  buildBroadEgressSection,
  buildCompilerSystemPrompt,
  ConstitutionCompilerSession,
  formatAnnotationsSummary,
  formatGroundTruthSection,
  validateCompiledRules,
  type CompilationOutput,
} from './constitution-compiler.js';
import { applyOutboundAssessment } from '../trusted-process/outbound-rules.js';
import { getHandwrittenScenarios } from './handwritten-scenarios.js';
import {
  diffListValues,
  formatListValueChanges,
  isUnresolvedList,
  listsNeedingResolution,
  resolveAllLists,
  revalidateResolvedList,
} from './list-resolver.js';
import {
  DYNAMIC_LISTS_FILENAME,
  mergeDynamicLists,
  planListMerge,
  readDynamicListsArtifact,
  renameListReferences,
  type ListMergePlan,
} from './list-merge.js';
import { lintCompiledRules, type PolicyLintOptions } from './policy-lint.js';
import {
  computeHash,
  loadStoredToolAnnotationsFile,
  resolveRulePaths,
  writeArtifact,
  removeArtifactIfExists,
  createPipelineLlm,
  createPerServerModel,
  createThrottledModel,
  SpinnerProgressReporter,
  type CompilationPhase,
  type ServerProgressReporter,
} from './pipeline-shared.js';
import {
  commitVerifiedServerArtifacts,
  invalidateServerArtifacts,
  loadVerifiedServerArtifacts,
  serverArtifactDir,
  SERVER_POLICY_FILE,
  writeUnverifiedServerPolicy,
  writeUnverifiedServerScenarios,
  type ServerPolicyDraft,
  type VerifiedServerArtifacts,
} from './server-artifacts.js';
import { resolveStoredAnnotationsFile } from '../types/argument-roles.js';
import { assertServerPolicyRules } from '../types/policy-schema.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { canonicalDigest } from '../policy-artifacts/canonical-json.js';
import {
  ENGINE_SEMANTICS_VERSION,
  PIPELINE_VERIFIER_VERSION,
  POLICY_COMPILER_EPOCH,
  buildPolicyProvenance,
  withPolicyProvenance,
} from '../policy-artifacts/provenance.js';
import { recordScenarioDecisions } from '../policy-artifacts/scenario-replay.js';
import {
  applyScenarioCorrections,
  buildJudgeSystemPrompt,
  createVerifierEngine,
  detectAllDefaultRoleFallbacks,
  executeScenarios,
  filterStructuralConflicts,
  PolicyVerifierSession,
  triageVerificationFailures,
  verifyPolicy,
} from './policy-verifier.js';
import { filterInvalidSchemaScenarios, type LiveSchemaIndex } from './scenario-schema-validator.js';
import { buildGeneratorSystemPrompt, generateScenarios, repairScenarios } from './scenario-generator.js';
import { prefilterServers } from './server-prefilter.js';
import type { LlmLogContext } from '../observability/llm-logger.js';
import { createCacheStrategy, type PromptCacheStrategy } from '../session/prompt-cache.js';
import {
  connectViaProxy,
  LIST_RESOLUTION_AUDIT_FILENAME,
  type ListResolutionMcpOptions,
  type MediatedMcpConnection,
} from './proxy-mcp-connections.js';
import type {
  CompiledPolicyFile,
  CompiledPolicyValidator,
  CompiledRule,
  Decision,
  DiscardedScenario,
  DynamicListsFile,
  ExecutionResult,
  FailedServer,
  ListDefinition,
  RepairContext,
  ResolvedList,
  ServerCompilationFailurePhase,
  ServerCompiledPolicyFile,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
  TestScenario,
  TestScenariosFile,
  ToolAnnotation,
  ToolAnnotationsFile,
  VerificationResult,
} from './types.js';

/**
 * Selects the LLM prompt variant for per-server policy compilation.
 *
 * - 'constitution': broad-principle compilation from a constitution document.
 * - 'task-policy': strict whitelist-generation from an English task description.
 *
 * Both modes compile each server independently via the per-server path.
 */
export type ConstitutionKind = 'constitution' | 'task-policy';

/**
 * Configuration for a single pipeline run.
 */
export interface PipelineRunConfig {
  /** The input text for compilation. */
  readonly constitutionInput: string;

  /** Controls which LLM prompt variant is used. */
  readonly constitutionKind: ConstitutionKind;

  /** Directory where compiled-policy.json and test-scenarios.json are written. */
  readonly outputDir: string;

  /** Directory where tool-annotations.json is read from. */
  readonly toolAnnotationsDir: string;

  /** Fallback directory for tool-annotations.json (package-bundled defaults). */
  readonly toolAnnotationsFallbackDir?: string;

  /** Sandbox boundary for structural invariant checks. */
  readonly allowedDirectory: string;

  /** Protected paths for structural invariant injection. */
  readonly protectedPaths: string[];

  /** MCP server configs (for domain allowlist extraction). */
  readonly mcpServers?: Record<string, MCPServerConfig>;

  /** Path to write LLM interaction logs. */
  readonly llmLogPath?: string;

  /**
   * Whether to include the handwritten scenarios (handwritten-scenarios.ts)
   * as ground truth: shown to the compiler and verified with every rule set
   * of the server they name. They are universal invariants that hold for any
   * constitution, persona or task, and the only expectations the policy under
   * test cannot have influenced, so every compile includes them (global,
   * persona and job compiles alike). Default true for both constitution
   * kinds; tests whose fake servers they do not apply to may turn them off.
   */
  readonly includeHandwrittenScenarios?: boolean;

  /** Progress callback for CLI output. */
  readonly onProgress?: (message: string) => void;

  /** Pre-loaded stored tool annotations (avoids re-reading from disk). */
  readonly preloadedStoredAnnotations?: StoredToolAnnotationsFile;

  /** Compile only these servers (default: all servers in annotations). */
  readonly serverFilter?: string[];

  /**
   * Whether to write the merged top-level artifacts (compiled-policy.json,
   * test-scenarios.json, dynamic-lists.json) into `outputDir`. The per-server
   * artifacts under `outputDir/servers/` are written either way.
   *
   * Defaults to true for a full run and to FALSE when `serverFilter` is set:
   * a filtered run compiles only some servers, so its merged result would
   * replace every other server's rules in the active policy. Pass true to
   * write it anyway (e.g. into a scratch `outputDir`).
   */
  readonly writeMergedArtifacts?: boolean;

  /**
   * Text for the pre-filter to evaluate server relevance against.
   * Caller provides the appropriate text for the compilation mode:
   * - Constitution mode: user constitution only (without base principles)
   * - Task-policy mode: task description
   * - Persona mode: persona constitution
   *
   * When undefined, the pre-filter is skipped. Its decisions are cached per
   * server in `outputDir/servers/<name>/prefilter-decision.json`.
   */
  readonly prefilterText?: string;

  /**
   * Factory for per-server progress reporters. When provided, both the
   * sequential and parallel paths use this instead of the built-in ora/spinner
   * (sequential) or multi-line (parallel) reporters. Non-TTY callers (e.g. the
   * daemon driving a compile over the WS surface) inject an event-bus reporter
   * here. Absent => the built-in reporters are used (CLI behavior).
   */
  readonly reporterFactory?: (serverName: string) => ServerProgressReporter;

  /**
   * Cooperative cancellation. Threaded into every LLM call (`abortSignal`) and
   * checked at each per-phase boundary so a long compile aborts promptly.
   */
  readonly signal?: AbortSignal;

  /**
   * Suppress narrative stderr output. The daemon path sets this so progress is
   * routed through `onProgress`/`reporterFactory` instead of polluting stderr.
   * When `quiet` is true, a `reporterFactory` MUST be supplied — there is no
   * silent fallback to the ora/spinner reporter (it would write to stderr).
   */
  readonly quiet?: boolean;

  /**
   * Whether the list resolver may connect to live MCP servers to resolve
   * data-backed (`requiresMcp: true`) lists. Defaults to true (CLI). The WS
   * compile path sets this to false: there is no live MCP available, so any
   * list definition that requires MCP fails fast with a typed error rather than
   * silently resolving to empty.
   */
  readonly allowMcpLists?: boolean;

  /**
   * Optional validation hook invoked on the in-memory merged policy BEFORE any
   * artifact is written. Throwing rejects the compile and leaves all prior
   * artifacts intact (no partial write). It receives the merged dynamic lists
   * and the stored tool annotations this run compiled against. Used by the
   * persona compile to enforce the broad-policy invariant atomically.
   */
  readonly validateCompiled?: CompiledPolicyValidator;

  /**
   * Compile rules (and resolve their dynamic lists) without generating
   * scenarios, verifying or repairing them. Only for a policy that can only
   * narrow another, verified one: a task scope (`--task-scoped`), which the
   * policy engine intersects with the session policy, so an unverified rule
   * there can at worst escalate a call the session policy allows and never
   * allow one it does not. The deterministic rule checks (policy lint)
   * still run after the compiler and after list resolution. Each server's
   * rules are kept as an unverified draft only (never served from the
   * per-server cache), and the merged scenarios file is empty. Defaults to
   * false (compile, verify, repair).
   */
  readonly skipVerification?: boolean;

  /**
   * Input schemas of the tools the reachable MCP servers list right now,
   * keyed by `liveSchemaKey(server, tool)` (`compile-policy` collects them
   * while checking the stored annotations for drift). Scenario validation
   * prefers them to the schemas stored in the annotations, which are as old
   * as the annotation; tools absent from the index fall back to the stored
   * schema. Every schema check uses them alike: generated scenarios, their
   * replacements, the judge's probes (inside verifyPolicy and again before
   * they are accumulated) and the replays, so a replay selects exactly the
   * scenarios verification ran. Absent with `--no-mcp` and for callers
   * without live servers.
   */
  readonly liveToolSchemas?: LiveSchemaIndex;

  /**
   * Ignore every per-server verified commit (and the scenarios stored with
   * it): each server is recompiled, its scenarios regenerated and its rules
   * re-verified (`compile-policy --force`). Cached pre-filter decisions are
   * ignored too: every server is judged again. For use after switching the
   * policy model or upgrading the verifier, whose versions the cache only
   * warns about. Resolved dynamic lists keep their own per-list cache
   * (`refresh-lists` re-resolves them).
   */
  readonly force?: boolean;

  /**
   * How this caller's user recompiles a server without the cache, named in
   * the warning about a cached result made by another policy model or
   * verifier version (one sentence). `compile-policy` names its `--force`.
   * Default: remove the server's artifact directory and compile again, which
   * works for every caller (persona and cron-job compiles have no `--force`).
   */
  readonly cacheBypassHint?: string;

  /**
   * Accept allow rules with broad domain access: `*`, a wildcard over a public
   * suffix (`*.com`, `*.github.io`), or a URL role with no domains condition.
   * The policy lint rejects them otherwise. Set only from an explicit opt-in:
   * compile-policy's `--allow-broad-domains` flag or constitution directive,
   * or a persona's `allowBroadPolicy` flag. Default false.
   */
  readonly allowBroadDomains?: boolean;
}

/**
 * LLM model references shared across pipeline runs.
 * Thin wrapper around PipelineLlm with a renamed field for clarity.
 */
export interface PipelineModels {
  /** The unwrapped base model for creating per-server wrapped models. */
  readonly baseLlm: LanguageModelV3;
  readonly cacheStrategy: PromptCacheStrategy;
  readonly logPath: string;
  /** Cheap model for pre-filter classification (Haiku). */
  readonly prefilterModel: LanguageModel;
  /**
   * The configured pre-filter model (`prefilterModelId`), part of the key of
   * every cached pre-filter decision. Defaults to the provider and model id
   * `prefilterModel` reports.
   */
  readonly prefilterModelId?: string;
  /**
   * The configured policy model (`policyModelId`), recorded in the policy's
   * provenance and in each verified per-server commit. A cached commit made by
   * another model is served with a warning. Undefined when unknown (fakes).
   */
  readonly policyModelId?: string;
  /**
   * The verification oracle's own model (`policyVerifierModelId`): it
   * generates the test scenarios (and the replacements for discarded ones)
   * and judges the compiled rules, so the model that writes the rules is not
   * the only one that checks them. Absent: `baseLlm` does both.
   */
  readonly verifier?: PipelineVerifierModel;
}

/** A verification model separate from the policy model (see {@link PipelineModels.verifier}). */
export interface PipelineVerifierModel {
  /** The unwrapped base model; each server wraps it with logging and throttling. */
  readonly baseLlm: LanguageModelV3;
  /** Prompt-cache strategy for this model's provider. */
  readonly cacheStrategy: PromptCacheStrategy;
  /** The configured model ID, recorded in each verified per-server commit. Undefined when unknown (fakes). */
  readonly modelId?: string;
}

/**
 * Creates PipelineModels from user config. Delegates to shared createPipelineLlm.
 *
 * `logFileName` overrides the default `llm-interactions.jsonl` filename so a
 * caller can scope the log to a single operation (e.g. the persona compile
 * orchestrator passes `<operationId>.jsonl`).
 *
 * A `policyVerifierModelId` other than the policy model gets its own model
 * (bound to the `policy` host profile like the policy model) for scenario
 * generation and judging.
 */
export async function createPipelineModels(logDir?: string, logFileName?: string): Promise<PipelineModels> {
  const effectiveLogDir = logDir ?? resolve(process.cwd(), 'generated');
  const llm = await createPipelineLlm(effectiveLogDir, 'unknown', logFileName);
  const userConfig = loadUserConfig();
  const haikuBaseLlm = await createLanguageModel(userConfig.prefilterModelId, userConfig, 'prefilter');
  const { model: prefilterModel } = createPerServerModel(haikuBaseLlm, llm.logPath, 'prefilter');
  const verifierModelId = userConfig.policyVerifierModelId;
  const verifier: PipelineVerifierModel | undefined =
    verifierModelId !== undefined && verifierModelId !== userConfig.policyModelId
      ? {
          baseLlm: await createLanguageModel(verifierModelId, userConfig, 'policy'),
          cacheStrategy: createCacheStrategy(verifierModelId),
          modelId: verifierModelId,
        }
      : undefined;
  return {
    baseLlm: llm.baseLlm,
    cacheStrategy: llm.cacheStrategy,
    logPath: llm.logPath,
    prefilterModel,
    prefilterModelId: userConfig.prefilterModelId,
    policyModelId: userConfig.policyModelId,
    ...(verifier ? { verifier } : {}),
  };
}

/** A model's identity for cache keys: its id string, or provider and model id. */
function modelIdentity(model: LanguageModel): string {
  return typeof model === 'string' ? model : `${model.provider}:${model.modelId}`;
}

// ---------------------------------------------------------------------------
// Per-server compilation types (internal to pipeline-runner)
// ---------------------------------------------------------------------------

/** Inputs for compiling a single server's policy rules. */
interface ServerCompilationUnit {
  readonly serverName: string;
  readonly annotations: ToolAnnotation[];
  readonly storedAnnotations: StoredToolAnnotation[];
  readonly constitutionText: string;
  readonly constitutionKind: ConstitutionKind;
  readonly allowedDirectory: string;
  readonly protectedPaths: string[];
  readonly mcpServerConfig?: MCPServerConfig;
  readonly handwrittenScenarios: TestScenario[];
  /** See {@link PipelineRunConfig.liveToolSchemas}. */
  readonly liveToolSchemas?: LiveSchemaIndex;
  /** Run-wide policy lint settings (see {@link lintSettingsFor}). */
  readonly lint: LintSettings;
}

/** The run-wide part of the policy lint's options; annotations and lists come per check. */
type LintSettings = Omit<PolicyLintOptions, 'annotations' | 'dynamicLists'>;

/** Output from a single server's compilation cycle. */
interface ServerCompilationResult {
  readonly serverName: string;
  readonly rules: CompiledRule[];
  readonly listDefinitions: ListDefinition[];
  readonly scenarios: TestScenario[];
  /**
   * The engine's decision for each of `scenarios` when the rules passed
   * verification (index-aligned). Undefined for a cached commit that did not
   * record them.
   */
  readonly scenarioDecisions?: Decision[];
  readonly inputHash: string;
  readonly constitutionHash: string;
  readonly resolvedLists?: DynamicListsFile;
  /**
   * Scenarios run against the final rules in this run (the commit replay).
   * Undefined when the result was served from the verified cache without
   * being verified again.
   */
  readonly testedScenarios?: number;
  /** Verifier version the rules passed (older for a commit served from cache). */
  readonly verifierVersion?: number;
  /** Policy model that compiled the rules, when known. */
  readonly policyModelId?: string;
}

/** Everything the phases of one server's compilation share. */
interface ServerRunContext {
  readonly unit: ServerCompilationUnit;
  readonly config: PipelineRunConfig;
  readonly constitutionHash: string;
  /** `computeServerPolicyHash` of the current inputs. */
  readonly inputHash: string;
  readonly compilerSystem: string | SystemModelMessage;
  /** Compiles and repairs the rules and resolves their lists. */
  readonly model: LanguageModel;
  /** Generates the test scenarios and judges the rules (the policy model unless a verifier is configured). */
  readonly verifier: ServerVerifierModel;
  readonly logContext: LlmLogContext;
  readonly reporter: ServerProgressReporter;
  readonly serverOutputDir: string;
  /** MCP access for this server's data-backed lists, shared by all its list resolutions. */
  readonly listConnection: ListMcpConnection;
}

/**
 * The policy-mediated MCP connection (`connectViaProxy`) one server's compile
 * uses for its data-backed lists. It is opened only when such a list misses
 * the list cache, reused by every later resolution of the same compile (the
 * repair loop resolves the lists again after each repair), and closed once
 * when the compile ends. A resolution that needs a server the open connection
 * does not reach replaces it with a connection for the lists it resolves.
 */
class ListMcpConnection {
  private connection: MediatedMcpConnection | undefined;
  private servers: ReadonlySet<string> = new Set();

  /** `options` is undefined when the compile has no MCP servers (`--no-mcp`): nothing can connect. */
  constructor(private readonly options: ListResolutionMcpOptions | undefined) {}

  /**
   * A connection reaching every server the data-backed `definitions` name,
   * or undefined when the compile has no MCP servers to connect.
   */
  async forLists(definitions: readonly ListDefinition[]): Promise<MediatedMcpConnection | undefined> {
    if (!this.options) return undefined;
    const needed = new Set(definitions.flatMap((d) => (d.requiresMcp && d.mcpServerHint ? [d.mcpServerHint] : [])));
    if (this.connection && [...needed].every((server) => this.servers.has(server))) return this.connection;
    await this.close();
    this.connection = await connectViaProxy(definitions, this.options);
    this.servers = needed;
    return this.connection;
  }

  /** Shuts the connection down (coordinator, audit log, relays); a no-op when none is open. */
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.servers = new Set();
    await connection?.shutdown();
  }
}

/** A server's verification model and the prompt-cache strategy of its provider. */
interface ServerVerifierModel {
  readonly model: LanguageModel;
  readonly cacheStrategy: PromptCacheStrategy;
}

/** Rules (fresh or from a verified commit) about to be verified and committed. */
interface RulesToVerify {
  readonly rules: CompiledRule[];
  readonly listDefinitions: ListDefinition[];
  readonly compilerSession: ConstitutionCompilerSession;
  /** Scenarios of the last verified commit, reused when their hash still matches. */
  readonly existingScenarios?: TestScenariosFile;
}

/** What the per-server cache can do with a verified commit whose inputHash matches. */
type CachedCommitDecision =
  | { readonly kind: 'hit'; readonly result: ServerCompilationResult }
  | {
      readonly kind: 'reverify';
      readonly reasons: readonly string[];
      readonly rules: CompiledRule[];
      readonly listDefinitions: ListDefinition[];
    }
  | { readonly kind: 'miss' };

/**
 * Mutable state threaded through the compile-verify-repair phases of a
 * single server's compilation. Keeps the orchestration method slim while
 * giving each extracted phase read/write access to shared state.
 */
interface ServerCompilationState {
  rules: CompiledRule[];
  listDefinitions: ListDefinition[];
  compilerSession: ConstitutionCompilerSession | undefined;
  dynamicLists: DynamicListsFile | undefined;
  serverPolicyFile: CompiledPolicyFile;
  verificationResult: VerificationResult;
  accumulatedProbes: TestScenario[];
  /** Repair compiles run so far. */
  repairAttempts: number;
  /** Why verification did not pass, for the failure report. Set when the rules are rejected. */
  failureDetail?: string;
  /** Scenarios the commit replay ran against the final rules (set when it passed). */
  testedScenarios?: number;
  /** Errors of the last repair the rule checks rejected (the previous rules were kept). */
  rejectedRepairErrors: readonly string[];
}

/**
 * Everything needed to re-run a server's scenarios against its current rules
 * exactly as verification runs them.
 */
interface ReplayContext {
  readonly unit: ServerCompilationUnit;
  readonly serverAnnotationsFile: StoredToolAnnotationsFile;
  readonly serverDomainAllowlists: ReadonlyMap<string, readonly string[]> | undefined;
  /** Drops structurally invalid scenarios, as before every verification. */
  readonly filterEngine: PolicyEngine;
}

/**
 * What the repair loop does after a verification that did not pass. Decided
 * from the judge's attributions and a deterministic replay of every scenario
 * against the current rules, never from the attributions alone.
 */
type VerificationAssessment =
  /** Every scenario passes against the current rules and the judge approved them. */
  | { readonly kind: 'pass'; readonly result: VerificationResult }
  /**
   * Repair the rules. `failures` are the scenarios that still fail on replay,
   * all of them rule failures; empty when no scenario fails but the judge
   * rejected the policy or asked for a rule change (blame "both").
   */
  | {
      readonly kind: 'repair';
      readonly failures: ExecutionResult[];
      readonly notes: ReadonlyMap<TestScenario, string>;
      readonly judgeAnalysis: string;
    }
  /** Scenario corrections cleared every failure, but the judge has not approved the rules yet. */
  | { readonly kind: 'reverify'; readonly judgeAnalysis: string };

/** Judge rounds in a server's initial verification. */
const INITIAL_VERIFY_MAX_ROUNDS = 3;

/**
 * Judge rounds in each follow-up verification (after a repair compile or after
 * scenario corrections). Two rounds let the judge see the results of the
 * probes it asks for before its final verdict; probes from the last round are
 * still run, unjudged.
 */
const FOLLOW_UP_VERIFY_MAX_ROUNDS = 2;

/** Follow-up verifications per server, each after a repair compile or after scenario corrections. */
const MAX_FOLLOW_UPS = 3;

/** What compiling one server produced: its result, or why it was left out. */
type ServerOutcome =
  | { readonly ok: true; readonly result: ServerCompilationResult }
  | { readonly ok: false; readonly failure: FailedServer };

/** Per-server results of a run, plus the servers that failed. */
interface ServerCompilationOutcomes {
  readonly results: ServerCompilationResult[];
  readonly failedServers: FailedServer[];
}

/** Longest failure reason recorded in `failedServers` (rendered characters). */
const FAILURE_REASON_MAX_LENGTH = 500;

/**
 * Forwards to a server's progress reporter and remembers the last phase the
 * server entered, so a failure can be attributed to a phase in `failedServers`.
 */
class PhaseTrackingReporter implements ServerProgressReporter {
  private current: ServerCompilationFailurePhase = 'compiling';

  constructor(private readonly inner: ServerProgressReporter) {}

  /** The phase the server was in most recently. */
  get phase(): ServerCompilationFailurePhase {
    return this.current;
  }

  update(phase: CompilationPhase, detail?: string): void {
    this.track(phase);
    this.inner.update(phase, detail);
  }

  complete(phase: CompilationPhase, summary: string, elapsed: number): void {
    this.track(phase);
    this.inner.complete(phase, summary, elapsed);
  }

  warn(message: string): void {
    this.inner.warn(message);
  }

  fail(phase: CompilationPhase, error: Error): void {
    this.inner.fail(phase, error);
  }

  done(summary: string): void {
    this.inner.done(summary);
  }

  private track(phase: CompilationPhase): void {
    if (phase !== 'cached' && phase !== 'done') this.current = phase;
  }
}

/**
 * Thrown by compileServer when a server's rules still fail verification after
 * every repair attempt. Its rules are kept only as inspection copies.
 * `detail` says why: the scenarios that still fail, or the judge's rejection.
 * When the last repair was rejected by the rule checks, their errors come
 * first: they often explain why the repairs could not converge (for example,
 * broad domain access the policy has not opted in to). The text quotes LLM
 * output (the judge's analysis, scenario descriptions, rule names), and
 * progress displays print error messages verbatim, so it is rendered as one
 * escaped, bounded line.
 */
class ServerVerificationFailedError extends Error {
  constructor(
    serverName: string,
    repairAttempts: number,
    detail: string,
    rejectedRepairErrors: readonly string[] = [],
  ) {
    const rejected =
      rejectedRepairErrors.length > 0
        ? `The last rejected repair failed the rule checks: ${rejectedRepairErrors.join('; ')}. `
        : '';
    super(
      `Verification still failing after ${repairAttempts} repair attempt(s); the rules were not used ` +
        `(inspect servers/${serverName}/compiled-policy.unverified.json and test-scenarios.unverified.json): ` +
        toDisplayText(rejected + detail, { maxLength: FAILURE_REASON_MAX_LENGTH }),
    );
    this.name = 'ServerVerificationFailedError';
  }
}

/**
 * Thrown when the merged policy fails the policy lint. Per-server checks run
 * first, so this is the last line of defence (for example, for a dynamic list
 * that two servers define differently). Nothing is written. Carries a
 * discriminant `code` so callers can detect it without importing this module.
 */
export class PolicyLintError extends Error {
  readonly code = 'POLICY_LINT_FAILED';
  constructor(readonly errors: readonly string[]) {
    super(`The compiled policy failed the policy checks; nothing was written: ${errors.join('; ')}`);
    this.name = 'PolicyLintError';
  }
}

/**
 * Thrown when every server that was compiled failed, so no policy was written.
 * Carries a discriminant `code` (callers can check it without importing this
 * module) and the per-server failures.
 */
export class AllServersFailedError extends Error {
  readonly code = 'ALL_SERVERS_FAILED';
  constructor(readonly failedServers: readonly FailedServer[]) {
    super(
      `All ${failedServers.length} server(s) failed compilation: ` +
        `${failedServers.map((f) => `${f.serverName} [${f.phase}]: ${f.reason}`).join('; ')}. ` +
        'No policy rules were produced.',
    );
    this.name = 'AllServersFailedError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Content of resolved lists that decides what rules referencing them match:
 * the values and the user's overrides, per list. Timestamps and the per-list
 * definition hash are left out (the definitions are covered by the rules).
 */
function resolvedListsDigest(dynamicLists: DynamicListsFile | undefined): string {
  if (!dynamicLists) return '';
  return canonicalDigest(
    Object.fromEntries(
      Object.entries(dynamicLists.lists).map(([name, list]) => [
        name,
        {
          values: list.values,
          manualAdditions: list.manualAdditions,
          manualRemovals: list.manualRemovals,
          resolutionState: list.resolutionState ?? 'legacy',
          unresolved: list.inputHash === '',
        },
      ]),
    ),
  );
}

/**
 * Hash of the scenario-generation inputs: the generator prompt (constitution,
 * annotations, sandbox, the directories the rules name, a preview of the
 * lists), the handwritten scenarios and the full resolved list content (the
 * prompt shows only a preview of each list).
 */
function computeScenariosHash(
  systemPrompt: string,
  handwrittenScenarios: TestScenario[],
  dynamicLists: DynamicListsFile | undefined,
): string {
  return computeHash(systemPrompt, JSON.stringify(handwrittenScenarios), resolvedListsDigest(dynamicLists));
}

/**
 * The scenario hash of a rule set: computed from the directories the rules
 * name and their resolved lists. A verified commit stores it for its
 * FINAL (possibly repaired) rules, and the cache check recomputes it from the
 * cached rules, so a repair that changed directories or lists no longer
 * misses the cache on the next run.
 */
function scenarioHashForRules(
  unit: ServerCompilationUnit,
  rules: CompiledRule[],
  dynamicLists: DynamicListsFile | undefined,
): string {
  const prompt = buildGeneratorSystemPrompt(
    unit.constitutionText,
    unit.storedAnnotations,
    unit.allowedDirectory,
    extractRuleDirectories(rules),
    dynamicLists,
  );
  return computeScenariosHash(prompt, unit.handwrittenScenarios, dynamicLists);
}

/**
 * The resolved lists a cached commit's rules use: the entries of the
 * per-server dynamic-lists.json in `serverOutputDir` named by its list
 * definitions, in definition order (the order resolution writes them in).
 * Undefined when the rules define no lists, so a stale file left by an earlier
 * compile is ignored (and not even read); 'incomplete' when there is no file
 * or a definition has no resolved entry.
 *
 * The file is read through the runtime schema (`loadDynamicListsArtifact`):
 * these values become the merged dynamic-lists.json (whose manual overrides
 * come from the previous merged file, see list-merge.ts), so a malformed file
 * throws and fails the server.
 */
function cachedListsFor(
  serverOutputDir: string,
  definitions: readonly ListDefinition[],
): DynamicListsFile | undefined | 'incomplete' {
  if (definitions.length === 0) return undefined;
  const file = loadDynamicListsArtifact(serverOutputDir);
  if (!file) return 'incomplete';
  const entries: Array<[string, ResolvedList]> = [];
  for (const definition of definitions) {
    if (!Object.hasOwn(file.lists, definition.name)) return 'incomplete';
    entries.push([definition.name, file.lists[definition.name]]);
  }
  return { generatedAt: file.generatedAt, lists: Object.fromEntries(entries) };
}

/**
 * The data-backed lists among `definitions` whose entry in `lists` is
 * UNRESOLVED: a run without MCP access (compile-policy --no-mcp) left them
 * empty (see `unresolvedList` in list-resolver.ts).
 */
function unresolvedMcpLists(
  lists: DynamicListsFile | undefined,
  definitions: readonly ListDefinition[],
): ListDefinition[] {
  if (!lists) return [];
  return definitions.filter(
    (definition) =>
      definition.requiresMcp &&
      Object.hasOwn(lists.lists, definition.name) &&
      isUnresolvedList(lists.lists[definition.name]),
  );
}

/**
 * Cached resolved lists as they are served: each re-validated against the
 * current value rules (revalidateResolvedList), as the merge step does for
 * every server. The rule checks of a cached commit see these values.
 */
function revalidateCachedLists(lists: DynamicListsFile, definitions: readonly ListDefinition[]): DynamicListsFile {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const entries = Object.entries(lists.lists).map(([name, list]): [string, ResolvedList] => {
    const definition = byName.get(name);
    return [name, definition ? revalidateResolvedList(list, definition) : list];
  });
  return { ...lists, lists: Object.fromEntries(entries) };
}

/**
 * Preventive warning: if `mcp-servers.json` declares servers that are not
 * present in `tool-annotations.json`, compiling will produce a policy with
 * no rules for those servers and every call to them will default-deny at
 * runtime. Surface this before starting the (slow) compile so the user
 * can re-run the per-server annotator first.
 *
 * `mcpServers` may be undefined when compile-policy is run with `--no-mcp`,
 * in which case the check is skipped.
 */
function warnOnCompileAnnotationGaps(
  mcpServers: Record<string, MCPServerConfig> | undefined,
  storedAnnotationsFile: StoredToolAnnotationsFile,
  log: NarrativeLogger = (msg) => {
    console.error(msg);
  },
): void {
  if (!mcpServers) return;
  const { missing } = findAnnotationServerDrift(storedAnnotationsFile, mcpServers);
  if (missing.length === 0) return;

  log(
    chalk.yellow(
      `Warning: ${missing.length} configured MCP server(s) have no tool annotations: ${missing.map(safeForDisplay).join(', ')}.`,
    ),
  );
  log(chalk.yellow('  The compiled policy will have no rules for these servers and their tools will be denied.'));
  for (const name of missing) {
    log(chalk.yellow(`  Run \`ironcurtain annotate-tools --server ${safeForDisplay(name)}\` to annotate this server.`));
  }
  log('');
}

/**
 * The directories the rules name in path conditions (`paths.within`), allow
 * and escalate rules alike, sorted. The scenario generator gets them as the
 * concrete paths of the directories a constitution names, labelled as
 * referenced by the policy under test and never as permitted (see
 * formatRuleDirectoriesSection in scenario-generator.ts).
 */
function extractRuleDirectories(rules: CompiledRule[]): string[] {
  const dirs = new Set<string>();
  for (const rule of rules) {
    if (rule.if.paths?.within) {
      dirs.add(rule.if.paths.within);
    }
  }
  return [...dirs].sort();
}

function collectProbeScenarios(result: VerificationResult): TestScenario[] {
  return result.rounds.flatMap((round) => round.newScenarios);
}

/** The scenarios verification can run, and why the others were set aside. */
interface VerifiableSelection {
  readonly valid: TestScenario[];
  /** Expectations that contradict a structural invariant (ground truth). */
  readonly structural: DiscardedScenario[];
  /** Arguments that leave every conditional role on its default (they test the wrong thing). */
  readonly fallback: Array<{ readonly scenario: TestScenario; readonly details: string }>;
  /** Arguments that violate the tool's input schema. */
  readonly schema: DiscardedScenario[];
}

/**
 * Selects the scenarios verification can run. Pure: logs nothing.
 * `liveSchemas` (see PipelineRunConfig.liveToolSchemas) takes precedence over
 * the stored input schemas for the schema check.
 */
function selectVerifiableScenarios(
  engine: PolicyEngine,
  scenarios: TestScenario[],
  storedAnnotations: StoredToolAnnotation[],
  liveSchemas: LiveSchemaIndex | undefined,
): VerifiableSelection {
  const structuralResult = filterStructuralConflicts(engine, scenarios);
  if (storedAnnotations.length === 0) {
    return { valid: structuralResult.valid, structural: structuralResult.discarded, fallback: [], schema: [] };
  }

  // Keyed by scenario object: two scenarios can share a description.
  const fallbackWarnings = new Map(
    detectAllDefaultRoleFallbacks(structuralResult.valid, storedAnnotations).map((w) => [w.scenario, w]),
  );
  const fallback: Array<{ scenario: TestScenario; details: string }> = [];
  const withRoles: TestScenario[] = [];
  for (const s of structuralResult.valid) {
    const warning = fallbackWarnings.get(s);
    if (warning) fallback.push({ scenario: s, details: warning.details.join('; ') });
    else withRoles.push(s);
  }

  // Unknown arg names, missing required fields, invalid enum values: against
  // the live schema when the server was reachable, else the stored one.
  const schemaResult = filterInvalidSchemaScenarios(withRoles, storedAnnotations, liveSchemas);
  return {
    valid: schemaResult.valid,
    structural: structuralResult.discarded,
    fallback,
    schema: schemaResult.discarded,
  };
}

function filterAndLogStructuralConflicts(
  engine: PolicyEngine,
  scenarios: TestScenario[],
  label: string = 'Discarded scenario (structural conflict)',
  storedAnnotations: StoredToolAnnotation[],
  reporter?: ServerProgressReporter,
  liveSchemas?: LiveSchemaIndex,
): { valid: TestScenario[]; discarded: DiscardedScenario[] } {
  const warn = (msg: string) => (reporter ? reporter.warn(msg) : console.error(msg));

  const selection = selectVerifiableScenarios(engine, scenarios, storedAnnotations, liveSchemas);
  for (const d of selection.structural) {
    const prefix =
      d.scenario.source === 'handwritten'
        ? chalk.yellow('Warning: handwritten scenario conflicts with structural invariant:')
        : chalk.dim(`${label}:`);
    warn(`  ${prefix} "${d.scenario.description}" — ${d.rule} always returns ${d.actual}`);
  }
  for (const f of selection.fallback) {
    warn(`  ${chalk.dim('Discarded (default role fallback):')} "${f.scenario.description}" — ${f.details}`);
  }
  for (const d of selection.schema) {
    warn(`  ${chalk.dim('Discarded (schema mismatch):')} "${d.scenario.description}" — ${d.rule}`);
  }

  return {
    valid: selection.valid,
    discarded: [
      ...selection.structural,
      ...selection.fallback.map((f) => ({
        scenario: f.scenario,
        rule: 'default-role-fallback',
        actual: 'deny' as const,
      })),
      ...selection.schema,
    ],
  };
}

/**
 * Re-runs every scenario verification runs -- the verifiable scenarios plus
 * the accumulated probes -- against the CURRENT rules, with the engine
 * verifyPolicy builds. Deterministic; no LLM call.
 */
function replayScenarios(
  state: ServerCompilationState,
  scenarios: TestScenario[],
  ctx: ReplayContext,
): ExecutionResult[] {
  const { valid } = selectVerifiableScenarios(
    ctx.filterEngine,
    scenarios,
    ctx.unit.storedAnnotations,
    ctx.unit.liveToolSchemas,
  );
  const engine = createVerifierEngine(
    state.serverPolicyFile,
    ctx.serverAnnotationsFile,
    ctx.unit.protectedPaths,
    ctx.unit.allowedDirectory,
    ctx.serverDomainAllowlists,
    state.dynamicLists,
  );
  return executeScenarios(engine, [...valid, ...state.accumulatedProbes]);
}

/**
 * Decides what follows a verification that did not pass. Applies the
 * corrections the judge's attributions justify (see
 * triageVerificationFailures), then replays every scenario against the
 * current rules: only the replay decides whether anything still fails, and
 * only a judge approval turns a clean replay into a pass.
 */
function assessVerification(
  state: ServerCompilationState,
  scenarioResult: { scenarios: TestScenario[]; inputHash: string },
  ctx: ReplayContext,
  reporter: ServerProgressReporter,
): VerificationAssessment {
  const verification = state.verificationResult;
  if (verification.pass) return { kind: 'pass', result: verification };

  const lastRound = verification.rounds.at(-1);
  const judgeAnalysis = lastRound?.llmAnalysis ?? verification.summary;
  const judgePass = lastRound?.judgePass ?? false;

  const triage = triageVerificationFailures(verification);
  for (const warning of triage.warnings) {
    reporter.warn(`  ${chalk.yellow('Warning:')} ${warning}`);
  }
  if (triage.corrections.size > 0) {
    scenarioResult.scenarios = applyScenarioCorrections(scenarioResult.scenarios, triage.corrections);
    state.accumulatedProbes = applyScenarioCorrections(state.accumulatedProbes, triage.corrections);
    reporter.warn(`  ${chalk.dim(`Corrected ${triage.corrections.size} scenario expectation(s)`)}`);
  }

  const replay = replayScenarios(state, scenarioResult.scenarios, ctx);
  const failures = replay.filter((r) => !r.pass);
  if (failures.length > 0) {
    return { kind: 'repair', failures, notes: triage.notes, judgeAnalysis };
  }
  if (judgePass && !triage.ruleChangeRequested) {
    const note =
      `[pipeline-runner: applied ${triage.corrections.size} scenario correction(s) from the judge's attributions; ` +
      `all ${replay.length} scenario(s) pass against the current rules.]`;
    return {
      kind: 'pass',
      result: { ...verification, pass: true, failedScenarios: [], summary: `${verification.summary}\n\n${note}` },
    };
  }
  // Nothing fails, but the judge has not approved. If corrections explain its
  // rejection, let it look again at the corrected scenarios; otherwise repair
  // from its analysis.
  if (triage.corrections.size > 0 && !triage.ruleChangeRequested) {
    return { kind: 'reverify', judgeAnalysis };
  }
  return { kind: 'repair', failures: [], notes: triage.notes, judgeAnalysis };
}

/** A bounded, single-paragraph list of failing scenarios for failure reports. */
function describeFailingScenarios(failures: ExecutionResult[]): string {
  const shown = failures
    .slice(0, 3)
    .map(
      (f) =>
        `"${f.scenario.description}" expected ${f.scenario.expectedDecision}, got ${f.actualDecision} (rule ${f.matchingRule})`,
    );
  const more = failures.length > shown.length ? `; and ${failures.length - shown.length} more` : '';
  return `${failures.length} scenario(s) still fail: ${shown.join('; ')}${more}`;
}

/** Why the repair loop gave up, for the failed-server report. */
function describeUnresolved(assessment: Exclude<VerificationAssessment, { kind: 'pass' }>): string {
  if (assessment.kind === 'reverify') {
    return `the verifier judge has not approved the policy since its scenario corrections: ${assessment.judgeAnalysis}`;
  }
  if (assessment.failures.length === 0) {
    return `the verifier judge rejected the policy without a failing scenario: ${assessment.judgeAnalysis}`;
  }
  return describeFailingScenarios(assessment.failures);
}

/** Fallback description of a failed verification (when the loop left no detail). */
function describeVerificationFailure(result: VerificationResult): string {
  return result.failedScenarios.length > 0
    ? describeFailingScenarios(result.failedScenarios)
    : `the verifier judge rejected the policy: ${result.summary}`;
}

/** Coerce an unknown thrown value into an Error. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * A narrative logger for non-progress output (summaries, warnings, gaps).
 * In quiet mode the message is routed to `onProgress` (so the daemon can
 * surface it) instead of stderr; otherwise it goes to stderr as before.
 */
type NarrativeLogger = (message: string) => void;

function makeNarrativeLogger(config: PipelineRunConfig): NarrativeLogger {
  if (config.quiet) {
    const onProgress = config.onProgress;
    return (msg: string) => {
      onProgress?.(msg);
    };
  }
  return (msg: string) => {
    console.error(msg);
  };
}

/**
 * Resolves the reporter for a server. A caller-supplied `reporterFactory`
 * always wins. When absent: quiet mode has NO fallback (the built-in reporters
 * write to stderr), so it is a configuration error; non-quiet mode uses the
 * built-in concrete reporter via `makeDefault`.
 */
function resolveReporter(
  config: PipelineRunConfig,
  serverName: string,
  makeDefault: () => ServerProgressReporter,
): ServerProgressReporter {
  if (config.reporterFactory) return config.reporterFactory(serverName);
  if (config.quiet) {
    throw new Error(
      `quiet:true requires a reporterFactory; no stderr-free reporter is available for server "${serverName}".`,
    );
  }
  return makeDefault();
}

/**
 * Compiled rules failed the deterministic checks (validateCompiledRules plus
 * the policy lint) and could not be repaired. The message carries the errors.
 */
class RuleValidationError extends Error {
  constructor(public readonly errors: readonly string[]) {
    super(`Compiled rules failed the rule checks: ${errors.join('; ')}`);
    this.name = 'RuleValidationError';
  }
}

/** A single-line, display-safe, bounded description of a server failure. */
function describeServerFailure(err: Error): string {
  return toDisplayText(err.message || err.name, { maxLength: FAILURE_REASON_MAX_LENGTH });
}

/** Longest single rule-check message printed to the progress output. */
const RULE_CHECK_MESSAGE_MAX_LENGTH = 1000;

/** How many times compiler output that fails the rule checks is sent back for a fix. */
const MAX_VALIDATION_REPAIRS = 2;

/**
 * Lint settings shared by every check in a run. The cwd-derived protected
 * entry (a relative AUDIT_LOG_PATH, by default `./audit.jsonl`) marks where
 * the command ran, not a sensitive location, so a directory that merely
 * contains it is not "too broad" (validateWorkspacePath exempts it the same
 * way).
 */
function lintSettingsFor(config: PipelineRunConfig): LintSettings {
  const cwdDerived = new Set(getCwdDerivedProtectedPaths());
  return {
    protectedPaths: config.protectedPaths.filter((path) => !cwdDerived.has(path)),
    allowedDirectory: config.allowedDirectory,
    allowBroadDomains: config.allowBroadDomains === true,
  };
}

/** Errors and warnings of the deterministic rule checks. */
interface RuleCheckResult {
  readonly errors: string[];
  readonly warnings: string[];
}

/**
 * The deterministic rule checks: validateCompiledRules (roles, list
 * references, path syntax) and the policy lint (rule breadth). `rules` have
 * canonical paths (resolveRulePaths). Pass the resolved dynamic lists once
 * they exist, so `@list` values count, and the rules as the compiler wrote
 * them when there are such (`writtenRules`): resolving turns a relative
 * `paths.within` into a directory under the compile's working directory, so
 * the syntax check must see the original to send it back for repair.
 */
function checkRules(
  rules: readonly CompiledRule[],
  listDefinitions: readonly ListDefinition[],
  annotations: readonly StoredToolAnnotation[],
  lint: LintSettings,
  inputs: { readonly dynamicLists?: DynamicListsFile; readonly writtenRules?: readonly CompiledRule[] } = {},
): RuleCheckResult {
  const validation = validateCompiledRules([...(inputs.writtenRules ?? rules)], [...listDefinitions]);
  const findings = lintCompiledRules(rules, { ...lint, annotations, dynamicLists: inputs.dynamicLists });
  return {
    errors: [...validation.errors, ...findings.errors.map((f) => f.message)],
    warnings: [...validation.warnings, ...findings.warnings.map((f) => f.message)],
  };
}

/** Prints rule-check messages, display-safe (they quote LLM-written rule names and values). */
function reportRuleCheck(reporter: ServerProgressReporter, label: string, messages: readonly string[]): void {
  for (const message of messages) {
    reporter.warn(`  ${label} ${toDisplayText(message, { maxLength: RULE_CHECK_MESSAGE_MAX_LENGTH })}`);
  }
}

/**
 * Re-checks rules that passed before their dynamic lists were resolved, now
 * with the list values (a list entry, such as a manual addition, can make an
 * allow rule broad). Throws RuleValidationError on errors. Warnings were
 * reported by the first check.
 */
function assertRulesPassWithLists(
  unit: ServerCompilationUnit,
  rules: readonly CompiledRule[],
  listDefinitions: readonly ListDefinition[],
  dynamicLists: DynamicListsFile | undefined,
): void {
  const check = checkRules(rules, listDefinitions, unit.storedAnnotations, unit.lint, { dynamicLists });
  if (check.errors.length > 0) throw new RuleValidationError(check.errors);
}

/**
 * Thrown when a list definition requires live MCP access (`requiresMcp: true`)
 * but the run was configured with `allowMcpLists: false` (e.g. the WS compile
 * path, which has no live MCP). Carries a discriminant `code` so callers can
 * detect it without importing this module (`error.code === 'MCP_LISTS_DISALLOWED'`).
 */
export class McpListsDisallowedError extends Error {
  readonly code = 'MCP_LISTS_DISALLOWED';
  constructor(public readonly listNames: string[]) {
    super(
      `Dynamic list(s) require live MCP access but it is disabled (allowMcpLists: false): ` +
        `${listNames.join(', ')}. Resolve these lists in an environment with MCP available, ` +
        `or remove the MCP-backed list definitions.`,
    );
    this.name = 'McpListsDisallowedError';
  }
}

/**
 * Whether this run can resolve data-backed lists: it has MCP server configs
 * (compile-policy without --no-mcp, persona and job compiles) and live MCP is
 * not disabled (`allowMcpLists: false`, the WS path).
 */
function canResolveMcpLists(config: PipelineRunConfig): boolean {
  return config.mcpServers !== undefined && config.allowMcpLists !== false;
}

function buildPolicyArtifact(
  constitutionHash: string,
  rules: CompiledRule[],
  listDefinitions: ListDefinition[],
  inputHash: string,
): CompiledPolicyFile {
  const artifact: CompiledPolicyFile = {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash,
    rules,
  };
  if (listDefinitions.length > 0) {
    artifact.listDefinitions = listDefinitions;
  }
  return artifact;
}

/**
 * Builds the task-policy system prompt for per-job compilation.
 * Instructs the LLM to generate a strict whitelist from the task.
 *
 * `handwrittenScenarios` are the universal invariants for this server, shown
 * as ground truth as in the constitution prompt (they are verified for task
 * policies too). With none, the prompt is the same as before they were
 * shown, so the compile cache of servers without them is unaffected.
 */
function buildTaskCompilerSystemPrompt(
  taskDescription: string,
  annotations: StoredToolAnnotation[],
  protectedPaths: string[],
  allowedDirectory: string,
  serverScope: string,
  handwrittenScenarios: readonly TestScenario[],
): string {
  const annotationsSummary = formatAnnotationsSummary(annotations);

  return `You are compiling a task-scoped security policy for an automated scheduled job. The job runs unattended on a schedule. Your goal is to generate the MINIMUM set of policy rules required for this specific task -- nothing more.

## Server Scope

You are generating rules ONLY for the "${serverScope}" server. Every rule you emit MUST include "server": ["${serverScope}"] in its "if" condition.

## Task Description

${taskDescription}

## Tool Annotations

These are the available tools and their classified capabilities:

${annotationsSummary}

## Structural Invariants (handled automatically -- do NOT generate rules for these)

1. **Protected paths** -- reads/writes/deletes to these paths are automatically denied:
${protectedPaths.map((p) => `- ${p}`).join('\n')}

2. **Workspace containment** -- operations within the job's workspace (${allowedDirectory}) are automatically allowed.

3. **Default deny** -- if no compiled rule matches, the operation is DENIED. You do NOT need catch-all rules.

## Instructions

Generate an ORDERED list of policy rules (first match wins) that allow EXACTLY the operations this task needs. Be a strict whitelist:

1. **Allow** operations the task explicitly describes or clearly requires.
   - "label each issue by type" -> allow github.add_label
   - "add a comment" -> allow github.create_comment
   - "close issues with no response for 30+ days" -> allow github.close_issue (the task explicitly authorizes this)

2. **Escalate** operations that are consequential AND only implicitly needed.
   - If the task says "fix bugs" but doesn't mention specific files, escalate write operations.
   - If an operation could cause data loss and the task doesn't explicitly authorize it, escalate.

3. **Omit** operations the task does not need. Default deny handles them.
   - Do NOT generate rules for tools unrelated to the task.
   - Do NOT generate broad "allow all reads" rules unless the task requires broad read access.

4. **Filesystem access**: The agent's workspace is automatically allowed. Only generate rules for filesystem access OUTSIDE the workspace if the task requires it.

5. **Side-effect-free operations**: Reading and listing operations for tools the task uses should generally be allowed. The task cannot operate without discovering available data.

## Rule Format

Produce an ORDERED list of policy rules (first match wins). Each rule has:
- "name": a kebab-case identifier
- "description": what the rule does
- "principle": which task requirement this implements
- "if": conditions that must ALL be true for the rule to fire:
  - "roles": array of argument roles to match. Omit = any tool.
  - "server": MUST be ["${serverScope}"]
  - "tool": array of specific tool names (omit = any matching tool)
  - "paths": path condition with "roles" and "within" (concrete absolute directory)
  - "domains": domain condition with "roles" and "allowed" (list of allowed domain patterns). For git-remote-url roles, use hostname/owner/repo patterns for specific repos (e.g., "github.com/provos/ironcurtain") or hostname-only for any repo on that host (e.g., "github.com"). Git tools with both path and URL roles need "domains" conditions for git-remote-url (path roles get sandbox-resolved separately).
  - "lists": array of list conditions with "roles", "allowed", and "matchType"
- "then": "allow" or "escalate" (deny is implicit via default-deny)
- "reason": human-readable explanation

CRITICAL RULES:
1. Do NOT generate rules for protected path checking, unknown tool denial, or sandbox containment.
2. Use CONCRETE ABSOLUTE paths when needed.
3. Order matters: more specific rules before more general ones.
4. Only output "allow" and "escalate" rules.
5. Be concise in descriptions and reasons -- one sentence each.
6. EVERY rule MUST have "server": ["${serverScope}"] in its condition.
7. Roles are evaluated independently and the most restrictive result wins. An ALLOW rule without "roles", "paths", "domains" or "lists" covers EVERY role of its tools: on a tool whose arguments carry write-path, delete-path, write-history or delete-history (in any mode) it allows those operations anywhere. Allow such roles only with a "paths" condition naming the directory, name the read roles explicitly ("roles": ["read-path"]) on multi-mode tools, and escalate the rest.
8. Every ALLOW rule names what it permits: a "tool" list (never a whole server), and for write, delete or history roles a specific directory (never a home directory, /home, /Users or /).${buildBroadEgressSection(annotations, false)}${formatGroundTruthSection(handwrittenScenarios)}`;
}

// ---------------------------------------------------------------------------
// Per-server merge helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Computes a content hash for a single server's policy compilation inputs.
 * The hash includes the policy-compiler epoch, the server name, constitution,
 * annotations, and prompt template so that any change invalidates the cache
 * for this server; bumping `POLICY_COMPILER_EPOCH` recompiles every server.
 *
 * The policy model and the verifier version are deliberately not part of it:
 * a commit made by another model or verified by another verifier version is
 * served with a warning instead of silently triggering a full, costly
 * recompile (`compile-policy --force` rebuilds on request).
 */
export function computeServerPolicyHash(
  serverName: string,
  constitutionText: string,
  annotations: ToolAnnotation[],
  compilerPromptTemplate: string,
  compilerEpoch: number = POLICY_COMPILER_EPOCH,
): string {
  return computeHash(
    `policy-compiler-epoch:${compilerEpoch}\n`,
    serverName,
    constitutionText,
    JSON.stringify(annotations),
    compilerPromptTemplate,
  );
}

/**
 * Filters handwritten scenarios to only those belonging to a specific server.
 * Safe because handwritten scenarios are tagged with serverName in their request.
 */
export function getHandwrittenScenariosForServer(serverName: string, sandboxDir: string): TestScenario[] {
  return getHandwrittenScenarios(sandboxDir).filter((s) => s.request.serverName === serverName);
}

/**
 * Debug assertion: validates that all rules from a server's compilation
 * are properly scoped to exactly that server. This should never fail if
 * the Zod schema with requireServer is correct.
 */
export function validateServerScoping(serverName: string, rules: CompiledRule[]): void {
  for (const rule of rules) {
    if (!rule.if.server || !rule.if.server.includes(serverName)) {
      throw new Error(
        `Rule "${rule.name}" from server "${serverName}" is missing ` +
          `server: ["${serverName}"] in its condition. This is a compiler bug.`,
      );
    }
    if (rule.if.server.length !== 1 || rule.if.server[0] !== serverName) {
      throw new Error(
        `Rule "${rule.name}" from server "${serverName}" has unexpected ` +
          `server scope: ${JSON.stringify(rule.if.server)}. Expected exactly ["${serverName}"].`,
      );
    }
  }
}

/**
 * Merges per-server compilation results into a single CompiledPolicyFile.
 * Rules are concatenated in alphabetical server order for determinism.
 *
 * List definitions are merged by `planListMerge` (list-merge.ts): servers
 * that define a list name identically share it, and a name that servers
 * define differently is kept apart per server (`<server>--<name>`, rewritten
 * in that server's rules), so every server's rules keep the values they were
 * verified against. The merged rules are then validated against the merged
 * definitions; an invalid merge throws instead of producing a policy.
 *
 * Servers that failed to compile are recorded in `failedServers` (they
 * contribute no rules). Pass `plan` when the caller already computed it.
 */
export function mergeServerResults(
  results: ServerCompilationResult[],
  constitutionHash: string,
  skippedServers?: Array<{ serverName: string; reason: string }>,
  log: NarrativeLogger = (msg) => {
    console.error(msg);
  },
  failedServers?: readonly FailedServer[],
  plan: ListMergePlan = planListMerge(results),
): CompiledPolicyFile {
  const sortedResults = [...results].sort((a, b) => a.serverName.localeCompare(b.serverName));

  for (const [name, servers] of plan.divergent) {
    log(
      `  Note: servers ${servers.join(', ')} define list "${name}" differently; each keeps its own ` +
        `(${servers.map((s) => `@${plan.renames.get(s)?.get(name) ?? name}`).join(', ')}).`,
    );
  }

  const allRules: CompiledRule[] = sortedResults.flatMap((r) =>
    renameListReferences(r.rules, plan.renames.get(r.serverName)),
  );
  const mergedListDefs = [...plan.definitions];

  // Each server's rules were validated against its own list definitions; the
  // renamed, merged set must still hold together (every reference defined,
  // list types matching the conditions that use them).
  const mergedValidation = validateCompiledRules(allRules, mergedListDefs);
  if (!mergedValidation.valid) {
    throw new Error(`The merged policy failed validation: ${mergedValidation.errors.join('; ')}`);
  }

  const mergedInputHash = computeHash(...sortedResults.map((r) => r.inputHash));

  const artifact: CompiledPolicyFile = {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: mergedInputHash,
    rules: allRules,
  };
  if (mergedListDefs.length > 0) {
    artifact.listDefinitions = mergedListDefs;
  }
  // skippedServers is informational metadata — not read by PolicyEngine.
  // It's intentionally excluded from inputHash; the constitutionHash already
  // changes when the constitution changes, which drives different skip decisions.
  if (skippedServers && skippedServers.length > 0) {
    artifact.skippedServers = skippedServers;
  }
  // failedServers is informational too (excluded from inputHash for the same
  // reason): the policy has no rules for these servers, so the engine
  // default-denies their tools whether or not it reads this field.
  if (failedServers && failedServers.length > 0) {
    artifact.failedServers = [...failedServers].sort((a, b) => a.serverName.localeCompare(b.serverName));
  }
  return artifact;
}

// ---------------------------------------------------------------------------
// PipelineRunner
// ---------------------------------------------------------------------------

/**
 * Encapsulates the full policy compilation pipeline:
 * compile rules -> generate scenarios -> verify -> repair loop.
 *
 * Uses per-server compilation with independent compile-verify-repair
 * cycles per server, then merges results. Works for both 'constitution'
 * (broad principles) and 'task-policy' (strict whitelist) modes.
 *
 * Every rule set also passes the deterministic rule checks
 * (validateCompiledRules and the policy lint, policy-lint.ts): after the
 * compiler answers (errors go back for a repair turn), after its dynamic
 * lists are resolved, on verified commits served or re-verified from the
 * per-server cache, for each repair (a failing repair is dropped for the
 * last valid rules), and on the merged policy before anything is written.
 */
export class PipelineRunner {
  private readonly baseLlm: LanguageModelV3;
  private readonly cacheStrategy: PromptCacheStrategy;
  private readonly logPath: string;
  private readonly prefilterModel: LanguageModel;
  private readonly prefilterModelId: string;
  private readonly policyModelId: string | undefined;
  private readonly verifierModel: PipelineVerifierModel | undefined;

  constructor(models: PipelineModels) {
    this.baseLlm = models.baseLlm;
    this.cacheStrategy = models.cacheStrategy;
    this.prefilterModel = models.prefilterModel;
    this.prefilterModelId = models.prefilterModelId ?? modelIdentity(models.prefilterModel);
    this.logPath = models.logPath;
    this.policyModelId = models.policyModelId;
    this.verifierModel = models.verifier;
  }

  /**
   * Runs the full pipeline. Returns the compiled policy on success.
   * All compilation modes use per-server compilation with independent
   * compile-verify-repair cycles per server, then merge results.
   */
  async run(config: PipelineRunConfig): Promise<CompiledPolicyFile> {
    return this.runPerServer(config);
  }

  // -----------------------------------------------------------------------
  // Per-server compilation path
  // -----------------------------------------------------------------------

  /**
   * Orchestrates per-server compilation + merge.
   *
   * Phase 1: Compile each server independently (compile-verify-repair per server)
   * Phase 2: Merge all per-server results into final compiled-policy.json
   * Phase 3: Resolve dynamic lists (global, post-merge)
   *
   * Works for both 'constitution' and 'task-policy' modes -- the
   * constitutionKind is forwarded to each server's compilation unit
   * to select the appropriate compiler prompt.
   */
  private async runPerServer(config: PipelineRunConfig): Promise<CompiledPolicyFile> {
    const log = makeNarrativeLogger(config);

    config.signal?.throwIfAborted();

    const storedAnnotationsFile =
      config.preloadedStoredAnnotations ??
      loadStoredToolAnnotationsFile(config.toolAnnotationsDir, config.toolAnnotationsFallbackDir);

    if (!storedAnnotationsFile) {
      throw new Error("tool-annotations.json not found. Run 'ironcurtain annotate-tools' first.");
    }

    warnOnCompileAnnotationGaps(config.mcpServers, storedAnnotationsFile, log);

    // Resolve conditional role specs to flat annotations for compiler prompts
    const toolAnnotationsFile = resolveStoredAnnotationsFile(storedAnnotationsFile);

    const constitutionHash = computeHash(config.constitutionInput);

    // Phase 1: Per-server compilation (with optional Haiku pre-filter)
    const {
      results: compiledResults,
      skippedServers,
      failedServers,
    } = await this.compileAllServers(config, toolAnnotationsFile, constitutionHash, storedAnnotationsFile);

    config.signal?.throwIfAborted();

    // Outbound channels: every allow that can match a tool carrying outbound
    // content (a message body, a commit message, a fetched URL) becomes an
    // `assess` rule, which allows subject to the opt-in outbound content
    // assessment (trusted-process/outbound-rules.ts). Applied here, to fresh
    // and cached server results alike, so the model, its repair rounds and
    // the verifier only ever deal with allow/escalate.
    const serverResults = compiledResults.map((result) => ({
      ...result,
      rules: applyOutboundAssessment(
        result.rules,
        Object.hasOwn(storedAnnotationsFile.servers, result.serverName)
          ? storedAnnotationsFile.servers[result.serverName].tools
          : [],
      ),
    }));

    // Phase 2: Merge (all three artifacts assembled in memory before any write).
    // planListMerge names every server's lists in the merged policy: a list
    // name that servers define differently is kept apart per server.
    // The merged policy records its provenance: this IronCurtain's compiler
    // and engine versions, the content digest of the annotations every
    // referenced server was compiled against, the oldest verifier version
    // among the servers (a commit served from cache may predate the current
    // one), and the policy model when every server shares it.
    const listPlan = planListMerge(serverResults);
    const mergedRules = mergeServerResults(
      serverResults,
      constitutionHash,
      skippedServers,
      log,
      failedServers,
      listPlan,
    );
    const models = new Set(serverResults.map((r) => r.policyModelId));
    const mergedPolicy = withPolicyProvenance(
      mergedRules,
      buildPolicyProvenance({
        policy: mergedRules,
        annotations: storedAnnotationsFile,
        policyModelId: models.size === 1 ? [...models][0] : undefined,
        verifierVersion: Math.min(
          PIPELINE_VERIFIER_VERSION,
          ...serverResults.map((r) => r.verifierVersion ?? PIPELINE_VERIFIER_VERSION),
        ),
      }),
    );

    const allScenarios = serverResults.flatMap((r) => r.scenarios);
    const mergedScenariosFile: TestScenariosFile = {
      generatedAt: new Date().toISOString(),
      constitutionHash,
      inputHash: mergedPolicy.inputHash,
      scenarios: allScenarios,
    };
    // Decisions recorded when each server's rules passed verification, for
    // offline replay by `ironcurtain doctor`. Kept only when every server has
    // them, so they stay index-aligned with the merged scenarios.
    const allDecisions: Decision[] = [];
    if (serverResults.every((r) => r.scenarioDecisions?.length === r.scenarios.length)) {
      for (const r of serverResults) allDecisions.push(...(r.scenarioDecisions ?? []));
      mergedScenariosFile.replay = { allowedDirectory: config.allowedDirectory, decisions: allDecisions };
    }

    // A filtered run holds only some servers' rules; writing them as the merged
    // policy would drop every other server from the active policy. Unless the
    // caller opts in, such a run leaves the merged artifacts untouched (its
    // per-server results under servers/ are already written).
    const writeMerged = config.writeMergedArtifacts ?? config.serverFilter === undefined;

    // Phase 3: Merge per-server resolved lists into the merged dynamic-lists.json.
    // Each server resolved its own lists during compileServer(). A fully cached
    // server serves its lists straight from disk, so they get the current value
    // rules here too (e.g. the Public Suffix List checks for domain lists). The
    // user's manual overrides live in the previous merged file and are carried
    // over (list-merge.ts); an unreadable or malformed file fails the run
    // rather than losing them.
    const previousLists =
      writeMerged || config.validateCompiled ? readDynamicListsArtifact(config.outputDir) : undefined;
    const { lists: mergedDynamicLists, notes: listNotes } = mergeDynamicLists(
      serverResults.map((result) => ({
        ...result,
        resolvedLists: result.resolvedLists && revalidateCachedLists(result.resolvedLists, result.listDefinitions),
      })),
      listPlan,
      previousLists,
    );
    for (const note of listNotes) log(chalk.yellow(`  Warning: ${note}`));

    // The policy lint on the merged policy, before anything is written. Every
    // server's rules (compiled or served from cache) were checked on their
    // own already; this is the last line of defence for every compile mode,
    // and the merged lists (the user's manual overrides included) are what the
    // engine will expand.
    const mergedLint = lintCompiledRules(mergedPolicy.rules, {
      ...lintSettingsFor(config),
      annotations: Object.values(storedAnnotationsFile.servers).flatMap((server) => server.tools),
      dynamicLists: mergedDynamicLists,
    });
    if (mergedLint.errors.length > 0) {
      throw new PolicyLintError(mergedLint.errors.map((finding) => finding.message));
    }

    // Optional caller validation runs on the in-memory policy BEFORE any artifact
    // is written, so a rejection leaves the prior generation's files intact.
    config.validateCompiled?.(mergedPolicy, mergedDynamicLists, storedAnnotationsFile);

    if (writeMerged) {
      this.writeMergedArtifacts(config.outputDir, mergedPolicy, mergedScenariosFile, mergedDynamicLists);
    }

    // Cross-server verification is intentionally omitted. Per-server rules compose
    // correctly by construction: every rule has server: [serverName] (enforced by
    // Zod schema), the engine checks cond.server.includes(request.serverName) so
    // rules from server A never match server B's calls, rules are only allow/escalate
    // with default-deny fallback, and structural invariants are evaluated before
    // compiled rules. Dynamic lists keep this property: a list name that servers
    // define differently is kept apart per server (planListMerge), so each server's
    // rules expand to the values resolved for its own definition. If each server's
    // rules verify in isolation, the merged set behaves identically, except for
    // the user's manual list overrides, which apply on top.

    // Summary
    const totalRules = mergedPolicy.rules.length;
    const serverCount = serverResults.length;
    // Only scenarios actually run against the final rules in this run count as
    // tested; servers served from the verified cache were tested when committed.
    const testedScenarios = serverResults.reduce((sum, r) => sum + (r.testedScenarios ?? 0), 0);
    const cachedServers = serverResults.filter((r) => r.testedScenarios === undefined).length;

    log('');
    log(`  Servers compiled: ${serverCount}`);
    if (failedServers.length > 0) {
      log(`  Servers failed: ${failedServers.length} (${failedServers.map((f) => f.serverName).join(', ')})`);
    }
    log(`  Rules: ${totalRules}`);
    log(
      `  Scenarios tested: ${testedScenarios}` +
        (cachedServers > 0 ? ` (${cachedServers} server(s) from cache, verified in an earlier run)` : ''),
    );
    if (writeMerged) {
      log(`  Artifacts written to: ${chalk.dim(config.outputDir + '/')}`);
    } else {
      log(`  Per-server artifacts written to: ${chalk.dim(resolve(config.outputDir, 'servers') + '/')}`);
      log(`  Merged policy not modified: this run compiled only ${serverResults.map((r) => r.serverName).join(', ')}.`);
    }
    if (config.llmLogPath) {
      log(`  LLM interaction log: ${chalk.dim(config.llmLogPath)}`);
    }

    log('');
    if (failedServers.length > 0) {
      log(
        chalk.yellow.bold(
          `Policy compilation finished with ${failedServers.length} failed server(s): ` +
            `${failedServers.map((f) => f.serverName).join(', ')}. ` +
            'They have no rules, so their tools are denied until a compile succeeds.',
        ),
      );
    } else {
      log(chalk.green.bold('Policy compilation successful!'));
    }

    return mergedPolicy;
  }

  /**
   * Writes the merged top-level artifacts.
   *
   * Write order is the REVERSE of the runtime read order in
   * loadPersonaPolicyArtifacts (compiled-policy first, then dynamic-lists):
   *   1. dynamic-lists.json (or atomically REMOVE the stale file when there
   *      are no list definitions and no manual overrides to keep — fixing the
   *      previous skip-leaves-stale bug)
   *   2. test-scenarios.json
   *   3. compiled-policy.json LAST
   * Each write is per-file atomic (tmp + rename). The dependency ordering
   * guarantees a concurrent reader that observes the NEW compiled-policy.json
   * already sees the matching dynamic-lists.json; the reverse interleaving
   * (new lists + old compiled) is fail-safe because an unknown @list-id
   * resolves to the empty allowlist => deny (PolicyEngine.getEffectiveListValues
   * returns [] for a missing list rather than throwing).
   */
  private writeMergedArtifacts(
    outputDir: string,
    mergedPolicy: CompiledPolicyFile,
    mergedScenariosFile: TestScenariosFile,
    mergedDynamicLists: DynamicListsFile | undefined,
  ): void {
    if (mergedDynamicLists) {
      writeArtifact(outputDir, DYNAMIC_LISTS_FILENAME, mergedDynamicLists);
    } else {
      removeArtifactIfExists(outputDir, DYNAMIC_LISTS_FILENAME);
    }
    writeArtifact(outputDir, 'test-scenarios.json', mergedScenariosFile);
    writeArtifact(outputDir, 'compiled-policy.json', mergedPolicy);
  }

  /**
   * Compiles rules for all servers, in parallel when multiple servers are present.
   * Single-server compilation uses sequential spinner-based output.
   * Multi-server compilation uses parallel execution with a multi-line progress display.
   */
  private async compileAllServers(
    config: PipelineRunConfig,
    toolAnnotationsFile: ToolAnnotationsFile,
    constitutionHash: string,
    storedAnnotationsFile: StoredToolAnnotationsFile,
  ): Promise<{
    results: ServerCompilationResult[];
    skippedServers: Array<{ serverName: string; reason: string }>;
    failedServers: FailedServer[];
  }> {
    const log = makeNarrativeLogger(config);
    const serverEntries = Object.entries(toolAnnotationsFile.servers);

    // Apply server filter if provided
    const { serverFilter } = config;
    const filteredEntries = serverFilter
      ? serverEntries.filter(([name]) => serverFilter.includes(name))
      : serverEntries;

    if (config.serverFilter && filteredEntries.length === 0) {
      throw new Error(
        `No matching servers found for filter: ${config.serverFilter.join(', ')}. ` +
          `Available: ${serverEntries.map(([n]) => n).join(', ')}`,
      );
    }

    // Pre-filter with Haiku: skip servers irrelevant to the input text
    let entriesToCompile = filteredEntries;
    const skippedServers: Array<{ serverName: string; reason: string }> = [];

    if (config.prefilterText !== undefined && !config.serverFilter) {
      const prefilterText = config.prefilterText;

      if (prefilterText.trim() === '') {
        log(chalk.yellow('Pre-filter input is empty. All servers skipped (default-deny applies).'));
        const allSkipped = filteredEntries.map(([name]) => ({
          serverName: name,
          reason: 'No input text provided — all servers skipped by default',
        }));
        return { results: [], skippedServers: allSkipped, failedServers: [] };
      }

      const serverToolPairs = filteredEntries.map(
        ([name]) => [name, toolAnnotationsFile.servers[name].tools] as [string, ReadonlyArray<ToolAnnotation>],
      );
      // Decisions are cached per server under outputDir, keyed by the text,
      // the server's tools, the prompt and the model, so an unchanged rerun
      // asks nothing and cannot flip a decision. --force asks again.
      const decisions = await prefilterServers(
        prefilterText,
        serverToolPairs,
        this.prefilterModel,
        config.constitutionKind,
        { outputDir: config.outputDir, modelId: this.prefilterModelId, refresh: config.force === true },
      );

      const decisionMap = new Map(decisions.map((d) => [d.serverName, d]));
      entriesToCompile = filteredEntries.filter(([name]) => {
        const decision = decisionMap.get(name);
        if (decision?.skip) {
          log(
            `  ${chalk.dim(name)}: ${chalk.yellow('skipped')} — ` +
              toDisplayText(decision.reason, { maxLength: FAILURE_REASON_MAX_LENGTH }) +
              (decision.cached ? chalk.dim(' (cached pre-filter decision)') : ''),
          );
          skippedServers.push({ serverName: name, reason: decision.reason });
          return false;
        }
        return true;
      });

      const skippedCount = filteredEntries.length - entriesToCompile.length;
      if (skippedCount > 0) {
        log(`  Pre-filter: ${skippedCount} server(s) skipped, ${entriesToCompile.length} proceeding`);
      }
      const cachedCount = decisions.filter((d) => d.cached).length;
      if (cachedCount > 0) {
        log(chalk.dim(`  Pre-filter: ${cachedCount} decision(s) reused from an earlier run with the same inputs`));
      }
    }

    if (entriesToCompile.length === 0) {
      log(chalk.yellow('All servers skipped by pre-filter. Policy will use default-deny only.'));
      return { results: [], skippedServers, failedServers: [] };
    }

    // Load handwritten scenarios once, then filter per server (avoids N redundant loads)
    const includeHandwritten = config.includeHandwrittenScenarios ?? true;
    const allHandwrittenScenarios = includeHandwritten ? getHandwrittenScenarios(config.allowedDirectory) : [];

    // Create concurrency controls
    const llmSemaphore = pLimit(8);
    const serverLimit = pLimit(10);
    const lint = lintSettingsFor(config);

    const buildUnit = (serverName: string): ServerCompilationUnit => ({
      serverName,
      annotations: toolAnnotationsFile.servers[serverName].tools,
      storedAnnotations: storedAnnotationsFile.servers[serverName].tools,
      constitutionText: config.constitutionInput,
      constitutionKind: config.constitutionKind,
      allowedDirectory: config.allowedDirectory,
      protectedPaths: config.protectedPaths,
      mcpServerConfig: config.mcpServers?.[serverName],
      handwrittenScenarios: allHandwrittenScenarios.filter((s) => s.request.serverName === serverName),
      liveToolSchemas: config.liveToolSchemas,
      lint,
    });

    const useParallel = entriesToCompile.length > 1;

    const { results, failedServers } = useParallel
      ? await this.compileServersParallel(
          entriesToCompile,
          config,
          constitutionHash,
          buildUnit,
          llmSemaphore,
          serverLimit,
        )
      : await this.compileServersSequential(entriesToCompile, config, constitutionHash, buildUnit, llmSemaphore);

    return { results, skippedServers, failedServers };
  }

  /** Creates a per-server model wrapped with LLM call throttling. */
  private createServerModel(
    serverName: string,
    llmSemaphore: ReturnType<typeof pLimit>,
    signal?: AbortSignal,
  ): { model: LanguageModel; verifier: ServerVerifierModel; logContext: LlmLogContext } {
    const { model, logContext } = createPerServerModel(this.baseLlm, this.logPath, serverName);
    const throttled = createThrottledModel(model, llmSemaphore, signal);
    if (!this.verifierModel) {
      return { model: throttled, verifier: { model: throttled, cacheStrategy: this.cacheStrategy }, logContext };
    }
    // The verifier logs to the same file under the same step names, and
    // shares the run's LLM concurrency limit and cancellation.
    const { model: verifierModel } = createPerServerModel(
      this.verifierModel.baseLlm,
      this.logPath,
      serverName,
      logContext,
    );
    return {
      model: throttled,
      verifier: {
        model: createThrottledModel(verifierModel, llmSemaphore, signal),
        cacheStrategy: this.verifierModel.cacheStrategy,
      },
      logContext,
    };
  }

  private async compileServersSequential(
    filteredEntries: [string, { tools: ToolAnnotation[] }][],
    config: PipelineRunConfig,
    constitutionHash: string,
    buildUnit: (name: string) => ServerCompilationUnit,
    llmSemaphore: ReturnType<typeof pLimit>,
  ): Promise<ServerCompilationOutcomes> {
    const log = makeNarrativeLogger(config);
    const outcomes: ServerOutcome[] = [];
    const totalServers = filteredEntries.length;

    for (let i = 0; i < filteredEntries.length; i++) {
      config.signal?.throwIfAborted();
      const [serverName] = filteredEntries[i];
      log('');
      log(chalk.bold(`[${i + 1}/${totalServers}] Compiling server: ${serverName}`));

      const outcome = await this.compileServerOutcome(
        serverName,
        config,
        constitutionHash,
        buildUnit,
        llmSemaphore,
        () => new SpinnerProgressReporter(serverName),
      );
      if (!outcome.ok) {
        log(`  ${chalk.red(`Server "${serverName}" failed (${outcome.failure.phase}):`)} ${outcome.failure.reason}`);
      }
      outcomes.push(outcome);
    }

    return this.handleCompilationResults(outcomes, log);
  }

  private async compileServersParallel(
    filteredEntries: [string, { tools: ToolAnnotation[] }][],
    config: PipelineRunConfig,
    constitutionHash: string,
    buildUnit: (name: string) => ServerCompilationUnit,
    llmSemaphore: ReturnType<typeof pLimit>,
    serverLimit: ReturnType<typeof pLimit>,
  ): Promise<ServerCompilationOutcomes> {
    const log = makeNarrativeLogger(config);

    // Lazy import to avoid loading parallel-progress.ts when not needed
    const { ParallelProgressDisplay, ParallelProgressReporter } = await import('./parallel-progress.js');

    const serverNames = filteredEntries.map(([name]) => name);
    // When a reporterFactory is injected the caller drives its own display; the
    // built-in multi-line ParallelProgressDisplay would write to stderr, so it
    // is only constructed for the built-in reporter path.
    const display = config.reporterFactory ? undefined : new ParallelProgressDisplay(serverNames);

    const settled = await Promise.allSettled(
      filteredEntries.map(([serverName]) =>
        serverLimit(async () => {
          config.signal?.throwIfAborted();
          return this.compileServerOutcome(serverName, config, constitutionHash, buildUnit, llmSemaphore, () => {
            // `display` is defined whenever reporterFactory is absent (built-in path).
            if (!display) throw new Error('internal: built-in parallel display missing');
            return new ParallelProgressReporter(display, serverName);
          });
        }),
      ),
    );

    display?.finish();

    const outcomes: ServerOutcome[] = [];
    for (const settledOutcome of settled) {
      // Per-server failures arrive as fulfilled outcomes. A rejection is a
      // run-level error (aborted run, MCP-backed lists disabled, reporter
      // misconfiguration) and fails the whole run.
      if (settledOutcome.status === 'rejected') throw toError(settledOutcome.reason);
      outcomes.push(settledOutcome.value);
    }

    return this.handleCompilationResults(outcomes, log);
  }

  /**
   * Compiles one server. A per-server failure (LLM or network error, invalid
   * rules, verification still failing after every repair) becomes a
   * `FailedServer` outcome. Run-level errors propagate instead: an aborted run,
   * and the disabled-MCP-list configuration error, which the orchestrator maps
   * to LIST_REQUIRES_MCP rather than a generic compile failure.
   */
  private async compileServerOutcome(
    serverName: string,
    config: PipelineRunConfig,
    constitutionHash: string,
    buildUnit: (name: string) => ServerCompilationUnit,
    llmSemaphore: ReturnType<typeof pLimit>,
    makeDefaultReporter: () => ServerProgressReporter,
  ): Promise<ServerOutcome> {
    const { model, verifier, logContext } = this.createServerModel(serverName, llmSemaphore, config.signal);
    const reporter = new PhaseTrackingReporter(resolveReporter(config, serverName, makeDefaultReporter));
    try {
      const result = await this.compileServer(
        buildUnit(serverName),
        config,
        constitutionHash,
        model,
        verifier,
        logContext,
        reporter,
      );
      return { ok: true, result };
    } catch (err) {
      const error = toError(err);
      const phase: ServerCompilationFailurePhase =
        err instanceof ServerVerificationFailedError ? 'verifying' : reporter.phase;
      // The failure reason is length-bounded; print every rule-check error.
      if (err instanceof RuleValidationError) reportRuleCheck(reporter, chalk.red('Rule check failed:'), err.errors);
      reporter.fail(phase, error);
      if (err instanceof McpListsDisallowedError) throw err;
      // An aborted run is not a per-server failure: surface the abort itself.
      config.signal?.throwIfAborted();
      return { ok: false, failure: { serverName, phase, reason: describeServerFailure(error) } };
    }
  }

  private handleCompilationResults(outcomes: ServerOutcome[], log: NarrativeLogger): ServerCompilationOutcomes {
    const results: ServerCompilationResult[] = [];
    const failedServers: FailedServer[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) results.push(outcome.result);
      else failedServers.push(outcome.failure);
    }

    if (results.length === 0) {
      throw new AllServersFailedError(failedServers);
    }

    if (failedServers.length > 0) {
      log('');
      log(
        chalk.yellow(
          `Warning: ${failedServers.length} server(s) failed and are left out of the policy (their tools will be denied):`,
        ),
      );
      for (const failure of failedServers) {
        log(chalk.yellow(`  ${failure.serverName} [${failure.phase}]: ${failure.reason}`));
      }
      log(chalk.yellow('Continuing with the servers that compiled.'));
    }

    return { results, failedServers };
  }

  /**
   * Compiles a single server: compile -> generate scenarios -> verify -> repair
   * (compile and list resolution only with `skipVerification`).
   * Self-contained compile-verify-repair loop per server.
   *
   * The per-server cache serves a verified commit whose compiler inputs
   * (`inputHash`) still match. When only the inputs of its test scenarios or
   * the policy-engine semantics changed, the commit's rules are re-verified
   * instead of recompiled. `config.force` ignores every commit.
   *
   * Each server receives its own model (with per-server logging middleware),
   * its verifier model (the same model unless a separate verifier is
   * configured), logContext (for step labeling), and reporter (for
   * progress/warnings). This makes the method safe for concurrent execution.
   */
  private async compileServer(
    unit: ServerCompilationUnit,
    config: PipelineRunConfig,
    constitutionHash: string,
    model: LanguageModel,
    verifier: ServerVerifierModel,
    logContext: LlmLogContext,
    reporter: ServerProgressReporter,
  ): Promise<ServerCompilationResult> {
    const serverOutputDir = serverArtifactDir(config.outputDir, unit.serverName);

    // Build per-server system prompt (only this server's annotations)
    const compilerPrompt =
      unit.constitutionKind === 'task-policy'
        ? buildTaskCompilerSystemPrompt(
            unit.constitutionText,
            unit.storedAnnotations,
            unit.protectedPaths,
            unit.allowedDirectory,
            unit.serverName,
            unit.handwrittenScenarios,
          )
        : buildCompilerSystemPrompt(
            unit.constitutionText,
            unit.storedAnnotations,
            {
              protectedPaths: unit.protectedPaths,
              allowedDirectory: unit.allowedDirectory,
              allowBroadDomains: unit.lint.allowBroadDomains === true,
            },
            unit.handwrittenScenarios.length > 0 ? unit.handwrittenScenarios : undefined,
            { serverScope: unit.serverName },
          );

    const inputHash = computeServerPolicyHash(unit.serverName, unit.constitutionText, unit.annotations, compilerPrompt);
    // Every resolver tool call is mediated by the security kernel under the
    // read-only policy and audited next to this server's artifacts.
    const listConnection = new ListMcpConnection(
      config.mcpServers
        ? {
            mcpServers: config.mcpServers,
            toolAnnotationsDir: config.toolAnnotationsDir,
            toolAnnotationsFallbackDir: config.toolAnnotationsFallbackDir,
            protectedPaths: config.protectedPaths,
            auditLogPath: resolve(serverOutputDir, LIST_RESOLUTION_AUDIT_FILENAME),
          }
        : undefined,
    );
    const ctx: ServerRunContext = {
      unit,
      config,
      constitutionHash,
      inputHash,
      compilerSystem: this.cacheStrategy.wrapSystemPrompt(compilerPrompt),
      model,
      verifier,
      logContext,
      reporter,
      serverOutputDir,
      listConnection,
    };
    try {
      return await this.compileServerWithContext(ctx);
    } finally {
      await listConnection.close();
    }
  }

  /** {@link compileServer} once the per-server context is built. */
  private async compileServerWithContext(ctx: ServerRunContext): Promise<ServerCompilationResult> {
    const { unit, config, inputHash, model, logContext, reporter, serverOutputDir } = ctx;

    // Per-server cache. Only a verified commit (rules that passed verification,
    // marked in the same atomic write) whose compiler inputs still match is
    // considered; --force ignores it.
    const verified = config.force ? undefined : loadVerifiedServerArtifacts(serverOutputDir, unit.serverName);
    if (verified && verified.policy.inputHash === inputHash) {
      const cached = this.checkVerifiedCommit(ctx, verified);
      if (cached.kind === 'hit') {
        this.warnOnCachedCommitDrift(ctx, verified.policy);
        reporter.complete('cached', `  ${unit.serverName}: compilation ${chalk.dim('(cached)')}`, 0);
        return cached.result;
      }
      if (cached.kind === 'reverify') {
        reporter.warn(
          `  ${chalk.dim(`${unit.serverName}: re-verifying the cached rules: ${cached.reasons.join('; ')}`)}`,
        );
        try {
          return await this.reverifyCachedRules(ctx, cached.rules, cached.listDefinitions, verified.scenarios);
        } catch (err) {
          // Only the check after list resolution throws this (repairs that
          // fail the checks are rejected, not thrown): the cached rules fail
          // with their freshly resolved lists, so they are recompiled.
          if (!(err instanceof RuleValidationError)) throw err;
          reporter.warn(
            `  ${chalk.yellow('Warning:')} cached rules fail the rule checks with their lists, recompiling:`,
          );
          reportRuleCheck(reporter, chalk.yellow('-'), err.errors);
        }
      }
    }

    // Recompiling: remove the verified pair before anything new is written, so
    // an abort, LLM error or crash below can never leave rules (or a new policy
    // beside an older scenarios file) that a later run would serve from cache.
    // The verified scenarios stay in memory for the scenario cache below.
    invalidateServerArtifacts(serverOutputDir);

    // Step 1: Compile rules for this server
    config.signal?.throwIfAborted();
    logContext.stepName = `compile-${unit.serverName}`;
    const compileResult = await this.compileServerPolicyRules(unit, ctx.compilerSystem, inputHash, model, reporter);

    // Validate server scoping (debug assertion)
    validateServerScoping(unit.serverName, compileResult.rules);

    return this.verifyAndCommit(ctx, {
      rules: compileResult.rules,
      listDefinitions: compileResult.listDefinitions,
      compilerSession: compileResult.session,
      existingScenarios: verified?.scenarios,
    });
  }

  /**
   * Decides what to do with a verified commit whose compiler inputs match:
   *  - 'hit': serve it without any LLM call;
   *  - 'reverify': keep its rules but verify them again, because the scenario
   *    hash recomputed from those rules and their resolved lists no longer
   *    matches the one recorded (the scenario prompt, handwritten scenarios or
   *    list values changed), their resolved lists are missing, a data-backed
   *    list was left unresolved by a run without MCP access and this run can
   *    resolve it (`canResolveMcpLists`), or they were verified under other
   *    policy-engine semantics;
   *  - 'miss': recompile, because its rules or list definitions do not match
   *    the compiled-policy.json schema, its rules are not scoped to this
   *    server (a hand-edited or corrupted file), or they (with their resolved
   *    lists, when present) fail the current rule checks, which may be
   *    stricter than the ones they passed or run without an opt-in the earlier
   *    compile had.
   *
   * A malformed per-server dynamic-lists.json that the rules use throws (see
   * {@link cachedListsFor}) and fails this server.
   */
  private checkVerifiedCommit(ctx: ServerRunContext, verified: VerifiedServerArtifacts): CachedCommitDecision {
    const { unit, reporter } = ctx;
    let rules: CompiledRule[];
    try {
      // The runtime schema (src/types/policy-schema.ts): served or re-verified
      // as they are, rules with an unknown decision or condition key would be
      // merged into a compiled-policy.json that no session loads, and every
      // unchanged recompile would write it again.
      assertServerPolicyRules(verified.policy, resolve(ctx.serverOutputDir, SERVER_POLICY_FILE));
      rules = resolveRulePaths(verified.policy.rules);
      validateServerScoping(unit.serverName, rules);
    } catch (err) {
      reporter.warn(`  ${chalk.yellow('Warning:')} cached rules rejected, recompiling: ${toError(err).message}`);
      return { kind: 'miss' };
    }
    const listDefinitions = verified.policy.listDefinitions ?? [];

    const lists = cachedListsFor(ctx.serverOutputDir, listDefinitions);
    // The rule checks see the lists as they are served: re-validated against
    // the current value rules, as the merge does for every server, so a value
    // those rules drop (it never reaches the engine) does not force a
    // recompile. Missing lists are resolved before the re-verification, and
    // the rules are checked again with their values then (verifyAndCommit).
    const servedLists =
      lists === 'incomplete' || lists === undefined ? undefined : revalidateCachedLists(lists, listDefinitions);
    const check = checkRules(rules, listDefinitions, unit.storedAnnotations, unit.lint, { dynamicLists: servedLists });
    if (check.errors.length > 0) {
      reporter.warn(`  ${chalk.yellow('Warning:')} cached rules fail the rule checks, recompiling:`);
      reportRuleCheck(reporter, chalk.yellow('-'), check.errors);
      return { kind: 'miss' };
    }

    const reasons: string[] = [];
    if (lists === 'incomplete') {
      reasons.push('its resolved dynamic lists are missing');
    } else {
      const scenarioHash = scenarioHashForRules(unit, rules, servedLists);
      if (verified.policy.scenarioHash !== scenarioHash || verified.scenarios.inputHash !== scenarioHash) {
        reasons.push('the inputs of its test scenarios changed');
      }
      // Rules verified while a data-backed list was unresolved (compile-policy
      // --no-mcp) were checked against an empty list. Served from cache, that
      // list would stay empty forever, so a run that can resolve it does and
      // verifies the rules again with its values.
      const unresolved = canResolveMcpLists(ctx.config) ? unresolvedMcpLists(lists, listDefinitions) : [];
      if (unresolved.length > 0) {
        reasons.push(
          `${unresolved.map((d) => `@${d.name}`).join(', ')} ${unresolved.length === 1 ? 'was' : 'were'} ` +
            'left unresolved by a run without MCP access',
        );
      }
    }
    const engineVersion = verified.policy.engineSemanticsVersion;
    if (engineVersion !== ENGINE_SEMANTICS_VERSION) {
      reasons.push(
        `it was verified under policy-engine semantics v${engineVersion ?? '?'} (this IronCurtain: v${ENGINE_SEMANTICS_VERSION})`,
      );
    }
    if (lists === 'incomplete' || reasons.length > 0) return { kind: 'reverify', reasons, rules, listDefinitions };

    const scenarios = verified.scenarios.scenarios;
    const decisions = verified.scenarios.replay?.decisions;
    return {
      kind: 'hit',
      result: {
        serverName: unit.serverName,
        rules,
        listDefinitions,
        scenarios,
        scenarioDecisions: decisions?.length === scenarios.length ? decisions : undefined,
        inputHash: ctx.inputHash,
        constitutionHash: ctx.constitutionHash,
        resolvedLists: servedLists,
        verifierVersion: verified.policy.verifierVersion,
        policyModelId: verified.policy.policyModelId,
      },
    };
  }

  /**
   * Warns when a served commit was verified by another pipeline verifier
   * version, compiled by another policy model than the one configured now, or
   * (when a separate verifier model is configured now or was then) judged by
   * another verifier model. None invalidates the cache (a silent full
   * recompile would be costly); the caller's `cacheBypassHint`
   * (`compile-policy --force`, or removing the server's artifact directory)
   * rebuilds on request.
   */
  private warnOnCachedCommitDrift(ctx: ServerRunContext, policy: ServerCompiledPolicyFile): void {
    const { unit, reporter } = ctx;
    const rebuild =
      ctx.config.cacheBypassHint ??
      `Remove ${toDisplayText(ctx.serverOutputDir)} and compile again to recompile and re-verify it.`;
    if (policy.verifierVersion !== PIPELINE_VERIFIER_VERSION) {
      reporter.warn(
        `  ${chalk.yellow('Warning:')} ${unit.serverName}: the cached policy was verified by pipeline verifier ` +
          `v${policy.verifierVersion ?? '?'}; this IronCurtain's verifier is v${PIPELINE_VERIFIER_VERSION}. ${rebuild}`,
      );
    }
    if (
      this.policyModelId !== undefined &&
      policy.policyModelId !== undefined &&
      policy.policyModelId !== this.policyModelId
    ) {
      reporter.warn(
        `  ${chalk.yellow('Warning:')} ${unit.serverName}: the cached policy was compiled by ` +
          `${toDisplayText(policy.policyModelId)}; the configured policy model is ${this.policyModelId}. ${rebuild}`,
      );
    }
    // Without a separate verifier on either side, the verifier is the policy
    // model and the warning above already covers it.
    const configuredVerifier = this.verifierModel?.modelId ?? this.policyModelId;
    const cachedVerifier = policy.verifierModelId ?? policy.policyModelId;
    if (
      (this.verifierModel !== undefined || policy.verifierModelId !== undefined) &&
      configuredVerifier !== undefined &&
      cachedVerifier !== undefined &&
      cachedVerifier !== configuredVerifier
    ) {
      reporter.warn(
        `  ${chalk.yellow('Warning:')} ${unit.serverName}: the cached policy was verified by ` +
          `${toDisplayText(cachedVerifier)}; the configured verifier model is ${toDisplayText(configuredVerifier)}. ${rebuild}`,
      );
    }
  }

  /**
   * Verifies a verified commit's rules again instead of recompiling them.
   * The commit stays in place until the new verdict: a pass replaces it, a
   * failure removes it. Repairs, if needed, start from the cached rules.
   */
  private async reverifyCachedRules(
    ctx: ServerRunContext,
    rules: CompiledRule[],
    listDefinitions: ListDefinition[],
    existingScenarios: TestScenariosFile,
  ): Promise<ServerCompilationResult> {
    const compilerSession = new ConstitutionCompilerSession({
      system: ctx.compilerSystem,
      model: ctx.model,
      annotations: ctx.unit.storedAnnotations,
      schemaOptions: { requireServer: true },
    });
    return this.verifyAndCommit(ctx, { rules, listDefinitions, compilerSession, existingScenarios });
  }

  /**
   * Resolves the rules' dynamic lists, generates (or reuses) test scenarios,
   * verifies and repairs the rules, then commits them as verified. When
   * verification still fails after every repair, the rules are kept as
   * inspection copies only, any older verified commit is removed, and
   * {@link ServerVerificationFailedError} is thrown.
   */
  private async verifyAndCommit(ctx: ServerRunContext, input: RulesToVerify): Promise<ServerCompilationResult> {
    const { unit, config, constitutionHash, inputHash, model, logContext, reporter, serverOutputDir } = ctx;
    const { rules, listDefinitions } = input;

    // Resolve dynamic lists for this server (before scenario generation so lists are available)
    config.signal?.throwIfAborted();
    let dynamicLists: DynamicListsFile | undefined;
    if (listDefinitions.length > 0) {
      dynamicLists = await this.resolveServerLists(
        listDefinitions,
        serverOutputDir,
        config,
        `  ${unit.serverName}`,
        model,
        logContext,
        reporter,
        ctx.listConnection,
      );
    }

    // Build per-server policy artifact for engine construction
    const serverPolicyFile = buildPolicyArtifact(constitutionHash, rules, listDefinitions, inputHash);

    const policyDraft = (draftRules: CompiledRule[], draftLists: ListDefinition[]): ServerPolicyDraft => ({
      generatedAt: new Date().toISOString(),
      serverName: unit.serverName,
      constitutionHash,
      inputHash,
      rules: draftRules,
      listDefinitions: draftLists.length > 0 ? draftLists : undefined,
    });
    // Persist intermediate rules so they survive a crash and can be inspected.
    // They go to the unverified copy, which the cache never reads, and every
    // call passes the rules it persists (no captured, possibly stale state).
    const persistUnverified = (draftRules: CompiledRule[], draftLists: ListDefinition[]): void => {
      writeUnverifiedServerPolicy(serverOutputDir, policyDraft(draftRules, draftLists));
    };
    persistUnverified(rules, listDefinitions);
    assertRulesPassWithLists(unit, rules, listDefinitions, dynamicLists);

    // Compile-only (task scopes): the rules stay an unverified draft, which
    // the per-server cache never serves; see PipelineRunConfig.skipVerification.
    if (config.skipVerification === true) {
      reporter.done(`${rules.length} rules (not verified: task scope)`);
      return {
        serverName: unit.serverName,
        rules,
        listDefinitions,
        scenarios: [],
        inputHash,
        constitutionHash,
        resolvedLists: dynamicLists,
      };
    }

    // Build per-server tool annotations file with conditional role specs preserved
    const serverAnnotationsFile: StoredToolAnnotationsFile = {
      generatedAt: new Date().toISOString(),
      servers: { [unit.serverName]: { inputHash, tools: unit.storedAnnotations } },
    };

    // Extract domain allowlists for this server
    const serverDomainAllowlists = unit.mcpServerConfig
      ? extractServerDomainAllowlists({ [unit.serverName]: unit.mcpServerConfig })
      : undefined;

    // Step 2: Generate test scenarios for this server (reused when the
    // previous commit's scenarios were generated from the same inputs)
    config.signal?.throwIfAborted();
    logContext.stepName = `scenarios-${unit.serverName}`;
    const ruleDirectories = extractRuleDirectories(rules);
    const scenarioResult = await this.generateTestScenarios(
      unit.constitutionText,
      unit.storedAnnotations,
      unit.allowedDirectory,
      unit.handwrittenScenarios,
      scenarioHashForRules(unit, rules, dynamicLists),
      input.existingScenarios,
      `  ${unit.serverName}`,
      ruleDirectories,
      dynamicLists,
      ctx.verifier,
      reporter,
    );

    // Step 3: Verify and repair
    config.signal?.throwIfAborted();
    const state = await this.verifyAndRepairServer(
      unit,
      config,
      constitutionHash,
      inputHash,
      serverPolicyFile,
      serverAnnotationsFile,
      serverDomainAllowlists,
      dynamicLists,
      rules,
      listDefinitions,
      input.compilerSession,
      scenarioResult,
      ruleDirectories,
      ctx.compilerSystem,
      model,
      ctx.verifier,
      logContext,
      reporter,
      serverOutputDir,
      persistUnverified,
      ctx.listConnection,
    );

    const finalScenarios = [...scenarioResult.scenarios, ...state.accumulatedProbes];
    // What the engine decides for each stored scenario under the final rules,
    // in the context they were verified in (the engine verification and the
    // replays use): replayed offline by doctor.
    const decisionEngine = createVerifierEngine(
      state.serverPolicyFile,
      serverAnnotationsFile,
      unit.protectedPaths,
      unit.allowedDirectory,
      serverDomainAllowlists,
      state.dynamicLists,
    );
    const scenarioDecisions = recordScenarioDecisions(decisionEngine, finalScenarios);
    // The scenario hash of the FINAL rules and lists, which is what the next
    // run recomputes from the cached rules: a repair that changed the rules'
    // directories or lists does not make an unchanged rerun miss the cache.
    const finalScenarioHash = scenarioHashForRules(unit, state.rules, state.dynamicLists);
    const scenariosFile: TestScenariosFile = {
      generatedAt: new Date().toISOString(),
      constitutionHash,
      inputHash: finalScenarioHash,
      scenarios: finalScenarios,
      replay: { allowedDirectory: unit.allowedDirectory, decisions: scenarioDecisions },
    };

    if (!state.verificationResult.pass) {
      // Keep the failing result for inspection only. Any verified commit is
      // removed too (re-verified rules that now fail must not be served), so
      // the next run recompiles instead of serving these rules.
      invalidateServerArtifacts(serverOutputDir);
      persistUnverified(state.rules, state.listDefinitions);
      writeUnverifiedServerScenarios(serverOutputDir, scenariosFile);
      throw new ServerVerificationFailedError(
        unit.serverName,
        state.repairAttempts,
        state.failureDetail ?? describeVerificationFailure(state.verificationResult),
        state.rejectedRepairErrors,
      );
    }

    // Verified: commit the scenarios, then the rules with `verified: true` in
    // the same atomic write (the commit point), and drop the inspection copies.
    commitVerifiedServerArtifacts(
      serverOutputDir,
      {
        ...policyDraft(state.rules, state.listDefinitions),
        scenarioHash: finalScenarioHash,
        engineSemanticsVersion: ENGINE_SEMANTICS_VERSION,
        verifierVersion: PIPELINE_VERIFIER_VERSION,
        ...(this.policyModelId !== undefined ? { policyModelId: this.policyModelId } : {}),
        ...(this.verifierModel?.modelId !== undefined ? { verifierModelId: this.verifierModel.modelId } : {}),
      },
      scenariosFile,
      state.verificationResult,
    );

    const summary =
      `${state.rules.length} rules, ${finalScenarios.length} scenarios` +
      (state.repairAttempts > 0 ? `, ${state.repairAttempts} repair(s)` : '');
    reporter.done(summary);

    return {
      serverName: unit.serverName,
      rules: state.rules,
      listDefinitions: state.listDefinitions,
      scenarios: finalScenarios,
      scenarioDecisions,
      inputHash,
      constitutionHash,
      resolvedLists: state.dynamicLists,
      testedScenarios: state.testedScenarios,
      verifierVersion: PIPELINE_VERIFIER_VERSION,
      policyModelId: this.policyModelId,
    };
  }

  /**
   * Runs initial verification and the compile-verify-repair loop for a server.
   * Returns the mutable compilation state after all repair attempts.
   * `model` repairs the rules; `verifier` replaces discarded scenarios and
   * judges every verification round.
   */
  private async verifyAndRepairServer(
    unit: ServerCompilationUnit,
    config: PipelineRunConfig,
    constitutionHash: string,
    inputHash: string,
    serverPolicyFile: CompiledPolicyFile,
    serverAnnotationsFile: StoredToolAnnotationsFile,
    serverDomainAllowlists: ReadonlyMap<string, readonly string[]> | undefined,
    dynamicLists: DynamicListsFile | undefined,
    rules: CompiledRule[],
    listDefinitions: ListDefinition[],
    compilerSession: ConstitutionCompilerSession | undefined,
    scenarioResult: { scenarios: TestScenario[]; inputHash: string },
    ruleDirectories: string[],
    compilerSystem: string | SystemModelMessage,
    model: LanguageModel,
    verifier: ServerVerifierModel,
    logContext: LlmLogContext,
    reporter: ServerProgressReporter,
    serverOutputDir: string,
    persistUnverified: (rules: CompiledRule[], listDefinitions: ListDefinition[]) => void,
    listConnection: ListMcpConnection,
  ): Promise<ServerCompilationState> {
    logContext.stepName = `verify-${unit.serverName}`;

    const filterEngine = new PolicyEngine(
      serverPolicyFile,
      serverAnnotationsFile,
      unit.protectedPaths,
      unit.allowedDirectory,
      undefined,
      dynamicLists,
    );

    const { filteredScenarios } = await this.filterAndRepairDiscardedScenarios(
      filterEngine,
      scenarioResult,
      unit,
      ruleDirectories,
      dynamicLists,
      verifier.model,
      logContext,
      reporter,
    );

    const serverToolNames = [...new Set(unit.annotations.map((a) => a.toolName))] as [string, ...string[]];
    const serverNames = [unit.serverName] as [string, ...string[]];
    const serverTools = unit.annotations.map((a) => ({ serverName: a.serverName, toolName: a.toolName }));

    const verifierSystem = verifier.cacheStrategy.wrapSystemPrompt(
      buildJudgeSystemPrompt(
        unit.constitutionText,
        serverPolicyFile,
        unit.protectedPaths,
        serverTools,
        dynamicLists,
        unit.allowedDirectory,
        unit.storedAnnotations,
      ),
    );
    const verifierSession = new PolicyVerifierSession({
      system: verifierSystem,
      model: verifier.model,
      serverNames,
      toolNames: serverToolNames,
      storedAnnotations: unit.storedAnnotations,
    });

    reporter.update('verifying');
    const verifyStart = Date.now();
    const verificationResultInitial = await verifyPolicy(
      unit.constitutionText,
      serverPolicyFile,
      serverAnnotationsFile,
      unit.protectedPaths,
      filteredScenarios,
      verifier.model,
      INITIAL_VERIFY_MAX_ROUNDS,
      unit.allowedDirectory,
      (msg) => reporter.update('verifying', msg),
      serverDomainAllowlists,
      dynamicLists,
      verifierSystem,
      verifierSession,
      unit.storedAnnotations,
      unit.liveToolSchemas,
    );
    const verifyElapsed = (Date.now() - verifyStart) / 1000;
    const verifyLabel = `  ${unit.serverName}: Verifying`;
    reporter.complete(
      'verifying',
      verificationResultInitial.pass
        ? `${verifyLabel}: ${verificationResultInitial.rounds.length} round(s) (${verifyElapsed.toFixed(1)}s)`
        : `${verifyLabel}: completed with failures (${verifyElapsed.toFixed(1)}s)`,
      verifyElapsed,
    );

    if (!verificationResultInitial.pass) {
      this.logVerboseFailures(verificationResultInitial, reporter);
    }

    // Collect probe scenarios
    const { valid: filteredInitialProbes } = filterAndLogStructuralConflicts(
      filterEngine,
      collectProbeScenarios(verificationResultInitial),
      'Discarded probe (structural conflict)',
      unit.storedAnnotations,
      reporter,
      unit.liveToolSchemas,
    );

    const state: ServerCompilationState = {
      rules,
      listDefinitions,
      compilerSession,
      dynamicLists,
      serverPolicyFile,
      verificationResult: verificationResultInitial,
      accumulatedProbes: filteredInitialProbes,
      repairAttempts: 0,
      rejectedRepairErrors: [],
    };
    const replayContext: ReplayContext = { unit, serverAnnotationsFile, serverDomainAllowlists, filterEngine };

    if (!state.verificationResult.pass) {
      await this.runRepairLoop(
        state,
        unit,
        config,
        constitutionHash,
        inputHash,
        replayContext,
        scenarioResult,
        serverToolNames,
        serverNames,
        serverTools,
        compilerSystem,
        model,
        verifier,
        logContext,
        reporter,
        serverOutputDir,
        persistUnverified,
        listConnection,
      );
    }

    if (state.verificationResult.pass) {
      // Commit gate: these scenarios are persisted as the rules' verified test
      // set, so every one verification can run must pass against the final
      // rules. A failure here means the loop accepted something it must not
      // have; fail closed rather than commit.
      const replay = replayScenarios(state, scenarioResult.scenarios, replayContext);
      const failures = replay.filter((r) => !r.pass);
      if (failures.length > 0) {
        state.verificationResult = { ...state.verificationResult, pass: false, failedScenarios: failures };
        state.failureDetail = `the final rules fail on replay: ${describeFailingScenarios(failures)}`;
      } else {
        state.testedScenarios = replay.length;
      }
    }

    return state;
  }

  /**
   * Filters structurally conflicting scenarios and generates replacements
   * for discarded ones via LLM repair (pre-loop, one-time). `model` is the
   * verifier model: replacements are part of the oracle, like the scenarios.
   */
  private async filterAndRepairDiscardedScenarios(
    filterEngine: PolicyEngine,
    scenarioResult: { scenarios: TestScenario[]; inputHash: string },
    unit: ServerCompilationUnit,
    ruleDirectories: string[],
    dynamicLists: DynamicListsFile | undefined,
    model: LanguageModel,
    logContext: LlmLogContext,
    reporter: ServerProgressReporter,
  ): Promise<{ filteredScenarios: TestScenario[] }> {
    const { valid: filteredScenarios, discarded: discardedScenarios } = filterAndLogStructuralConflicts(
      filterEngine,
      scenarioResult.scenarios,
      undefined,
      unit.storedAnnotations,
      reporter,
      unit.liveToolSchemas,
    );

    if (discardedScenarios.length > 0) {
      const discardedForRepair = discardedScenarios.map((d) => ({
        scenario: d.scenario,
        feedback: `${d.rule} always returns ${d.actual}`,
      }));
      logContext.stepName = `repair-scenarios-${unit.serverName}`;
      reporter.update('repair-scenarios');
      const repairStart = Date.now();
      const replacementScenarios = await repairScenarios(
        discardedForRepair,
        unit.constitutionText,
        unit.storedAnnotations,
        unit.allowedDirectory,
        model,
        ruleDirectories,
        dynamicLists,
        (msg) => reporter.warn(`  ${chalk.dim(msg)}`),
      );
      if (replacementScenarios.length > 0) {
        const { valid: validReplacements } = filterAndLogStructuralConflicts(
          filterEngine,
          replacementScenarios,
          'Discarded replacement (structural conflict)',
          unit.storedAnnotations,
          reporter,
          unit.liveToolSchemas,
        );
        scenarioResult.scenarios.push(...validReplacements);
        filteredScenarios.push(...validReplacements);
        reporter.warn(
          `  ${chalk.dim(`Repaired ${discardedScenarios.length} discarded scenario(s) → ${validReplacements.length} replacement(s)`)}`,
        );
      }
      const repairElapsed = (Date.now() - repairStart) / 1000;
      reporter.complete(
        'repair-scenarios',
        `  ${unit.serverName}: Repaired scenarios (${repairElapsed.toFixed(1)}s)`,
        repairElapsed,
      );
    }

    return { filteredScenarios };
  }

  /**
   * Compile-verify-repair loop: up to MAX_FOLLOW_UPS follow-up verifications,
   * each after a repair compile or, when only scenario corrections are
   * pending, without one. Mutates `state` in place with updated rules, lists,
   * scenarios and verification results. Each repaired rule set is persisted
   * only as an unverified inspection copy.
   *
   * Each iteration consumes the just-completed verification (the initial one,
   * then each follow-up) through assessVerification, which applies the
   * corrections the judge's attributions justify and replays every scenario
   * against the current rules. A pass needs a clean replay AND the judge's
   * approval; anything else is repaired, re-verified, or, once the budget is
   * spent, reported with `state.failureDetail`.
   *
   * A repair whose rules fail the deterministic rule checks is rejected (see
   * compileRepairCandidate): the last valid rules stay, and the next
   * iteration repairs the same assessment again. It uses up a follow-up.
   */
  private async runRepairLoop(
    state: ServerCompilationState,
    unit: ServerCompilationUnit,
    config: PipelineRunConfig,
    constitutionHash: string,
    inputHash: string,
    replayContext: ReplayContext,
    scenarioResult: { scenarios: TestScenario[]; inputHash: string },
    serverToolNames: [string, ...string[]],
    serverNames: [string, ...string[]],
    serverTools: { serverName: string; toolName: string }[],
    compilerSystem: string | SystemModelMessage,
    model: LanguageModel,
    verifier: ServerVerifierModel,
    logContext: LlmLogContext,
    reporter: ServerProgressReporter,
    serverOutputDir: string,
    persistUnverified: (rules: CompiledRule[], listDefinitions: ListDefinition[]) => void,
    listConnection: ListMcpConnection,
  ): Promise<void> {
    const { filterEngine, serverAnnotationsFile, serverDomainAllowlists } = replayContext;

    // The assessment a rejected repair left unresolved: the rules and the
    // verification result are unchanged, so it is not assessed again.
    let pending: Exclude<VerificationAssessment, { kind: 'pass' }> | undefined;
    for (let followUps = 0; ; followUps++) {
      const assessment = pending ?? assessVerification(state, scenarioResult, replayContext, reporter);
      pending = undefined;
      if (assessment.kind === 'pass') {
        state.verificationResult = assessment.result;
        return;
      }
      // Out of budget: keep the failing result and say why.
      if (followUps === MAX_FOLLOW_UPS) {
        state.failureDetail = describeUnresolved(assessment);
        return;
      }

      let progressLabel: string;
      if (assessment.kind === 'repair') {
        const repairAttempt = state.repairAttempts + 1;
        const repairContext: RepairContext = {
          failedScenarios: assessment.failures,
          failureNotes: assessment.notes,
          judgeAnalysis: assessment.judgeAnalysis,
          attemptNumber: repairAttempt,
          existingListDefinitions: state.listDefinitions.length > 0 ? state.listDefinitions : undefined,
          handwrittenScenarios: unit.handwrittenScenarios.length > 0 ? unit.handwrittenScenarios : undefined,
        };

        logContext.stepName = `repair-compile-${unit.serverName}-${repairAttempt}`;
        reporter.update('repair-compile', `attempt ${repairAttempt}/${MAX_FOLLOW_UPS}`);
        const repairCompileStart = Date.now();
        const candidate = await this.compileRepairCandidate(
          state,
          unit,
          config,
          inputHash,
          repairContext,
          compilerSystem,
          model,
          logContext,
          reporter,
          serverOutputDir,
          listConnection,
        );
        const repairCompileElapsed = (Date.now() - repairCompileStart) / 1000;
        const repairLabel = `  ${unit.serverName} repair ${repairAttempt}/${MAX_FOLLOW_UPS}`;
        state.repairAttempts = repairAttempt;
        if (!candidate.ok) {
          // A repair that fails the rule checks must not cost the server its
          // last valid rules: keep them and spend the next attempt on a new
          // repair (the session history shows the compiler the rejection).
          state.rejectedRepairErrors = candidate.errors;
          pending = assessment;
          reporter.complete(
            'repair-compile',
            `${repairLabel}: rejected by the rule checks, keeping the previous rules (${repairCompileElapsed.toFixed(1)}s)`,
            repairCompileElapsed,
          );
          continue;
        }
        reporter.complete(
          'repair-compile',
          `${repairLabel}: ${candidate.rules.length} rules (${repairCompileElapsed.toFixed(1)}s)`,
          repairCompileElapsed,
        );
        state.rules = candidate.rules;
        state.listDefinitions = candidate.listDefinitions;
        state.compilerSession = candidate.session;
        state.dynamicLists = candidate.dynamicLists;
        state.rejectedRepairErrors = [];

        state.serverPolicyFile = buildPolicyArtifact(constitutionHash, state.rules, state.listDefinitions, inputHash);
        // Persist the REPAIRED rules (passed explicitly from state).
        persistUnverified(state.rules, state.listDefinitions);

        logContext.stepName = `repair-verify-${unit.serverName}-${repairAttempt}`;
        progressLabel = `repair ${repairAttempt}/${MAX_FOLLOW_UPS}`;
      } else {
        // Only scenario corrections are pending: the rules are unchanged, so
        // let a fresh judge review them against the corrected scenarios.
        reporter.warn(`  ${chalk.dim('Re-verifying with the corrected scenario expectations')}`);
        logContext.stepName = `reverify-${unit.serverName}-${followUps + 1}`;
        progressLabel = 're-verify after corrections';
      }

      const verifierSystem = verifier.cacheStrategy.wrapSystemPrompt(
        buildJudgeSystemPrompt(
          unit.constitutionText,
          state.serverPolicyFile,
          unit.protectedPaths,
          serverTools,
          state.dynamicLists,
          unit.allowedDirectory,
          unit.storedAnnotations,
        ),
      );
      const verifierSession = new PolicyVerifierSession({
        system: verifierSystem,
        model: verifier.model,
        serverNames,
        toolNames: serverToolNames,
        storedAnnotations: unit.storedAnnotations,
      });

      const { valid: currentFilteredScenarios } = filterAndLogStructuralConflicts(
        filterEngine,
        scenarioResult.scenarios,
        undefined,
        unit.storedAnnotations,
        reporter,
        unit.liveToolSchemas,
      );
      const scenariosForRepairVerify = [...currentFilteredScenarios, ...state.accumulatedProbes];
      reporter.update('repair-verify', progressLabel);
      const repairVerifyStart = Date.now();
      const repairVerifyResult = await verifyPolicy(
        unit.constitutionText,
        state.serverPolicyFile,
        serverAnnotationsFile,
        unit.protectedPaths,
        scenariosForRepairVerify,
        verifier.model,
        FOLLOW_UP_VERIFY_MAX_ROUNDS,
        unit.allowedDirectory,
        (msg) => reporter.update('repair-verify', msg),
        serverDomainAllowlists,
        state.dynamicLists,
        verifierSystem,
        verifierSession,
        unit.storedAnnotations,
        unit.liveToolSchemas,
      );
      const repairVerifyElapsed = (Date.now() - repairVerifyStart) / 1000;
      const repairVerifyText = `  ${unit.serverName} ${progressLabel}: Verifying`;
      reporter.complete(
        'repair-verify',
        repairVerifyResult.pass
          ? `${repairVerifyText}: passed (${repairVerifyElapsed.toFixed(1)}s)`
          : `${repairVerifyText}: ${repairVerifyResult.failedScenarios.length} failure(s) (${repairVerifyElapsed.toFixed(1)}s)`,
        repairVerifyElapsed,
      );
      state.verificationResult = repairVerifyResult;

      if (!state.verificationResult.pass) {
        this.logVerboseFailures(state.verificationResult, reporter);
      }

      const { valid: validRepairProbes } = filterAndLogStructuralConflicts(
        filterEngine,
        collectProbeScenarios(state.verificationResult),
        'Discarded probe (structural conflict)',
        unit.storedAnnotations,
        reporter,
        unit.liveToolSchemas,
      );
      state.accumulatedProbes.push(...validRepairProbes);
    }
  }

  /**
   * One repair compile in the verify-repair loop. Asks the compiler for a fix
   * (point-fix, falling back to a full recompile), runs the rule checks with
   * validation-repair turns, resolves the candidate's dynamic lists and checks
   * again with their values. A candidate that still fails the rule checks is
   * returned as rejected, never adopted, so the caller keeps its last valid
   * rules; the per-server lists file is restored to those rules' lists.
   *
   * A candidate without list definitions uses no resolved lists: neither the
   * judge, the replays, the recorded decisions nor the final scenario hash
   * then see lists its rules no longer reference.
   */
  private async compileRepairCandidate(
    state: ServerCompilationState,
    unit: ServerCompilationUnit,
    config: PipelineRunConfig,
    inputHash: string,
    repairContext: RepairContext,
    compilerSystem: string | SystemModelMessage,
    model: LanguageModel,
    logContext: LlmLogContext,
    reporter: ServerProgressReporter,
    serverOutputDir: string,
    listConnection: ListMcpConnection,
  ): Promise<
    | {
        readonly ok: true;
        readonly rules: CompiledRule[];
        readonly listDefinitions: ListDefinition[];
        readonly dynamicLists: DynamicListsFile | undefined;
        readonly session: ConstitutionCompilerSession | undefined;
      }
    | { readonly ok: false; readonly errors: readonly string[] }
  > {
    try {
      const repaired = await this.compilePolicyRulesWithPointFix(
        state.rules,
        unit,
        inputHash,
        repairContext,
        compilerSystem,
        state.compilerSession,
        state.listDefinitions,
        model,
        (msg) => reporter.update('repair-compile', msg),
        reporter,
      );
      validateServerScoping(unit.serverName, repaired.rules);

      let dynamicLists: DynamicListsFile | undefined;
      if (repaired.listDefinitions.length > 0) {
        // Writes servers/<name>/dynamic-lists.json.
        dynamicLists = await this.resolveServerLists(
          repaired.listDefinitions,
          serverOutputDir,
          config,
          `  ${unit.serverName}`,
          model,
          logContext,
          reporter,
          listConnection,
        );
      }
      try {
        assertRulesPassWithLists(unit, repaired.rules, repaired.listDefinitions, dynamicLists);
      } catch (err) {
        if (dynamicLists !== undefined) {
          if (state.dynamicLists) writeArtifact(serverOutputDir, 'dynamic-lists.json', state.dynamicLists);
          else removeArtifactIfExists(serverOutputDir, 'dynamic-lists.json');
        }
        throw err;
      }
      return {
        ok: true,
        rules: repaired.rules,
        listDefinitions: repaired.listDefinitions,
        dynamicLists,
        session: repaired.session,
      };
    } catch (err) {
      if (!(err instanceof RuleValidationError)) throw err;
      reporter.warn(
        `  ${chalk.yellow('Warning:')} the repaired rules failed the rule checks; keeping the previous rules:`,
      );
      reportRuleCheck(reporter, chalk.yellow('-'), err.errors);
      return { ok: false, errors: err.errors };
    }
  }

  /**
   * Runs the rule checks (validateCompiledRules and the policy lint) on
   * compiler output. While they report errors, the errors go back to the
   * compiler session for a corrected rule set, at most MAX_VALIDATION_REPAIRS
   * times. Returns the rules with canonical paths. Throws RuleValidationError
   * when errors remain, or when there is no session to ask.
   *
   * The dynamic lists are not resolved yet, so `@list` values are checked
   * later (assertRulesPassWithLists).
   */
  private async validateWithRepair(
    output: CompilationOutput,
    unit: ServerCompilationUnit,
    session: ConstitutionCompilerSession | undefined,
    phase: 'compiling' | 'repair-compile',
    reporter: ServerProgressReporter,
  ): Promise<{ rules: CompiledRule[]; listDefinitions: ListDefinition[] }> {
    let current = output;
    for (let attempt = 1; ; attempt++) {
      const rules = resolveRulePaths(current.rules);
      const check = checkRules(rules, current.listDefinitions, unit.storedAnnotations, unit.lint, {
        writtenRules: current.rules,
      });
      if (check.errors.length === 0) {
        reportRuleCheck(reporter, chalk.yellow('Warning:'), check.warnings);
        return { rules, listDefinitions: current.listDefinitions };
      }
      if (!session || attempt > MAX_VALIDATION_REPAIRS) throw new RuleValidationError(check.errors);

      reporter.warn(
        `  ${chalk.yellow(`The rules failed the rule checks; asking the compiler to fix them (${attempt}/${MAX_VALIDATION_REPAIRS}):`)}`,
      );
      reportRuleCheck(reporter, chalk.yellow('-'), check.errors);
      reporter.update(phase, `fixing rule-check errors (${attempt}/${MAX_VALIDATION_REPAIRS})`);
      // The rejected rule set travels with the errors: after a point-fix the
      // compiler's last answer is a patch, not the rules it produced.
      current = await session.repairValidation(check.errors, attempt, current, (msg) => reporter.update(phase, msg));
    }
  }

  /**
   * Compiles policy rules for a single server (initial compilation).
   * Uses per-server schema with requireServer: true. Rules that fail the rule
   * checks are sent back for repair (see validateWithRepair).
   */
  private async compileServerPolicyRules(
    unit: ServerCompilationUnit,
    system: string | SystemModelMessage,
    inputHash: string,
    model: LanguageModel,
    reporter: ServerProgressReporter,
  ): Promise<{
    rules: CompiledRule[];
    listDefinitions: ListDefinition[];
    inputHash: string;
    session: ConstitutionCompilerSession;
  }> {
    reporter.update('compiling');
    const start = Date.now();

    const session = new ConstitutionCompilerSession({
      system,
      model,
      annotations: unit.storedAnnotations,
      schemaOptions: { requireServer: true },
    });

    const output = await session.compile((msg) => reporter.update('compiling', msg));
    const { rules: compiledRules, listDefinitions } = await this.validateWithRepair(
      output,
      unit,
      session,
      'compiling',
      reporter,
    );

    const elapsed = (Date.now() - start) / 1000;
    reporter.complete(
      'compiling',
      `  ${unit.serverName}: Compiling rules: ${compiledRules.length} rules (${elapsed.toFixed(1)}s)`,
      elapsed,
    );

    return {
      rules: compiledRules,
      listDefinitions,
      inputHash,
      session,
    };
  }

  // -----------------------------------------------------------------------
  // Private compilation methods
  // -----------------------------------------------------------------------

  private async compilePolicyRulesWithRepair(
    unit: ServerCompilationUnit,
    baseInputHash: string,
    repairContext: RepairContext,
    system: string | SystemModelMessage,
    session: ConstitutionCompilerSession | undefined,
    model: LanguageModel,
    onProgress: ((message: string) => void) | undefined,
    reporter: ServerProgressReporter,
  ): Promise<{
    rules: CompiledRule[];
    listDefinitions: ListDefinition[];
    inputHash: string;
    session?: ConstitutionCompilerSession;
  }> {
    let output;
    if (session) {
      output = await session.recompile(repairContext, onProgress);
    } else {
      const { compileConstitution } = await import('./constitution-compiler.js');
      output = await compileConstitution(
        '', // Not needed when system prompt is provided
        unit.storedAnnotations,
        { protectedPaths: unit.protectedPaths },
        model,
        repairContext,
        onProgress,
        system,
      );
    }
    const { rules, listDefinitions } = await this.validateWithRepair(output, unit, session, 'repair-compile', reporter);

    return {
      rules,
      listDefinitions,
      inputHash: `${baseInputHash}-repair`,
      session,
    };
  }

  /**
   * Attempts point-fix repair via the session, falling back to full recompile.
   * When a compiler session exists, uses repairPointFix() to emit a minimal
   * patch instead of regenerating the entire rule set. This avoids oscillation
   * where fixing one failure breaks previously-passing rules.
   */
  private async compilePolicyRulesWithPointFix(
    existingRules: CompiledRule[],
    unit: ServerCompilationUnit,
    baseInputHash: string,
    repairContext: RepairContext,
    system: string | SystemModelMessage,
    session: ConstitutionCompilerSession | undefined,
    existingListDefinitions: ListDefinition[],
    model: LanguageModel,
    onProgress: ((message: string) => void) | undefined,
    reporter: ServerProgressReporter,
  ): Promise<{
    rules: CompiledRule[];
    listDefinitions: ListDefinition[];
    inputHash: string;
    session?: ConstitutionCompilerSession;
  }> {
    let output;
    if (session) {
      output = await session.repairPointFix(existingRules, repairContext, existingListDefinitions, onProgress);
    } else {
      // No session available -- fall back to full recompile
      return this.compilePolicyRulesWithRepair(
        unit,
        baseInputHash,
        repairContext,
        system,
        session,
        model,
        onProgress,
        reporter,
      );
    }
    const { rules, listDefinitions } = await this.validateWithRepair(output, unit, session, 'repair-compile', reporter);

    return {
      rules,
      listDefinitions,
      inputHash: `${baseInputHash}-repair`,
      session,
    };
  }

  /**
   * Resolves dynamic lists for a single server's list definitions.
   * Loads existing per-server dynamic-lists.json for cache comparison,
   * connects MCP servers only when a data-backed list misses that cache
   * (through `listConnection`, which the compile's later resolutions reuse),
   * and writes results to serverOutputDir.
   *
   * The per-server copy holds resolver output only: the user's manual
   * overrides live in the merged dynamic-lists.json (see list-merge.ts).
   *
   * A run without MCP server configs (compile-policy --no-mcp) leaves a
   * data-backed list that has no valid cached resolution UNRESOLVED (no
   * values, no valid inputHash) with a warning, instead of failing the server.
   */
  private async resolveServerLists(
    listDefinitions: ListDefinition[],
    serverOutputDir: string,
    config: PipelineRunConfig,
    labelPrefix: string,
    model: LanguageModel,
    logContext: LlmLogContext,
    reporter: ServerProgressReporter,
    listConnection: ListMcpConnection,
  ): Promise<DynamicListsFile> {
    logContext.stepName = `resolve-lists-${labelPrefix.trim()}`;
    // Validated (a malformed file throws and fails this server): resolution
    // carries each list's manual overrides into the values it writes, so a
    // string where an array belongs must not be spread into characters.
    const existingLists = loadDynamicListsArtifact(serverOutputDir);

    const mcpListNames = listDefinitions.filter((d) => d.requiresMcp).map((d) => d.name);
    const needsMcp = mcpListNames.length > 0;

    // The WS compile path disables live MCP. Fail fast with a typed error rather
    // than silently resolving MCP-backed lists to empty (which would deny).
    if (needsMcp && config.allowMcpLists === false) {
      throw new McpListsDisallowedError(mcpListNames);
    }

    // Data-backed lists served from the list cache need no MCP server, so no
    // relay (or Docker container) is started for them.
    const mcpMisses = listsNeedingResolution(listDefinitions, existingLists).filter((d) => d.requiresMcp);
    const mcpConnection = mcpMisses.length > 0 ? await listConnection.forLists(mcpMisses) : undefined;

    reporter.update('lists');
    const start = Date.now();
    const resolvedLists = await resolveAllLists(
      listDefinitions,
      { model, mcpConnection, leaveMcpListsUnresolved: !config.mcpServers },
      existingLists,
      (msg) => reporter.update('lists', msg),
    );
    const elapsed = (Date.now() - start) / 1000;
    const count = Object.keys(resolvedLists.lists).length;
    reporter.complete(
      'lists',
      `${labelPrefix}: Resolving dynamic lists: ${count} list(s) resolved (${elapsed.toFixed(1)}s)`,
      elapsed,
    );
    // Show what the resolution added and removed, so the values that widen
    // the policy can be reviewed instead of only counted.
    for (const line of formatListValueChanges(diffListValues(existingLists, resolvedLists))) {
      reporter.warn(line);
    }
    const unresolved = Object.keys(resolvedLists.lists).filter((name) => isUnresolvedList(resolvedLists.lists[name]));
    if (unresolved.length > 0) {
      const one = unresolved.length === 1;
      reporter.warn(
        `  ${chalk.yellow.bold('Warning:')} ${unresolved.map((name) => `@${name}`).join(', ')} ` +
          `${one ? 'needs' : 'need'} MCP access and ${one ? 'was' : 'were'} NOT resolved (--no-mcp). Rules that ` +
          `use ${one ? 'it' : 'them'} match only manual additions until a compile-policy or refresh-lists run ` +
          'with MCP access resolves them.',
      );
    }
    writeArtifact(serverOutputDir, DYNAMIC_LISTS_FILENAME, resolvedLists);
    return resolvedLists;
  }

  /**
   * Generates the server's test scenarios with the verifier model, or reuses
   * the stored ones when their inputs (`inputHash`) did not change.
   */
  private async generateTestScenarios(
    constitutionText: string,
    annotations: StoredToolAnnotation[],
    allowedDirectory: string,
    handwrittenScenarios: TestScenario[],
    inputHash: string,
    existingScenarios: TestScenariosFile | undefined,
    stepLabel: string,
    ruleDirectories: string[] | undefined,
    dynamicLists: DynamicListsFile | undefined,
    verifier: ServerVerifierModel,
    reporter: ServerProgressReporter,
  ): Promise<{
    scenarios: TestScenario[];
    inputHash: string;
  }> {
    const stepText = `${stepLabel} Generating test scenarios`;

    if (existingScenarios && existingScenarios.inputHash === inputHash) {
      reporter.complete('scenarios', `${stepText} ${chalk.dim('(cached)')}`, 0);
      return { scenarios: existingScenarios.scenarios, inputHash };
    }

    reporter.update('scenarios');
    const start = Date.now();
    const scenarios = await generateScenarios(
      constitutionText,
      annotations,
      handwrittenScenarios,
      allowedDirectory,
      verifier.model,
      ruleDirectories,
      (msg: string) => reporter.update('scenarios', msg),
      dynamicLists,
      (prompt: string) => verifier.cacheStrategy.wrapSystemPrompt(prompt),
    );
    const elapsed = (Date.now() - start) / 1000;
    const generatedCount = scenarios.length - handwrittenScenarios.length;
    reporter.complete(
      'scenarios',
      `${stepText}: ${scenarios.length} scenarios (${handwrittenScenarios.length} handwritten + ${generatedCount} generated) (${elapsed.toFixed(1)}s)`,
      elapsed,
    );

    return { scenarios, inputHash };
  }

  private logVerboseFailures(result: VerificationResult, reporter: ServerProgressReporter): void {
    reporter.warn('');
    reporter.warn(chalk.red('Verification FAILED:'));
    reporter.warn(result.summary);
    reporter.warn('');
    if (result.failedScenarios.length === 0) {
      reporter.warn(`  ${chalk.red('No scenario failed, but the verifier judge rejected the policy.')}`);
    }
    for (const f of result.failedScenarios) {
      reporter.warn(`  ${chalk.red('FAIL:')} ${f.scenario.description}`);
      reporter.warn(`    Expected: ${f.scenario.expectedDecision}, Got: ${f.actualDecision} (rule: ${f.matchingRule})`);
    }
  }
}
