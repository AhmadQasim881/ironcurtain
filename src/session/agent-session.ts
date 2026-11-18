/**
 * AgentSession -- concrete Session implementation.
 *
 * Not exported from the public API. Callers use the Session interface
 * via createSession() in index.ts.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEscalationWatcher } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import { clearSessionUserContext, recordSessionUserContext } from '../escalation/session-user-context.js';
import { SessionTaskSummary } from '../escalation/escalation-review.js';
import { EXECUTE_CODE_JUSTIFICATION_DESCRIPTION } from '../sandbox/chain-justifications.js';
import {
  generateText,
  stepCountIs,
  tool,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepResult,
  type SystemModelMessage,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { createLanguageModel, resolveHostModelId } from '../config/model-provider.js';
import type { LlmLogContext } from '../observability/llm-logger.js';
import { createSessionLlmLogMiddleware } from '../observability/session-llm-log.js';
import type { IronCurtainConfig } from '../config/types.js';
import * as logger from '../logger.js';
import type { Sandbox, SandboxInitOptions, UnavailableMcpServer } from '../sandbox/index.js';
import type { ServerSchemaDrift } from '../trusted-process/schema-drift.js';
import type { ToolCallCoordinator } from '../trusted-process/tool-call-coordinator.js';
import type { LogRedaction } from '../trusted-process/audit-redactor.js';
import { resolveLogRedaction } from '../trusted-process/audit-secrets.js';
import type { WorkflowCommitHandler } from '../trusted-process/workflow-commit-tool.js';
import { annotationDriftDiagnostics } from './annotation-drift-diagnostics.js';
import { BoundedLog, SESSION_DIAGNOSTIC_LOG_LIMIT, SESSION_TURN_HISTORY_LIMIT } from './bounded-log.js';
import type { HostModelNotice } from './host-model-roles.js';
import { hostModelDiagnostics, policyWarningDiagnostics, unavailableServerDiagnostics } from './startup-notices.js';
import {
  SessionNotReadyError,
  SessionClosedError,
  BudgetExhaustedError,
  EscalationExpiredError,
} from '../types/errors.js';
import { buildInterruptedTurnNote, describeTurnFailure, estimateNextInputTokens } from './conversation-history.js';
import { HISTORY_SYSTEM_PROMPT_SECTION, MessageCompactor } from './message-compactor.js';
import { ToolResultTrimmer } from './tool-result-trimmer.js';
import { createCacheStrategy, type PromptCacheStrategy } from './prompt-cache.js';
import { buildSystemPrompt } from './prompts.js';
import type { ServerListing } from '../types/server-listing.js';
import type { ProcessLockHandle } from '../docker-workload/process-lock.js';
import { errorMessage } from '../utils/error-message.js';
import { saveConversation, type StoredConversation } from './conversation-store.js';
import { ResourceBudgetTracker, resolveStepCap } from './resource-budget-tracker.js';
import { releaseSessionDirectory } from './session-lock.js';
import { StepLoopDetector } from './step-loop-detector.js';
import { truncateExecutionOutput, getResultSizeLimit, formatKB } from './truncate-result.js';
import {
  createAgentConversationId,
  type AgentConversationId,
  type Session,
  type SessionId,
  type SessionStatus,
  type SessionInfo,
  type SessionOptions,
  type ConversationTurn,
  type DiagnosticEvent,
  type EscalationRequest,
  type SandboxFactory,
  type BudgetStatus,
  type SendMessageOptions,
} from './types.js';

/**
 * How a turn ended once the agent loop returned: with the model's answer, or
 * with a budget stop that sendMessage reports as BudgetExhaustedError after
 * the turn has been recorded.
 */
type TurnOutcome = { readonly text: string } | { readonly error: BudgetExhaustedError };

/**
 * Abort reasons of a turn. Both are `AbortError` DOMExceptions so the AI SDK
 * and fetch treat them as ordinary aborts; their text reaches the
 * `execute_code` script (and the audit entries of the tool calls it had in
 * flight) as the reason it was cancelled.
 */
function wallClockAbortReason(): DOMException {
  return new DOMException('the turn exceeded its wall-clock time budget', 'AbortError');
}

function sessionClosedAbortReason(): DOMException {
  return new DOMException('Session has been closed', 'AbortError');
}

/**
 * State the session factory hands to a new AgentSession. Not part of the
 * public SessionOptions: only createBuiltinSession() produces it.
 */
