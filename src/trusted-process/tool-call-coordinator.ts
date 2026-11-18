/**
 * ToolCallCoordinator -- The single host-side owner of the policy gate.
 *
 * Centralizes the full tool-call pipeline (validation, normalization,
 * policy evaluation, escalation, circuit breaking, dispatch, audit) into
 * a single process-local class.
 *
 * The coordinator holds two mutexes:
 *   - tool-call mutex: serializes concurrent `handleToolCall` invocations
 *     so the three in-memory caches (approval whitelist, circuit breaker,
 *     server-context map) cannot race against each other. An escalation
 *     wait releases it (the wait is registered as a pending escalation
 *     instead) so other calls proceed while a human decides.
 *   - policy mutex: taken by `loadPolicy` to swap the active engine.
 *
 * MITM egress decisions (`authorizeEgress`, opt-in `egressPolicy`; see
 * `egress-policy.ts`) are admitted like tool calls (refused once closed or
 * once the audit log is gone, held back during a quiesce) and register
 * their human waits as pending escalations, but never take the call mutex:
 * they touch none of the caches it protects, and a decision must not wait
 * behind a long backend call. The proxy relays the tunnel or response only
 * after the decision returned, so no streamed transfer holds a lock.
 *
 * `close()` and `loadPolicy()` quiesce tool calls before they act. A call
 * parked in an escalation wait would hold the quiesce for the whole
 * escalation timeout, so both first cancel every pending escalation: the
 * pipeline denies the call at once, audits it as `cancelled` (never as a
 * human denial), removes its request file and returns its admission slot.
 *
 * A caller can also cancel a single call (`handleToolCall(..., { signal })`);
 * the Code Mode chain runner aborts the signal when the script that made the
 * call ends. The pipeline then withdraws the call's pending escalation the
 * same way, refuses to act on an approval that lands afterwards (audited
 * under `call-cancelled`, approval kept), and cancels a backend call in
 * flight, so a script the agent was told had failed leaves no side effect
 * behind.
 *
 * Audit failures fail closed. When the pipeline reports that the audit log
 * cannot be written (`AUDIT_LOG_UNAVAILABLE`), the coordinator latches the
 * failure and refuses every later tool call at admission, so a session
 * that can no longer be audited cannot keep acting; the pipeline itself
 * guarantees the failing call was not dispatched.
 *
 * With taint escalation enabled (opt-in, `taint-policy.ts`) the coordinator
 * also owns the session's monotonic taint state: replayed from the audit log
 * at construction, set when a taint source is dispatched (or when
 * `authorizeEgress` admits a MITM egress destination, a `network/request`
 * source), and consulted by the pipeline for every sink call.
 *
 * Subprocesses spawned by `MCPClientManager` are pure MCP relays that
 * forward calls to the real backend without any policy evaluation.
 *
 * A session started with `--task-scoped` also has a task scope: a policy
 * compiled from its task text that every engine the coordinator builds
 * intersects with the session policy (see `PolicyEngine`). It is fixed at
 * construction and survives `loadPolicy`, so it narrows every persona of a
 * workflow run alike.
 */

import type { LanguageModelV3 } from '@ai-sdk/provider';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  StoredToolAnnotationsFile,
} from '../pipeline/types.js';
import type { ToolCallRequest, ToolCallResult, PolicyDecision } from '../types/mcp.js';
import type { ReadOnlyWorkspace } from '../types/read-only-workspace.js';
import { AuditLog, AuditLogUnavailableError, isAuditLogUnavailableError } from './audit-log.js';
import { PolicyEngine, TASK_SCOPE_ESCALATE_RULE } from './policy-engine.js';
import type { TaskScopePolicy } from './policy-types.js';
import { MCPClientManager } from './mcp-client-manager.js';
import { CallCircuitBreaker } from './call-circuit-breaker.js';
import { createApprovalWhitelist, type ApprovalWhitelist, type WhitelistCandidateIpc } from './approval-whitelist.js';
import { type ServerContextMap } from './server-context.js';
import { AsyncMutex } from './async-mutex.js';
import type { ControlApiClient } from '../docker/proxy-tools.js';
import {
  handleCallTool,
  extractTextFromContent,
  type CallToolDeps,
  type ClientState,
  type EscalationWaitRunner,
  type InProcessEscalationDetails,
  type InProcessEscalationFn,
  type ProxiedTool,
  type ToolCallResponse,
} from './tool-call-pipeline.js';
import { DEFAULT_BACKEND_CALL_TIMEOUT_MS, DEFAULT_ESCALATION_TIMEOUT_SECONDS } from './call-timeouts.js';
import { escalationAbortReason } from './escalation-wait.js';
import { ContentAssessor, type ContentAssessorOptions } from './assessment.js';
import type { ResolvedSandboxConfig } from './sandbox-integration.js';
import { loadPersonaPolicyArtifacts } from '../config/index.js';
import type { PolicyOnStale } from '../config/user-config.js';
import { validatePolicyDir } from '../config/validate-policy-dir.js';
import { proxyAnnotations, proxyPolicyRules } from '../docker/proxy-tools.js';
import {
  WORKFLOW_COMMIT_SERVER,
  workflowCommitPolicyRules,
  workflowCommitToolDefinition,
  withWorkflowCommitAnnotations,
  withWorkflowCommitRules,
  type WorkflowCommitHandler,
} from './workflow-commit-tool.js';
import { ControlServer, type ControlServerAddress, type ControlServerListenOptions } from './control-server.js';
import { createSessionTaint, type SessionTaint, type TaintEscalationOptions } from './taint-policy.js';
import type { TaintEvent } from '../types/taint.js';
import {
  buildEgressPolicyRules,
  createEgressEscalationSlots,
  decideEgress,
  mergeEgressAnnotations,
  type EgressAuthorizer,
  type EgressDecision,
  type EgressPolicyOptions,
  type EgressRequest,
} from './egress-policy.js';
import {
  describeServerDrift,
  diffServerSchemas,
  hasServerDrift,
  serverDriftAffectsPolicy,
  type ServerSchemaDrift,
} from './schema-drift.js';
import * as logger from '../logger.js';
import {
  approvalScopeForPolicyPersona,
  isApprovalScope,
  recordHumanApproval,
  type ApprovalScope,
} from '../audit/approval-history.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result from an escalation callback, optionally including whitelist selection.
 * Mirrors the `EscalationResult` shape used by `TrustedProcess`.
 */
export interface EscalationResult {
  readonly decision: 'approved' | 'denied';
  /** Index into whitelistCandidates to whitelist. Absent = no whitelisting. */
  readonly whitelistSelection?: number;
}

/**
 * Callback invoked by the coordinator when policy decides to escalate and
 * neither the whitelist nor the auto-approver resolved the request.
 * `details.humanOnly` marks an escalation that must be decided by a human
 * one at a time (no auto-approval, no whitelist, no bulk approval).
 *
 * `details.signal` aborts when the coordinator stops waiting for the
 * answer: the configured escalation timeout elapsed, or the wait was
 * cancelled by `close()` / `loadPolicy()`. The result is ignored after
 * that, so handlers that show a prompt should withdraw it on abort. A
 * handler that learns nobody will decide any more rejects with
 * `EscalationWithdrawnError` (`escalation-wait.ts`): the call is then
 * denied as cancelled, not as a human denial.
 */
export type EscalationPromptFn = (
  request: ToolCallRequest,
  reason: string,
  context: Readonly<Record<string, string>> | undefined,
  whitelistCandidates: readonly WhitelistCandidateIpc[] | undefined,
  details: EscalationPromptDetails,
) => Promise<EscalationResult>;

/** Per-escalation details passed to {@link EscalationPromptFn}. */
export type EscalationPromptDetails = InProcessEscalationDetails;

/**
 * Per-call options for {@link ToolCallCoordinator.handleToolCall}. Everything
 * in them is host-assigned; none of it comes from the agent.
 */
