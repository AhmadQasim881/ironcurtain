import type { Transport } from './transport.js';
import type { SendMessageOptions, Session } from './types.js';
import { InteractionLog, type InteractionEntry } from './interaction-log.js';
import { getSessionInteractionLogPath } from '../config/paths.js';
import { saveSessionMemory } from '../memory/auto-save.js';
import * as logger from '../logger.js';

export interface BaseTransportOptions {
  /** When true, save session memory when the session ends. */
  readonly autoSaveMemory?: boolean;
  /** When true, session is running in Docker mode. */
  readonly dockerMode?: boolean;
}

/**
 * Abstract base class for transports that provides interaction logging
 * and auto-save of session memory.
 *
 * Subclasses implement runSession() instead of run(), and use
 * sendAndLog() instead of session.sendMessage() directly.
 *
 * When autoSaveMemory is enabled, session memory is saved after
 * runSession() completes (for all transport types) but before the
 * session is closed. This is the single place where auto-save is
 * wired in, so subclasses do not need to handle it individually.
 */
export abstract class BaseTransport implements Transport {
  private interactionLog: InteractionLog | null = null;
  private turnCounter = 0;
  private readonly autoSaveMemory: boolean;
  private readonly dockerMode: boolean;

  constructor(options?: BaseTransportOptions) {
    this.autoSaveMemory = options?.autoSaveMemory ?? false;
    this.dockerMode = options?.dockerMode ?? false;
  }

  async run(session: Session): Promise<void> {
    const logPath = getSessionInteractionLogPath(session.getInfo().id);
    // The session knows its configuration's redaction (audit redactor plus
    // known credential values, or none when auditRedaction is off); a session
    // that does not say gets the audit redactor's patterns.
    this.interactionLog = new InteractionLog(logPath, { redaction: session.getLogRedaction?.() });
    try {
      await this.runSession(session);
      await this.autoSaveIfEnabled(session);
    } finally {
      await this.interactionLog.close();
      this.interactionLog = null;
    }
  }

  private async autoSaveIfEnabled(session: Session): Promise<void> {
    if (!this.autoSaveMemory) return;
    logger.info('[BaseTransport] Auto-saving session memory...');
    await saveSessionMemory(session, {
      dockerMode: this.dockerMode,
      sendFn: (msg, options) => this.sendAndLog(session, msg, options),
    });
  }

  /** Subclasses implement this instead of run(). */
  protected abstract runSession(session: Session): Promise<void>;

  abstract close(): void;

  /**
   * Sends a message through the session and logs both sides. `options`
   * (the message's origin) is passed to the session unchanged, so a
   * system-generated turn is never recorded as trusted user context.
   */
  protected async sendAndLog(session: Session, userMessage: string, options?: SendMessageOptions): Promise<string> {
    const turnNumber = ++this.turnCounter;
    const sessionId = session.getInfo().id;

    this.logEntry({ sessionId, turnNumber, role: 'user', content: userMessage });
    // A plain user turn keeps the one-argument call; only a turn with an
    // explicit origin passes the options.
    const response =
      options === undefined ? await session.sendMessage(userMessage) : await session.sendMessage(userMessage, options);
    this.logEntry({ sessionId, turnNumber, role: 'assistant', content: response });

    return response;
  }

  private logEntry(fields: Omit<InteractionEntry, 'timestamp'>): void {
    this.interactionLog?.log({ timestamp: new Date().toISOString(), ...fields });
  }
}
