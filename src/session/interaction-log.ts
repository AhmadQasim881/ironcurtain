import { createWriteStream, type WriteStream } from 'node:fs';
import { PRIVATE_FILE_MODE, preparePrivateLogFile } from '../observability/private-log-file.js';
import { PATTERN_ONLY_REDACTION, redactString, type LogRedaction } from '../trusted-process/audit-redactor.js';

export interface InteractionEntry {
  timestamp: string;
  sessionId: string;
  turnNumber: number;
  role: 'user' | 'assistant';
  content: string;
}

export interface InteractionLogOptions {
  /**
   * Redaction applied to each entry's `content` before it is written. Pass
   * the session's redaction (`Session.getLogRedaction()`), which masks the
   * known credential values too, or null to write verbatim (audit redaction
   * turned off). Defaults to the audit redactor's patterns alone.
   */
  readonly redaction?: LogRedaction | null;
}

/**
 * Append-only JSONL transcript of a session's turns (`interactions.jsonl`):
 * the user's message and the agent's reply for each turn.
 *
 * The file is created owner-only (0600; an existing file is tightened) and
 * each entry's content passes through the audit redactor, the same masking
 * audit.jsonl gets, so a key the user pasted or the agent read back does not
 * land in the transcript in clear.
 */
export class InteractionLog {
  private stream: WriteStream;
  private readonly redaction: LogRedaction | null;

  constructor(path: string, options: InteractionLogOptions = {}) {
    // Creates the file (and a missing directory) owner-only before the
    // stream opens it, so an unwritable location fails here, not later as an
    // unhandled stream error.
    preparePrivateLogFile(path, { truncate: false });
    this.stream = createWriteStream(path, { flags: 'a', mode: PRIVATE_FILE_MODE });
    this.redaction = options.redaction === undefined ? PATTERN_ONLY_REDACTION : options.redaction;
  }

  log(entry: InteractionEntry): void {
    if (!this.stream.destroyed) {
      const written = this.redaction
        ? { ...entry, content: redactString(entry.content, this.redaction.secrets).redacted }
        : entry;
      this.stream.write(JSON.stringify(written) + '\n');
    }
  }

  async close(): Promise<void> {
    if (this.stream.destroyed || this.stream.closed) {
      return;
    }
    return new Promise((resolve, reject) => {
      this.stream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
