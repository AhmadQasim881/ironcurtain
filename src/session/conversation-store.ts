/**
 * Saved conversation of a builtin (Code Mode) session.
 *
 * After every recorded user turn, and after a failed one that kept its
 * finished steps, AgentSession rewrites `<sessionDir>/messages.jsonl` with
 * its model-visible history: the AI SDK messages exactly as the next turn
 * would send them, which begin with the `<ironcurtain_conversation_summary>`
 * message once older turns have been compacted, and hold trimmed tool
 * results in their trimmed form. `ironcurtain start --resume <id>` loads the
 * file back, so the agent continues the conversation instead of starting
 * blank.
 *
 * Format (JSON Lines): one header line, then one ModelMessage per line.
 *
 *   {"format":"ironcurtain-builtin-conversation","version":1,"savedAt":"...","messageCount":2,"lastInputTokens":1234}
 *   {"role":"user","content":"..."}
 *   {"role":"assistant","content":[...]}
 *
 * `lastInputTokens` is the compactor's trigger: the estimated input size of
 * the request after the last saved step (that step's input and output plus
 * the tool results it appended). The compactor uses it to decide whether to
 * compact before the next turn, so a resumed session compacts exactly when
 * the original would have.
 *
 * `summary` (optional) is present when the first message is a compaction
 * summary the session wrote: what that summary was built from (the user's
 * messages it keeps verbatim, how many older ones it left out, the
 * summarizer's notes; see CompactionSummaryState in message-compactor.ts).
 * A resumed session's compactor takes the summary back as its own only when
 * this record rebuilds the message exactly, so the user's earlier messages
 * stay verbatim at its next compaction instead of being summarized again as
 * notes; a well-formed record that does not rebuild it is ignored, a
 * malformed one makes the file invalid. Readers that predate the field
 * ignore it, so the version stays 1.
 *
 * The file is host-owned state. The session directory lies outside the
 * agent's sandbox, and only the trusted process writes it. It holds the whole
 * conversation, tool output included, so it is written with mode 0600,
 * atomically (a temporary file renamed over the name, never written through a
 * link), and read through one no-follow descriptor. A file that does not
 * validate completely is an error, never a partial history: resuming with
 * silently missing context is the failure this file exists to prevent.
 */

import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { modelMessageSchema, type ModelMessage } from 'ai';
import { z } from 'zod';
import { SESSION_MESSAGES_FILENAME } from '../config/paths.js';
import { readHardenedFile, writeFileNoFollowAtomic } from '../hardened-fs.js';
import { errorMessage } from '../utils/error-message.js';
import type { CompactionSummaryState } from './message-compactor.js';

const CONVERSATION_FORMAT = 'ironcurtain-builtin-conversation';
const CONVERSATION_VERSION = 1;

/**
 * Largest saved conversation accepted on load. A history the model still
 * accepts is a few megabytes at most (it must fit the context window), so
 * this bound only rejects a file that is not one of ours.
 */
const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;

/** The model-visible state of a builtin conversation. */
export interface StoredConversation {
  /** AI SDK messages, oldest first; never contains a system message. */
  readonly messages: readonly ModelMessage[];
  /**
   * The compactor's trigger: estimated input tokens of the request after the
   * last saved step (see estimateNextInputTokens in conversation-history.ts).
   */
  readonly lastInputTokens: number;
  /**
   * What the compaction summary `messages` starts with was built from, when
   * the session wrote that summary itself (see the module comment).
   */
  readonly summary?: CompactionSummaryState;
}

const summaryStateSchema = z.object({
  userMessages: z.array(z.string()),
  omittedUserMessages: z.number().int().nonnegative(),
  notes: z.string(),
});

const headerSchema = z.object({
  format: z.literal(CONVERSATION_FORMAT),
  version: z.number().int(),
  savedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  lastInputTokens: z.number().int().nonnegative(),
  /** Validated on its own (summaryStateSchema), for a precise error. */
  summary: z.unknown().optional(),
});

/**
 * Atomically replaces `<sessionDir>/messages.jsonl` with `conversation`.
 * `sessionDir` must be the session's real, absolute directory.
 */