export interface ToolCallOptions {
  /**
   * Aborts when the caller no longer waits for the call: the Code Mode
   * script that made it finished, failed, timed out or was cancelled. A
   * pending escalation is then withdrawn (its request file is removed, so
   * the session reports it expired, and an in-process handler's signal
   * aborts), an approval that arrives afterwards is not acted on, and a
   * backend call in flight is cancelled. Nothing is dispatched once it has
   * aborted.
   */
  readonly signal?: AbortSignal;
  /**
   * Opaque identity of the agent stream the call belongs to. The Code
   * Mode proxy assigns one per agent connection, so each agent process
   * in a shared workflow container (one per fan-out lane) is its own
   * lane. Keys the circuit breaker's per-lane window; calls without a
   * lane share the default lane.
   */
  readonly lane?: string;
}

/**
 * Configuration for the coordinator. All fields are read-only after
 * construction.
 */
export interface ToolCallCoordinatorOptions {
  readonly compiledPolicy: CompiledPolicyFile;
  readonly toolAnnotations: StoredToolAnnotationsFile;
  /**
   * Task scope (`--task-scoped`) intersected with the session policy for
   * the coordinator's whole life: it survives every `loadPolicy` hot-swap,
   * so each workflow persona's policy is narrowed by the same task. The
   * coordinator prepends the virtual proxy rules (and, with
   * `workflowCommit`, the `workflow_commit` rule) to it and, with
   * `egressPolicy`, appends the egress rules, as it does to each hot-swapped
   * policy, so the proxy tools, the commit tool and the configured egress
   * hosts keep their fixed decisions.
   */
  readonly taskScope?: TaskScopePolicy;
  readonly protectedPaths: string[];
  readonly allowedDirectory?: string;
  /**
   * Makes `allowedDirectory` read-only except for the given subdirectories:
   * every policy engine this coordinator builds, the first one and each one
   * `loadPolicy` swaps in, denies a write, delete or history rewrite outside
   * them (`PolicyEngineOptions.readOnlyWorkspace`). A property of the session
   * or workflow bundle, not of a persona, so a policy hot-swap never lifts it.
   */
  readonly readOnlyWorkspace?: ReadOnlyWorkspace;
  readonly serverDomainAllowlists?: ReadonlyMap<string, readonly string[]>;
  readonly dynamicLists?: DynamicListsFile;
  readonly trustedServers?: ReadonlySet<string>;
  /** Path where audit entries are appended. */
  readonly auditLogPath: string;
  /** Whether to redact PII/credentials before writing. */
  readonly auditRedact?: boolean;
  /**
   * Exact credential values (configured server credentials, provider API
   * keys, OAuth tokens) that audit redaction replaces wherever they appear
   * in tool arguments and results. Collected by
   * `collectAuditRedactionSecrets`; only applied when `auditRedact` is on.
   */
  readonly auditRedactSecrets?: Iterable<string | undefined | null>;
  /** Auto-approval model (null = disabled). */
  readonly autoApproveModel?: LanguageModelV3 | null;
  /**
   * Outbound content assessment settings. When set, the assessment is on
   * for this session: calls allowed subject to it (`assess` rules) and
   * escalated calls have their outbound content checked (see
   * `assessment.ts`). Absent or null = off, the default; an `assess` rule
   * then allows like `allow`. Built from the user config by
   * `contentAssessorOptionsFromConfig` (assessment-config.ts).
   */
  readonly contentAssessment?: ContentAssessorOptions | null;
  /** Directory for file-based escalation IPC (used by file-IPC callers). */
  readonly escalationDir?: string;
  /**
   * Whether the session is a PTY (mux / web terminal) session. The
   * auto-approver then trusts the file-IPC user context only when the
   * trusted host front-end wrote it (`source: 'mux-trusted-input'`, fresh
   * timestamp). From `IronCurtainConfig.isPtySession`; defaults to false.
   */
  readonly isPtySession?: boolean;
  /**
   * How long an escalated call waits for a decision before it is denied
   * as timed out. The session layer derives it from the user's
   * `escalationTimeoutSeconds`; defaults to 300 s.
   */
  readonly escalationTimeoutMs?: number;
  /**
   * Bound for one backend tool call (the relay enforces it against the
   * real server; the coordinator waits slightly longer for the relay).
   * Defaults to `DEFAULT_BACKEND_CALL_TIMEOUT_MS`.
   */
  readonly backendCallTimeoutMs?: number;
  /**
   * In-process escalation callback. When set, supersedes the
   * file-IPC escalation path. The callback receives the synthesized
   * `ToolCallRequest`, the reason, server context, and any whitelist
   * candidates the coordinator extracted.
   */
  readonly onEscalation?: EscalationPromptFn;
  /** Control API client for virtual proxy tools (Docker Agent Mode only). */
  readonly controlApiClient?: ControlApiClient | null;
  /**
   * Target of the coordinator-owned `workflow_commit` tool. When set, the
   * coordinator registers the tool (server `workflow`), merges its
   * hardcoded annotation and allow rule into every policy it loads, and
   * dispatches each call to this handler in-process (see
   * `workflow-commit-tool.ts`). Set only for workflow agent states; every
   * other coordinator has no such tool.
   */
  readonly workflowCommit?: WorkflowCommitHandler;
  /**
   * Pre-existing `MCPClientManager` to use for dispatch. When omitted a new
   * one is constructed internally. Tests inject a mock here.
   */
  readonly mcpManager?: MCPClientManager;
  /**
   * Resolved sandbox configs per server. Used by `handleCallTool` to
   * annotate audit entries with `sandboxed=true` when applicable.
   * Optional; coordinator supplies an empty map when absent.
   */
  readonly resolvedSandboxConfigs?: Map<string, ResolvedSandboxConfig>;
  /**
   * Most agent lanes expected to call through this coordinator at once:
   * the widest fan-out of a workflow bundle's scope, 1 (the default) for
   * everything else. The circuit breaker keeps a window per lane (see
   * {@link ToolCallOptions.lane}) with the single-lane threshold, so
   * concurrent lanes do not trip each other; this only sizes the
   * all-lanes window that bounds their total (`threshold * maxLanes`).
   * It never raises what one lane may do.
   */
  readonly maxLanes?: number;
  /**
   * Optional HTTP control server endpoint. When supplied, `start()`
   * binds a small JSON API that the workflow orchestrator uses to
   * hot-swap policy between state transitions (§4 of the
   * workflow-container-lifecycle design). When omitted, no server is
   * started -- standalone sessions (CLI, daemon, cron) do not use this
   * channel and must not pay for it.
   *
   * Exactly one of `socketPath` / `port` may be set (same contract as
   * `ControlServer.start`).
   */
  readonly controlServerListen?: ControlServerListenOptions;
  /**
   * `policy.onStale` from the user config. `loadPolicy` checks each policy it
   * hot-swaps in against this IronCurtain and the retained annotations, and
   * under 'refuse' rejects a stale one (the old engine stays). Absent means
   * 'warn': the finding goes to the session log.
   */
  readonly policyOnStale?: PolicyOnStale;
  /**
   * Sequence-aware (taint) policy, opt-in (`taintEscalation` in the user
   * config; see `taint-policy.ts`). Absent or `enabled: false`: nothing is
   * tracked. Enabled: the coordinator replays `auditLogPath` (a resumed
   * session starts tainted when it was), dispatching a taint source taints
   * the session for good, and a sink call in a tainted session that policy
   * does not deny needs a human.
   */
  readonly taintEscalation?: TaintEscalationOptions;
  /**
   * Audit logs that earlier coordinators wrote for the same agent context,
   * replayed after `auditLogPath` when taint escalation is enabled (ignored
   * otherwise). A resumed workflow run mints new bundles, each with a new
   * audit file, so the orchestrator passes the audit logs of the bundles
   * the run's earlier legs minted. Missing files restore nothing; files
   * that exist but cannot be read taint the session.
   */
  readonly taintReplayAuditLogPaths?: readonly string[];
  /**
   * Policy-evaluated MITM egress (opt-in, `egressPolicy.enabled` in the user
   * config; Docker Agent Mode only). When set, the virtual `network` server's
   * annotation and rules are merged into every policy this coordinator loads
   * (after the compiled rules), and `authorizeEgress` decides the
   * destinations the MITM proxy asks about. When omitted, `authorizeEgress`
   * refuses every request.
   */
  readonly egressPolicy?: EgressPolicyOptions;
  /**
   * Constitution scope that human approvals are attributed to in the
   * host-side approval history (`global`, `persona:<name>`, `job:<id>`; see
   * `src/audit/approval-history.ts`). Unset (or malformed): approvals are not
   * recorded. A workflow bundle starts with `global`, and `loadPolicy` moves
   * the scope to the persona it loads. With a `taskScope`, approvals of the
   * escalations the task scope raised are not recorded (see
   * `humanApprovalRecorder`).
   */
  readonly approvalHistoryScope?: string;
  /** Approval-history file (default `$IRONCURTAIN_HOME/approval-history.jsonl`). Test seam. */
  readonly approvalHistoryPath?: string;
}

