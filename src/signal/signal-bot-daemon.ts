/**
 * SignalBotDaemon - long-lived singleton managing the Signal transport.
 *
 * Responsibilities:
 * - WebSocket connection to signal-cli-rest-api with reconnect + exponential backoff
 * - Message routing: authorization, identity verification, escalation replies,
 *   control commands, and session forwarding
 * - Multi-session lifecycle: creates transport+session on demand, cleans up on end
 * - Identity verification with TTL cache (5 min), fail-closed: a missing
 *   recipient record rejects the message, a message from another account
 *   than the one recorded at setup locks the transport (one that names no
 *   account is rejected), and approve/deny replies are always checked
 *   afresh (see recipient-identity.ts)
 * - Escalation banners and replies: each banner carries a code derived from
 *   the escalation ID and an approval must quote it, so a reply acts only on
 *   the escalation the user saw (see escalation-reply.ts); `approve+ <code>`
 *   also whitelists the pattern the banner showed, `/pending` lists the
 *   pending escalations and `/show <code>` shows one in full
 * - Message sending via POST /v2/send, styled by default and in normal text
 *   mode for anything that carries agent-controlled text verbatim
 *
 * Session state is owned by SessionManager (injected via constructor).
 * This class only handles Signal-specific concerns: WebSocket, identity,
 * message parsing, and command dispatch.
 */

import { createStandaloneSession } from '../session/index.js';
import { loadConfig } from '../config/index.js';
import { loadUserConfig } from '../config/user-config.js';
import { resolveSignalConfig, type ResolvedSignalConfig } from './signal-config.js';
import type { EscalationRequest, SessionMode } from '../session/types.js';
import type { SignalContainerManager } from './signal-container.js';
import type { SignalBridgeClient } from './signal-bridge-client.js';
import type { WebSocket } from 'ws';
import { SessionManager, type ManagedSession } from '../session/session-manager.js';
import { shouldAutoSaveMemory } from '../memory/auto-save.js';
import { SignalSessionTransport } from './signal-transport.js';
import { markdownToSignal } from './markdown-to-signal.js';
import {
  formatBudgetMessage,
  formatBudgetSummary,
  formatEscalationBanner,
  formatEscalationDetails,
  formatJobList,
  formatPendingEscalations,
  formatSessionList,
  formatSessionNoticesMessage,
  prefixWithLabel,
  splitMessage,
  turnTokenBudgetPercent,
  SIGNAL_MAX_MESSAGE_LENGTH,
  type JobListEntry,
  type SessionListEntry,
} from './format.js';
import {
  EscalationCodes,
  parseEscalationReply,
  predatesEscalation,
  replySentAt,
  sentBefore,
  REPLY_CLOCK_SKEW_MS,
  type EscalationReply,
  type EscalationReplyVerb,
} from './escalation-reply.js';
import { matchSenderAccount, selectRecipientIdentity, type RecipientIdentity } from './recipient-identity.js';
import { isSignalImageError } from './signal-image.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { DEFAULT_WHITELIST_OPTIONS } from '../trusted-process/approval-whitelist.js';
import { BudgetExhaustedError } from '../types/errors.js';
import * as logger from '../logger.js';

/** How often to proactively verify the recipient's identity key (ms). */
const IDENTITY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Waits between attempts to send an escalation banner message (backoff). */
const DEFAULT_ESCALATION_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/** Upper bound on one attempt to send an escalation banner message. */
const ESCALATION_SEND_TIMEOUT_MS = 20_000;

/** Codes of recently settled escalations remembered for clearer replies. */
const RECENT_ESCALATION_OUTCOMES = 64;

const APPROVE_NEEDS_CODE =
  'Approvals need the escalation\'s code: reply "approve <code>" with the code shown in its banner.';

const APPROVE_PLUS_NEEDS_CODE =
  'Approvals need the escalation\'s code: reply "approve+ <code>" with the code shown in its banner ' +
  'to approve it and whitelist the pattern the banner shows.';

const ESCALATION_USAGE: Readonly<Record<EscalationReplyVerb, string>> = {
  approve: APPROVE_NEEDS_CODE,
  'approve+': APPROVE_PLUS_NEEDS_CODE,
  deny: 'Reply "deny <code>" with the code shown in the escalation banner ("deny" alone works when one escalation is pending).',
  details: 'Reply "details <code>" with the code shown in an escalation banner to see its arguments.',
  show: 'Send "/show <code>" with the code shown in an escalation banner to see it in full.',
  pending: 'Send "/pending" to list the pending escalations and their codes.',
};

/** How a message's text is interpreted by signal-cli-rest-api. */
export type SignalTextMode = 'styled' | 'normal';

export interface SendSignalMessageOptions {
  /**
   * `styled` (the default) turns `**bold**`, `*italic*`, `` `mono` ``,
   * `~strike~` and `||spoiler||` into formatting; `normal` sends the text as
   * written. Use `normal` for any message that quotes agent-controlled text,
   * so the agent cannot style or restructure it.
   */
  readonly textMode?: SignalTextMode;
}

/** Where an escalation surfaced over Signal comes from, for its banner. */
export interface EscalationOrigin {
  /** The cron job whose session escalated. */
  readonly jobName?: string;
}

/** How a surfaced escalation was settled, as told to the user. */
type EscalationOutcome = 'approved' | 'denied' | 'expired (timed out)' | 'denied automatically';

/** Signal-side state of an escalation whose banner was sent over Signal. */
interface SurfacedEscalation {
  readonly escalationId: string;
  readonly label: number;
  /** The reply code shown in the banner. */
  readonly code: string;
  readonly request: EscalationRequest;
  readonly jobName: string | undefined;
  /** Host time (ms) at which the escalation was raised. */
  readonly raisedAt: number;
  /**
   * Host time (ms) at which the last banner message was delivered; undefined
   * while delivery is still running. Approvals wait for it, and an approval
   * sent before it (beyond the clock-skew allowance) is refused.
   */
  deliveredAt: number | undefined;
  /** False when the banner could not show every value it must show in full. */
  readonly approvable: boolean;
  /**
   * The whitelist pattern the banner showed with `approve+` (display text),
   * or undefined when it offered none: `approve+` then is refused.
   */
  readonly whitelist: string | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Signal envelope types ---

/**
 * Signal message envelope received via WebSocket.
 * Only the fields relevant to IronCurtain are typed here;
 * the full envelope has many more fields (receipts, typing
 * indicators, etc.) that we ignore.
 */
export interface SignalEnvelope {
  /** Sender's phone number or UUID. */
  source?: string;
  /** Sender's phone number (may differ from source in group messages). */
  sourceNumber?: string;
  /** Sender's account UUID (ACI). Checked against the UUID recorded at setup. */
  sourceUuid?: string;
  /**
   * When the Signal server received the message (ms since the epoch, the
   * server's clock). Escalation replies are checked against it.
   */
  serverReceivedTimestamp?: number;
  /** Whether the sender's identity key has changed since last seen by signal-cli. */
  untrustedIdentity?: boolean;
  /** The actual message content, present for data messages. */
  dataMessage?: {
    /** Message text. */
    message?: string;
    /** Timestamp of the message. */
    timestamp?: number;
    /** Group context, if this is a group message. */
    groupInfo?: { groupId: string };
  };
  /** Typing indicator events - ignored. */
  typingMessage?: unknown;
  /** Receipt events - ignored. */
  receiptMessage?: unknown;
}

export interface SignalBotDaemonOptions {
  readonly config: ResolvedSignalConfig;
  readonly containerManager: SignalContainerManager;
  readonly mode: SessionMode;
  readonly sessionManager?: SessionManager;
  /**
   * Optional hook called immediately after a Signal session is registered
   * with the SessionManager. Used to wire sessions into the token stream
   * bridge so that `observe` subscribers can receive events from Signal
   * sessions created while the daemon is running.
   */
  readonly onSessionRegistered?: (label: number, managed: ManagedSession) => void;
  /**
   * Optional hook called after a Signal session is ended (either via /quit
   * or transport exit). Used to tear down any external bookkeeping tied to
   * the session's label.
   */
  readonly onSessionEnded?: (label: number) => void;
  /**
   * Waits between attempts to send an escalation banner message. After the
   * last one fails the escalation is denied. Default: 1 s, 2 s, 4 s.
   */
  readonly escalationRetryDelaysMs?: readonly number[];
  /**
   * Clock-skew allowance when comparing a reply's timestamp with host times
   * (when the escalation was raised, when its banner was delivered).
   * Default: {@link REPLY_CLOCK_SKEW_MS}.
   */
  readonly replyClockSkewMs?: number;
}

export class SignalBotDaemon {
  private config: ResolvedSignalConfig;
  private readonly containerManager: SignalContainerManager;
  private readonly mode: SessionMode;
  private readonly sessionManager: SessionManager;