export function saveConversation(sessionDir: string, conversation: StoredConversation): void {
  const tokens = conversation.lastInputTokens;
  const { summary } = conversation;
  const header: z.infer<typeof headerSchema> = {
    format: CONVERSATION_FORMAT,
    version: CONVERSATION_VERSION,
    savedAt: new Date().toISOString(),
    messageCount: conversation.messages.length,
    // A provider's odd usage report must not make the file unloadable
    // (JSON has no NaN or Infinity).
    lastInputTokens: Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0,
    ...(summary === undefined
      ? {}
      : {
          summary: {
            userMessages: [...summary.userMessages],
            omittedUserMessages: summary.omittedUserMessages,
            notes: summary.notes,
          },
        }),
  };
  // JSON.stringify escapes every line break inside strings, so each record
  // is exactly one line.
  const lines = [JSON.stringify(header), ...conversation.messages.map((message) => JSON.stringify(message))];
  writeFileNoFollowAtomic(sessionDir, SESSION_MESSAGES_FILENAME, `${lines.join('\n')}\n`, 0o600);
}

/**
 * Loads the conversation saved in `<sessionDir>/messages.jsonl`.
 *
 * Returns `undefined` when there is none (a session that never completed a
 * user turn, or one created before conversations were saved).
 *
 * @throws {Error} when the file exists but is not a complete, valid saved
 *   conversation (a symlink, unreadable, too large, malformed, from a newer
 *   format version, or any message that is not a valid non-system message).
 */
export function loadConversation(sessionDir: string): StoredConversation | undefined {
  const path = resolve(sessionDir, SESSION_MESSAGES_FILENAME);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read saved conversation ${path}: ${errorMessage(error)}`, { cause: error });
  }
  const bytes = readHardenedFile(path, {
    label: 'saved conversation',
    minBytes: 1,
    maxBytes: MAX_CONVERSATION_BYTES,
  });
  return parseConversation(bytes.toString('utf8'), path);
}

function parseConversation(text: string, path: string): StoredConversation {
  const invalid = (detail: string): Error => new Error(`saved conversation ${path} is invalid: ${detail}`);

  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const [headerLine, ...messageLines] = lines;

  const header = headerSchema.safeParse(parseJsonLine(headerLine, 1, invalid));
  if (!header.success) throw invalid('line 1 is not a conversation header');
  if (header.data.version !== CONVERSATION_VERSION) {
    throw invalid(
      `format version ${header.data.version} is not supported (expected ${CONVERSATION_VERSION}); ` +
        'it was probably saved by a different IronCurtain version',
    );
  }
  if (messageLines.length !== header.data.messageCount) {
    throw invalid(`the header announces ${header.data.messageCount} messages but ${messageLines.length} follow`);
  }
  let summary: CompactionSummaryState | undefined;
  if (header.data.summary !== undefined) {
    const parsed = summaryStateSchema.safeParse(header.data.summary);
    if (!parsed.success) throw invalid('the compaction summary record on line 1 is malformed');
    summary = parsed.data;
  }

  const messages = messageLines.map((line, index): ModelMessage => {
    const lineNumber = index + 2;
    const parsed = modelMessageSchema.safeParse(parseJsonLine(line, lineNumber, invalid));
    if (!parsed.success) throw invalid(`line ${lineNumber} is not a valid conversation message`);
    // The system prompt is rebuilt on every start and passed separately; a
    // session never stores one in its history, so a saved one is not ours.
    if (parsed.data.role === 'system') throw invalid(`line ${lineNumber} is a system message`);
    return parsed.data;
  });

  return {
    messages,
    lastInputTokens: header.data.lastInputTokens,
    ...(summary === undefined ? {} : { summary }),
  };
}

function parseJsonLine(line: string | undefined, lineNumber: number, invalid: (detail: string) => Error): unknown {
  if (line === undefined || line === '') throw invalid(`line ${lineNumber} is empty`);
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw invalid(`line ${lineNumber} is not valid JSON`);
  }
}
