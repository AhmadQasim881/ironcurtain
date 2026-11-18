import { getGatewayDefinition } from '../config/provider-definitions.js';
import { assertAgentResponseOutputBound } from './agent-response-output.js';
/**
 * DockerAgentSession -- Session implementation that runs an external
 * agent inside a Docker container.
 *
 * The agent communicates with IronCurtain's MCP proxy server via a
 * Unix domain socket. The proxy enforces the same policy rules as
 * the built-in agent session.
 *
 * Docker infrastructure (proxies, orientation, image, running `sleep
 * infinity` container, TCP-mode sidecar and internal network) is created
 * by `createDockerInfrastructure()` in `docker-infrastructure.ts` and
 * handed to this class as a `DockerInfrastructure` bundle. The session
 * is a thin exec-harness over that bundle.
 *
 * Infrastructure ownership (`ownsInfra`):
 * - `ownsInfra: true` (standalone mode): the session owns the bundle and
 *   its `close()` method tears down proxies, container, sidecar, and
 *   internal network along with session-local state.
 * - `ownsInfra: false` (borrow mode): the session uses a bundle owned by
 *   an external caller (e.g., a workflow that shares one container across
 *   multiple sessions). `close()` stops session-owned state (escalation
 *   watcher, audit tailer) but leaves the infrastructure alive for the
 *   caller to destroy via `destroyDockerInfrastructure()`.
 *
 * Lifecycle:
 * 1. initialize() -- write system prompt; start escalation watcher and audit tailer
 * 2. sendMessage() -- docker exec agent command, wait for exit, collect output
 * 3. close() -- tear down watchers; tear down infra too iff `ownsInfra` is true;
 *    then release the claim on the session directory (`resume.lock`) that a
 *    standalone session holds
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  AgentConversationId,
  AgentTurnResult,
  Session,
  SessionId,
  SessionInfo,
  SessionStatus,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  BudgetCostSource,
  BudgetStatus,
  SendMessageOptions,
} from '../session/types.js';
import { createAgentConversationId } from '../session/types.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { DockerInfrastructure } from './docker-infrastructure.js';
import { destroyDockerInfrastructure } from './docker-infrastructure.js';
import { AuditLogTailer } from './audit-log-tailer.js';
import { findStoredConversation, recordStoredConversation } from './conversation-state.js';
import {
  SessionNotReadyError,
  SessionClosedError,
  BudgetExhaustedError,
  EscalationExpiredError,
} from '../types/errors.js';
import { findCumulativeBudgetExhaustion, type CumulativeBudgetExhaustion } from '../session/budget-admission.js';
import { releaseSessionDirectory } from '../session/session-lock.js';
import type { ProcessLockHandle } from '../docker-workload/process-lock.js';
import {
  buildBoundedTurn,
  killTimedOutTurn,
  killTurnProcesses,
  turnTimedOut,
  TURN_MARKER_ENV,
} from './turn-timeout.js';
import type { BudgetGateExhaustion } from './budget-gate.js';
import { resolveMaxAgentTurns } from './agent-adapter.js';
import { createEscalationWatcher } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import { clearSessionUserContext, recordSessionUserContext } from '../escalation/session-user-context.js';
import { SessionTaskSummary } from '../escalation/escalation-review.js';
import * as logger from '../logger.js';
import { annotationDriftDiagnostics } from '../session/annotation-drift-diagnostics.js';
import { BoundedLog, SESSION_DIAGNOSTIC_LOG_LIMIT, SESSION_TURN_HISTORY_LIMIT } from '../session/bounded-log.js';
import type { HostModelNotice } from '../session/host-model-roles.js';
import {
  hostModelDiagnostics,
  policyWarningDiagnostics,
  unavailableServerDiagnostics,
  type HostPrivilegedFilesDiagnostic,
} from '../session/startup-notices.js';
import { hostPrivilegedFilesNotice } from './host-mount-privilege-scan.js';
import { getTokenStreamBus } from './token-stream-bus.js';
import type { DockerExecResult } from './types.js';
import { getLlmMetricsEventBus } from '../llm-metrics/event-bus.js';
import { ObservedUsageAccumulator, type ObservedUsageSnapshot } from '../llm-metrics/observed-usage-accumulator.js';
import type { TurnBudgetSnapshot } from '../session/resource-budget-tracker.js';
import type { LogRedaction } from '../trusted-process/audit-redactor.js';
import { resolveLogRedaction } from '../trusted-process/audit-secrets.js';

export interface DockerAgentSessionDeps {
  readonly config: IronCurtainConfig;
  readonly sessionId: SessionId;
  /**
   * Agent CLI conversation id threaded through to the adapter's CLI-arg
   * construction (e.g., `--session-id <id>` / `--resume <id>` for Claude
   * Code). Distinct from `sessionId`: the session id identifies an
   * IronCurtain session and its on-disk session tree; the conversation
   * id identifies the external agent's conversation history file
   * (`projects/<cwd-hash>/<id>.jsonl`) and is the value the agent CLI
   * picks up on turn-to-turn resume.
   *
   * Required: callers (the session factory or workflow orchestrator)
   * mint one via `createAgentConversationId()` per Docker session.
   * Under `sharedContainer: true` workflow mode, re-entering a state
   * with `freshSession: false` reuses the prior visit's id so the agent
   * CLI can `--resume` the existing conversation.
   *
   * See `docs/designs/workflow-session-identity.md` §2.2 / §8.5.
   */
  readonly agentConversationId: AgentConversationId;
  /**
   * Fully-formed infrastructure bundle produced by
   * `createDockerInfrastructure()`. The main agent container is already
   * created and running; the session drives it via `docker exec`. All of
   * `docker`, `proxy`, `mitmProxy`, `adapter`, `fakeKeys`, `useTcp`,
   * `bundleDir`, `workspaceDir`, `escalationDir`, `auditLogPath`,
   * `conversationStateDir`, `conversationStateConfig`, `systemPrompt`,
   * `containerId`, `sidecarContainerId`, and `internalNetwork` live on
   * this bundle.
   */
  readonly infra: DockerInfrastructure;
  /**
   * Whether this session owns the infrastructure bundle.
   *
   * - `true`: standalone mode -- `close()` invokes
   *   `destroyDockerInfrastructure(infra)` to tear down proxies, container,
   *   sidecar, and internal network alongside session-local state.
   * - `false`: borrow mode -- the bundle is owned by an external caller
   *   (e.g., a workflow driver sharing one container across sessions).
   *   `close()` leaves the infrastructure alive and the caller is
   *   responsible for invoking `destroyDockerInfrastructure` when done.
   *
   * This flag is required: callers must state ownership explicitly so a
   * missing value never silently selects the wrong teardown behavior.
   */
  readonly ownsInfra: boolean;
  /**
   * Optional system prompt override composed by the caller (e.g., with
   * persona augmentation appended). When unset, `infra.systemPrompt` is
   * used as-is.
   */
  readonly systemPromptOverride?: string;
  /** Qualified model ID ("provider:model-name") to use for this session's turns, overriding the adapter default. */
  readonly agentModelOverride?: string;
  /** Content-free workflow dimensions attached to metrics leases. */
  readonly metricsStateId?: string;
  readonly metricsPersonaId?: string;
  readonly metricsWorkflowRunId?: string;
  readonly onEscalation?: (request: EscalationRequest) => void;
  readonly onEscalationExpired?: (escalationId: string) => void;
  readonly onEscalationResolved?: (escalationId: string, decision: 'approved' | 'denied') => void;
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
  /**
   * The session's claim on the logger (see logger.ts). The session binds
   * its own work to it and releases it in close().
   */
  readonly logClaim?: logger.LoggerClaim;
  /**
   * The claim on the session directory (`resume.lock`, see
   * src/session/session-lock.ts) that a standalone session holds, fresh or
   * resumed. The session owns it from construction and releases it in
   * close() once its bundle is torn down, so a `--resume` never runs beside
   * this session's container. Absent on a borrowed workflow bundle.
   */
  readonly sessionLock?: ProcessLockHandle;
  /**
   * Host-model roles running differently for lack of credentials
   * (host-model-roles.ts), reported as `host_model_fallback` diagnostics
   * while the session initializes.
   */
  readonly hostModelNotices?: readonly HostModelNotice[];
  /**
   * Warnings about the session's compiled policy that buildSessionConfig
   * collected (stale provenance), reported as `policy_stale` diagnostics
   * while the session initializes.
   */
  readonly policyWarnings?: readonly string[];
}