export interface AgentSessionRuntime {
  /**
   * The conversation saved by an earlier run of this session
   * (`--resume`). The session continues from it.
   */
  readonly restoredConversation?: StoredConversation;
  /**
   * The claim on the session directory (see session-lock.ts). The session
   * owns it from construction and releases it in close().
   */
  readonly sessionLock?: ProcessLockHandle;
  /**
   * The session's claim on the logger (see logger.ts). The session binds
   * its own work to it, so its lines go to its own log while other
   * sessions or the daemon log too, and releases it in close().
   */
  readonly logClaim?: logger.LoggerClaim;
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

/**
 * What the steps of the current turn have committed so far. A failed turn
 * keeps these instead of erasing them (see restoreHistoryAfterFailedTurn).
 */
interface TurnProgress {
  /**
   * Latest `response.messages` snapshot from onStepFinish. The SDK passes
   * the cumulative messages of the whole generateText call, cloned per
   * step and taken after the step's tool results, so each snapshot holds
   * complete tool-call/tool-result pairs and replaces the previous one.
   */
  committedMessages: ModelMessage[];
  completedSteps: number;
  /**
   * Estimated input tokens of the request after the last finished step
   * (its input and output plus the tool results it appended; see
   * estimateNextInputTokens), once a step has finished. Drives trimming
   * within the turn and the compaction threshold for the next turn.
   */
  nextInputTokens: number | undefined;
}

/** Default sandbox factory: creates a real UTCP Code Mode sandbox. */
async function defaultSandboxFactory(config: IronCurtainConfig, options?: SandboxInitOptions): Promise<Sandbox> {
  const { Sandbox: SandboxClass } = await import('../sandbox/index.js');
  const instance = new SandboxClass();
  await instance.initialize(config, options);
  return instance;
}

/**
 * The live-schema drift the sandbox's coordinator found while registering
 * tools. Test doubles built from a partial `Sandbox` shape have no
 * coordinator accessor and report none.
 */
function sandboxSchemaDrift(sandbox: Sandbox): readonly ServerSchemaDrift[] {
  const accessor = (sandbox as { getCoordinator?: () => ToolCallCoordinator | null }).getCoordinator;
  const coordinator = typeof accessor === 'function' ? accessor.call(sandbox) : null;
  return coordinator ? [...coordinator.getSchemaDrift().values()] : [];
}

/**
 * The MCP servers the sandbox could not start. Test doubles built from a
 * partial `Sandbox` shape have no accessor and report none.
 */
function sandboxUnavailableServers(sandbox: Sandbox): readonly UnavailableMcpServer[] {
  const accessor = (sandbox as { getUnavailableServers?: () => readonly UnavailableMcpServer[] }).getUnavailableServers;
  return typeof accessor === 'function' ? accessor.call(sandbox) : [];
}

export class AgentSession implements Session {
  private readonly sessionId: SessionId;
  private status: SessionStatus = 'initializing';
  private readonly config: IronCurtainConfig;
  private sandbox: Sandbox | null = null;
  private readonly createdAt: string;
  private readonly sandboxFactory: SandboxFactory;
  private readonly escalationDir: string;
  private readonly sessionDir: string;

  /**
   * Raw AI SDK message history. Saved to `<sessionDir>/messages.jsonl`
   * after every recorded user turn (one a budget stopped included) and
   * after a failed one that kept finished steps, and restored from it on
   * resume.
   */
  private messages: ModelMessage[] = [];

  /** Claim on the session directory, released by close(). */
  private sessionLock: ProcessLockHandle | undefined;

  /** Claim on the logger, released by close(); undefined when none was handed over. */
  private readonly logClaim: logger.LoggerClaim | undefined;

  /** Host-model notices reported once the session initializes. */
  private readonly hostModelNotices: readonly HostModelNotice[];

  /** Stale-policy warnings reported once the session initializes. */
  private readonly policyWarnings: readonly string[];

  /**
   * Structured turn log exposed through getHistory(): the newest turns,
   * while `total` counts all of them (turn numbers, turnCount).
   */
  private readonly turns = new BoundedLog<ConversationTurn>(SESSION_TURN_HISTORY_LIMIT);

  /** The newest diagnostic events, exposed through getDiagnosticLog(). */
  private readonly diagnosticLog = new BoundedLog<DiagnosticEvent>(SESSION_DIAGNOSTIC_LOG_LIMIT);

  /** System prompt, built once after sandbox initialization. */
  private systemPrompt: string | SystemModelMessage = '';

  /** The tool set, built once after sandbox initialization. */
  private tools: ToolSet = {};

  /** Language model, optionally wrapped with logging middleware. */
  private model: LanguageModel | null = null;

  /** Shared escalation watcher (replaces inline polling). */
  private escalationWatcher: EscalationWatcher | null = null;

  /** Step-level loop detector for the agent. Reset at the start of every turn. */
  private loopDetector = new StepLoopDetector();

  /** Resource budget tracker for token, step, time, and cost limits. */
  private readonly budgetTracker: ResourceBudgetTracker;

  /**
   * Per-turn step cap for the agent loop: resourceBudget.maxSteps, or the
   * tracker's safety cap when the step budget is disabled.
   */
  private readonly stepCap: number;

  /** Pricing warnings already surfaced (each once per session; see surfacePricingNotice). */
  private readonly surfacedPricingWarnings = new Set<string>();

  /** Message compactor for auto-summarizing older messages. */
  private readonly compactor: MessageCompactor;

  /** Trims older execute_code results when a turn nears the compaction threshold. */
  private readonly toolResultTrimmer = new ToolResultTrimmer();

  /** Provider-specific prompt caching strategy. */
  private readonly cacheStrategy: PromptCacheStrategy;

  /** Last step's input token count, used by the compactor to detect threshold. */
  private lastStepInputTokens = 0;

  /** Transcript redaction (see getLogRedaction); undefined until first asked. */
  private logRedaction: LogRedaction | null | undefined;

  /**
   * The turn in flight. Its signal reaches every model call (the
   * auto-compaction summary included) and every `execute_code` script of
   * the turn; the wall-clock budget and `close()` abort it. Null between
   * turns.
   */
  private turnAbort: AbortController | null = null;

  /** The task this session was started with, attached to every escalation it surfaces. */
  private readonly taskSummary = new SessionTaskSummary();

  /** Callbacks from SessionOptions. */
  private readonly onEscalation?: (request: EscalationRequest) => void;
  private readonly onEscalationExpired?: (escalationId: string) => void;
  private readonly onEscalationResolved?: (escalationId: string, decision: 'approved' | 'denied') => void;
  private readonly onDiagnostic?: (event: DiagnosticEvent) => void;

  /** Additional content appended to the system prompt (e.g., cron task context). */
  private readonly systemPromptAugmentation?: string;
  /**
   * Target of the coordinator-owned `workflow_commit` tool, for a workflow
   * agent state (see `WorkflowBorrowOptions.workflowCommit`). Handed to the
   * sandbox, whose coordinator then offers the tool.
   */
  private readonly workflowCommit?: WorkflowCommitHandler;