/** What `ToolCallCoordinator.getTaintStatus` reports. */
export interface TaintStatus {
  /** Whether taint escalation is enabled for this coordinator. */
  readonly enabled: boolean;
  /** What first tainted the session; undefined while untainted (or disabled). */
  readonly taintedBy: TaintEvent | undefined;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/** Shape of a tool registered with the coordinator. */
export type CoordinatorTool = ProxiedTool;

export class ToolCallCoordinator implements EgressAuthorizer {
  private readonly policyMutex = new AsyncMutex();
  private readonly callMutex = new AsyncMutex();

  private policyEngine: PolicyEngine;
  private auditLog: AuditLog;
  private readonly circuitBreaker: CallCircuitBreaker;
  /**
   * Approval patterns humans whitelisted under the policy currently loaded.
   * Replaced by an empty whitelist on every `loadPolicy`: a pattern approved
   * for one persona must not discharge another persona's escalations.
   */
  private whitelist: ApprovalWhitelist;
  /**
   * The session's taint state when taint escalation is enabled, else
   * undefined. Monotonic and kept across `loadPolicy`: it describes what the
   * agent has read, not a persona's policy, and every lane sharing this
   * coordinator shares it (lanes share a workspace).
   */
  private readonly taint: SessionTaint | undefined;
  private readonly serverContextMap: ServerContextMap = new Map();
  private readonly mcpManager: MCPClientManager;
  private readonly ownedMcpManager: boolean;
  private readonly resolvedSandboxConfigs: Map<string, ResolvedSandboxConfig>;
  private readonly autoApproveModel: LanguageModelV3 | null;
  /**
   * The session's outbound content assessor (with its verdict cache), or
   * undefined when the assessment is off. Kept across policy hot-swaps: a
   * verdict depends on the content and the settings, not on the policy.
   */
  private readonly contentAssessor: ContentAssessor | undefined;
  private readonly escalationDir?: string;
  private readonly isPtySession: boolean;
  private readonly escalationTimeoutMs: number;
  private readonly backendCallTimeoutMs: number;
  private readonly onEscalation?: EscalationPromptFn;
  /**
   * One controller per escalation wait currently parked outside the call
   * mutex. `cancelPendingEscalations` aborts them so a quiesce never
   * waits out the escalation timeout.
   */
  private readonly pendingEscalations = new Set<AbortController>();
  /**
   * Set while a quiesce is in progress. An escalation wait that starts
   * after the cancel sweep (a call admitted before admission closed, still
   * evaluating policy at that moment) is aborted at once with this detail
   * instead of parking for the full timeout.
   */
  private escalationCancelDetail: string | null = null;
  private readonly controlApiClient: ControlApiClient | null;
  /** Target of the `workflow_commit` tool; null when this coordinator does not offer it. */
  private readonly workflowCommit: WorkflowCommitHandler | null;
  private readonly allowedDirectory?: string;
  // Retained so `loadPolicy` can reconstruct the policy engine with the
  // same per-session invariants (these do not change between personas).
  private readonly protectedPaths: string[];
  /** The read-only workspace every engine of this coordinator enforces, when there is one. */
  private readonly readOnlyWorkspace?: ReadOnlyWorkspace;
  private readonly serverDomainAllowlists: ReadonlyMap<string, readonly string[]>;
  private readonly trustedServers: ReadonlySet<string>;
  /**
   * Tool annotations retained for policy hot-swap. Persona policy
   * directories only ship `compiled-policy.json` (+ optional
   * `dynamic-lists.json`); annotations are globally scoped and do not
   * change when the persona swaps. `loadPolicy` reuses this object
   * verbatim when constructing the replacement `PolicyEngine`.
   *
   * This field already has proxy annotations merged in (if the caller
   * did so at construction time), and the `workflow_commit` annotation
   * when this coordinator offers that tool; `loadPolicy` therefore does
   * not need to re-merge the latter.
   */
  private readonly toolAnnotations: StoredToolAnnotationsFile;
  /** `policy.onStale` applied to every policy `loadPolicy` installs. */
  private readonly policyOnStale: PolicyOnStale;
  /**
   * The hardcoded `network` egress rules (allowed hosts, then the human-only
   * escalation), appended after the compiled rules of every policy this
   * coordinator loads, the task scope included. Undefined when
   * policy-evaluated egress is off.
   */
  private readonly egressRules: readonly CompiledRule[] | undefined;
  /** Bounds the egress escalations waiting for a human at once. */
  private readonly egressEscalationSlots = createEgressEscalationSlots();
  /**
   * Task scope intersected with every policy this coordinator enforces
   * (the construction-time one and each `loadPolicy` replacement), with the
   * same hardcoded rules as each of them: the virtual proxy rules and the
   * `workflow_commit` rule (when offered) first and the egress rules (when
   * on) last. Undefined for an unscoped session.
   */
  private readonly taskScope: TaskScopePolicy | undefined;

  /**
   * Control server handle. Inert until `start()` (eager, using
   * `controlServerListen` from the ctor) or `startControlServer(opts)`
   * (dynamic, used by the workflow orchestrator) binds it.
   */
  private readonly controlServer: ControlServer;
  private readonly controlServerListen?: ControlServerListenOptions;
  private controlServerAddress: ControlServerAddress | null = null;
  /**
   * Most recent user message. Set by `setLastUserMessage` and threaded
   * into the auto-approver when set. Mutable so callers can update it
   * across turns without reconstructing the coordinator.
   */
  private lastUserMessage: string | null = null;
  /**
   * Reports the agent's justification for the `execute_code` chain running
   * now, or undefined when there is none or it cannot be told which chain a
   * call came from (see `Sandbox.currentAgentJustification`). Read once per
   * call, when it enters `handleToolCall`. UNTRUSTED text for the human
   * reviewer only; see `setAgentJustificationProvider`.
   */
  private agentJustificationProvider: (() => string | undefined) | null = null;
  /**
   * Persona currently active for policy evaluation. Updated ONLY inside
   * `loadPolicy` under the policy mutex; read during `buildCallToolDeps`
   * under the call mutex and stamped onto every audit entry.
   *
   * `undefined` until the first successful `loadPolicy` call. Single-
   * session modes (CLI, daemon, cron) never call `loadPolicy`, so their
   * audit entries omit the `persona` field. Workflow runs call
   * `loadPolicy` before the first tool call of each agent state, so
   * every workflow-run audit entry carries a persona.
   */
  private currentPersona: string | undefined = undefined;
  /**
   * Scope human approvals are recorded under, or undefined when this
   * coordinator does not record them. Updated with `currentPersona` in
   * `loadPolicy`, so an approval is always attributed to the constitution
   * whose policy escalated the call.
   */
  private approvalScope: ApprovalScope | undefined;
  /** Whether this coordinator records human approvals at all (fixed at construction). */
  private readonly recordsApprovals: boolean;
  private readonly approvalHistoryPath: string | undefined;
  /**
   * The rules only the task scope produces, by name: its out-of-scope
   * escalation (`task-scope-escalate`) and the task policy's own rules.
   * Undefined without a task scope. See `humanApprovalRecorder`.
   */
  private readonly taskScopeRuleNames: ReadonlySet<string> | undefined;