export class DockerAgentSession implements Session {
  private readonly sessionId: SessionId;
  private agentConversationId: AgentConversationId;
  private readonly config: IronCurtainConfig;
  private readonly infra: DockerInfrastructure;
  private readonly ownsInfra: boolean;
  private readonly agentModelOverride?: string;
  private readonly metricsStateId?: string;
  private readonly metricsPersonaId?: string;
  private readonly metricsWorkflowRunId?: string;
  private readonly systemPrompt: string;

  private status: SessionStatus = 'initializing';
  private readonly createdAt: string;

  /**
   * Whether the first turn of this conversation has completed at least once.
   * Used to decide whether to pin a fresh session id (`--session-id`) or
   * resume an existing one (`--resume`) for agents like Claude Code. Set to
   * true in the constructor if the agent CLI already holds this conversation
   * (see `findStoredConversation`); otherwise flipped to true after the
   * first turn that produced output.
   */
  private firstTurnComplete = false;

  /**
   * The CLI-minted thread that continues this conversation (Codex), from the
   * host record at construction or from the last turn's `thread.started`.
   * Cleared whenever the conversation id rotates.
   */
  private agentThreadId: string | undefined;

  /** The `<conversation id>/<thread id>` pair last written to the host record, to skip rewrites. */
  private recordedConversation: string | undefined;

  /** The newest turns (getHistory); `total` counts every completed turn. */
  private readonly turns = new BoundedLog<ConversationTurn>(SESSION_TURN_HISTORY_LIMIT);
  /** The newest diagnostic events (getDiagnosticLog). */
  private readonly diagnosticLog = new BoundedLog<DiagnosticEvent>(SESSION_DIAGNOSTIC_LOG_LIMIT);
  /** Claim on the logger, released by close(); undefined when none was handed over. */
  private readonly logClaim: logger.LoggerClaim | undefined;
  /** Claim on the session directory, released by close() after the teardown; undefined when none was handed over. */
  private sessionLock: ProcessLockHandle | undefined;
  private readonly hostModelNotices: readonly HostModelNotice[];
  private readonly policyWarnings: readonly string[];
  private escalationWatcher: EscalationWatcher | null = null;

  private auditTailer: AuditLogTailer | null = null;
  /** Every close caller joins the same infrastructure teardown. */
  private closePromise: Promise<void> | undefined;
  private cumulativeActiveMs = 0;
  /**
   * The latest cumulative cost reported to the session, if any: OpenRouter's
   * summed `usage.cost` from the token stream (for a proxy-cost profile), else
   * the agent CLI's self-report. A display fallback only: host-observed cost
   * wins when it covers every exchange (see `sessionCost`), and budget
   * decisions never read it (see `hostObservedCostUsd`).
   */
  private reportedCostUsd: number | undefined;

  /**
   * Cumulative authoritative USD cost, summed from OpenRouter `usage.cost`
   * values surfaced on the token-stream bus (`message_end` events) for this
   * session id (§10, D6). This is ground truth for the Anthropic-skin path:
   * Claude Code's own `total_cost_usd` self-report is wrong when routed to a
   * non-Anthropic model. Preferred over the CLI self-report only when the
   * active profile is openrouter-type AND this sum is > 0 (see
   * `resolveReportedCostUsd`). Populated by the token-stream subscription
   * installed in `initialize()`; the token stream decodes compressed
   * responses, so a gzip or br stream still contributes.
   */
  private authoritativeCostUsd = 0;

  /** Unsubscribe handle for the token-stream cost subscription. */
  private unsubscribeCostStream: (() => void) | null = null;
  private readonly observedUsage: ObservedUsageAccumulator;
  private unsubscribeObservedUsage: (() => void) | null = null;
  private lastTurnUsage: ObservedUsageSnapshot;
  /** Budget view of the last completed turn (one agent CLI invocation); null before the first. */
  private lastTurnBudget: TurnBudgetSnapshot | null = null;

  /** Transcript redaction (see getLogRedaction); undefined until first asked. */
  private logRedaction: LogRedaction | null | undefined;

  /** The task this session was started with, attached to every escalation it surfaces. */
  private readonly taskSummary = new SessionTaskSummary();