  /**
   * Requested model ID, including the session override. SDK creation resolves
   * this fresh request through its host profile; budgeting uses the effective
   * selection without feeding it back through the model map.
   */
  private readonly agentModelId: string;

  constructor(
    config: IronCurtainConfig,
    sessionId: SessionId,
    escalationDir: string,
    sessionDir: string,
    options: SessionOptions = {},
    runtime: AgentSessionRuntime = {},
  ) {
    this.sessionId = sessionId;
    this.config = config;
    this.escalationDir = escalationDir;
    this.sessionDir = sessionDir;
    this.sessionLock = runtime.sessionLock;
    this.logClaim = runtime.logClaim;
    this.hostModelNotices = runtime.hostModelNotices ?? [];
    this.policyWarnings = runtime.policyWarnings ?? [];
    this.sandboxFactory = options.sandboxFactory ?? defaultSandboxFactory;
    this.onEscalation = options.onEscalation;
    this.onEscalationExpired = options.onEscalationExpired;
    this.onEscalationResolved = options.onEscalationResolved;
    this.onDiagnostic = options.onDiagnostic;
    this.systemPromptAugmentation = options.systemPromptAugmentation;
    this.workflowCommit = options.workflow?.workflowCommit;
    this.agentModelId = options.agentModelOverride ?? config.agentModelId;
    this.createdAt = new Date().toISOString();
    const budgetModelId = resolveHostModelId(this.agentModelId, config.userConfig, 'agent');
    this.budgetTracker = new ResourceBudgetTracker(config.userConfig.resourceBudget, budgetModelId, {
      pricingOverrides: config.userConfig.modelPricingOverrides,
    });
    this.stepCap = resolveStepCap(config.userConfig.resourceBudget);
    this.compactor = new MessageCompactor(config.userConfig.autoCompact);
    this.cacheStrategy = createCacheStrategy(this.agentModelId);

    const restored = runtime.restoredConversation;
    if (restored) {
      this.messages = [...restored.messages];
      this.lastStepInputTokens = restored.lastInputTokens;
      this.compactor.recordInputTokens(restored.lastInputTokens);
      this.restoreCompactionSummary(restored);
    }
  }

  /**
   * Initialize the session's sandbox and build the tool set.
   * Called by the factory function, not by external callers.
   */
  initialize(): Promise<void> {
    // The sandbox's relays, the coordinator and the escalation watcher are
    // created bound to the session's logger claim, so what they log later
    // lands in this session's log too.
    return logger.runWithClaim(this.logClaim, () => this.initializeSession());
  }

