/**
 * Signal session transport - thin adapter implementing the Transport interface.
 *
 * One SignalSessionTransport exists per session. It does not own the
 * WebSocket or manage identity verification - those responsibilities
 * belong to the SignalBotDaemon. The transport's job is to:
 *
 * 1. Block run() until close() is called (session lifetime)
 * 2. Create callback factories that bridge session events to the daemon
 */

import { BaseTransport, type BaseTransportOptions } from '../session/base-transport.js';
import { isStartupNotice, type SessionNotice, type StartupNotice } from '../session/startup-notices.js';
import type { Session, DiagnosticEvent, EscalationRequest } from '../session/types.js';
import { formatSessionNoticesMessage } from './format.js';
import type { SignalBotDaemon } from './signal-bot-daemon.js';
import * as logger from '../logger.js';

export interface SignalSessionTransportOptions extends BaseTransportOptions {
  readonly daemon: SignalBotDaemon;
}

export class SignalSessionTransport extends BaseTransport {
  private session: Session | null = null;
  private readonly daemon: SignalBotDaemon;
  private exitResolve: (() => void) | null = null;

  /** Session label assigned by the daemon after construction. */
  sessionLabel = 0;

  /**
   * Start-up notices (`isStartupNotice`) emitted while the session was being
   * created, before it had a label. The daemon sends them once, right after
   * announcing the session ({@link takeStartupNotices}); null from then on,
   * when a notice is sent as it comes.
   */
  private pendingStartupNotices: StartupNotice[] | null = [];

  constructor(options: SignalSessionTransportOptions) {
    super(options);
    this.daemon = options.daemon;
  }

  /**
   * Implements the session lifecycle. The returned promise resolves when
   * close() is called, which signals that the session is done.
   */
  protected async runSession(session: Session): Promise<void> {
    this.session = session;
    return new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /**
   * Signals the transport to stop. Resolves the run() promise.
   * Does NOT call daemon.endSession() - the daemon owns session
   * lifecycle and calls this method, not the other way around.
   */
  close(): void {
    this.session = null;
    this.exitResolve?.();
    this.exitResolve = null;
  }

  /**
   * Forwards a message through the transport's sendAndLog() pipeline.
   * Called by the daemon to route user messages through the transport layer.
   */
  async forwardMessage(text: string): Promise<string> {
    if (!this.session) {
      throw new Error('No active session');
    }
    return this.sendAndLog(this.session, text);
  }

  // --- Callback factories (wired into SessionOptions by the daemon) ---

  createDiagnosticHandler(): (event: DiagnosticEvent) => void {
    return (event) => {
      const label = this.sessionLabel;
      if (isStartupNotice(event)) {
        if (this.pendingStartupNotices !== null) this.pendingStartupNotices.push(event);
        else this.sendNotices([event]);
        return;
      }
      switch (event.kind) {
        case 'tool_call':
          // Don't send every tool call - too noisy for messaging
          break;
        case 'budget_warning':
          this.daemon.sendSignalMessage(`[#${label}] [Budget warning] ${event.message}`).catch(() => {});
          break;
        case 'budget_exhausted':
          this.daemon.sendSignalMessage(`[#${label}] [Budget exhausted] ${event.message}`).catch(() => {});
          break;
        case 'host_privileged_files':
          // After a turn or at session end, when the label is known.
          this.sendNotices([event]);
          break;
      }
    };
  }

  /**
   * Hands over the start-up notices held since the session was created, for
   * the daemon to send once after announcing the session. Any later one is
   * sent as it comes.
   */
  takeStartupNotices(): readonly StartupNotice[] {
    const notices = this.pendingStartupNotices ?? [];
    this.pendingStartupNotices = null;
    return notices;
  }

  /** Notices quote server-provided text and agent-chosen paths: plain text, never styled. */
  private sendNotices(notices: readonly SessionNotice[]): void {
    this.daemon
      .sendSignalMessage(formatSessionNoticesMessage(this.sessionLabel, notices), { textMode: 'normal' })
      .catch(() => {});
  }

  /**
   * Hands each escalation to the daemon, which records it and sends the
   * coded banner the user must quote to approve it.
   */
  createEscalationHandler(): (request: EscalationRequest) => void {
    return (request) => {
      const label = this.sessionLabel;
      logger.info(
        `[Signal Transport] Escalation fired on session #${label} ` +
          `(tool=${request.serverName}/${request.toolName}, id=${request.escalationId})`,
      );
      void this.daemon.surfaceEscalation(label, request);
    };
  }

  /** Hands each expiry to the daemon, which drops that escalation and tells the user. */
  createEscalationExpiredHandler(): (escalationId: string) => void {
    return (escalationId) => {
      this.daemon.expireEscalation(this.sessionLabel, escalationId);
    };
  }
}