  // WebSocket state
  private ws: WebSocket | null = null;
  private client: SignalBridgeClient | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;
  private static readonly BASE_RECONNECT_DELAY_MS = 1_000;

  private readonly maxConcurrentSessions: number;

  private readonly onSessionRegistered?: (label: number, managed: ManagedSession) => void;
  private readonly onSessionEnded?: (label: number) => void;

  // Identity verification state
  private identityLocked = false;
  private lastIdentityCheckMs = 0;

  // Message deduplication for drainMissedMessages()
  private recentTimestamps = new Set<number>();

  // Escalations whose banner went out over Signal, by escalation ID. The
  // SessionManager stays the source of truth for what is pending; entries
  // are dropped once their escalation is no longer pending there.
  private readonly escalationCodes = new EscalationCodes();
  private readonly surfacedEscalations = new Map<string, SurfacedEscalation>();
  private readonly recentEscalationOutcomes = new Map<string, { label: number; outcome: EscalationOutcome }>();
  private readonly escalationRetryDelaysMs: readonly number[];
  private readonly replyClockSkewMs: number;

  // Serializes session-mutating operations (/new, /quit) so that
  // routeToSession() sees the updated currentLabel after the operation completes.
  // Without this, the fire-and-forget WebSocket handler can process a user message
  // concurrently with /new, routing it to the old session.
  private sessionOpInProgress: Promise<void> = Promise.resolve();

  // Resolves when the daemon should exit (shutdown() called)
  private exitResolve: (() => void) | null = null;

  constructor(options: SignalBotDaemonOptions) {
    this.config = options.config;
    this.containerManager = options.containerManager;
    this.mode = options.mode;
    this.maxConcurrentSessions = options.config.maxConcurrentSessions;
    this.sessionManager = options.sessionManager ?? new SessionManager();
    this.onSessionRegistered = options.onSessionRegistered;
    this.onSessionEnded = options.onSessionEnded;
    this.escalationRetryDelaysMs = options.escalationRetryDelaysMs ?? DEFAULT_ESCALATION_RETRY_DELAYS_MS;
    this.replyClockSkewMs = options.replyClockSkewMs ?? REPLY_CLOCK_SKEW_MS;
  }

  /**
   * Schedules a session-mutating operation (/new, /quit) so that
   * concurrent routeToSession() calls wait for it to complete.
   * Operations are chained to prevent interleaving.
   */
  private scheduleSessionOp(op: () => Promise<void>): void {
    this.sessionOpInProgress = this.sessionOpInProgress.then(op).catch((err: unknown) => {
      logger.error(`[Signal Daemon] Session operation failed: ${String(err)}`);
    });
  }