  private async initializeSession(): Promise<void> {
    this.sandbox = this.workflowCommit
      ? await this.sandboxFactory(this.config, { workflowCommit: this.workflowCommit })
      : await this.sandboxFactory(this.config);
    // Start-up notices: a stale compiled policy and host-model features
    // running differently (both already logged by buildSessionConfig), MCP
    // servers the sandbox could not start and annotation drift found while it
    // registered their tools (both already in the session log). The
    // diagnostics let the transport show them in its own UI.
    for (const event of policyWarningDiagnostics(this.policyWarnings)) {
      this.emitDiagnostic(event);
    }
    for (const event of hostModelDiagnostics(this.hostModelNotices)) {
      this.emitDiagnostic(event);
    }
    for (const event of unavailableServerDiagnostics(sandboxUnavailableServers(this.sandbox))) {
      this.emitDiagnostic(event);
    }
    for (const event of annotationDriftDiagnostics(sandboxSchemaDrift(this.sandbox))) {
      this.emitDiagnostic(event);
    }
    const helpData = this.sandbox.getHelpData();
    const serverListings: ServerListing[] = Object.entries(helpData.serverDescriptions).map(([name, description]) => ({
      name,
      description,
    }));
    let rawPrompt = buildSystemPrompt(serverListings, this.config.allowedDirectory);
    rawPrompt += '\n\n' + HISTORY_SYSTEM_PROMPT_SECTION;
    if (this.systemPromptAugmentation) {
      rawPrompt += '\n\n' + this.systemPromptAugmentation;
    }
    writeFileSync(resolve(this.sessionDir, 'system-prompt.txt'), rawPrompt);
    this.systemPrompt = this.cacheStrategy.wrapSystemPrompt(rawPrompt);
    this.tools = this.cacheStrategy.wrapTools(this.buildTools());
    this.model = await this.buildModel();
    this.startEscalationWatcher();
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

  rotateAgentConversationId(): AgentConversationId {
    if (this.status === 'closed') throw new SessionClosedError();
    if (this.status !== 'ready') throw new SessionNotReadyError(this.status);
    this.messages.length = 0;
    this.loopDetector.reset();
    this.lastStepInputTokens = 0;
    this.compactor.reset();
    this.toolResultTrimmer.reset();
    return createAgentConversationId();
  }

  sendMessage(userMessage: string, options?: SendMessageOptions): Promise<string> {
    // The turn (model calls, execute_code scripts and the coordinator's
    // policy decisions for their tool calls) logs to this session's log,
    // whichever transport or daemon context sent the message.
    return logger.runWithClaim(this.logClaim, () => this.runTurn(userMessage, options));
  }

  private async runTurn(userMessage: string, options: SendMessageOptions | undefined): Promise<string> {
    if (this.status === 'closed') throw new SessionClosedError();
    if (this.status !== 'ready') throw new SessionNotReadyError(this.status);

    // Loop detection covers one turn. A block, and the streaks and outcome
    // hashes behind it, must not outlive the turn that caused it: otherwise
    // every later request in this session, however different, would be
    // refused with "LOOP DETECTED".
    this.loopDetector.reset();
    this.budgetTracker.startTurn();
    this.status = 'processing';
    const turnStart = new Date().toISOString();
    // A failed turn truncates the history back to this message object (found
    // by identity, so the position stays right after compaction rewrote the
    // array) and keeps whatever its finished steps committed.
    const turnMessage: ModelMessage = { role: 'user', content: userMessage };
    const progress: TurnProgress = { committedMessages: [], completedSteps: 0, nextInputTokens: undefined };
    /** Set from onStepFinish: whether the last finished step called tools (the model had not answered yet). */
    const loop = { lastStepCalledTools: false };

    // One abort signal per turn: the wall-clock budget (when enabled) and
    // close() fire it. It cancels the model call and the execute_code script
    // in flight, and a stop condition ends the agent loop after the step that
    // saw it, so no further model call is made.
    const turnAbort = new AbortController();
    this.turnAbort = turnAbort;
    const remainingMs = this.budgetTracker.getRemainingWallClockMs();
    const abortTimeout =
      remainingMs !== null ? setTimeout(() => turnAbort.abort(wallClockAbortReason()), remainingMs) : null;

    let outcome: TurnOutcome;
    try {
      this.surfacePricingWarning();
      this.messages.push(turnMessage);

      // Write user context for the auto-approver in the proxy process.
      // The file is overwritten each turn. The proxy reads it only on
      // escalation. A system-generated turn (the memory auto-save prompt,
      // which replays the agent's own replies) clears it instead, so an
      // escalation during that turn always reaches a human.
      if (options?.origin === 'system') {
        this.clearUserContext();
      } else {
        this.writeUserContext(userMessage);
      }
      this.taskSummary.recordMessage(userMessage, options?.origin);

      // Auto-compact older messages if the previous turn exceeded the threshold.
      // A summarizer failure is reported and the turn continues uncompacted.
      // The summarization call is a model call of this turn too: close() and
      // the wall clock cancel it.
      await this.compactHistoryIfNeeded(turnAbort.signal);

      if (!this.model) throw new SessionNotReadyError(this.status);
      // A turn aborted while it compacted (close(), wall clock) makes no
      // model call at all, and neither does one whose budget the
      // compaction's own model call used up.
      turnAbort.signal.throwIfAborted();
      this.throwIfBudgetExhaustedBeforeFirstStep();

      const result = await generateText({
        model: this.model,
        system: this.systemPrompt,
        messages: this.cacheStrategy.applyHistoryBreakpoint(this.messages),
        tools: this.tools,
        // The budget stop condition only reads the tracker; the step cap
        // follows resourceBudget.maxSteps (safety cap when it is disabled).
        // The abort condition ends the loop after a step that ran while the
        // turn was aborted, whether or not the provider honours the signal.
        stopWhen: [stepCountIs(this.stepCap), this.budgetTracker.createStopCondition(), () => turnAbort.signal.aborted],
        abortSignal: turnAbort.signal,
        prepareStep: ({ messages }) => this.prepareStepMessages(progress, messages),
        onStepFinish: (stepResult) => {
          // Record every step here, including the final text step: the SDK
          // runs this before evaluating stop conditions, and evaluates stop
          // conditions only after steps that called tools.
          this.budgetTracker.recordStep(stepResult.usage);
          loop.lastStepCalledTools = stepResult.toolCalls.length > 0;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- usage may be undefined at runtime (TS 5.9 type inference vs ESLint disagree)
          this.lastStepInputTokens = stepResult.usage?.inputTokens ?? 0;
          progress.completedSteps++;
          progress.nextInputTokens = estimateNextInputTokens(stepResult);
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- response may be absent at runtime (test doubles pass partial step results)
          const snapshot = stepResult.response?.messages;
          if (Array.isArray(snapshot)) progress.committedMessages = snapshot;
          this.emitToolCallDiagnostics(stepResult.toolCalls);
          this.emitTextDiagnostic(stepResult.text);
          this.emitBudgetWarnings();
        },
      });

      // close() during the turn: the caller learns the session is gone,
      // whatever the loop returned.
      if (this.isClosed()) throw new SessionClosedError();

      // Keep the turn's steps in the history even when a budget stopped it:
      // their tool calls have already run.
      this.messages.push(...result.response.messages);
      this.applyTrimmedResultsToHistory();

      // Record the history's size for the compactor's next-turn threshold
      // check. After a budget stop the last step's tool results are part of
      // the history but of no reported input, hence the estimate.
      this.compactor.recordInputTokens(progress.nextInputTokens ?? this.lastStepInputTokens);

      // A last step that still called tools means a stop condition (budget
      // or step cap) ended the loop before the model answered; result.text
      // would only be that step's fragment, so the turn reports an explicit
      // stop instead.
      const earlyStop = loop.lastStepCalledTools ? this.describeEarlyStop() : null;
      const responseText = earlyStop ? earlyStop.message : result.text;

      const turn = this.recordTurn(userMessage, responseText, result.totalUsage, turnStart);
      this.turns.push(turn);

      if (earlyStop) this.emitBudgetExhaustedDiagnostic(earlyStop.dimension, earlyStop.message);

      // Only the user's conversation is saved for --resume. A system turn
      // (the memory auto-save prompt as the session ends, or a workflow
      // state's prompt) is not part of it, so a resumed session continues
      // from the last user turn. A turn a budget or the step cap stopped is
      // saved like any other recorded turn: its steps stay in the history
      // above because their tool calls have already run.
      if (options?.origin !== 'system') this.saveConversation();

      this.markReady();
      outcome = earlyStop?.exhausted
        ? { error: new BudgetExhaustedError(earlyStop.dimension, earlyStop.message) }
        : { text: responseText };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const keptSteps = this.restoreHistoryAfterFailedTurn(turnMessage, progress, error, aborted);
      // A failed user turn that kept finished steps is saved like a budget
      // stop: their tool calls have already run, so a resumed session must
      // see them (and the note) rather than repeat them. A turn rolled back
      // to before it is not saved; the last save still holds every user turn
      // that ran. (A closed session saves nothing: see saveConversation.)
      if (keptSteps && options?.origin !== 'system') this.saveConversation();
      // A closed session stays closed: close() aborted this turn.
      if (this.isClosed()) throw new SessionClosedError();
      this.markReady();

      // Detect AbortError from wall-clock timeout
      if (aborted) {
        const exhausted = this.budgetTracker.isExhausted();
        const dimension = exhausted?.dimension ?? 'wall_clock';
        const message = exhausted?.message ?? 'Session aborted: wall-clock time budget exceeded';
        this.emitBudgetExhaustedDiagnostic(dimension, message);
        throw new BudgetExhaustedError(dimension, message);
      }

      throw error;
    } finally {
      if (abortTimeout !== null) clearTimeout(abortTimeout);
      if (this.turnAbort === turnAbort) this.turnAbort = null;
      this.budgetTracker.endTurn();
    }

    // Every budget dimension ends a turn the same way: BudgetExhaustedError,
    // as the wall-clock abort above does when it interrupts a model call.
    if ('error' in outcome) throw outcome.error;
    return outcome.text;
  }

  getHistory(): readonly ConversationTurn[] {
    return this.turns.items;
  }

  getDiagnosticLog(): readonly DiagnosticEvent[] {
    return this.diagnosticLog.items;
  }

  getPendingEscalations(): readonly EscalationRequest[] {
    return (this.escalationWatcher?.getPending() ?? []).map((pending) => this.taskSummary.attach(pending));
  }

  getBudgetStatus(): BudgetStatus {
    return {
      ...this.budgetTracker.getSnapshot(),
      limits: this.config.userConfig.resourceBudget,
      tokenTrackingAvailable: true,
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
    return logger.runWithClaim(this.logClaim, () => this.closeSession());
  }

  private async closeSession(): Promise<void> {
    if (this.status === 'closed') return;
    this.status = 'closed';
    // End the turn in flight: it makes no further model call, its
    // execute_code script is cancelled (pending escalations withdrawn,
    // nothing more dispatched), and its sendMessage rejects with
    // SessionClosedError instead of reporting the session ready again.
    this.turnAbort?.abort(sessionClosedAbortReason());
    this.stopEscalationWatcher();
    try {
      if (this.sandbox) {
        await this.sandbox.shutdown();
        this.sandbox = null;
      }
    } finally {
      // Hand the session directory back only once nothing of this session
      // runs any more, so a --resume never overlaps the MCP servers.
      if (this.sessionLock) {
        releaseSessionDirectory(this.sessionLock);
        this.sessionLock = undefined;
      }
      // Give back this session's logger claim only (even when the sandbox
      // failed to shut down): the daemon's log and other sessions' logs
      // carry on (see `src/logger.ts`).
      logger.release(this.logClaim);
    }
  }

  // --- Private helpers ---

  /** True once close() ran (a separate read, so TS does not narrow it away mid-turn). */
  private isClosed(): boolean {
    return this.status === 'closed';
  }

  /** Back to 'ready' after a turn -- unless close() ran meanwhile: closed is final. */
  private markReady(): void {
    if (!this.isClosed()) this.status = 'ready';
  }

  private buildTools(): ToolSet {
    return {
      execute_code: tool({
        description:
          'Execute TypeScript code in a secure sandbox with access to MCP tool servers. ' +
          "Call help.help() to list servers, help.help('serverName') to discover tools. " +
          'Tools are synchronous — no await needed. Use return to provide results. ' +
          "Call __getToolInterface('tool.name') to inspect a tool's full type signature.",
        inputSchema: z.object({
          code: z.string().describe('TypeScript code to execute in the sandbox'),
          justification: z.string().optional().describe(EXECUTE_CODE_JUSTIFICATION_DESCRIPTION),
        }),
        execute: async ({ code, justification }, { abortSignal }) => {
          if (!this.sandbox) throw new Error('Sandbox not initialized');

          const budgetBlock = this.budgetTracker.isExhausted();
          if (budgetBlock) {
            return { error: budgetBlock.message };
          }

          const blockCheck = this.loopDetector.isBlocked();
          if (blockCheck) {
            return { error: blockCheck.message };
          }

          try {
            // The turn's signal cancels the script (close(), wall clock), and
            // the script never outlives the turn's remaining wall clock. The
            // justification is the agent's own text: shown, labelled as the
            // agent's, to a human reviewing an escalated call; never an input
            // to any decision.
            const remainingMs = this.budgetTracker.getRemainingWallClockMs();
            const { result, logs } = await this.sandbox.executeCode(code, {
              ...(abortSignal === undefined ? {} : { signal: abortSignal }),
              ...(remainingMs === null ? {} : { timeoutMs: remainingMs }),
              ...(justification === undefined ? {} : { justification }),
            });

            // The console and the result share one size budget, applied
            // before loop detection hashes the output (a full copy of it).
            const truncation = truncateExecutionOutput(logs, result, getResultSizeLimit());
            const output: Record<string, unknown> = {};
            if (truncation.console.length > 0) output.console = truncation.console;
            output.result = truncation.result;
            if (truncation.truncated) {
              output.warning = `Tool result truncated from ${formatKB(truncation.originalSize)} to ${formatKB(truncation.finalSize)} (console output and return value share one limit). Use targeted reads (head/tail parameters) for specific portions, and log less.`;
              logger.warn(
                `[truncation] Result truncated: ${formatKB(truncation.originalSize)} -> ${formatKB(truncation.finalSize)}`,
              );
              this.emitTruncationDiagnostic(truncation.originalSize, truncation.finalSize);
            }

            return this.applyLoopVerdict(code, output);
          } catch (err) {
            const output: Record<string, unknown> = {
              error: err instanceof Error ? err.message : String(err),
            };
            return this.applyLoopVerdict(code, output);
          }
        },
      }),
    };
  }

  private async buildModel(): Promise<LanguageModel> {
    const baseModel = await createLanguageModel(this.agentModelId, this.config.userConfig, 'agent');
    if (!this.config.llmLogPath) return baseModel;

    // observability.llmInteractionLog decides what is logged ('off' installs
    // nothing). The log is appended to, so a resumed session extends it.
    const logContext: LlmLogContext = { stepName: 'agent' };
    const middleware = createSessionLlmLogMiddleware(this.config.llmLogPath, logContext, this.config.userConfig, {
      deltaLogging: true,
    });
    return middleware ? wrapLanguageModel({ model: baseModel, middleware }) : baseModel;
  }

  /**
   * Saves the model-visible history (compaction summary included) for
   * `--resume`. Best effort: the turn has already happened, so a failed
   * write is logged rather than failing it. A later resume then restores
   * the last history that was saved.
   */
  private saveConversation(): void {
    // close() has handed the session directory back (released the session
    // lock): a turn that finishes after it must not write there any more,
    // since another process may have resumed the session meanwhile.
    if (this.status === 'closed') return;
    try {
      // The compactor's trigger rather than the last step's reported input:
      // it also counts the tool results the last step appended
      // (estimateNextInputTokens), so a resumed session compacts, and trims
      // before its first step, exactly when this one would. The record of
      // the compaction summary the history starts with, when the compactor
      // wrote it, lets a resumed session carry that summary forward the same
      // way this one would (restoreCompactionSummary).
      const summary = this.compactor.summaryStateFor(this.messages);
      saveConversation(this.sessionDir, {
        messages: this.messages,
        lastInputTokens: this.compactor.recordedInputTokens,
        ...(summary === undefined ? {} : { summary }),
      });
    } catch (error) {
      logger.warn(`[session] Could not save the conversation for resume: ${errorMessage(error)}`);
    }
  }

  /**
   * Hands the compactor the record saved with the compaction summary the
   * restored history starts with, so the next compaction carries that
   * summary forward as its own: the user's earlier messages it holds stay
   * verbatim instead of being summarized again as notes. A record that does
   * not rebuild the summary exactly is not used (the compactor then treats
   * the summary as one it did not write).
   */
  private restoreCompactionSummary(restored: StoredConversation): void {
    const first = this.messages.at(0);
    if (restored.summary === undefined || first === undefined) return;
    if (!this.compactor.restoreSummary(first, restored.summary)) {
      logger.warn(
        '[compaction] The saved summary record does not match the summary the restored conversation starts with; ' +
          'the next compaction summarizes that summary again as earlier notes',
      );
    }
  }

  /**
   * Compacts older messages when the previous turn passed the threshold.
   * Never fails the turn: a summarizer failure leaves the history as it
   * was, is reported as a diagnostic, and the compactor backs off.
   */
  private async compactHistoryIfNeeded(abortSignal: AbortSignal | undefined): Promise<void> {
    const outcome = await this.compactor.compactIfNeeded(this.messages, this.config.userConfig, abortSignal);
    if (outcome === null) return;
    // The summarizer's call is a model call of this turn, paid for whether or
    // not it produced a usable summary.
    if (outcome.usage !== undefined) this.recordSummarizerUsage(outcome.usage);
    if (!outcome.compacted) {
      this.emitDiagnostic({
        kind: 'message_compaction_failed',
        reason: outcome.reason,
        retryAfterTurns: outcome.retryAfterTurns,
      });
      return;
    }
    this.toolResultTrimmer.retainOnly(this.messages);
    this.emitDiagnostic({
      kind: 'message_compaction',
      originalMessageCount: outcome.originalMessageCount,
      newMessageCount: outcome.newMessageCount,
      summaryPreview: outcome.summaryPreview,
    });
  }

  /**
   * Charges the summarizer's tokens and cost to the turn's budget and the
   * session totals (not as a step), priced for the summary model. They
   * count toward the per-turn limits like a step's: a limit they use up
   * ends the turn before its first agent step
   * (throwIfBudgetExhaustedBeforeFirstStep), the stop condition and the
   * execute_code pre-check see them, and a warning threshold they cross is
   * reported now.
   */
  private recordSummarizerUsage(usage: LanguageModelUsage): void {
    const modelId = this.summaryBudgetModelId();
    this.budgetTracker.recordAuxiliaryUsage(usage, modelId);
    this.surfacePricingWarning(modelId);
    this.emitBudgetWarnings();
  }

  /**
   * Ends the turn before its first agent step when a budget dimension is
   * already used up: in practice by the auto-compaction summary's model
   * call, which counts toward the turn (recordSummarizerUsage), or by the
   * time it took. After a step, the stop condition ends the loop before the
   * next model call once a limit is used up; the AI SDK evaluates stop
   * conditions only after a step, so without this check the turn would
   * still make its first agent call (and return normally when that call
   * answered in text). No step has finished, so the turn is rolled back like
   * any turn that fails before its first step (restoreHistoryAfterFailedTurn);
   * the compaction stays.
   */
  private throwIfBudgetExhaustedBeforeFirstStep(): void {
    const verdict = this.budgetTracker.isExhausted();
    if (verdict === null) return;
    const message = `${verdict.message}. Stopped before the agent's first step.`;
    this.emitBudgetExhaustedDiagnostic(verdict.dimension, message);
    throw new BudgetExhaustedError(verdict.dimension, message);
  }

  /**
   * The summary model's identity for host accounting: the model its host
   * profile routes the request to, as for the agent model (see
   * agentModelId). Falls back to the configured ID when that cannot be
   * resolved; the summary model cannot be created then either, so no
   * usage is priced with it.
   */
  private summaryBudgetModelId(): string {
    const { userConfig } = this.config;
    const requested = userConfig.autoCompact.summaryModelId;
    try {
      return resolveHostModelId(requested, userConfig, 'summary');
    } catch {
      return requested;
    }
  }

  /**
   * prepareStep hook: the prompt of the step about to run, with older tool
   * results trimmed when the context nears the compaction threshold (see
   * trimOlderToolResults) and a cache breakpoint on its last message, the
   * newest tool result (prompt-cache.ts). Each step moves that breakpoint,
   * so the next step of the turn reads everything before its own new
   * messages from the cache rather than paying for the turn's growing tail
   * again; the history breakpoint before the user message stays for the
   * next turn.
   */
  private prepareStepMessages(progress: TurnProgress, messages: ModelMessage[]): PrepareStepResult<ToolSet> {
    const stepMessages = this.trimOlderToolResults(progress, messages) ?? messages;
    return { messages: this.cacheStrategy.applyStepBreakpoint(stepMessages) };
  }

  /**
   * Compaction only runs between turns, so within a turn the context is
   * kept in bounds here: once the step about to run is estimated to read
   * close to the compaction threshold (the last step's input plus what it
   * appended, or, for a turn's first step, the size recorded after the
   * previous turn when compaction failed or had nothing to split), older
   * large execute_code results are replaced by short stubs. Trimmed results
   * stay trimmed for every later step and in the stored history. Returns
   * the trimmed prompt, or undefined when nothing is trimmed. Any error
   * leaves the step untouched.
   */
  private trimOlderToolResults(progress: TurnProgress, messages: ModelMessage[]): ModelMessage[] | undefined {
    try {
      const inputTokens = progress.nextInputTokens ?? this.compactor.recordedInputTokens;
      if (this.compactor.isNearThreshold(inputTokens)) {
        const marked = this.toolResultTrimmer.markOlderResults(messages);
        if (marked > 0) {
          logger.info(`[compaction] Trimmed ${marked} older tool result(s) to stay within the context limit`);
        }
      }
      if (this.toolResultTrimmer.trimmedCount === 0) return undefined;
      return this.toolResultTrimmer.apply(messages);
    } catch (error) {
      logger.warn(
        `[compaction] Could not trim older tool results: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** Stores trimmed tool results in their trimmed form, as the model last saw them. */
  private applyTrimmedResultsToHistory(): void {
    if (this.toolResultTrimmer.trimmedCount > 0) {
      this.messages = this.toolResultTrimmer.apply(this.messages);
    }
  }

  /**
   * Repairs the history after a turn failed (model or network error, budget
   * abort). The history is truncated back to the turn's user message, found
   * by identity: compaction may have rewritten the array, and truncating can
   * never grow it (assigning a saved length could, leaving holes). The
   * compacted prefix stays.
   *
   * When no step finished, the failed message goes too and the history is
   * as it was before the turn. Otherwise the steps that finished are kept,
   * since their code may already have written files or sent messages, and
   * a note records that the turn stopped early and that the step in
   * progress has an unknown outcome. The compactor then learns the size the
   * history reached after the last finished step, so an oversized history
   * still compacts. Results trimmed during the turn stay trimmed.
   *
   * Runs inside sendMessage's catch block, so it never throws: if keeping
   * the steps fails, the history stays truncated to before the turn.
   *
   * Returns true when finished steps were kept, i.e. the history now holds
   * tool calls that ran in this turn.
   */
  private restoreHistoryAfterFailedTurn(
    turnMessage: ModelMessage,
    progress: TurnProgress,
    error: unknown,
    aborted: boolean,
  ): boolean {
    const start = this.messages.lastIndexOf(turnMessage);
    if (start === -1) return false;
    this.messages.splice(start);
    if (progress.committedMessages.length === 0) return false;

    try {
      const budgetDimension = aborted ? (this.budgetTracker.isExhausted()?.dimension ?? 'wall_clock') : undefined;
      this.messages.push(
        turnMessage,
        ...progress.committedMessages,
        buildInterruptedTurnNote(describeTurnFailure(error, budgetDimension), progress.completedSteps),
      );
      // Over the whole history: the trimmer detects shared tool call ids
      // only among the results it is shown.
      this.applyTrimmedResultsToHistory();
      if (progress.nextInputTokens !== undefined) {
        this.compactor.recordInputTokens(progress.nextInputTokens);
      }
      return true;
    } catch (restoreError) {
      this.messages.splice(start);
      logger.warn(
        `[session] Could not keep the finished steps of a failed turn: ${
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        }`,
      );
      return false;
    }
  }

  /** Logs a diagnostic event and forwards it to the transport callback. */
  private emitDiagnostic(event: DiagnosticEvent): void {
    this.diagnosticLog.push(event);
    this.onDiagnostic?.(event);
  }

  private emitToolCallDiagnostics(toolCalls: readonly { toolName: string; input?: unknown }[]): void {
    for (const tc of toolCalls) {
      if (tc.toolName === 'execute_code' && tc.input != null) {
        const input = tc.input as { code: string };
        const preview = input.code.substring(0, 120).replace(/\n/g, '\\n');
        this.emitDiagnostic({
          kind: 'tool_call',
          toolName: tc.toolName,
          preview: `${preview}${input.code.length > 120 ? '...' : ''}`,
        });
      }
    }
  }

  /** Analyze a step for loop detection and attach a warning if needed. */
  private applyLoopVerdict(code: string, output: Record<string, unknown>): Record<string, unknown> {
    const verdict = this.loopDetector.analyzeStep(code, output);
    if (verdict.action === 'warn' || verdict.action === 'block') {
      const existing = typeof output.warning === 'string' ? output.warning : '';
      output.warning = existing ? `${existing} | ${verdict.message}` : verdict.message;
      this.emitLoopDetectionDiagnostic(verdict.action, verdict.category, verdict.message);
    }
    return output;
  }

  private emitTruncationDiagnostic(originalSize: number, finalSize: number): void {
    this.emitDiagnostic({
      kind: 'result_truncation',
      originalKB: +(originalSize / 1024).toFixed(1),
      finalKB: +(finalSize / 1024).toFixed(1),
    });
  }

  private emitLoopDetectionDiagnostic(action: 'warn' | 'block', category: string, message: string): void {
    this.emitDiagnostic({ kind: 'loop_detection', action, category, message });
  }

  private emitBudgetWarnings(): void {
    // How the step just recorded was priced (a long prompt charged the
    // long-context multiplier), once per model.
    for (const notice of this.budgetTracker.takePricingNotices()) this.surfacePricingNotice(notice);
    for (const warning of this.budgetTracker.getActiveWarnings()) {
      this.emitDiagnostic({
        kind: 'budget_warning',
        dimension: warning.dimension,
        percentUsed: warning.percentUsed,
        message: warning.message,
      });
    }
  }

  private emitBudgetExhaustedDiagnostic(dimension: string, message: string): void {
    this.emitDiagnostic({ kind: 'budget_exhausted', dimension, message });
  }

  /**
   * Explains a loop that stopped while the model was still calling tools:
   * `exhausted` when a budget dimension stopped it, otherwise the step cap
   * (without a budget hit that is the safety cap, used when
   * resourceBudget.maxSteps is disabled). Null when neither applies, i.e.
   * the loop ended for another reason and the model's text stands.
   */
  private describeEarlyStop(): {
    readonly dimension: string;
    readonly message: string;
    readonly exhausted: boolean;
  } | null {
    const steps = this.budgetTracker.getSnapshot().stepCount;
    const stopped = `Stopped after ${steps} step${steps === 1 ? '' : 's'} without a final answer`;
    const verdict = this.budgetTracker.isExhausted();
    if (verdict) {
      return { dimension: verdict.dimension, message: `${verdict.message}. ${stopped}.`, exhausted: true };
    }
    if (steps < this.stepCap) return null;
    const safetyCapNote =
      this.config.userConfig.resourceBudget.maxSteps === null
        ? ' (resourceBudget.maxSteps is disabled, so the safety cap applies)'
        : '';
    return {
      dimension: 'steps',
      message: `${stopped}: the per-turn step cap of ${this.stepCap} was reached${safetyCapNote}.`,
      exhausted: false,
    };
  }

  /**
   * Surfaces, once per session, that cost estimates for the agent's model
   * (or, with `modelId`, for that model: the summary model) use a
   * fail-closed default price (the model is missing from the pricing table
   * and has no resourceBudget.modelPricing override).
   */
  private surfacePricingWarning(modelId?: string): void {
    const warning = this.budgetTracker.getPricing(modelId).warning;
    if (warning !== undefined) this.surfacePricingNotice(warning);
  }

  /**
   * Logs a notice about how cost estimates are priced (a fail-closed default
   * price, a long prompt charged the long-context multiplier) and reports it
   * to the transport as a cost warning, each distinct notice once per session.
   */
  private surfacePricingNotice(message: string): void {
    if (this.surfacedPricingWarnings.has(message)) return;
    this.surfacedPricingWarnings.add(message);
    logger.warn(`[budget] ${message}`);
    this.emitDiagnostic({ kind: 'budget_warning', dimension: 'cost', percentUsed: 0, message });
  }

  private emitTextDiagnostic(text: string): void {
    if (!text) return;
    this.emitDiagnostic({
      kind: 'agent_text',
      preview: `${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`,
    });
  }

  private recordTurn(
    userMessage: string,
    assistantResponse: string,
    usage: LanguageModelUsage,
    timestamp: string,
  ): ConversationTurn {
    return {
      turnNumber: this.turns.total + 1,
      userMessage,
      assistantResponse,
      usage: {
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        cacheReadTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
      },
      timestamp,
    };
  }

  /**
   * Starts the shared escalation watcher for this session's escalation directory.
   */
  private startEscalationWatcher(): void {
    this.escalationWatcher = createEscalationWatcher(this.escalationDir, {
      onEscalation: (request) => this.onEscalation?.(this.taskSummary.attach(request)),
      onEscalationExpired: (escalationId) => this.onEscalationExpired?.(escalationId),
      onEscalationResolved: (id, decision) => this.onEscalationResolved?.(id, decision),
    });
    this.escalationWatcher.start();
  }

  /**
   * Writes the user's message to the escalation directory for the auto-approver,
   * stamped with its source and the time it was sent: the auto-approver trusts
   * it only while it is fresh (see `isUserContextTrusted`). A missing file
   * (a failed write) reads as "no context" and falls through to a human.
   */
  private writeUserContext(userMessage: string): void {
    recordSessionUserContext(this.escalationDir, userMessage);
  }

  /**
   * Clears the user context for a system-generated turn, fail-closed (see
   * `clearSessionUserContext`): skipping the write would leave the previous
   * human message in place to authorize escalations raised by the system
   * prompt.
   */
  private clearUserContext(): void {
    clearSessionUserContext(this.escalationDir);
  }

  private stopEscalationWatcher(): void {
    this.escalationWatcher?.stop();
    this.escalationWatcher = null;
  }
}