  /** Tool registry keyed by tool name. */
  private readonly toolMap = new Map<string, CoordinatorTool>();
  /** Client states used for roots expansion on escalation. */
  private readonly clientStates = new Map<string, ClientState>();
  /**
   * Live-schema drift per registered server with an annotations entry
   * (drifted servers only), as computed at registration. Read by session
   * layers that report it after start-up.
   */
  private readonly schemaDrift = new Map<string, ServerSchemaDrift>();
  private activeToolCalls = 0;
  private toolCallAdmissionOpen = true;
  private closed = false;
  /**
   * Latched audit failure. Set the first time a tool call rejects with
   * `AUDIT_LOG_UNAVAILABLE`; from then on `enterToolCall` refuses every
   * call with that cause. Never cleared: the `AuditLog` latch below it is
   * permanent for the session too, and a session that lost its audit log
   * must be torn down, not resumed.
   */
  private auditFailure: Error | null = null;
  private readonly toolCallAdmissionWaiters: Array<() => void> = [];
  private readonly toolCallDrainWaiters: Array<() => void> = [];

  constructor(options: ToolCallCoordinatorOptions) {
    this.egressRules = options.egressPolicy ? buildEgressPolicyRules(options.egressPolicy) : undefined;
    const egressRules = this.egressRules;
    // A workflow coordinator offers the virtual `workflow_commit` tool: its
    // hardcoded annotation and allow rule join the policy here (the rule
    // ahead of the compiled rules, the egress rules after them) and the task
    // scope, and the annotation is retained below so every `loadPolicy`
    // keeps it.
    this.workflowCommit = options.workflowCommit ?? null;
    const egressAnnotations = egressRules ? mergeEgressAnnotations(options.toolAnnotations) : options.toolAnnotations;
    const toolAnnotations = this.workflowCommit ? withWorkflowCommitAnnotations(egressAnnotations) : egressAnnotations;
    const egressPolicy = egressRules
      ? { ...options.compiledPolicy, rules: [...options.compiledPolicy.rules, ...egressRules] }
      : options.compiledPolicy;
    const compiledPolicy = this.workflowCommit ? withWorkflowCommitRules(egressPolicy) : egressPolicy;
    this.taskScope = options.taskScope
      ? withHardcodedTaskScopeRules(options.taskScope, this.workflowCommit !== null, egressRules)
      : undefined;
    this.policyEngine = new PolicyEngine(
      compiledPolicy,
      toolAnnotations,
      options.protectedPaths,
      options.allowedDirectory,
      options.serverDomainAllowlists,
      options.dynamicLists,
      options.trustedServers,
      this.taskScope,
      { readOnlyWorkspace: options.readOnlyWorkspace },
    );
    this.auditLog = new AuditLog(options.auditLogPath, {
      redact: options.auditRedact === true,
      secrets: options.auditRedactSecrets,
    });
    this.circuitBreaker = new CallCircuitBreaker({ maxLanes: options.maxLanes ?? 1 });
    this.whitelist = createApprovalWhitelist();
    // Replays the audit log (before this coordinator appends to it) when the
    // session is resumed on an existing one, then the earlier legs' logs of
    // a resumed workflow run.
    this.taint = createSessionTaint(options.taintEscalation, options.auditLogPath, options.taintReplayAuditLogPaths);
    this.autoApproveModel = options.autoApproveModel ?? null;
    this.contentAssessor = options.contentAssessment ? new ContentAssessor(options.contentAssessment) : undefined;
    this.escalationDir = options.escalationDir;
    this.isPtySession = options.isPtySession === true;
    this.escalationTimeoutMs = options.escalationTimeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_SECONDS * 1000;
    this.backendCallTimeoutMs = options.backendCallTimeoutMs ?? DEFAULT_BACKEND_CALL_TIMEOUT_MS;
    this.onEscalation = options.onEscalation;
    this.controlApiClient = options.controlApiClient ?? null;
    this.allowedDirectory = options.allowedDirectory;
    this.resolvedSandboxConfigs = options.resolvedSandboxConfigs ?? new Map<string, ResolvedSandboxConfig>();

    if (options.mcpManager) {
      this.mcpManager = options.mcpManager;
      this.ownedMcpManager = false;
    } else {
      this.mcpManager = new MCPClientManager();
      this.ownedMcpManager = true;
    }

    // Retain per-session invariants so `loadPolicy` can reconstruct the
    // PolicyEngine with the same arguments it was first built with --
    // only the compiled rules / dynamic lists change. Annotations are
    // globally scoped (not shipped in per-persona policy dirs); retain
    // them here so `loadPolicy` does not attempt to re-read them.
    this.protectedPaths = options.protectedPaths;
    this.readOnlyWorkspace = options.readOnlyWorkspace;
    this.serverDomainAllowlists = options.serverDomainAllowlists ?? new Map();
    this.trustedServers = options.trustedServers ?? new Set();
    // With egress on, the retained annotations carry the `network` entry,
    // and with `workflow_commit` offered the `workflow` entry, so
    // `loadPolicy` keeps evaluating both under every persona. (The
    // provenance check `loadPolicy` runs against them ignores both:
    // reserved virtual servers are never part of a policy's provenance.)
    this.toolAnnotations = toolAnnotations;
    this.policyOnStale = options.policyOnStale ?? 'warn';

    this.approvalScope = isApprovalScope(options.approvalHistoryScope) ? options.approvalHistoryScope : undefined;
    this.recordsApprovals = this.approvalScope !== undefined;
    this.approvalHistoryPath = options.approvalHistoryPath;
    this.taskScopeRuleNames = this.taskScope
      ? new Set([TASK_SCOPE_ESCALATE_RULE, ...this.taskScope.compiledPolicy.rules.map((rule) => rule.name)])
      : undefined;

    this.controlServerListen = options.controlServerListen;
    this.controlServer = new ControlServer({
      onLoadPolicy: (req) => this.loadPolicy(req),
    });

    if (this.workflowCommit) {
      // Registered directly: the tool is hardcoded, so there is no live
      // schema to compare with its annotation.
      this.toolMap.set(`${WORKFLOW_COMMIT_SERVER}__${workflowCommitToolDefinition.name}`, {
        serverName: WORKFLOW_COMMIT_SERVER,
        name: workflowCommitToolDefinition.name,
        description: workflowCommitToolDefinition.description,
        inputSchema: workflowCommitToolDefinition.inputSchema,
      });
      // Tell the orchestrator the agent behind this coordinator can commit
      // through the tool.
      this.workflowCommit.attach();
    }
  }

  getMcpManager(): MCPClientManager {
    return this.mcpManager;
  }

  getPolicyEngine(): PolicyEngine {
    return this.policyEngine;
  }

  /** True when every policy this coordinator enforces is narrowed by a task scope. */
  hasTaskScope(): boolean {
    return this.taskScope !== undefined;
  }

  /**
   * Registers the tools a backend server exposes. Called after the
   * subprocess has connected and listed tools.
   *
   * Optionally associates a `ClientState` with the server so escalation
   * root expansion can reach the MCP client (used by the Sandbox wiring
   * for real subprocess clients).
   *
   * Compares the registered tools with the server's entry in
   * `tool-annotations.json` (`schema-drift.ts`): tools added, removed or
   * renamed since the last `annotate-tools` run, and for every annotated
   * tool its arguments, conditional discriminators, enums and required
   * list. Drift is kept on the coordinator (`getSchemaDrift`, which session
   * layers turn into an `annotation_drift` diagnostic for their transport)
   * and written to the session log. Without this, a server release that
   * renames an argument surfaces only as per-call denials
   * (`unannotated-arguments`, the engine's structural fallbacks), and a new
   * argument the annotation does not classify goes unnoticed until a call
   * carries it. Enforcement stays per call: the pipeline denies every
   * unclassified argument. This is the chokepoint for both the Code Mode
   * sandbox and Docker `CodeModeProxy` paths.
   */
  registerTools(serverName: string, tools: CoordinatorTool[], clientState?: ClientState): void {
    for (const tool of tools) {
      this.toolMap.set(`${serverName}__${tool.name}`, tool);
    }
    if (clientState) {
      this.clientStates.set(serverName, clientState);
    }
    this.recordSchemaDrift(serverName, tools);
  }