  /**
   * Connects the daemon: starts the Docker container, waits for
   * health, connects WebSocket, and sends the online greeting.
   * Throws if any step fails (container won't start, health timeout, etc.).
   */
  async connect(): Promise<void> {
    logger.info('[Signal Daemon] Ensuring container is running...');
    try {
      this.client = await this.containerManager.ensureRunning();
      if (this.closed) {
        this.client.close();
        throw new Error('Signal transport was closed during startup');
      }
    } catch (err) {
      // The bridge image is not usable without the user (not pinned, or the
      // pin cannot be pulled): say so on stderr, not only in the log.
      if (isSignalImageError(err)) {
        process.stderr.write(`Signal transport not started: ${toDisplayText(err.message)}\n`);
      }
      throw err;
    }
    try {
      logger.info('[Signal Daemon] Waiting for container health check...');
      await this.containerManager.waitForHealthy(this.client);
      logger.info('[Signal Daemon] Connecting WebSocket...');
      await this.connectWebSocket();
    } catch (err) {
      this.client.close();
      throw err;
    }
    // Greeting is best-effort — signal-cli may be healthy but not yet
    // fully connected to Signal servers (e.g., broken pipe on first send).
    try {
      await this.sendSignalMessage('IronCurtain bot is online. Send a message to begin.');
    } catch (err) {
      logger.warn(`[Signal Daemon] Greeting failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Blocks until shutdown() is called (e.g., SIGTERM/SIGINT).
   * Call connect() first to establish the connection.
   */
  async run(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /**
   * Convenience: connects and then blocks until shutdown.
   * Used by the standalone `ironcurtain bot` command.
   */
  async start(): Promise<void> {
    await this.connect();
    await this.run();
  }

  /**
   * Initiates graceful shutdown. Ends all Signal sessions,
   * closes the WebSocket, and unblocks start().
   */
  async shutdown(): Promise<void> {
    logger.info('[Signal Daemon] Shutting down...');
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.postMessage('IronCurtain bot is shutting down. Goodbye.', 'styled', 2_000).catch(() => {});
    this.client?.close();

    // Wait for any in-flight session operations (e.g., /new) to complete
    await this.sessionOpInProgress.catch(() => {});

    // End all Signal sessions without letting a single failure abort shutdown
    const signalSessions = this.sessionManager.byKind('signal');
    await Promise.allSettled(
      signalSessions.map(async (managed) => {
        try {
          await this.sessionManager.end(managed.label);
        } catch (err: unknown) {
          logger.error(`[Signal Daemon] Failed to end session #${managed.label} during shutdown: ${String(err)}`);
        }
        this.onSessionEnded?.(managed.label);
      }),
    );

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.exitResolve?.();
  }

  // --- WebSocket connection ---

  private async connectWebSocket(): Promise<void> {
    const isReconnect = this.reconnectAttempts > 0;

    return new Promise<void>((resolve, reject) => {
      const ws = this.requireClient().openReceive(this.config.botNumber);
      let opened = false;

      ws.addEventListener('open', () => {
        opened = true;
        this.reconnectAttempts = 0;

        if (isReconnect) {
          this.drainMissedMessages().catch((err: unknown) => {
            logger.info(`[Signal Daemon] Failed to drain missed messages: ${String(err)}`);
          });
        }

        resolve();
      });

      ws.addEventListener('message', (event) => {
        const data =
          typeof event.data === 'string'
            ? event.data
            : Buffer.isBuffer(event.data)
              ? event.data.toString('utf8')
              : undefined;
        if (data === undefined) return;
        this.handleIncomingMessage(data).catch((err: unknown) => {
          logger.error(`[Signal Daemon] Error handling message: ${String(err)}`);
        });
      });

      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        if (!opened) reject(new Error('WebSocket connection failed'));
        if (!this.closed && (opened || isReconnect)) {
          this.scheduleReconnect();
        }
      });

      ws.addEventListener('error', () => {
        if (!opened) {
          reject(new Error('WebSocket connection failed'));
        }
      });

      this.ws = ws;
    });
  }

  /**
   * Polls GET /v1/receive/{number} to drain messages missed during
   * a WebSocket disconnect. Uses timestamp-based deduplication to
   * avoid processing messages that the WebSocket already delivered.
   */
  private async drainMissedMessages(): Promise<void> {
    try {
      const resp = await this.requireClient().request(`/v1/receive/${encodeURIComponent(this.config.botNumber)}`);
      if (!resp.ok) return;
      const messages = (await resp.json()) as unknown[];
      for (const msg of messages) {
        const data = JSON.stringify(msg);
        await this.handleIncomingMessage(data);
      }
    } catch {
      // Best-effort - new messages will arrive via WS
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectAttempts++;

    const delay = Math.min(
      SignalBotDaemon.BASE_RECONNECT_DELAY_MS * Math.pow(1.5, this.reconnectAttempts),
      SignalBotDaemon.MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) {
        this.connectWebSocket().catch(() => {
          // Retry will be scheduled by the close handler
        });
      }
    }, delay);
    // Don't let a pending reconnect timer keep the event loop alive after shutdown.
    this.reconnectTimer.unref();
  }

  // --- Message routing ---

  private async handleIncomingMessage(data: string): Promise<void> {
    const envelope = parseSignalEnvelope(data);
    if (!envelope) return;

    // Authorization: only accept messages from the configured user
    if (!isAuthorizedSender(envelope, this.config.recipientNumber)) return;

    // Deduplication: skip messages we've already processed
    const ts = envelope.dataMessage?.timestamp;
    if (ts) {
      if (this.recentTimestamps.has(ts)) return;
      this.recentTimestamps.add(ts);
      // Prune old timestamps (keep last 5 minutes)
      if (this.recentTimestamps.size > 500) {
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const t of this.recentTimestamps) {
          if (t < cutoff) this.recentTimestamps.delete(t);
        }
      }
    }

    const text = envelope.dataMessage?.message;
    // Escalation replies: approve/approve+/deny <code>, details <code>,
    // /show <code> and /pending (see parseEscalationReply).
    const reply = text ? parseEscalationReply(text) : null;

    // Identity verification. A decision is checked afresh, never on the
    // cached result: a key change that arrives without signal-cli's
    // untrustedIdentity flag must not ride an earlier success.
    if (await this.checkIdentityChanged(envelope, { fresh: reply?.kind === 'decision' })) return;

    if (!text) return;

    // Escalation replies act on any escalation whose banner went out over
    // Signal (Signal and cron sessions) and are never forwarded to an agent.
    if (reply) {
      this.handleEscalationReply(reply, replySentAt(envelope));
      return;
    }

    // Control commands: /quit, /new, /sessions, /switch, /budget, /jobs, /help
    if (this.handleControlCommand(text)) return;

    // Reject unrecognized slash commands rather than forwarding to agent
    if (text.trimStart().startsWith('/')) {
      const cmd = text.trim().split(/\s/)[0];
      await this.sendSignalMessage(`Unknown command: ${cmd}\nSend /help for available commands.`);
      return;
    }

    // Regular message -> route to Signal session
    await this.routeToSession(text);
  }

  /**
   * Routes a user message to the current Signal session. Creates a new
   * session if none exists. Handles BudgetExhaustedError by ending
   * the exhausted session and notifying the user.
   *
   * Supports one-shot `#N` prefix routing: `#2 do something` routes
   * "do something" to session #2 without changing currentLabel.
   * Only Signal sessions accept forwarded messages.
   */
  private async routeToSession(text: string): Promise<void> {
    // Wait for any pending session operation (/new, /quit) to complete
    // before routing, so we see the updated currentLabel.
    await this.sessionOpInProgress;

    // Parse optional #N prefix for one-shot routing
    const { targetLabel, messageText } = parseHashPrefix(text);

    // If #N prefix was used, route directly to that session (no auto-create)
    if (targetLabel !== null) {
      const managed = this.sessionManager.get(targetLabel);
      if (!managed) {
        await this.sendSignalMessage(`No session #${targetLabel}.`);
        return;
      }
      if (managed.source.kind !== 'signal') {
        await this.sendSignalMessage(
          `Session #${targetLabel} is a ${managed.source.kind} session and does not accept messages.`,
        );
        return;
      }
      await this.forwardToSession(managed, messageText);
      return;
    }

    // Create session on demand if none exists.
    // Serialize through scheduleSessionOp so concurrent messages don't
    // race to create multiple sessions.
    if (this.sessionManager.currentLabel === null) {
      const createOp = new Promise<void>((resolve, reject) => {
        this.scheduleSessionOp(async () => {
          try {
            // Re-check after serialization — another message may have created one
            if (this.sessionManager.currentLabel === null) {
              await this.startNewSession();
            }
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });
      try {
        await createOp;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.sendSignalMessage(`Failed to create session: ${msg}`);
        return;
      }
    }

    const currentLabel = this.sessionManager.currentLabel;
    if (currentLabel === null) return;
    const managed = this.sessionManager.get(currentLabel);
    if (!managed) return;

    await this.forwardToSession(managed, messageText);
  }

  /**
   * Forwards a message to a specific managed session. Handles
   * in-flight guards, BudgetExhaustedError, and response formatting.
   */
  private async forwardToSession(managed: ManagedSession, text: string): Promise<void> {
    const transport = managed.transport as SignalSessionTransport;
    const sessionCount = this.sessionManager.size;
    logger.info(
      `[Signal Daemon] Routing message to session #${managed.label} ` +
        `(currentLabel=${this.sessionManager.currentLabel}, sessions=${this.sessionManager
          .all()
          .map((m) => m.label)
          .join(',')}, ` +
        `transportLabel=${transport.sessionLabel})`,
    );

    if (managed.messageInFlight) {
      await this.sendSignalMessage(
        prefixWithLabel('Still processing previous message, please wait...', managed.label, sessionCount),
      );
      return;
    }

    managed.messageInFlight = true;
    try {
      const response = await transport.forwardMessage(text);
      const styledText = markdownToSignal(response);
      const hasContent = styledText.trim().length > 0;
      if (!hasContent) {
        logger.warn(`[Signal Daemon] Session #${managed.label} returned empty response; sending fallback message`);
      }
      const messageToSend = hasContent ? styledText : 'The agent completed but produced no text response.';
      await this.sendSignalMessage(prefixWithLabel(messageToSend, managed.label, this.sessionManager.size));
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        const status = managed.session.getBudgetStatus();
        await this.sendSignalMessage(
          prefixWithLabel(
            `Session budget exhausted: ${error.message}\n` +
              formatBudgetSummary(status) +
              '\n' +
              'Send a new message to start a fresh session.',
            managed.label,
            this.sessionManager.size,
          ),
        );
        await this.sessionManager.end(managed.label);
        this.onSessionEnded?.(managed.label);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendSignalMessage(prefixWithLabel(`Error: ${message}`, managed.label, this.sessionManager.size));
      }
    } finally {
      managed.messageInFlight = false;
    }
  }

  // --- Session lifecycle ---

  /**
   * Creates a new Signal session with a fresh SignalSessionTransport.
   * Follows the same pattern as index.ts: create transport,
   * wire callbacks, create session, start transport.
   * Returns the label of the new session.
   */
  private async startNewSession(persona?: string): Promise<number> {
    // Count only Signal sessions toward the concurrency limit
    const signalSessionCount = this.sessionManager.byKind('signal').length;
    if (signalSessionCount >= this.maxConcurrentSessions) {
      throw new Error(`Session limit reached (max ${this.maxConcurrentSessions}). Use /quit to end a session first.`);
    }

    const config = loadConfig();

    const transport = new SignalSessionTransport({
      daemon: this,
      autoSaveMemory: shouldAutoSaveMemory(config, { persona }),
      dockerMode: this.mode.kind === 'docker',
    });

    const session = await createStandaloneSession({
      config,
      mode: this.mode,
      persona,
      onEscalation: transport.createEscalationHandler(),
      onEscalationExpired: transport.createEscalationExpiredHandler(),
      onDiagnostic: transport.createDiagnosticHandler(),
    });

    const label = this.sessionManager.register(session, transport, { kind: 'signal' });
    transport.sessionLabel = label;

    // Notify external observers (e.g., token stream bridge) so that a
    // pre-existing `observe --all` subscription routes this session's events.
    const managed = this.sessionManager.get(label);
    if (managed && this.onSessionRegistered) {
      this.onSessionRegistered(label, managed);
    }

    // Start the transport in the background. Store the run promise so
    // SessionManager.end() can await it (giving auto-save time to finish)
    // before closing the session.
    const runPromise = transport.run(session);

    if (managed) {
      managed.runPromise = runPromise;
    }

    // When the transport resolves (session closed/budget exhausted), clean up.
    runPromise
      .then(() => {
        // Transport exited - remove session if still present
        const m = this.sessionManager.get(label);
        if (m) {
          this.sessionManager.end(label).catch((err: unknown) => {
            logger.error(`[Signal Daemon] Failed to clean up session #${label}: ${String(err)}`);
          });
          this.onSessionEnded?.(label);
        }
      })
      .catch((err: unknown) => {
        logger.error(`[Signal Daemon] Transport #${label} error: ${String(err)}`);
      });

    await this.sendSignalMessage(prefixWithLabel('Started a new session.', label, this.sessionManager.size));
    // The start-up notices the session emitted while it was created (a stale
    // policy, an MCP server that did not start, ...), once, in plain text:
    // they quote server-provided text.
    const notices = transport.takeStartupNotices();
    if (notices.length > 0) {
      await this.sendSignalMessage(formatSessionNoticesMessage(label, notices), { textMode: 'normal' }).catch(
        (err: unknown) => {
          logger.warn(`[Signal Daemon] Could not send the start-up notices of session #${label}: ${errorMessage(err)}`);
        },
      );
    }
    return label;
  }

  // --- Escalation handling ---

  /**
   * Records a pending escalation of a Signal or cron session and sends its
   * banner (see `formatEscalationBanner`): first the header with the reply
   * code and instructions, then the arguments. Only a reply quoting the code
   * approves this escalation, and only one sent after the whole banner was
   * delivered. Delivery runs in the background with retries; if a banner
   * message still cannot be sent, the escalation is denied and the failure
   * logged.
   *
   * The returned promise settles (never rejects) once delivery has finished
   * either way; callers may ignore it.
   */
  surfaceEscalation(label: number, request: EscalationRequest, origin?: EscalationOrigin): Promise<void> {
    const raisedAt = Date.now();
    // The full request (not just its ID), so other clients listing pending
    // escalations, such as the web UI (which the SessionManager tells), see
    // and can decide what is being asked: the whitelist candidates (the
    // patterns `whitelistSelection` indexes, the first being the one the
    // banner offers with `approve+`) and the reviewer context (the human's
    // task and last message; the agent's untrusted justification). No group
    // key (see toPendingEscalationData): an escalation surfaced here is
    // decided on its own, never as part of a group approval in another client.
    this.sessionManager.recordEscalation(label, request, { receivedAt: raisedAt });
    this.pruneSurfacedEscalations();

    const code = this.escalationCodes.codeFor(request.escalationId);
    const jobName = origin?.jobName;
    const banner = formatEscalationBanner(request, { label, code, ...(jobName !== undefined ? { jobName } : {}) });
    const entry: SurfacedEscalation = {
      escalationId: request.escalationId,
      label,
      code,
      request,
      jobName,
      raisedAt,
      deliveredAt: undefined,
      approvable: banner.approvable,
      whitelist: banner.whitelist,
    };
    this.surfacedEscalations.set(request.escalationId, entry);
    logger.info(`[Signal Daemon] Escalation ${request.escalationId} set on session #${label}`);

    return this.deliverEscalationBanner(entry, [banner.header, ...banner.argumentMessages]).catch((err: unknown) => {
      logger.error(`[Signal Daemon] Escalation banner delivery failed: ${errorMessage(err)}`);
    });
  }

  /**
   * Called when one of a session's escalations expired (the proxy timed it
   * out and denied the call): clears it and, when its banner went out over
   * Signal, tells the user. The session's other escalations stay pending.
   */
  expireEscalation(label: number, escalationId: string): void {
    this.sessionManager.expireEscalation(label, escalationId);
    const entry = this.surfacedEscalations.get(escalationId);
    if (entry?.label !== label) return;
    this.surfacedEscalations.delete(entry.escalationId);
    this.rememberEscalationOutcome(entry, 'expired (timed out)');
    this.sendSignalMessage(`[#${label}] Escalation ${entry.code} expired (timed out); the tool call was denied.`, {
      textMode: 'normal',
    }).catch(() => {});
  }

  /**
   * Sends the banner messages in order, each with retries, in normal text
   * mode. Stops early (also between retries) if the escalation is settled
   * meanwhile, for example in the web UI; denies it if a message cannot be
   * delivered, because the user cannot decide on an escalation they were not
   * shown.
   */
  private async deliverEscalationBanner(entry: SurfacedEscalation, messages: readonly string[]): Promise<void> {
    const stillPending = (): boolean => this.isStillPending(entry);
    for (const message of messages) {
      if (!stillPending()) return;
      try {
        await this.postWithRetry(message, stillPending);
      } catch (err) {
        // Settled elsewhere while this message failed: nothing left to deny.
        if (!stillPending()) return;
        await this.denyUndeliveredEscalation(entry, err);
        return;
      }
    }
    entry.deliveredAt = Date.now();
  }

  /** Posts one banner message, retrying with backoff while `keepTrying()` holds. */
  private async postWithRetry(text: string, keepTrying: () => boolean): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.postMessage(text, 'normal', ESCALATION_SEND_TIMEOUT_MS);
        return;
      } catch (err) {
        const delay = this.escalationRetryDelaysMs.at(attempt);
        if (delay === undefined || this.closed || !keepTrying()) throw err;
        logger.warn(
          `[Signal Daemon] Escalation banner send failed (attempt ${attempt + 1}), retrying in ${delay}ms: ${errorMessage(err)}`,
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref();
        });
      }
    }
  }

  private async denyUndeliveredEscalation(entry: SurfacedEscalation, cause: unknown): Promise<void> {
    logger.error(
      `[Signal Daemon] Could not deliver the banner of escalation ${entry.escalationId} ` +
        `(session #${entry.label}): ${errorMessage(cause)}. Denying it.`,
    );
    let notice: string | undefined;
    try {
      const result = await this.sessionManager.resolveSessionEscalation(entry.escalationId, 'denied');
      if (result.resolved) {
        this.rememberEscalationOutcome(entry, 'denied automatically');
        notice = `[#${entry.label}] Escalation ${entry.code} was denied automatically: its banner could not be delivered.`;
      } else if (result.reason === 'expired') {
        this.rememberEscalationOutcome(entry, 'expired (timed out)');
        notice = `[#${entry.label}] Escalation ${entry.code} expired (timed out); the tool call was denied.`;
      } else {
        // Settled or being settled elsewhere (for example in the web UI):
        // the user must not be told it was denied here.
        logger.warn(`[Signal Daemon] Escalation ${entry.escalationId} was not denied: ${result.reason ?? 'unknown'}`);
      }
    } catch (err) {
      logger.error(`[Signal Daemon] Denying escalation ${entry.escalationId} failed: ${errorMessage(err)}`);
    }
    this.surfacedEscalations.delete(entry.escalationId);
    if (notice === undefined) return;
    // One attempt only: the channel just failed, so this may not arrive either.
    await this.postMessage(notice, 'normal').catch(() => {});
  }

  /** Whether the session still has this escalation pending. */
  private isStillPending(entry: SurfacedEscalation): boolean {
    return this.sessionManager.get(entry.label)?.pendingEscalations.has(entry.escalationId) === true;
  }

  /** Drops surfaced escalations that are no longer pending (settled elsewhere, session ended). */
  private pruneSurfacedEscalations(): void {
    for (const entry of [...this.surfacedEscalations.values()]) {
      if (!this.isStillPending(entry)) this.surfacedEscalations.delete(entry.escalationId);
    }
  }

  private rememberEscalationOutcome(entry: SurfacedEscalation, outcome: EscalationOutcome): void {
    this.recentEscalationOutcomes.delete(entry.code);
    this.recentEscalationOutcomes.set(entry.code, { label: entry.label, outcome });
    for (const code of this.recentEscalationOutcomes.keys()) {
      if (this.recentEscalationOutcomes.size <= RECENT_ESCALATION_OUTCOMES) break;
      this.recentEscalationOutcomes.delete(code);
    }
  }

  /**
   * Sends a short reply; failures are ignored (the user can ask again).
   * `normal` text mode for a reply that quotes agent-controlled text.
   */
  private notify(text: string, textMode: SignalTextMode = 'styled'): void {
    this.sendSignalMessage(text, { textMode }).catch(() => {});
  }

  /**
   * Handles an escalation reply (see `parseEscalationReply`): `approve`,
   * `approve+`, `deny`, `details` / `/show` and `/pending`. Such a message is
   * never forwarded to an agent, even when nothing is pending.
   *
   * Only escalations whose banner went out over Signal (Signal and cron
   * sessions) are acted on. An approval must quote the escalation's code
   * (`approve K7Q2`, `approve+ K7Q2`); `deny` alone denies the only pending
   * escalation and `deny #N` the one on session N. A reply sent before the
   * escalation it would act on was raised is refused ("escalation changed,
   * re-confirm"), and so is an approval sent before its banner was delivered
   * in full, whether it came over the WebSocket or from the reconnect drain.
   */
  private handleEscalationReply(reply: EscalationReply, sentAt: number | undefined): void {
    this.pruneSurfacedEscalations();
    switch (reply.kind) {
      case 'usage':
        this.notify(ESCALATION_USAGE[reply.verb]);
        break;
      case 'pending':
        this.sendPendingEscalations();
        break;
      case 'details':
        this.sendEscalationDetails(reply.code, reply.label);
        break;
      case 'decision':
        this.handleEscalationDecision(reply, sentAt);
        break;
    }
  }

  private handleEscalationDecision(
    reply: Extract<EscalationReply, { kind: 'decision' }>,
    sentAt: number | undefined,
  ): void {
    const target = this.findDecisionTarget(reply);
    if (!target) return;
    const pending = this.sessionManager.get(target.label)?.pendingEscalations.get(target.escalationId);
    if (!pending) return;
    const approve = reply.decision === 'approved';

    // An approval must be datable; a deny without a timestamp is harmless.
    const stale =
      sentAt === undefined ? approve : predatesEscalation(sentAt, pending.receivedAt, this.replyClockSkewMs);
    if (stale) {
      logger.warn(
        `[Signal Daemon] Refused a ${reply.decision} reply for escalation ${target.escalationId}: ` +
          `sent at ${sentAt === undefined ? 'unknown time' : new Date(sentAt).toISOString()}, ` +
          `escalation raised at ${pending.receivedAt}`,
      );
      const why =
        sentAt === undefined
          ? 'That reply carries no timestamp, so it was not applied.'
          : 'Escalation changed since that reply was sent, so it was not applied.';
      this.notify(
        prefixWithLabel(
          `${why} Re-confirm with the code in the current escalation banner.`,
          target.label,
          this.sessionManager.size,
        ),
      );
      return;
    }
    const whitelist = approve && reply.whitelist === true;
    if (approve && (sentAt === undefined || !this.mayApprove(target, sentAt, whitelist))) return;
    this.resolveSurfacedEscalation(target, reply.decision, whitelist ? target.whitelist : undefined);
  }

  /**
   * Whether an approval sent at `sentAt` may be applied to `target`, after
   * telling the user why not. The whole banner must have been delivered, and
   * the approval sent after that: a reply processed late (for example from
   * the reconnect drain) can have been written before the arguments reached
   * the phone. The banner must have shown every value it must show in full.
   * And `approve+` (`whitelist`) needs a whitelist pattern the banner showed.
   */
  private mayApprove(target: SurfacedEscalation, sentAt: number, whitelist: boolean): boolean {
    const say = (text: string): void => {
      this.notify(prefixWithLabel(text, target.label, this.sessionManager.size));
    };
    const deliveredAt = target.deliveredAt;
    if (deliveredAt === undefined) {
      say(`Escalation ${target.code} is still being delivered. Read its arguments when they arrive, then reply again.`);
      return false;
    }
    if (sentBefore(sentAt, deliveredAt, this.replyClockSkewMs)) {
      logger.warn(
        `[Signal Daemon] Refused an approval of escalation ${target.escalationId}: sent at ` +
          `${new Date(sentAt).toISOString()}, before its banner was delivered at ${new Date(deliveredAt).toISOString()}`,
      );
      say(
        `That approval was sent before the arguments of escalation ${target.code} were delivered, ` +
          'so it was not applied. Read them, then reply again.',
      );
      return false;
    }
    if (!target.approvable) {
      say(
        `Escalation ${target.code} cannot be approved over Signal: values that must be shown in full did not fit ` +
          `in its banner. Reply "deny ${target.code}" to deny it.`,
      );
      return false;
    }
    if (whitelist && target.whitelist === undefined) {
      say(
        `Escalation ${target.code} offers no whitelist pattern, so nothing was changed. ` +
          `Reply "approve ${target.code}" to approve this call only.`,
      );
      return false;
    }
    return true;
  }

  /**
   * The escalation a decision reply names, or undefined after telling the
   * user why there is none. Never reveals a pending escalation's code.
   */
  private findDecisionTarget(reply: Extract<EscalationReply, { kind: 'decision' }>): SurfacedEscalation | undefined {
    if (reply.code !== undefined) return this.findByCode(reply.code, reply.label);

    const open = [...this.surfacedEscalations.values()];
    if (reply.decision === 'approved') {
      const needsCode = reply.whitelist === true ? APPROVE_PLUS_NEEDS_CODE : APPROVE_NEEDS_CODE;
      this.notify(open.length === 0 ? 'No escalation is pending.' : needsCode);
      return undefined;
    }
    const candidates = reply.label === undefined ? open : open.filter((entry) => entry.label === reply.label);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) {
      this.notify(
        reply.label === undefined ? 'No escalation is pending.' : `Session #${reply.label} has no pending escalation.`,
      );
    } else {
      // One session can have several pending (parallel tool calls): each label once.
      const labels = [...new Set(candidates.map((entry) => `#${entry.label}`))].join(', ');
      this.notify(`Several escalations are pending (${labels}). Reply "deny <code>" with the code from its banner.`);
    }
    return undefined;
  }

  /** The pending escalation with this code (on session `label`, when given), or undefined after a reply. */
  private findByCode(code: string, label: number | undefined): SurfacedEscalation | undefined {
    const matches = [...this.surfacedEscalations.values()].filter((entry) => entry.code === code);
    if (matches.length > 1) {
      this.notify(
        `Code ${code} matches more than one pending escalation, so nothing was changed. ` +
          'Deny one with "deny #N", or decide in the web UI.',
      );
      return undefined;
    }
    if (matches.length === 0) {
      this.notify(this.noPendingEscalationMessage(code));
      return undefined;
    }
    const match = matches[0];
    if (label !== undefined && label !== match.label) {
      this.notify(`Escalation ${code} is not on session #${label}, so nothing was changed.`);
      return undefined;
    }
    return match;
  }

  private noPendingEscalationMessage(code: string): string {
    const recent = this.recentEscalationOutcomes.get(code);
    if (!recent) return `No pending escalation has code ${code}. Use the code from the latest escalation banner.`;
    const newer = [...this.surfacedEscalations.values()].some((entry) => entry.label === recent.label);
    return (
      `Escalation ${code} (#${recent.label}) was already ${recent.outcome}, so nothing was changed.` +
      (newer ? ` Session #${recent.label} has a newer escalation: read its banner and re-confirm with its code.` : '')
    );
  }

  /**
   * Resolves the escalation and tells the user how it went. With
   * `whitelistPattern` (an `approve+`, checked by `mayApprove`) the approval
   * also whitelists the escalation's first whitelist candidate, the one its
   * banner showed as that pattern.
   */
  private resolveSurfacedEscalation(
    target: SurfacedEscalation,
    decision: 'approved' | 'denied',
    whitelistPattern?: string,
  ): void {
    const say = (text: string, textMode?: SignalTextMode): void => {
      this.notify(prefixWithLabel(text, target.label, this.sessionManager.size), textMode);
    };
    const options = whitelistPattern !== undefined ? DEFAULT_WHITELIST_OPTIONS : undefined;
    this.sessionManager.resolveSessionEscalation(target.escalationId, decision, options).then(
      (result) => {
        if (result.resolved) {
          this.surfacedEscalations.delete(target.escalationId);
          this.rememberEscalationOutcome(target, decision);
          if (whitelistPattern === undefined) say(`Escalation ${target.code} ${decision}.`);
          // Plain text: the pattern quotes paths and domains the agent chose.
          else say(`Escalation ${target.code} approved. Whitelisted for this session: ${whitelistPattern}`, 'normal');
        } else if (result.reason === 'expired') {
          // The response reached the proxy after its timeout: the call was
          // denied, so a late approval must not be reported as approved.
          this.surfacedEscalations.delete(target.escalationId);
          this.rememberEscalationOutcome(target, 'expired (timed out)');
          say(`Escalation ${target.code} had already expired (timed out), so the tool call was denied.`);
        } else if (result.reason === 'already_resolving') {
          say(`Escalation ${target.code} is being resolved, please wait...`);
        } else {
          say(`Escalation ${target.code} is no longer pending.`);
        }
      },
      (err: unknown) => {
        say(`Escalation error: ${errorMessage(err)}`);
      },
    );
  }

  /** Replies to `details <code>` / `/show <code>` with the escalation in full, as plain text. */
  private sendEscalationDetails(code: string, label: number | undefined): void {
    const entry = this.findByCode(code, label);
    if (!entry) return;
    const messages = formatEscalationDetails(entry.request, {
      label: entry.label,
      code: entry.code,
      ...(entry.jobName !== undefined ? { jobName: entry.jobName } : {}),
      approvable: entry.approvable,
      ...(entry.whitelist !== undefined ? { whitelist: entry.whitelist } : {}),
    });
    (async () => {
      for (const message of messages) await this.postMessage(message, 'normal');
    })().catch((err: unknown) => {
      logger.warn(`[Signal Daemon] Sending escalation details failed: ${errorMessage(err)}`);
    });
  }

  /**
   * Replies to `/pending` with the escalations whose banner went out over
   * Signal, as plain text, and how many other clients hold.
   */
  private sendPendingEscalations(): void {
    const surfaced = [...this.surfacedEscalations.values()];
    const elsewhere = this.sessionManager
      .allPendingEscalations()
      .filter(({ escalation }) => !this.surfacedEscalations.has(escalation.escalationId)).length;
    const entries = surfaced.map((entry) => ({
      label: entry.label,
      code: entry.code,
      serverName: entry.request.serverName,
      toolName: entry.request.toolName,
      ...(entry.jobName !== undefined ? { jobName: entry.jobName } : {}),
      raisedAt: entry.raisedAt,
      delivering: entry.deliveredAt === undefined,
      denyOnly: !entry.approvable,
      whitelist: entry.whitelist !== undefined,
    }));
    this.notify(formatPendingEscalations(entries, { elsewhere }), 'normal');
  }

  // --- Control commands ---

  private handleControlCommand(text: string): boolean {
    const lower = text.trim().toLowerCase();

    // /quit [N] or /exit [N]
    const quitMatch = lower.match(/^\/(quit|exit)(?:\s+#?(\d+))?$/);
    if (quitMatch) {
      const explicitLabel = quitMatch[2] ? parseInt(quitMatch[2], 10) : null;
      this.scheduleSessionOp(async () => {
        const labelToEnd = explicitLabel ?? this.sessionManager.currentLabel;

        if (labelToEnd === null) {
          await this.sendSignalMessage('No active session.');
          return;
        }
        if (!this.sessionManager.get(labelToEnd)) {
          await this.sendSignalMessage(`No session #${labelToEnd}.`);
          return;
        }

        const wasCurrent = labelToEnd === this.sessionManager.currentLabel;
        try {
          await this.sessionManager.end(labelToEnd);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.sendSignalMessage(`Failed to end session #${labelToEnd}: ${msg}`);
          return;
        }
        this.onSessionEnded?.(labelToEnd);

        if (wasCurrent && this.sessionManager.size > 0 && this.sessionManager.currentLabel !== null) {
          await this.sendSignalMessage(
            `Session #${labelToEnd} ended. Switched to #${this.sessionManager.currentLabel}.`,
          );
        } else if (this.sessionManager.size > 0) {
          await this.sendSignalMessage(`Session #${labelToEnd} ended.`);
        } else {
          await this.sendSignalMessage('Session ended. Send a message to start a new one.');
        }
      });
      return true;
    }

    // /new [persona-name]
    const newMatch = lower.match(/^\/new(?:\s+(\S+))?$/);
    if (newMatch) {
      const personaArg = newMatch[1]; // undefined if bare /new
      this.scheduleSessionOp(async () => {
        try {
          await this.startNewSession(personaArg);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.sendSignalMessage(msg);
        }
      });
      return true;
    }

    // /sessions
    if (lower === '/sessions') {
      this.scheduleSessionOp(async () => {
        const allSessions = this.sessionManager.all();
        const entries: SessionListEntry[] = allSessions.map((managed) => {
          const info = managed.session.getInfo();
          return {
            label: managed.label,
            turnCount: info.turnCount,
            budgetPercent: turnTokenBudgetPercent(managed.session.getBudgetStatus(), info.status === 'processing'),
          };
        });
        await this.sendSignalMessage(formatSessionList(entries, this.sessionManager.currentLabel));
      });
      return true;
    }

    // /switch N - only switch to Signal sessions
    const switchMatch = lower.match(/^\/switch\s+#?(\d+)$/);
    if (switchMatch) {
      const label = parseInt(switchMatch[1], 10);
      this.scheduleSessionOp(async () => {
        const managed = this.sessionManager.get(label);
        if (!managed) {
          await this.sendSignalMessage(`No session #${label}.`);
        } else if (managed.source.kind !== 'signal') {
          await this.sendSignalMessage(
            `Session #${label} is a ${managed.source.kind} session and cannot be switched to.`,
          );
        } else {
          this.sessionManager.currentLabel = label;
          await this.sendSignalMessage(`Switched to session #${label}.`);
        }
      });
      return true;
    }

    // /budget [N]
    const budgetMatch = lower.match(/^\/budget(?:\s+#?(\d+))?$/);
    if (budgetMatch) {
      const explicitBudgetLabel = budgetMatch[1] ? parseInt(budgetMatch[1], 10) : null;
      this.scheduleSessionOp(async () => {
        const label = explicitBudgetLabel ?? this.sessionManager.currentLabel;
        const managed = label !== null ? this.sessionManager.get(label) : undefined;

        if (label === null) {
          await this.sendSignalMessage('No active session.');
        } else if (!managed) {
          await this.sendSignalMessage(`No session #${label}.`);
        } else {
          const status = managed.session.getBudgetStatus();
          await this.sendSignalMessage(prefixWithLabel(formatBudgetMessage(status), label, this.sessionManager.size));
        }
      });
      return true;
    }

    // /jobs
    if (lower === '/jobs') {
      this.scheduleSessionOp(async () => {
        try {
          const { sendControlRequest } = await import('../daemon/control-socket.js');
          const result = await sendControlRequest({ command: 'list-jobs' });
          if (result.kind !== 'response') {
            const errMsg = result.kind === 'unreachable' ? 'daemon may not be running' : result.reason;
            await this.sendSignalMessage(`Failed to query jobs: ${errMsg}`);
          } else if (!result.response.ok) {
            await this.sendSignalMessage(`Failed to query jobs: ${result.response.error}`);
          } else {
            const jobs = (result.response.data ?? []) as JobListEntry[];
            await this.sendSignalMessage(formatJobList(jobs));
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.sendSignalMessage(`Failed to query jobs: ${msg}`);
        }
      });
      return true;
    }

    // /help
    if (lower === '/help') {
      this.scheduleSessionOp(async () => {
        const currentLabel = this.sessionManager.currentLabel;
        const sessionLine = currentLabel !== null ? `Current session: #${currentLabel}` : 'No active session.';
        await this.sendSignalMessage(
          sessionLine +
            '\n\n' +
            'Commands:\n' +
            '  /new [persona] - start a new session (optionally with a persona)\n' +
            '  /sessions - list active sessions\n' +
            '  /switch N - switch to session #N\n' +
            '  #N <message> - send to session #N without switching\n' +
            '  /quit [N] - end session (current or #N)\n' +
            '  /budget [N] - show resource usage\n' +
            '  /jobs - list scheduled cron jobs\n' +
            '  /help - show this message\n' +
            '  /pending - list pending escalations with their codes\n' +
            '  /show <code> - show an escalation in full (also "details <code>")\n' +
            '  approve <code> - approve the escalation whose banner shows <code>\n' +
            '  approve+ <code> - approve it and whitelist the pattern its banner shows\n' +
            '  deny <code> - deny it ("deny" alone denies the only pending one, "deny #N" the one on #N)',
        );
      });
      return true;
    }

    return false;
  }

  // --- Identity verification ---

  /**
   * Checks whether the sender's Signal identity key has changed.
   *
   * Detection path 1: signal-cli flags the envelope with `untrustedIdentity`,
   *   or (with the account UUID recorded at setup) the envelope names
   *   another sender account (`sourceUuid`).
   * Detection path 2: proactive check via GET /v1/identities against the
   *   recipient's record (see `selectRecipientIdentity`: the stored UUID's
   *   record, else the newest one for the number). A success is cached for
   *   IDENTITY_CHECK_INTERVAL_MS to avoid HTTP overhead on every message;
   *   `fresh` (escalation decisions) skips the cache.
   *
   * Fails closed: an API error, an unreadable list, no record for the
   * recipient, or (with a stored UUID) an envelope that names no sender
   * account rejects the message without caching anything, so the next
   * message checks again; a different key locks the transport.
   *
   * When locked, attempts self-healing by re-reading config from disk
   * (handles the case where the user ran `--re-trust` externally): a new
   * identity key or account UUID unlocks, and the next check asks
   * signal-cli again (a lock drops the cached success).
   *
   * Returns true if the message should be rejected.
   */
  async checkIdentityChanged(envelope: SignalEnvelope, options: { readonly fresh?: boolean } = {}): Promise<boolean> {
    // If locked, attempt self-healing via config reload. The lock cleared the
    // cached success, so the record check below runs against what was reloaded.
    if (this.identityLocked) {
      try {
        const freshUserConfig = loadUserConfig();
        const freshSignal = resolveSignalConfig(freshUserConfig);
        if (
          freshSignal &&
          (freshSignal.recipientIdentityKey !== this.config.recipientIdentityKey ||
            freshSignal.recipientUuid !== this.config.recipientUuid)
        ) {
          logger.info('[Signal Daemon] Detected a new identity key or account UUID on disk. Unlocking.');
          this.config = freshSignal;
          this.identityLocked = false;
        }
      } catch {
        logger.error('[Signal Daemon] Failed to reload config during lock check.');
      }
      if (this.identityLocked) return true;
    }

    // Detection path 1: envelope flag (real-time)
    if (envelope.untrustedIdentity) {
      this.lockTransport('Identity key change detected via envelope flag.');
      return true;
    }

    // Detection path 1b: with the account UUID recorded at setup, a message
    // from the recipient's number but from another account means the number
    // now belongs to someone else. Checked on every message: the record check
    // below verifies the recorded account, not the sender, so a message that
    // names no sender account cannot be vouched for by it either.
    const recipient: RecipientIdentity = {
      number: this.config.recipientNumber,
      ...(this.config.recipientUuid !== undefined ? { uuid: this.config.recipientUuid } : {}),
    };
    const sender = matchSenderAccount(envelope.sourceUuid, recipient);
    if (sender === 'other') {
      this.lockTransport(
        `Message from Signal account ${toDisplayText(String(envelope.sourceUuid), { maxLength: 64 })}, ` +
          `not the recorded ${this.config.recipientUuid ?? ''}.`,
      );
      return true;
    }
    if (sender === 'unnamed') {
      // Fail closed without locking: nothing shows the number moved, but
      // nothing ties the message to the recorded account either.
      logger.error(
        `[Signal Daemon] Message from ${this.config.recipientNumber} names no sender account ` +
          `(the recorded account is ${this.config.recipientUuid ?? ''}). Rejecting message (fail-closed).`,
      );
      return true;
    }

    // Detection path 2: proactive API check (periodic, TTL-cached; decisions always check)
    const now = Date.now();
    if (options.fresh !== true && now - this.lastIdentityCheckMs < IDENTITY_CHECK_INTERVAL_MS) {
      return false; // Within TTL, skip API call
    }

    try {
      // Use the all-identities endpoint and filter by recipient number.
      // The per-recipient endpoint is not available in all versions.
      const resp = await this.requireClient().request(`/v1/identities/${encodeURIComponent(this.config.botNumber)}`);
      if (!resp.ok) {
        // Fail closed: treat API errors as unverifiable.
        // Don't update lastIdentityCheckMs so the next message retries.
        logger.error(
          `[Signal Daemon] Identity check API returned ${resp.status}. ` +
            'Rejecting message (fail-closed). Check signal-cli container health.',
        );
        return true;
      }
      const current = selectRecipientIdentity(await resp.json(), recipient);
      if (current === undefined) {
        // Fail closed without locking: signal-cli may list the record
        // without its number for a while. Not cached, so the next message
        // checks again.
        logger.error(
          `[Signal Daemon] signal-cli lists no identity key for ${this.config.recipientNumber}` +
            `${this.config.recipientUuid !== undefined ? ` (account ${this.config.recipientUuid})` : ''}. ` +
            'Rejecting message (fail-closed).',
        );
        return true;
      }
      if (current.fingerprint !== this.config.recipientIdentityKey) {
        this.lockTransport(
          `Identity key mismatch.\n` +
            `  Expected: ${this.config.recipientIdentityKey.substring(0, 20)}...\n` +
            `  Received: ${current.fingerprint.substring(0, 20)}...`,
        );
        return true;
      }
      // Only cache success - failures will retry on the next message
      this.lastIdentityCheckMs = now;
    } catch {
      // Fail closed: reject message when we cannot verify identity.
      // Don't update lastIdentityCheckMs so the next message retries.
      logger.error(
        '[Signal Daemon] Identity check API unavailable. ' +
          'Rejecting message (fail-closed). Check signal-cli container health.',
      );
      return true;
    }

    return false;
  }

  private lockTransport(reason: string): void {
    this.identityLocked = true;
    // A success cached before the lock vouches for the identity that just
    // failed: after an unlock (a re-trust on disk), the next message must be
    // checked against signal-cli again, not ride the old 5-minute window.
    this.lastIdentityCheckMs = 0;
    logger.error(
      `[Signal Daemon] LOCKED: ${reason}\n` +
        `The Signal identity key for ${this.config.recipientNumber} has changed.\n` +
        `All messages are being rejected until re-trust is completed.\n` +
        `Run: ironcurtain setup-signal --re-trust`,
    );
  }

  // --- Message sending ---

  async sendSignalMessage(text: string, options: SendSignalMessageOptions = {}): Promise<void> {
    const textMode = options.textMode ?? 'styled';
    const chunks = splitMessage(text, SIGNAL_MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.postMessage(chunk, textMode);
    }
  }

  private async postMessage(text: string, textMode: SignalTextMode = 'styled', timeoutMs?: number): Promise<void> {
    const body: Record<string, unknown> = {
      message: text,
      number: this.config.botNumber,
      recipients: [this.config.recipientNumber],
      text_mode: textMode,
    };

    const resp = await this.requireClient().request('/v2/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });

    if (!resp.ok) {
      throw new Error(`Signal send failed: ${resp.status}`);
    }
  }

  private requireClient(): SignalBridgeClient {
    if (this.client === null) throw new Error('Signal bridge is not connected');
    return this.client;
  }
}

// --- Envelope parsing and authorization ---

export function parseSignalEnvelope(data: string): SignalEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    // json-rpc mode wraps the envelope; fall back to the raw object
    return record.envelope ?? parsed;
  } catch {
    return null;
  }
}

export function normalizePhoneNumber(number: string): string {
  return number.replace(/\s+/g, '');
}

export function isAuthorizedSender(envelope: SignalEnvelope, recipientNumber: string): boolean {
  const sender = envelope.sourceNumber ?? envelope.source;
  if (!sender) return false;
  return normalizePhoneNumber(sender) === normalizePhoneNumber(recipientNumber);
}

// --- Message prefix parsing ---

export interface HashPrefixResult {
  /** The session label from the #N prefix, or null if no prefix was found. */
  targetLabel: number | null;
  /** The message text with the #N prefix stripped (or the original text if no prefix). */
  messageText: string;
}

/**
 * Parses an optional `#N` prefix from a message for one-shot session routing.
 * Pattern: `#N ` at the start, where N is one or more digits, followed by a space.
 * E.g., `#2 do something` -> { targetLabel: 2, messageText: 'do something' }
 */
export function parseHashPrefix(text: string): HashPrefixResult {
  const match = text.match(/^#(\d+) (.*)$/s);
  if (!match) return { targetLabel: null, messageText: text };
  return { targetLabel: parseInt(match[1], 10), messageText: match[2] };
}