  private readonly onEscalation?: (request: EscalationRequest) => void;
  private readonly onEscalationExpired?: (escalationId: string) => void;
  private readonly onEscalationResolved?: (escalationId: string, decision: 'approved' | 'denied') => void;
  private readonly onDiagnostic?: (event: DiagnosticEvent) => void;

  constructor(deps: DockerAgentSessionDeps) {
    this.sessionId = deps.sessionId;
    this.agentConversationId = deps.agentConversationId;
    this.config = deps.config;
    this.infra = deps.infra;
    this.ownsInfra = deps.ownsInfra;
    this.agentModelOverride = deps.agentModelOverride;
    this.metricsStateId = deps.metricsStateId;
    this.metricsPersonaId = deps.metricsPersonaId;
    this.metricsWorkflowRunId = deps.metricsWorkflowRunId;
    this.systemPrompt = deps.systemPromptOverride ?? deps.infra.systemPrompt;
    this.onEscalation = deps.onEscalation;
    this.onEscalationExpired = deps.onEscalationExpired;
    this.onEscalationResolved = deps.onEscalationResolved;
    this.onDiagnostic = deps.onDiagnostic;
    this.logClaim = deps.logClaim;
    this.sessionLock = deps.sessionLock;
    this.hostModelNotices = deps.hostModelNotices ?? [];
    this.policyWarnings = deps.policyWarnings ?? [];
    this.createdAt = new Date().toISOString();
    this.observedUsage = new ObservedUsageAccumulator(this.sessionId, this.infra.beginMetricsInvocation !== undefined);
    this.lastTurnUsage = this.observedUsage.takeTurnSnapshot('');

    // If the agent CLI already holds THIS conversation, treat the first turn
    // as "already done" so buildCommand continues it (`--resume <id>` for
    // Claude Code, `exec resume <thread>` for Codex, `--resume` of the named
    // Goose session) instead of starting it. Matching on
    // `agentConversationId` (not `sessionId`) matters under shared-container
    // workflow mode: each state invocation gets a fresh IronCurtain session
    // but may reuse the prior visit's conversation id (`freshSession: false`).
    // See §8.5 in docs/designs/workflow-session-identity.md. The state dir is
    // the agent's read-write mount (an earlier state or run may have planted
    // links or loops), so the probes are bounded and never follow a symlink;
    // the Codex and Goose records live in the host-only bundle dir.
    if (this.infra.conversationStateDir) {
      const stored = findStoredConversation({
        stateDir: this.infra.conversationStateDir,
        // Every adapter with a state dir declares its layout; Claude Code's
        // is the historical default for bundles assembled without one.
        layout: this.infra.conversationStateConfig?.transcriptLayout ?? 'claude-projects',
        recordRoot: this.infra.bundleDir,
        agentConversationId: this.agentConversationId,
      });
      this.firstTurnComplete = stored.stored;
      this.agentThreadId = stored.threadId;
      if (stored.stored) this.recordedConversation = `${this.agentConversationId}/${stored.threadId ?? ''}`;
    }
  }