  getRegisteredTools(): CoordinatorTool[] {
    return [...this.toolMap.values()];
  }

  /**
   * Live-schema drift found at `registerTools` time, per server. Only
   * servers with an annotations entry whose live tools differ from it
   * appear; a server that matches, a trusted server (policy never
   * evaluates its calls) and a server with no annotations at all (reported
   * by `checkAnnotationFreshness`) do not.
   */
  getSchemaDrift(): ReadonlyMap<string, ServerSchemaDrift> {
    return this.schemaDrift;
  }

  /**
   * Diffs a server's live tools against its stored annotations and records
   * the result. Servers without an annotations entry are skipped: that gap
   * is server-level drift, which `checkAnnotationFreshness` reports at
   * policy-load time.
   *
   * The full report goes to the session log: as a warning when the drift
   * changes what policy evaluates, as information when only schema text
   * changed (descriptions, the `required` list, stale annotations). Nothing
   * is written to the terminal from here: a raw stderr write would bypass
   * the session log and garble the start-up spinners. The session layers
   * read `getSchemaDrift()` and present it on their own surface
   * (`annotation_drift` diagnostics for the CLI and web transports, the PTY
   * start-up notice for mux and web terminals).
   *
   * Spurious "stale annotations" reports from servers that failed to start
   * are avoided upstream: in the sandbox/router path the proxy subprocess
   * exits non-zero when no backend connects (`proxyCanServe` in
   * `mcp-proxy-server.ts`); in the direct `TrustedProcess.connectMcpServers`
   * path the caller skips failed servers before reaching `registerTools`.
   */
  private recordSchemaDrift(serverName: string, tools: readonly CoordinatorTool[]): void {
    if (this.trustedServers.has(serverName) || !Object.hasOwn(this.toolAnnotations.servers, serverName)) return;
    const drift = diffServerSchemas(serverName, this.toolAnnotations.servers[serverName].tools, tools);
    if (!hasServerDrift(drift)) {
      this.schemaDrift.delete(serverName);
      return;
    }
    this.schemaDrift.set(serverName, drift);
    const affectsPolicy = serverDriftAffectsPolicy(drift);
    for (const line of describeServerDrift(drift)) {
      if (affectsPolicy) logger.warn(`[annotations] ${line}`);
      else logger.info(`[annotations] ${line}`);
    }
  }

  /** Associates a `ClientState` with a server (roots-expansion path). */
  setClientState(serverName: string, state: ClientState): void {
    this.clientStates.set(serverName, state);
  }

  /** Associates a resolved sandbox config with a server (audit `sandboxed` flag). */
  setResolvedSandboxConfig(serverName: string, config: ResolvedSandboxConfig): void {
    this.resolvedSandboxConfigs.set(serverName, config);
  }

  // ---------------------------------------------------------------------
  // Tool-call pipeline
  // ---------------------------------------------------------------------

  /**
   * Handles a single tool call end-to-end. Serialized by the tool-call
   * mutex so the coordinator-owned caches remain consistent under
   * concurrent callers.
   *
   * @param serverName - the MCP server that owns the tool
   * @param toolName - the bare tool name (e.g. `read_file`, not `filesystem__read_file`)
   * @param rawArgs - the tool's arguments
   * @param options - host-assigned per-call options: `signal` cancels the
   *   call, `lane` keys the circuit breaker's window (see {@link ToolCallOptions})
   */
  async handleToolCall(
    serverName: string,
    toolName: string,
    rawArgs: Record<string, unknown>,
    options: ToolCallOptions = {},
  ): Promise<ToolCallResponse> {
    const key = `${serverName}__${toolName}`;
    // Read before admission and the call mutex: the provider describes the
    // chain running now, which is the chain that issued this call.
    const agentJustification = this.agentJustificationProvider?.();
    return this.runAdmittedToolCall(async (runEscalationWait) => {
      const deps = this.buildCallToolDeps(null, runEscalationWait, options, agentJustification);
      return handleCallTool(key, rawArgs, deps);
    });
  }

  /**
   * Admits one tool call, runs it under the call mutex and returns its
   * slot. An `AUDIT_LOG_UNAVAILABLE` rejection latches `auditFailure`
   * before it is re-thrown, so the next `enterToolCall` refuses at once.
   * The pipeline has already guaranteed that the failing call itself was
   * not dispatched.
   */
  private async runAdmittedToolCall(
    run: (runEscalationWait: EscalationWaitRunner) => Promise<ToolCallResponse>,
  ): Promise<ToolCallResponse> {
    await this.enterToolCall();
    try {
      return await this.runSerializedToolCall(run);
    } catch (err) {
      if (isAuditLogUnavailableError(err)) {
        this.auditFailure ??= err;
      }
      throw err;
    } finally {
      this.leaveToolCall();
    }
  }

  /**
   * The audit failure that stopped this coordinator from admitting tool
   * calls, or null while the audit log is healthy. Session layers can use
   * it to tear down instead of relaying an endless series of refusals.
   */
  getAuditFailure(): Error | null {
    return this.auditFailure;
  }

  private async runSerializedToolCall<T>(run: (runEscalationWait: EscalationWaitRunner) => Promise<T>): Promise<T> {
    let release = await this.callMutex.acquire();
    let lockHeld = true;

    const runEscalationWait: EscalationWaitRunner = async (wait) => {
      if (lockHeld) {
        release();
        lockHeld = false;
      }
      try {
        return await this.runCancellableEscalationWait(wait);
      } finally {
        release = await this.callMutex.acquire();
        lockHeld = true;
      }
    };

    try {
      return await run(runEscalationWait);
    } finally {
      release();
    }
  }

  /**
   * Runs one escalation wait registered as pending, so
   * `cancelPendingEscalations` can end it. A wait that begins during a
   * quiesce is aborted before it starts. Takes no lock: the tool-call path
   * releases the call mutex around it, the egress path never holds it.
   */
  private async runCancellableEscalationWait<T>(wait: (cancelSignal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.pendingEscalations.add(controller);
    if (this.escalationCancelDetail !== null) {
      controller.abort(escalationAbortReason('cancelled', this.escalationCancelDetail));
    }
    try {
      return await wait(controller.signal);
    } finally {
      this.pendingEscalations.delete(controller);
    }
  }

  private async enterToolCall(): Promise<void> {
    for (;;) {
      if (this.closed) {
        throw new Error('ToolCallCoordinator is closed');
      }
      if (this.auditFailure) {
        // Fail closed: a trusted process that cannot audit must not keep
        // processing tool calls. Same code as the original failure so
        // callers can recognise both as the audit log being gone.
        throw new AuditLogUnavailableError(
          `Tool call refused: the audit log is unavailable and tool calls are no longer admitted (${this.auditFailure.message})`,
          { cause: this.auditFailure },
        );
      }
      if (this.toolCallAdmissionOpen) {
        this.activeToolCalls++;
        return;
      }
      await new Promise<void>((resolve) => this.toolCallAdmissionWaiters.push(resolve));
    }
  }

  private leaveToolCall(): void {
    this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
    if (this.activeToolCalls === 0) {
      const waiters = this.toolCallDrainWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * Aborts every parked escalation wait with a `cancelled` reason. The
   * pipeline then denies each call immediately (audited as cancelled, not
   * as a human denial), deletes its request file and leaves the call.
   */
  private cancelPendingEscalations(detail: string): void {
    for (const controller of this.pendingEscalations) {
      controller.abort(escalationAbortReason('cancelled', detail));
    }
  }

  /**
   * Suspends admission, cancels pending escalations, waits for active
   * calls to drain, then runs `fn`. `cancelDetail` is what the cancelled
   * calls' audit entries and agent-facing errors say happened.
   */
  private async withToolCallsQuiesced<T>(cancelDetail: string, fn: () => Promise<T>): Promise<T> {
    this.toolCallAdmissionOpen = false;
    this.escalationCancelDetail = cancelDetail;
    this.cancelPendingEscalations(cancelDetail);
    while (this.activeToolCalls > 0) {
      await new Promise<void>((resolve) => this.toolCallDrainWaiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      if (!this.closed) {
        this.toolCallAdmissionOpen = true;
        this.escalationCancelDetail = null;
      }
      const waiters = this.toolCallAdmissionWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * Decides one destination the MITM proxy asks about (policy-evaluated
   * egress; see `egress-policy.ts`): the structural screen, the active
   * policy's `network/request` rules, and for an escalation the earlier
   * human decision the proxy passed as `prior` or a new human decision
   * through this coordinator's normal escalation channel (the in-process
   * handler, else the escalation directory). Every decision is audited.
   *
   * Admitted like a tool call (it waits while a policy swap is in progress
   * and is refused once the coordinator is closed or its audit log is gone)
   * but never takes the call mutex. The human wait is registered as a
   * pending escalation, so `close()` and `loadPolicy()` cancel it. With taint
   * escalation enabled, an admitted destination taints the session (a
   * `network/request` source by default) before the decision is returned.
   *
   * @throws when the coordinator is closed or the audit log is unavailable;
   *   the proxy then refuses the request.
   */
  async authorizeEgress(request: EgressRequest): Promise<EgressDecision> {
    const egressRules = this.egressRules;
    if (egressRules === undefined) {
      // Never wired without the option; refuse rather than guess.
      return {
        allowed: false,
        settledBy: 'policy',
        rule: 'egress-policy-disabled',
        reason: 'Policy-evaluated egress is not enabled for this session',
      };
    }
    await this.enterToolCall();
    try {
      return await decideEgress(request, {
        // Read after admission: a policy swap cannot be half-applied here.
        policyEngine: this.policyEngine,
        auditLog: this.auditLog,
        persona: this.currentPersona,
        channel: {
          onEscalation: this.onEscalation,
          escalationDir: this.escalationDir,
          escalationTimeoutMs: this.escalationTimeoutMs,
        },
        runEscalationWait: (wait) => this.runCancellableEscalationWait(wait),
        escalationSlots: this.egressEscalationSlots,
        // Shared with the tool-call pipeline: an admitted destination lets
        // content reach the agent without an MCP call, like add_proxy_domain.
        taint: this.taint,
      });
    } catch (err) {
      if (isAuditLogUnavailableError(err)) {
        this.auditFailure ??= err;
      }
      throw err;
    } finally {
      this.leaveToolCall();
    }
  }

  /**
   * Structured entry point matching the shape used by in-process
   * `TrustedProcess` callers (returns `ToolCallResult`).
   *
   * The `policyDecision` on the returned result is sourced from the
   * coordinator-internal `_policyDecision` field on the response when
   * present (always, in practice -- `handleCallTool` stamps it). Falls
   * back to a synthesized value if the field is missing.
   */
  async handleStructuredToolCall(request: ToolCallRequest, options: ToolCallOptions = {}): Promise<ToolCallResult> {
    const startTime = Date.now();

    // Structured callers supply (serverName, toolName). If the tool
    // isn't registered, pass a per-call augmented lookup so
    // `handleCallTool` can route through the policy engine (which
    // will report `missing-annotation` via the normal path). Without
    // this, the coordinator would short-circuit with `unknown-tool`,
    // losing the existing semantics that in-process callers rely on.
    //
    // The synthetic entry is scoped to this invocation only -- it is
    // never persisted in `this.toolMap`, which would cause unbounded
    // growth and cross-server collisions when two servers expose the
    // same tool name.
    const key = `${request.serverName}__${request.toolName}`;
    const synthetic: CoordinatorTool | null = this.toolMap.has(key)
      ? null
      : {
          serverName: request.serverName,
          name: request.toolName,
          inputSchema: {},
        };

    // As in handleToolCall: the chain running now is the one that issued the call.
    const agentJustification = this.agentJustificationProvider?.();
    const response = await this.runAdmittedToolCall(async (runEscalationWait) => {
      const deps = this.buildCallToolDeps(synthetic, runEscalationWait, options, agentJustification);
      // Preserve the caller's requestId/timestamp so audit entries
      // correlate with caller-side tracing. Low-level UTCP callers
      // route through `handleToolCall` below, which omits this.
      return handleCallTool(key, request.arguments, deps, {
        requestId: request.requestId,
        timestamp: request.timestamp,
      });
    });

    const isError = response.isError === true;
    // The pipeline always stamps `_policyDecision` on its responses, so
    // the decision's own `status` field is the authoritative signal for
    // whether a failure was a policy deny vs. a downstream runtime error.
    // Fall back to 'error' only if the decision is missing entirely.
    const status: ToolCallResult['status'] = isError
      ? response._policyDecision?.status === 'deny'
        ? 'denied'
        : 'error'
      : 'success';

    const policyDecision: PolicyDecision = response._policyDecision ?? {
      status: 'allow',
      rule: 'synthesized',
      reason: extractTextFromContent(response.content) ?? (isError ? 'error' : 'ok'),
    };

    return {
      requestId: request.requestId,
      status,
      content: response.content,
      policyDecision,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Builds the `CallToolDeps` snapshot consumed by `handleCallTool`.
   *
   * When `syntheticTool` is provided, it is overlaid on the real
   * toolMap for this single call only. Callers that need to route a
   * structured request for an unregistered tool through the policy
   * engine use this to avoid mutating the coordinator's long-lived
   * tool registry.
   */
  private buildCallToolDeps(
    syntheticTool: CoordinatorTool | null = null,
    runEscalationWait?: EscalationWaitRunner,
    options: ToolCallOptions = {},
    agentJustification?: string,
  ): CallToolDeps {
    // Capture the callback reference once to narrow the type, then
    // adapt it to the shape handleCallTool expects.
    const escalationFn = this.onEscalation;
    const onEscalation: InProcessEscalationFn | undefined = escalationFn
      ? async (req, reason, ctx, candidates, details) => escalationFn(req, reason, ctx, candidates, details)
      : undefined;

    // When a synthetic entry is provided, construct a fresh map that
    // overlays it on the real registry. The overlay is local to this
    // call; it never mutates `this.toolMap`. Without a synthetic
    // entry, reuse the real map directly to avoid per-call copies.
    const toolMap = syntheticTool
      ? new Map([...this.toolMap, [`${syntheticTool.serverName}__${syntheticTool.name}`, syntheticTool]])
      : this.toolMap;

    return {
      toolMap,
      policyEngine: this.policyEngine,
      auditLog: this.auditLog,
      circuitBreaker: this.circuitBreaker,
      clientStates: this.clientStates,
      resolvedSandboxConfigs: this.resolvedSandboxConfigs,
      allowedDirectory: this.allowedDirectory,
      escalationDir: this.escalationDir,
      autoApproveModel: this.autoApproveModel,
      contentAssessor: this.contentAssessor,
      isPtySession: this.isPtySession,
      serverContextMap: this.serverContextMap,
      whitelist: this.whitelist,
      controlApiClient: this.controlApiClient,
      ...(this.workflowCommit ? { workflowCommit: this.workflowCommit } : {}),
      onEscalation,
      autoApproveUserMessage: this.lastUserMessage ?? undefined,
      ...(agentJustification !== undefined ? { agentJustification } : {}),
      runEscalationWait,
      persona: this.currentPersona,
      lane: options.lane,
      escalationTimeoutMs: this.escalationTimeoutMs,
      backendCallTimeoutMs: this.backendCallTimeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      taint: this.taint,
      onHumanApproval: this.humanApprovalRecorder(),
    };
  }

  /**
   * Records human approvals in the approval history under the scope in
   * effect, or undefined when this coordinator does not record them. Best
   * effort: a write that fails is logged and the call is unaffected.
   *
   * With a task scope (`--task-scoped`), an escalation named after a rule
   * only the task scope produces (`task-scope-escalate`, or one of the task
   * policy's own rules) is not recorded: the session policy allowed that
   * call and the per-task scope escalated it, so no amendment of the
   * constitution in scope would spare the approval, and the approval says
   * nothing about that constitution. An escalation under a session-policy
   * rule is recorded as usual (the intersection names the session policy's
   * rule when both escalate); a session-policy rule that shares its name
   * with a task rule is skipped too, which only records less.
   */
  private humanApprovalRecorder(): CallToolDeps['onHumanApproval'] {
    const scope = this.approvalScope;
    if (scope === undefined) return undefined;
    const location = this.approvalHistoryPath !== undefined ? { path: this.approvalHistoryPath } : {};
    const taskScopeRules = this.taskScopeRuleNames;
    return (approval) => {
      if (taskScopeRules?.has(approval.rule) === true) {
        logger.debug(
          `[approval-history] approval of ${approval.serverName}/${approval.toolName} not recorded: the task scope escalated it`,
        );
        return;
      }
      const written = recordHumanApproval(
        scope,
        {
          serverName: approval.serverName,
          toolName: approval.toolName,
          rule: approval.rule,
          constraints: approval.pattern.constraints,
          description: approval.pattern.description,
        },
        location,
      );
      // Not learnable (a structural rule, the proxy server) or not writable.
      if (!written) {
        logger.debug(`[approval-history] approval of ${approval.serverName}/${approval.toolName} not recorded`);
      }
    };
  }

  /**
   * Whether taint escalation is enabled and what tainted the session, if
   * anything (diagnostics, tests).
   */
  getTaintStatus(): TaintStatus {
    return { enabled: this.taint !== undefined, taintedBy: this.taint?.taintedBy };
  }

  /** Number of escalation waits currently parked (exposed for tests and diagnostics). */
  getPendingEscalationCount(): number {
    return this.pendingEscalations.size;
  }

  /** The escalation wait this coordinator applies, in milliseconds (tests, diagnostics). */
  getEscalationTimeoutMs(): number {
    return this.escalationTimeoutMs;
  }

  /** The backend call bound this coordinator applies, in milliseconds (tests, diagnostics). */
  getBackendCallTimeoutMs(): number {
    return this.backendCallTimeoutMs;
  }

  /**
   * Sets the most recent user message used by the auto-approver. Called
   * by session layers before each agent turn so auto-approval sees the
   * current prompt context. Setting `null` clears the value.
   */
  setLastUserMessage(message: string | null): void {
    this.lastUserMessage = message;
  }

  /**
   * Installs the function that reports the agent's justification for the
   * `execute_code` chain issuing tool calls now (the Sandbox installs its
   * `currentAgentJustification`). Each call entering `handleToolCall` reads
   * it once and an escalation of that call shows the text to the human
   * reviewer, labelled as written by the agent. It is untrusted display
   * text: the policy engine, the approval whitelist and the auto-approver
   * never see it. `null` removes the provider.
   */
  setAgentJustificationProvider(provider: (() => string | undefined) | null): void {
    this.agentJustificationProvider = provider;
  }

  /**
   * Hot-swap the policy engine and update the active persona stamp.
   *
   * Invariants:
   *
   *   1. Suspend new tool-call admission, cancel every pending escalation
   *      wait (each call is denied at once and audited as cancelled: a
   *      policy swap must never leave a call waiting under the old
   *      persona's policy, nor block for the escalation timeout) and wait
   *      for active calls to drain before we swap.
   *   2. Acquire the call mutex, then the policy mutex, to serialize against
   *      overlapping tool-call tails and loadPolicy calls.
   *   3. Load + construct the new engine. If the policy dir is missing
   *      or malformed, we abort with the old engine still intact --
   *      callers can keep running under the previous persona's policy
   *      until they decide to tear down. The coordinator's task scope
   *      (`--task-scoped`), if any, is intersected with the new policy
   *      too: only the persona policy changes, never the task scope.
   *   4. Swap the engine reference AND update `currentPersona` in the
   *      same critical section. Subsequent tool calls start under the
   *      new engine and stamp audit entries with the new persona. The
   *      approval whitelist is emptied in the same step, so no pattern a
   *      human approved under the previous persona outlives its policy.
   *      Session taint (taint escalation enabled) is kept: the next
   *      persona's agent works in the same workspace the tainted content
   *      may have reached.
   *   5. On failure in step 3, propagate the error without touching the
   *      old engine or `currentPersona`.
   *
   * Audit-file contract: the coordinator writes every entry to the
   * single `auditLogPath` supplied at construction time. Workflow runs
   * rely on the `persona` field on each entry (set here) plus JSONL
   * ordering to reconstruct per-persona / per-re-entry slices.
   */
  async loadPolicy(req: { persona: string; policyDir: string }): Promise<void> {
    // Defense-in-depth: any process that can reach the control socket
    // can invoke this RPC, so we must not trust `req.policyDir`.
    // Canonicalize it and require one of the exact compiled-policy
    // directories (validate-policy-dir.ts) BEFORE acquiring any mutex. Rejecting early means a hostile request cannot even
    // block tool-call dispatch. Throws `PolicyDirValidationError`, which
    // the control server maps to a 500 via its generic error path.
    //
    // Use the validator's realpath-canonicalized return value for every
    // subsequent read. Passing `req.policyDir` through unmodified would
    // reopen the symlink-swap TOCTOU window the validator was introduced
    // to close: an attacker could swap the symlink target between the
    // validate() call and loadPersonaPolicyArtifacts(), pointing the
    // load at attacker-controlled files outside the trusted roots.
    const canonicalPolicyDir = validatePolicyDir(req.policyDir);

    // Cancel calls paused outside the call mutex for human escalation,
    // then wait for every in-flight tool call to drain. Then serialize
    // against concurrent loadPolicy. The two mutexes are acquired in this
    // order (call, then policy) everywhere; deadlock is impossible because
    // no other code path acquires them in reverse.
    await this.withToolCallsQuiesced(`policy hot-swap to persona "${req.persona}"`, async () => {
      await this.callMutex.withLock(async () => {
        // The inner critical section is fully synchronous (policy load,
        // engine construction, reference swap); `async` is kept only so
        // the function matches `AsyncMutex.withLock`'s `() => Promise<T>`
        // signature.
        // eslint-disable-next-line @typescript-eslint/require-await
        await this.policyMutex.withLock(async () => {
          // Step 1: load only the per-persona artifacts (compiled policy
          // + optional dynamic lists). Annotations are globally scoped
          // and were retained at construction time -- persona dirs do
          // not ship `tool-annotations.json`. The loader schema-validates
          // both files (src/types/policy-schema.ts): if a required file
          // is missing or either one is malformed (an unknown decision, a
          // misspelled condition key, a list value that is not a string
          // array), it throws and we surface that to the caller without
          // touching the live engine. The policy's provenance is then
          // checked against this IronCurtain and the retained annotations:
          // under `policy.onStale: "refuse"` a stale policy throws here
          // (the old engine stays); otherwise the finding is logged (the
          // session that follows the swap warns on stderr).
          const { compiledPolicy, dynamicLists } = loadPersonaPolicyArtifacts(canonicalPolicyDir, {
            provenanceCheck: {
              annotations: this.toolAnnotations,
              onStale: this.policyOnStale,
              owner: { persona: req.persona },
              report: (text) => {
                logger.warn(`[policy] ${text.trimEnd()}`);
              },
            },
          });

          // Step 2: re-merge the virtual proxy tool annotations and
          // rules. The sandbox does this at construction time
          // (`buildCoordinator` in src/sandbox/index.ts); a
          // persona-swapped policy must re-apply the same merge or the
          // new engine will treat `add_proxy_domain` /
          // `remove_proxy_domain` / `list_proxy_domains` as unknown
          // tools. The merge comes after validation on purpose: the
          // hardcoded rules carry `humanOnly`, which the file format
          // does not allow.
          //
          // The merge is idempotent: `proxy` is a reserved server name
          // (RESERVED_SERVER_NAMES) so overwriting it on each load is
          // always correct, even if the caller already merged at
          // construction time.
          const mergedAnnotations = mergeProxyAnnotations(this.toolAnnotations);
          // The `workflow_commit` rule rides along the same way (its
          // annotation is already in `this.toolAnnotations`), so a persona
          // swap never takes the commit tool away from a workflow agent.
          // The egress rules follow the persona's own rules, so a persona
          // policy that allows, escalates or denies `network` requests
          // decides before the configured allowlist and the fallback
          // escalation. (The retained annotations already carry the
          // `network` entry when egress is on.)
          compiledPolicy.rules = [
            ...proxyPolicyRules,
            ...(this.workflowCommit ? workflowCommitPolicyRules : []),
            ...compiledPolicy.rules,
            ...(this.egressRules ?? []),
          ];

          // Step 3: build the replacement engine using the retained +
          // proxy-merged annotations. A synchronous construction failure
          // (malformed policy) propagates out below without touching
          // `this.policyEngine` or `this.currentPersona`. The run's task
          // scope (if any) narrows the new persona's policy exactly as it
          // narrowed the previous one: a hot-swap never drops it.
          const nextEngine = new PolicyEngine(
            compiledPolicy,
            mergedAnnotations,
            this.protectedPaths,
            this.allowedDirectory,
            this.serverDomainAllowlists,
            dynamicLists,
            this.trustedServers,
            this.taskScope,
            // The read-only workspace belongs to the session or bundle, not
            // to the persona: the swapped-in engine enforces it too.
            { readOnlyWorkspace: this.readOnlyWorkspace },
          );

          // Step 4: swap the engine reference and update the persona
          // stamp together. Both fields are read by handlers that queue
          // on the call mutex we are holding, so they cannot observe a
          // partial swap. The approval whitelist starts empty under the
          // new policy: its patterns were approved for calls the previous
          // persona's policy escalated, and a human never approved them
          // for this one (a workflow bundle's coordinator outlives its
          // personas, unlike a session's).
          this.policyEngine = nextEngine;
          this.currentPersona = req.persona;
          this.whitelist = createApprovalWhitelist();
          // Approvals from now on are made under this persona's policy.
          if (this.recordsApprovals) {
            this.approvalScope = approvalScopeForPolicyPersona(req.persona);
          }
        });
      });
    });
  }

  /**
   * Starts the HTTP control server if one was configured via
   * `controlServerListen`. No-op when no server is configured.
   * Calling twice on a configured coordinator is an error.
   */
  async start(): Promise<ControlServerAddress | null> {
    if (!this.controlServerListen) return null;
    return this.startControlServer(this.controlServerListen);
  }

  /**
   * Starts the HTTP control server at runtime with the supplied listen
   * options. Used by the workflow orchestrator to attach a control
   * server on a workflow-scoped UDS after the coordinator was built by
   * the generic session path.
   *
   * A second call throws so accidental double-starts surface loudly
   * instead of silently leaking a socket. The server is cleaned up by
   * `close()`.
   */
  async startControlServer(options: ControlServerListenOptions): Promise<ControlServerAddress> {
    if (this.controlServerAddress) {
      throw new Error('ToolCallCoordinator control server already running');
    }
    this.controlServerAddress = await this.controlServer.start(options);
    return this.controlServerAddress;
  }

  /** Returns the bound control server address, or null if not started. */
  getControlServerAddress(): ControlServerAddress | null {
    return this.controlServerAddress;
  }

  /** Releases all held resources (MCP subprocesses, audit stream, control server). */
  async close(): Promise<void> {
    // Stop the control server first so no new loadPolicy requests can
    // arrive while we're tearing down the underlying components.
    if (this.controlServerAddress) {
      await this.controlServer.stop();
      this.controlServerAddress = null;
    }

    // Cancel pending escalations and drain any in-flight tool call or
    // `loadPolicy` handler before we close the audit log. Stopping the
    // control server above only prevents NEW control requests -- a
    // handler already inside `loadPolicy` (mid-rotate) or a tool call
    // already inside `handleCallTool` (writing to audit) continues to run
    // against the coordinator's state. Acquiring both mutexes in the same
    // order used elsewhere (call, then policy) guarantees those handlers
    // complete before we tear the audit log out from under them; no
    // deadlock risk because no code path takes these in reverse.
    await this.withToolCallsQuiesced('coordinator shutting down', async () => {
      await this.callMutex.withLock(async () => {
        await this.policyMutex.withLock(async () => {
          // Mutexes held — no loadPolicy/handleCallTool can be in flight.
        });
      });
      this.closed = true;
    });

    if (this.ownedMcpManager) {
      await this.mcpManager.closeAll();
    }
    await this.auditLog.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a shallow-cloned annotations file with the virtual `proxy`
 * server entry overwritten. Mirrors the merge the sandbox performs at
 * construction time so hot-swapped persona policies can evaluate the
 * virtual proxy tools without the caller re-merging.
 *
 * The clone is shallow (copy the `servers` map, keep per-server tool
 * arrays by reference): we only need to replace the `proxy` slot, and
 * the engine does not mutate any other server's tool arrays.
 */
function mergeProxyAnnotations(src: StoredToolAnnotationsFile): StoredToolAnnotationsFile {
  return {
    ...src,
    servers: {
      ...src.servers,
      proxy: {
        inputHash: 'hardcoded',
        tools: proxyAnnotations,
      },
    },
  };
}

/**
 * Returns the task scope with the hardcoded rules every session policy
 * gets: the virtual proxy rules first (sandbox construction, `loadPolicy`),
 * then, on a coordinator that offers `workflow_commit`, that tool's allow
 * rule (this coordinator's constructor, `loadPolicy`) and, with
 * policy-evaluated egress on, the `network` egress rules last (this
 * coordinator's constructor, `loadPolicy`). A task policy is compiled from
 * the task text and knows nothing of these virtual servers, so without them
 * `list_proxy_domains`, every workflow state's commit and every egress
 * destination would escalate as out of scope; with them the proxy tools
 * keep their fixed decisions (`add_proxy_domain` stays a human-only
 * escalation through the session policy), a workflow agent can commit its
 * state's result, the hosts in `egressPolicy.allowedHosts` stay admitted
 * and every other destination stays a human-only escalation. A destination
 * only the session policy's own compiled `network` rules allow is not in
 * the task scope, so it escalates. The scope can still never allow what
 * the session policy does not (see `PolicyEngine`). Rules already present
 * under a hardcoded rule's name are replaced, so the merge is idempotent.
 */
function withHardcodedTaskScopeRules(
  scope: TaskScopePolicy,
  offersWorkflowCommit: boolean,
  egressRules: readonly CompiledRule[] | undefined,
): TaskScopePolicy {
  const prepended = [...proxyPolicyRules, ...(offersWorkflowCommit ? workflowCommitPolicyRules : [])];
  const appended = egressRules ?? [];
  const hardcodedNames = new Set([...prepended, ...appended].map((rule) => rule.name));
  return {
    ...scope,
    compiledPolicy: {
      ...scope.compiledPolicy,
      rules: [
        ...prepended,
        ...scope.compiledPolicy.rules.filter((rule) => !hardcodedNames.has(rule.name)),
        ...appended,
      ],
    },
  };
}