  /**
   * Initialize the Docker agent session. All infrastructure (proxies,
   * orientation, image, container, sidecar, internal network) is already
   * created by `createDockerInfrastructure()` before the session is
   * constructed. This method only wires up session-local state:
   *
   * 1. Ensure session directories exist
   * 2. Write the effective system prompt for debugging
   * 3. Start the escalation watcher
   * 4. Start the audit log tailer at the log's current end
   */
  initialize(): Promise<void> {
    // The watchers, tailers and bus subscriptions created here are bound to
    // the session's logger claim, so what they log later lands in this
    // session's log too.
    return logger.runWithClaim(this.logClaim, () => this.initializeSession());
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy Session interface
  private async initializeSession(): Promise<void> {
    mkdirSync(this.infra.workspaceDir, { recursive: true });
    mkdirSync(this.infra.escalationDir, { recursive: true });

    // Write the effective system prompt for debugging. The file stays on
    // the host: only `<bundleDir>/orientation` is mounted into the
    // container, and batch turns hand the prompt to the agent CLI through
    // the adapter's command (`buildCommand`). In borrow mode this
    // overwrites the same bundle-scoped file each state.
    writeFileSync(resolve(this.infra.bundleDir, 'system-prompt.txt'), this.systemPrompt);

    logger.info(`Session attached to container: ${this.infra.containerId.substring(0, 12)}`);

    this.escalationWatcher = createEscalationWatcher(this.infra.escalationDir, {
      onEscalation: (request) => this.onEscalation?.(this.taskSummary.attach(request)),
      onEscalationExpired: (escalationId) => this.onEscalationExpired?.(escalationId),
      onEscalationResolved: (id, decision) => this.onEscalationResolved?.(id, decision),
    });
    this.escalationWatcher.start();

    // AuditLogTailer handles missing files: openSync catches ENOENT, and
    // watchFile polls regardless of existence. Don't create the file here --
    // it would race the proxy subprocess, which appends audit entries
    // concurrently, and the default `writeFileSync` 'w' flag could truncate
    // an entry the proxy just wrote.
    //
    // Tail from the log's current end, so the session reports only the tool
    // calls it makes. In borrow mode the log is the bundle's, shared by every
    // earlier state of the workflow run, and a resumed session reuses the old
    // session's log: tailing from offset 0 re-read and re-reported that whole
    // history on every session. A fresh session's log holds no tool calls yet
    // (no turn has run), so starting at its end loses nothing.
    this.auditTailer = new AuditLogTailer(this.infra.auditLogPath, (event) => this.emitDiagnostic(event), {
      startOffset: 'end',
    });
    this.auditTailer.start();

    // Start-up notices: a stale compiled policy and host-model features
    // running differently (both logged by buildSessionConfig), MCP servers
    // the proxy's sandbox could not start and annotation drift its
    // coordinator found while registering the backend servers' tools (both in
    // the session log). The diagnostics surface them in the transport (CLI,
    // web UI, Signal).
    for (const event of policyWarningDiagnostics(this.policyWarnings)) {
      this.emitDiagnostic(event);
    }
    for (const event of hostModelDiagnostics(this.hostModelNotices)) {
      this.emitDiagnostic(event);
    }
    for (const event of unavailableServerDiagnostics(this.infra.proxy.getUnavailableServers?.() ?? [])) {
      this.emitDiagnostic(event);
    }
    for (const event of annotationDriftDiagnostics(this.infra.proxy.getSchemaDrift?.() ?? [])) {
      this.emitDiagnostic(event);
    }

    // Authoritative-cost tap (§10, D6): sum OpenRouter `usage.cost` values
    // surfaced on `message_end` events for this session id. The MITM proxy
    // publishes on the module-scoped singleton bus keyed by its token-session
    // id, which equals this session id in single-session mode (see
    // docker-infrastructure.ts `routingId`). The subscription is unconditional
    // and cheap — accumulation is a no-op for native providers (no `costUsd`
    // field); whether the sum is *preferred* over the CLI self-report is gated
    // in `resolveReportedCostUsd`.
    this.unsubscribeCostStream = getTokenStreamBus().subscribe(this.sessionId, (_sessionId, event) => {
      if (
        event.kind === 'message_end' &&
        typeof event.costUsd === 'number' &&
        Number.isFinite(event.costUsd) &&
        event.costUsd >= 0
      ) {
        this.authoritativeCostUsd += event.costUsd;
      }
    });
    if (this.infra.beginMetricsInvocation !== undefined) {
      this.unsubscribeObservedUsage = getLlmMetricsEventBus().subscribe((exchange) => {
        this.observedUsage.observe(exchange);
      });
    }

    // Trajectory capture is driven HERE only in standalone (owns-infra)
    // mode: the session owns the bundle and runs exactly one Claude session
    // through it, with no fsmState (not a workflow) and no persona, so
    // `{ sessionId }` alone is correct. In borrow mode (workflow shared
    // container) the orchestrator drives the capture lifecycle and supplies
    // the full `{ sessionId, persona, fsmState }`; the session must NOT also
    // call begin/end here, or the orchestrator's richer call would be
    // silently dropped by the dispatcher's first-wins idempotency, losing
    // persona/fsmState on the `session-start` manifest entry.
    // No-op when capture is disabled (writer absent). The `ownsInfra` gate
    // is a real lifecycle decision (borrow mode lets the orchestrator drive
    // begin/end); the method is always present.
    // See docs/designs/mitm-token-trajectory-capture.md §11.
    if (this.ownsInfra) {
      this.infra.beginCaptureSession({ sessionId: this.sessionId });
    }

    this.status = 'ready';
  }

  getInfo(): SessionInfo {
    return {
      id: this.sessionId,
      status: this.status,
      turnCount: this.turns.total,
      createdAt: this.createdAt,
    };
  }

  async sendMessage(userMessage: string, options?: SendMessageOptions): Promise<string> {
    const result = await this.sendMessageDetailed(userMessage, options);
    // Non-workflow transports use the string-only Session API and cannot see
    // the hardFailure flag. Rotate here so their next user turn never resumes
    // a conversation whose failed CLI invocation produced no transcript.
    // Workflow callers use sendMessageDetailed() and own their retry/rotation
    // policy explicitly, so they do not pass through this branch.
    if (result.hardFailure) this.rotateAgentConversationId();
    return result.text;
  }

  sendMessageDetailed(userMessage: string, options?: SendMessageOptions): Promise<AgentTurnResult> {
    // The turn logs to this session's log, whichever transport, daemon or
    // workflow context sent the message.
    return logger.runWithClaim(this.logClaim, () => this.runTurn(userMessage, options));
  }

  private async runTurn(userMessage: string, options: SendMessageOptions | undefined): Promise<AgentTurnResult> {
    if (this.status === 'closed') throw new SessionClosedError();
    if (this.status !== 'ready') throw new SessionNotReadyError(this.status);

    this.status = 'processing';
    let turnExecStarted = false;
    try {
      // Between-turn admission on host-observed usage only (tokens, steps,
      // cost), including the bundle's budget gate. The turn now starting is
      // bounded in flight by that gate, which refuses completions once a
      // token or cost limit is reached (see below), and by the wall clock.
      this.assertBudgetAdmitsNextTurn();

      // Per-turn wall-clock timeout (matches builtin session semantics:
      // maxSessionSeconds is a per-turn limit, idle time doesn't count).
      // Explicit null disables it. The limit is enforced INSIDE the container
      // by wrapping the command in coreutils `timeout`, which signals the
      // turn's whole process group; the host exec deadline is a longer
      // backstop that only fires when the wrapper could not end the exec.
      // See turn-timeout.ts.
      const maxSeconds = this.config.userConfig.resourceBudget.maxSessionSeconds;
      const maxAgentTurns = resolveMaxAgentTurns(this.config);

      const turnStartMs = Date.now();
      const turnStart = new Date(turnStartMs).toISOString();
      const costBeforeTurnUsd = this.sessionCost().usd;

      // Write user context for the auto-approver. A system-generated turn
      // (the memory auto-save prompt, which replays the agent's own replies)
      // clears it instead, so an escalation during that turn reaches a human.
      if (options?.origin === 'system') {
        this.clearUserContext();
      } else {
        this.writeUserContext(userMessage);
      }
      this.taskSummary.recordMessage(userMessage, options?.origin);

      const baseCommand = this.infra.adapter.buildCommand(userMessage, this.systemPrompt, {
        // The adapter consumes this as the agent-CLI conversation id
        // (`--session-id <id>` / `--resume <id>`). It is NOT the IronCurtain
        // session id — see §8.5 in docs/designs/workflow-session-identity.md.
        sessionId: this.agentConversationId,
        firstTurn: !this.firstTurnComplete,
        ...(this.agentThreadId === undefined ? {} : { agentThreadId: this.agentThreadId }),
        // The session's own config, loaded for this session (the daemon
        // reloads it per session; the cached adapter must not hold one).
        agentModelId: this.config.agentModelId,
        modelOverride: this.agentModelOverride,
        providerProfile: this.config.activeProviderProfile,
        ...(maxAgentTurns === undefined ? {} : { maxAgentTurns }),
      });
      // Gated on `skillsMount` so adapters don't pass flags pointing at
      // a path that isn't bind-mounted into this session.
      const batchArgs = this.infra.adapter.skills?.batchArgs;
      const agentCommand = this.infra.skillsMount && batchArgs?.length ? [...baseCommand, ...batchArgs] : baseCommand;

      const turnId = randomUUID();
      const bounded = buildBoundedTurn(agentCommand, turnId, maxSeconds);
      logger.info(`[docker-agent] exec: ${formatCommand(bounded.command)}`);

      const metricsLease = this.infra.beginMetricsInvocation?.({
        sessionId: this.sessionId,
        agentConversationId: this.agentConversationId,
        turnId,
        bundleId: this.infra.bundleId,
        workflowRunId: this.metricsWorkflowRunId ?? this.infra.workflowId,
        stateId: this.metricsStateId,
        personaId: this.metricsPersonaId,
        agentId: this.infra.adapter.id,
      });
      // The bundle's budget gate (budget-gate.ts) forwards completion
      // requests only while a turn is open on it, and refuses them once a
      // token or cost limit is reached. On that refusal the gate notifies
      // here: the turn's processes are swept by their marker, and the turn
      // ends with BudgetExhaustedError once the exec returns. The marker is
      // put in the exec environment whenever a gate exists, since the sweep
      // needs it even when no time limit applies.
      const gate = this.infra.budgetGate;
      const budgetStop: { exhaustion?: BudgetGateExhaustion; sweep?: Promise<void> } = {};
      const stopWatchingBudget = gate?.onExhausted((exhaustion) => {
        if (budgetStop.exhaustion !== undefined) return;
        budgetStop.exhaustion = exhaustion;
        logger.warn(`[docker-agent] ${exhaustion.message}; stopping the running turn`);
        budgetStop.sweep = killTurnProcesses(this.infra.docker, this.infra.containerId, bounded, 'budget-stopped');
      });
      const gateTurn = gate?.beginTurn();
      const execStartMs = Date.now();
      let execResult: DockerExecResult;
      turnExecStarted = true;
      try {
        // Lease routing plus the turn marker the timeout and budget sweeps
        // match on. Values travel through the child environment, never argv.
        const environment: Record<string, string> = {
          ...(metricsLease ? { HTTPS_PROXY: metricsLease.proxyUrl, HTTP_PROXY: metricsLease.proxyUrl } : {}),
          ...bounded.environment,
          ...(gate ? { [TURN_MARKER_ENV]: turnId } : {}),
        };
        execResult = await this.infra.docker.exec(
          this.infra.containerId,
          bounded.command,
          bounded.hostTimeoutMs,
          undefined,
          undefined,
          Object.keys(environment).length > 0 ? environment : undefined,
        );
      } finally {
        // From here on the bundle forwards no completion for this turn: a
        // process the agent left behind is refused by the gate.
        gateTurn?.end();
        stopWatchingBudget?.();
        await metricsLease?.end();
      }
      const { exitCode, stdout, stderr } = execResult;
      const execDurationMs = Date.now() - execStartMs;
      const timeoutLabel =
        maxSeconds === null ? 'disabled' : `${maxSeconds}s (host backstop ${bounded.hostTimeoutMs}ms)`;
      logger.info(
        `[docker-agent] exit=${exitCode} stdout=${stdout.length}B stderr=${stderr.length}B ` +
          `duration=${execDurationMs}ms timeout=${timeoutLabel}`,
      );
      if (exitCode !== 0) {
        logger.warn(`[docker-agent] non-zero exit code ${exitCode} after ${execDurationMs}ms`);
      }

      if (stderr) {
        logger.info(`[docker-agent] stderr: ${stderr.substring(0, 500)}`);
      }

      const turnActiveMs = Date.now() - turnStartMs;
      this.cumulativeActiveMs += turnActiveMs;

      if (budgetStop.exhaustion !== undefined) {
        // The gate refused a completion during this turn: the budget is spent
        // for the whole bundle. Wait for the sweep, then abandon the
        // conversation id as after a timeout (the CLI may have left a partial
        // transcript) and report the exhausted dimension, so the daemon
        // records budget_exhausted and transports show it.
        await budgetStop.sweep;
        this.observedUsage.takeTurnSnapshot(turnId);
        this.rotateAgentConversationId();
        const message = `${budgetStop.exhaustion.message}; the agent was stopped inside the container`;
        logger.warn(`[docker-agent] ${message}`);
        this.emitDiagnostic({ kind: 'budget_exhausted', dimension: budgetStop.exhaustion.dimension, message });
        throw new BudgetExhaustedError(budgetStop.exhaustion.dimension, message, true);
      }

      if (turnTimedOut(execResult, bounded, execDurationMs)) {
        // The in-container `timeout` wrapper has signalled the turn's process
        // group (exit 124/137), or the host backstop fired because something
        // kept the exec alive past the wrapper's kill grace. Either way, sweep
        // the turn's surviving processes by marker: a child that left the
        // process group (for example a tool subprocess spawned detached) is
        // not reached by the group kill. Only then is the conversation id
        // abandoned, before anything else can reuse it: the CLI may have
        // materialised a partial transcript that neither `--session-id` nor
        // `--resume` can continue safely. This is reported as wall-clock
        // exhaustion, never as the adapter's "exited without producing output"
        // hard failure, so callers do not retry a turn the host itself stopped.
        await killTimedOutTurn(this.infra.docker, this.infra.containerId, bounded);
        this.observedUsage.takeTurnSnapshot(turnId);
        this.rotateAgentConversationId();
        const limitLabel = bounded.maxSeconds === null ? '' : ` / ${bounded.maxSeconds}s per-turn limit`;
        const message =
          `Time budget exhausted: turn ran ${Math.round(execDurationMs / 1000)}s${limitLabel}; ` +
          'the agent was stopped inside the container';
        logger.warn(`[docker-agent] ${message}`);
        this.emitDiagnostic({ kind: 'budget_exhausted', dimension: 'wall_clock', message });
        throw new BudgetExhaustedError('wall_clock', message, true);
      }

      assertAgentResponseOutputBound(stdout, stderr);
      const response = this.infra.adapter.extractResponse(exitCode, stdout, stderr);

      this.reportedCostUsd = this.resolveReportedCostUsd(response.costUsd);
      const observedTurn = this.observedUsage.takeTurnSnapshot(turnId);
      this.lastTurnUsage = observedTurn;
      this.lastTurnBudget = {
        totalInputTokens: observedTurn.inputTokens,
        totalOutputTokens: observedTurn.outputTokens,
        totalTokens: observedTurn.totalTokens,
        stepCount: 1,
        elapsedSeconds: turnActiveMs / 1000,
        estimatedCostUsd: Math.max(0, this.sessionCost().usd - costBeforeTurnUsd),
      };

      const turn: ConversationTurn = {
        turnNumber: this.turns.total + 1,
        userMessage,
        assistantResponse: response.text,
        usage: {
          promptTokens: observedTurn.inputTokens,
          completionTokens: observedTurn.outputTokens,
          totalTokens: observedTurn.totalTokens,
          cacheReadTokens: observedTurn.cacheReadTokens,
          cacheWriteTokens: observedTurn.cacheWriteTokens,
          thinkingTokens: observedTurn.thinkingTokens,
          usageCompleteness: observedTurn.status,
          observedExchanges: observedTurn.observedExchanges,
          incompleteExchanges: observedTurn.incompleteExchanges,
          unmeasuredExchanges: observedTurn.unmeasuredExchanges,
        },
        timestamp: turnStart,
      };
      this.turns.push(turn);

      // Mark the first turn complete whenever the agent CLI produced any
      // non-whitespace stdout. Claude Code's `--session-id` is a create-only
      // flag — the CLI rejects the next call with "Session ID is already in
      // use" if the transcript JSONL on disk already exists. Any real stdout
      // proves the session got far enough for the CLI to materialize that
      // JSONL, even if the run ultimately exited non-zero (e.g. Anthropic
      // API 400 mid-stream). The next turn must therefore use `--resume`
      // rather than re-pinning the same id. The whitespace-trimmed check
      // matches `extractResponse`'s hard-failure definition (stdout.trim()
      // empty); hard failures still route through rotateAgentConversationId()
      // at the orchestrator layer.
      if (stdout.trim().length > 0) {
        this.firstTurnComplete = true;
        // A CLI that mints its own conversation id (Codex) reports it every
        // turn; a resumed thread reports the same id again.
        if (response.agentThreadId !== undefined) this.agentThreadId = response.agentThreadId;
        this.recordConversation();
      }

      return {
        text: response.text,
        hardFailure: response.hardFailure ?? false,
        quotaExhausted: response.quotaExhausted,
        transientFailure: response.transientFailure,
      };
    } finally {
      // On a host-root Docker daemon, sweep the agent's read-write host mounts
      // for setuid/setgid and root-owned files the turn may have left behind
      // (succeeded, failed or timed out alike; a timed-out turn's processes
      // were killed above). The scanner is absent elsewhere and never throws.
      // What no earlier scan of the bundle reported reaches the transport.
      if (turnExecStarted) {
        const scan = await this.infra.privilegedFileScanner?.scan('after agent turn');
        this.emitHostMountNotice(hostPrivilegedFilesNotice(scan, 'new'));
      }
      // Restore to 'ready' on both success and exception so a failed
      // turn (docker.exec timeout, adapter parse error, etc.) doesn't
      // leave the session permanently stuck in 'processing' and block
      // further turns. Don't overwrite 'closed' if close() was called
      // concurrently. Cast widens TS's narrowed 'processing' type —
      // TS doesn't model concurrent mutation of a class member while
      // we were awaiting.
      if ((this.status as SessionStatus) !== 'closed') {
        this.status = 'ready';
      }
    }
  }

  /**
   * Rotates `agentConversationId` to a freshly-minted UUID and resets
   * `firstTurnComplete` so the next turn pins the new id with
   * `--session-id` (vs. `--resume`).
   *
   * Called by the workflow orchestrator after a hard failure or before a
   * fresh replacement execution when status recovery did not commit. After
   * a hard failure, the prior id was consumed without a resumable transcript;
   * before replacement, its transcript is intentionally abandoned so the new
   * executor receives a clean full prompt.
   *
   * The session metadata file on disk is deliberately NOT rewritten: the
   * workflow persists the returned id through its invocation result instead.
   */
  rotateAgentConversationId(): AgentConversationId {
    const previousId = this.agentConversationId;
    this.agentConversationId = createAgentConversationId();
    this.firstTurnComplete = false;
    this.agentThreadId = undefined;
    logger.info(
      `[docker-agent] rotated agentConversationId from ${previousId} to ${this.agentConversationId} ` +
        `(fresh conversation requested)`,
    );
    return this.agentConversationId;
  }

  /**
   * Streams the agent container's complete log into `sink` through the
   * bundle's own runtime and its real container id (see
   * `Session.streamContainerLogs`).
   */
  async streamContainerLogs(sink: NodeJS.WritableStream): Promise<void> {
    const runtime = this.infra.docker;
    if (runtime.streamContainerLogs === undefined) {
      throw new Error(`the ${this.infra.runtimeKind} container runtime cannot stream container logs`);
    }
    await runtime.streamContainerLogs(this.infra.containerId, sink);
  }

  getHistory(): readonly ConversationTurn[] {
    return this.turns.items;
  }

  getDiagnosticLog(): readonly DiagnosticEvent[] {
    return this.diagnosticLog.items;
  }

  /** Process any new audit log entries immediately (useful for tests). */
  flushAuditLog(): void {
    this.auditTailer?.readNewEntries();
  }

  getPendingEscalations(): readonly EscalationRequest[] {
    return (this.escalationWatcher?.getPending() ?? []).map((pending) => this.taskSummary.attach(pending));
  }

  getBudgetStatus(): BudgetStatus {
    const elapsedSeconds = this.cumulativeActiveMs / 1000;
    const current = this.lastTurnUsage;
    const cumulative = this.observedUsage.cumulativeSnapshot();
    // Display value and its source (see `sessionCost`): it can be the agent
    // CLI's own (validated) self-report. Decisions never read this field;
    // they read `hostObservedCostUsd`.
    const cost = this.sessionCost();
    // Bundle-wide charges of the MITM budget gate: every completion the
    // bundle forwarded, attributed or not, statistics on or off.
    const gate = this.infra.budgetGate?.snapshot();

    return {
      totalInputTokens: current.inputTokens,
      totalOutputTokens: current.outputTokens,
      totalTokens: current.totalTokens,
      stepCount: this.turns.total,
      elapsedSeconds,
      estimatedCostUsd: cost.usd,
      costSource: cost.source,
      limits: this.config.userConfig.resourceBudget,
      lastTurn: this.lastTurnBudget,
      cumulative: {
        totalInputTokens: cumulative.inputTokens,
        totalOutputTokens: cumulative.outputTokens,
        totalTokens: cumulative.totalTokens,
        stepCount: this.turns.total,
        activeSeconds: elapsedSeconds,
        estimatedCostUsd: cost.usd,
      },
      hostObservedCostUsd: this.hostObservedCostUsd(),
      ...(gate !== undefined
        ? {
            budgetGate: { bundleId: String(this.infra.bundleId), totalTokens: gate.totalTokens, costUsd: gate.costUsd },
          }
        : {}),
      tokenTrackingAvailable: cumulative.status !== 'unavailable',
      tokenTrackingStatus: cumulative.status,
      observedExchanges: cumulative.observedExchanges,
      incompleteExchanges: cumulative.incompleteExchanges,
      unmeasuredExchanges: cumulative.unmeasuredExchanges,
    };
  }

  getLogRedaction(): LogRedaction | null {
    // Resolved once: the known credential values are a snapshot, like the
    // coordinator's audit redaction list.
    if (this.logRedaction === undefined) this.logRedaction = resolveLogRedaction(this.config.userConfig);
    return this.logRedaction;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy Session interface
  async resolveEscalation(
    escalationId: string,
    decision: 'approved' | 'denied',
    options?: { whitelistSelection?: number },
  ): Promise<void> {
    if (!this.escalationWatcher) {
      throw new Error(`No pending escalation with ID: ${escalationId}`);
    }
    // The watcher reports a response that came after the proxy's timeout
    // (the request file was already gone): the call was denied, so the
    // decision must not be acknowledged as applied.
    if (!this.escalationWatcher.resolve(escalationId, decision, options)) {
      throw new EscalationExpiredError(escalationId);
    }
  }

  close(): Promise<void> {
    this.closePromise ??= logger.runWithClaim(this.logClaim, () => this.closeSession());
    return this.closePromise;
  }

  private async closeSession(): Promise<void> {
    // Session-owned state (status, escalation watcher, audit tailer) is
    // always torn down. Infrastructure teardown is gated on `ownsInfra`:
    // borrow mode leaves the bundle alive for the external owner to
    // destroy via `destroyDockerInfrastructure()`.
    if (this.status === 'closed') return;
    this.status = 'closed';

    this.escalationWatcher?.stop();
    this.auditTailer?.stop();
    this.unsubscribeCostStream?.();
    this.unsubscribeCostStream = null;
    this.unsubscribeObservedUsage?.();
    this.unsubscribeObservedUsage = null;

    // Trajectory capture: end the capture session BEFORE infrastructure
    // teardown so the `session-end` manifest entry is durable. The
    // infrastructure-teardown safety net inside destroyDockerInfrastructure
    // would otherwise emit a synthetic poisoned end. Pre-empting it keeps
    // the manifest clean for normal exits. Gated on `ownsInfra` to stay
    // symmetric with the begin call above: in borrow mode the orchestrator
    // owns begin/end, so the session calling end alone would terminate a
    // capture session the orchestrator is still using.
    if (this.ownsInfra) {
      await this.infra.endCaptureSession(this.sessionId).catch((err: unknown) => {
        logger.warn(`endCaptureSession failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    try {
      if (this.ownsInfra) {
        // The teardown's final host-mount scan runs once the container is
        // gone; whatever it found left behind goes to the transport. (A
        // borrowed bundle's owner reports its own teardown.)
        const teardown = await destroyDockerInfrastructure(this.infra);
        this.emitHostMountNotice(teardown.privilegedFiles);
      }
    } finally {
      // Hand the session directory back only once the bundle's teardown has
      // run (even when it failed, as a builtin session does), so a --resume
      // never starts beside this session's container.
      if (this.sessionLock) {
        releaseSessionDirectory(this.sessionLock);
        this.sessionLock = undefined;
      }
      // Give back this session's logger claim only, even when the teardown
      // failed: the daemon's log, a concurrent session's log and the next
      // workflow state's log carry on (see `src/logger.ts`).
      logger.release(this.logClaim);
    }
  }

  // --- Private helpers ---

  /**
   * Record in the host-only bundle dir that the CLI now holds this
   * conversation (and, for Codex, which thread continues it), so a later
   * session reusing the conversation id resumes it. A no-op for Claude Code,
   * whose transcript is named by our id. Failure is logged, not thrown: this
   * session still continues the conversation from memory.
   */
  private recordConversation(): void {
    const layout = this.infra.conversationStateConfig?.transcriptLayout;
    if (layout === undefined) return;
    const key = `${this.agentConversationId}/${this.agentThreadId ?? ''}`;
    if (this.recordedConversation === key) return;
    try {
      const written = recordStoredConversation({
        layout,
        recordRoot: this.infra.bundleDir,
        agentConversationId: this.agentConversationId,
        ...(this.agentThreadId === undefined ? {} : { threadId: this.agentThreadId }),
      });
      if (written) this.recordedConversation = key;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(`[docker-agent] could not record conversation ${this.agentConversationId}: ${detail}`);
    }
  }

  /**
   * Cumulative cost from host-observed sources only: the metrics tap's
   * per-exchange cost (the gateway's reported cost, or the host's list-price
   * estimate for an exchange on a verified official provider origin) and the
   * token-stream bus's OpenRouter `usage.cost` sum, all derived from provider
   * responses the MITM saw. A lower bound while some exchange could not be
   * priced (see `sessionCost`). Never includes the agent CLI's self-reported
   * `total_cost_usd`.
   */
  private hostObservedCostUsd(): number {
    return Math.max(this.observedUsage.cumulativeSnapshot().costUsd, this.authoritativeCostUsd);
  }

  /**
   * Between-turn admission on host-derived numbers only. First the bundle's
   * budget gate: the tokens and list-priced cost its MITM proxy charged for
   * every completion it forwarded, attributed or not (`budget-gate.ts`; in a
   * shared workflow bundle, all lanes together). Then the session's own
   * view: tokens observed at the proxy (when the metrics path is active),
   * completed agent turns as steps, and host-observed cost, with the same
   * check as the workflow orchestrator (`session/budget-admission.ts`), so a
   * standalone, cron or Signal Docker session stops at the same point a
   * workflow state does. The agent's own cost report is deliberately not
   * consulted: a compromised agent can print any figure.
   *
   * The limits are cumulative. Session token totals count only the exchanges
   * the proxy attributed to this session exactly, so they are a lower bound;
   * the gate counts everything and also bounds a turn in flight, which this
   * check does not.
   *
   * Throws `BudgetExhaustedError` (code `BUDGET_EXHAUSTED`) so the daemon
   * records `budget_exhausted` truthfully and transports show the dimension.
   */
  private assertBudgetAdmitsNextTurn(): void {
    const gateExhaustion = this.infra.budgetGate?.exhaustion();
    if (gateExhaustion !== undefined) {
      const message = `${gateExhaustion.message}; no further turns run in this session`;
      logger.warn(`[docker-agent] refusing next turn: ${message}`);
      this.emitDiagnostic({ kind: 'budget_exhausted', dimension: gateExhaustion.dimension, message });
      throw new BudgetExhaustedError(gateExhaustion.dimension, message);
    }
    const exhaustion = findCumulativeBudgetExhaustion(this.getBudgetStatus());
    if (exhaustion === undefined) return;
    const message = `${describeExhaustedSessionBudget(exhaustion)}; no further turns run in this session`;
    logger.warn(`[docker-agent] refusing next turn: ${message}`);
    this.emitDiagnostic({ kind: 'budget_exhausted', dimension: exhaustion.dimension, message });
    throw new BudgetExhaustedError(exhaustion.dimension, message);
  }

  /**
   * The cumulative cost reported to the session, applying the D6 order
   * (§10): OpenRouter's summed `usage.cost` from the token stream, preferred
   * ONLY when the active profile prefers proxy cost AND the sum is > 0
   * (Claude Code's `total_cost_usd` is wrong when routed to a non-Anthropic
   * model), else the CLI's self-reported `costUsd` when it is a valid amount
   * (finite, >= 0), else the previous report. Undefined until something
   * reported a cost.
   *
   * DISPLAY ONLY. The CLI self-report comes from the container's stdout,
   * which the agent controls; an invalid amount is ignored, and no report
   * ever feeds a budget decision (see `hostObservedCostUsd`).
   *
   * Both are cumulative session totals, so this returns the value to *assign*
   * (not add) to `reportedCostUsd`. This is only the fallback: the host
   * observes every exchange's tokens and prices them itself (`sessionCost`).
   */
  private resolveReportedCostUsd(cliCostUsd: number | undefined): number | undefined {
    const profile = this.config.activeProviderProfile;
    const preferProxyCost = profile && profile.type !== 'native' && getGatewayDefinition(profile.type).preferProxyCost;
    if (preferProxyCost && this.authoritativeCostUsd > 0) {
      return this.authoritativeCostUsd;
    }
    if (cliCostUsd !== undefined && Number.isFinite(cliCostUsd) && cliCostUsd >= 0) {
      return cliCostUsd;
    }
    return this.reportedCostUsd;
  }

  /**
   * Session cost as getBudgetStatus() reports it, and where it comes from:
   * 1. host-observed cost (gateway-reported or list-price per exchange) when
   *    every observed exchange carried one;
   * 2. else the reported cumulative cost (`resolveReportedCostUsd`): a
   *    complete report is never replaced by a known-partial sum;
   * 3. else the partial host sum, as a lower bound;
   * 4. else unknown (0, shown as "unknown").
   *
   * DISPLAY ONLY, like `resolveReportedCostUsd`: step 2 can be the agent's
   * own report. Budget decisions read `hostObservedCostUsd()`.
   */
  private sessionCost(): { readonly usd: number; readonly source: BudgetCostSource } {
    const observed = this.observedUsage.cumulativeSnapshot();
    if (observed.observedExchanges > 0 && observed.costedExchanges === observed.observedExchanges) {
      return { usd: observed.costUsd, source: 'observed' };
    }
    if (this.reportedCostUsd !== undefined) return { usd: this.reportedCostUsd, source: 'reported' };
    if (observed.costedExchanges > 0) return { usd: observed.costUsd, source: 'partial' };
    return { usd: 0, source: 'unknown' };
  }

  private emitDiagnostic(event: DiagnosticEvent): void {
    this.diagnosticLog.push(event);
    this.onDiagnostic?.(event);
  }

  /**
   * Reports host-mount findings (`host_privileged_files`), if any. Called
   * from a turn's `finally` block, which must still restore the session's
   * status and keep the turn's own outcome, and from close() after the
   * teardown: a transport that fails on the notice is logged, never thrown
   * into either. The findings are in the session log and diagnostic log
   * regardless.
   */
  private emitHostMountNotice(notice: HostPrivilegedFilesDiagnostic | undefined): void {
    if (notice === undefined) return;
    try {
      this.emitDiagnostic(notice);
    } catch (err) {
      logger.warn(
        `[docker-agent] could not hand host-mount findings to the transport: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Writes the user's message for the auto-approver, stamped with its source
   * and the time it was sent so the approver trusts it only while fresh
   * (see `isUserContextTrusted`). A missing file (a failed write) reads as
   * "no context" and every escalation then goes to a human.
   */
  private writeUserContext(userMessage: string): void {
    recordSessionUserContext(this.infra.escalationDir, userMessage);
  }

  /**
   * Clears the user context for a system-generated turn, fail-closed (see
   * `clearSessionUserContext`), so the previous human message cannot
   * authorize escalations the system prompt provokes.
   */
  private clearUserContext(): void {
    clearSessionUserContext(this.infra.escalationDir);
  }
}

/** User-facing text for a cumulative limit that refuses the next container turn. */
function describeExhaustedSessionBudget(exhaustion: CumulativeBudgetExhaustion): string {
  switch (exhaustion.dimension) {
    case 'tokens':
      return (
        `Token budget exhausted: ${exhaustion.used.toLocaleString()} / ` +
        `${exhaustion.limit.toLocaleString()} tokens observed at the proxy`
      );
    case 'steps':
      return `Step budget exhausted: ${exhaustion.used} / ${exhaustion.limit} agent turns`;
    case 'cost':
      return (
        `Cost budget exhausted: $${exhaustion.used.toFixed(2)} / $${exhaustion.limit.toFixed(2)} ` +
        'observed at the proxy'
      );
  }
}

/** Formats a command array for logging, truncating long arguments. */
function formatCommand(args: readonly string[]): string {
  const MAX_ARG_LEN = 80;
  return args
    .map((a) => {
      const display = a.length > MAX_ARG_LEN ? `${a.substring(0, MAX_ARG_LEN)}...` : a;
      return a.includes(' ') ? `"${display}"` : display;
    })
    .join(' ');
}
