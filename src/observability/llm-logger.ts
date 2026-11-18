/**
 * LLM Interaction Logger -- AI SDK middleware that records every LLM call
 * to a JSONL file, one entry per `doGenerate` call.
 *
 * Call sites:
 *   - the offline policy compilation pipeline: full detail, the whole prompt
 *     in every entry (each step starts a fresh conversation);
 *   - the session runtime, through `createSessionLlmLogMiddleware`
 *     (session-llm-log.ts): the builtin agent (one long-running
 *     conversation, delta logging) and the auto-approver, both following
 *     the user's `observability.llmInteractionLog` setting.
 *
 * Uses `wrapLanguageModel()` with a middleware that intercepts every
 * `doGenerate` call. The caller sets `context.stepName` before each phase so
 * entries are labeled without changing module APIs.
 *
 * Detail levels:
 *   - 'metadata' (the default): timing, token usage, finish reason, the
 *     number of prompt messages, the size of the response text and the
 *     number of tool calls. Never any prompt, response or error text.
 *   - 'full': the prompt and response text as well. With `redaction`, every
 *     string passes through the audit redactor before it is written.
 *
 * Every call is logged, including one whose `doGenerate` throws: that entry
 * records the error's name (and, at full detail, its message), and the error
 * is rethrown unchanged. Writing an entry is best effort: a log that cannot
 * be written is reported once and never fails, or masks the error of, the
 * model call it describes.
 *
 * Log files are created owner-only (0600); a missing log directory is
 * created owner-only (0700).
 */

import { createHash } from 'node:crypto';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import * as logger from '../logger.js';
import { redactObject, redactString, type LogRedaction } from '../trusted-process/audit-redactor.js';
import { appendPrivateLog, preparePrivateLogFile } from './private-log-file.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How much of each call an entry records. */
export type LlmLogDetail = 'metadata' | 'full';

export interface LlmLogUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number | undefined;
}

/** What an entry records about a call whose `doGenerate` threw. */
export interface LlmLogError {
  /** The error's name, such as `AI_APICallError` or `AbortError`. */
  name: string;
  /** The HTTP status of a provider API error, when the error carries one. */
  statusCode?: number;
  /** Full detail only: the error message, redacted like the prompt. */
  message?: string;
}

interface LlmLogEntryFields {
  timestamp: string;
  stepName: string;
  modelId: string;
  durationMs: number;
  /** Calls that returned: token usage. */
  usage?: LlmLogUsage;
  /** Calls whose `doGenerate` threw (the error was rethrown to the caller). */
  error?: LlmLogError;
}

/** An entry at 'metadata' detail: no prompt, response or error text. */
export interface LlmMetadataLogEntry extends LlmLogEntryFields {
  detail: 'metadata';
  /** Number of messages in the prompt, the system message included. */
  promptMessages: number;
  /** Calls that returned: the unified finish reason (`stop`, `tool-calls`, ...). */
  finishReason?: string;
  /** Calls that returned: length of the response text. */
  responseChars?: number;
  /** Calls that returned: number of tool calls in the response. */
  toolCalls?: number;
}

/** An entry at 'full' detail. */
export interface LlmFullLogEntry extends LlmLogEntryFields {
  detail: 'full';
  /**
   * Prompt messages, starting at `promptOffset`. An entry whose
   * `promptOffset` is 0 carries the complete prompt and starts a new
   * transcript. Any other entry carries only the messages appended since the
   * previous entry: the prompt of entry k is the `prompt` of the latest entry
   * at or before k whose `promptOffset` is 0, followed by the `prompt` arrays
   * of the entries after it, up to and including k. Without delta logging
   * every entry has `promptOffset` 0.
   */
  prompt: unknown;
  /** Index into the full prompt where this entry's `prompt` starts. */
  promptOffset: number;
  /**
   * Delta logging only: the entry starts over at offset 0 because the prompt
   * no longer extends the one logged before it (the history was compacted, a
   * failed turn was rolled back, the conversation was reset).
   */
  reset?: true;
  /** Calls that returned: the response's text parts, joined. */
  responseText?: string;
}

export type LlmLogEntry = LlmMetadataLogEntry | LlmFullLogEntry;

export interface LlmLogContext {
  stepName: string;
}

export interface LlmLoggingOptions {
  /** What each entry records. Defaults to 'metadata'. */
  readonly detail?: LlmLogDetail;
  /**
   * Full detail only. When true, an entry carries only the prompt messages
   * added since the previous entry (one long-running conversation, such as
   * the agent session); see `LlmFullLogEntry.prompt`. When false (default),
   * every entry carries the whole prompt (the pipeline, where each step
   * starts a fresh conversation).
   */
  readonly deltaLogging?: boolean;
  /**
   * Keep an existing log file and append to it. By default the file is
   * truncated when the middleware is created, so a run never mixes with the
   * previous one.
   */
  readonly appendOnly?: boolean;
  /**
   * Full detail only: redaction applied to the prompt, response and error
   * text before it is written. Absent or null writes the text verbatim.
   */
  readonly redaction?: LogRedaction | null;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/** What a `doGenerate` call produced. */
type CallOutcome = { readonly result: LanguageModelV3GenerateResult } | { readonly error: unknown };

/**
 * Creates an AI SDK middleware that logs every generate call to a JSONL file.
 *
 * @param logPath - Absolute path to the output JSONL file. It is created (or,
 *   without `appendOnly`, truncated) here, with mode 0600.
 * @param context - Mutable context object. Set `context.stepName` before each
 *   pipeline phase to label the log entries.
 * @param options - Detail level, delta logging, append mode and redaction.
 */
export function createLlmLoggingMiddleware(
  logPath: string,
  context: LlmLogContext,
  options: LlmLoggingOptions = {},
): LanguageModelMiddleware {
  preparePrivateLogFile(logPath, { truncate: options.appendOnly !== true });

  const detail = options.detail ?? 'metadata';
  const redaction = detail === 'full' ? (options.redaction ?? null) : null;
  const deltas = detail === 'full' && options.deltaLogging === true ? new PromptDeltaTracker() : null;
  const writer = new LogWriter(logPath);

  const record = (
    fields: Omit<LlmLogEntryFields, 'usage' | 'error'>,
    prompt: readonly unknown[],
    outcome: CallOutcome,
  ): void => {
    const written = writer.write(() =>
      detail === 'full'
        ? fullEntry(fields, prompt, outcome, deltas, redaction)
        : metadataEntry(fields, prompt, outcome),
    );
    // An entry that was not written must not be counted as logged: the next
    // one then carries the whole prompt again.
    if (!written) deltas?.forget();
  };

  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const start = Date.now();
      const prompt: readonly unknown[] = Array.isArray(params.prompt) ? params.prompt : [params.prompt];
      const fields = () => ({
        timestamp: new Date().toISOString(),
        stepName: context.stepName,
        modelId: model.modelId,
        durationMs: Date.now() - start,
      });

      let result: LanguageModelV3GenerateResult;
      try {
        result = await doGenerate();
      } catch (error) {
        record(fields(), prompt, { error });
        throw error;
      }
      record(fields(), prompt, { result });
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function metadataEntry(
  fields: Omit<LlmLogEntryFields, 'usage' | 'error'>,
  prompt: readonly unknown[],
  outcome: CallOutcome,
): LlmMetadataLogEntry {
  const entry: LlmMetadataLogEntry = { ...fields, detail: 'metadata', promptMessages: prompt.length };
  if ('error' in outcome) {
    entry.error = describeError(outcome.error, null, false);
    return entry;
  }
  const { result } = outcome;
  const finishReason = finishReasonOf(result);
  if (finishReason !== undefined) entry.finishReason = finishReason;
  entry.responseChars = extractTextFromContent(result.content).length;
  entry.toolCalls = result.content.filter((part) => part.type === 'tool-call').length;
  entry.usage = usageOf(result);
  return entry;
}

function fullEntry(
  fields: Omit<LlmLogEntryFields, 'usage' | 'error'>,
  prompt: readonly unknown[],
  outcome: CallOutcome,
  deltas: PromptDeltaTracker | null,
  redaction: LogRedaction | null,
): LlmFullLogEntry {
  const { offset, reset } = deltas ? deltas.next(prompt) : { offset: 0, reset: false };
  const entry: LlmFullLogEntry = {
    ...fields,
    detail: 'full',
    prompt: redactValue(prompt.slice(offset), redaction),
    promptOffset: offset,
    ...(reset ? { reset: true as const } : {}),
  };
  if ('error' in outcome) {
    entry.error = describeError(outcome.error, redaction, true);
    return entry;
  }
  entry.responseText = redactText(extractTextFromContent(outcome.result.content), redaction);
  entry.usage = usageOf(outcome.result);
  return entry;
}

function usageOf(result: LanguageModelV3GenerateResult): LlmLogUsage {
  return {
    inputTokens: result.usage.inputTokens.total,
    outputTokens: result.usage.outputTokens.total,
    cacheReadTokens: result.usage.inputTokens.cacheRead,
    cacheWriteTokens: result.usage.inputTokens.cacheWrite,
  };
}

/** The unified finish reason (older providers report a plain string). */
function finishReasonOf(result: LanguageModelV3GenerateResult): string | undefined {
  const reason: unknown = result.finishReason;
  if (typeof reason === 'string') return reason;
  if (reason !== null && typeof reason === 'object') {
    const unified = (reason as { unified?: unknown }).unified;
    if (typeof unified === 'string') return unified;
  }
  return undefined;
}

/** Name and HTTP status of a failed call, plus (full detail) its message. */
function describeError(error: unknown, redaction: LogRedaction | null, withMessage: boolean): LlmLogError {
  const described: LlmLogError = { name: error instanceof Error ? error.name : typeof error };
  if (error !== null && typeof error === 'object') {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number') described.statusCode = statusCode;
  }
  if (withMessage) {
    described.message = redactText(error instanceof Error ? error.message : String(error), redaction);
  }
  return described;
}

function redactText(text: string, redaction: LogRedaction | null): string {
  return redaction ? redactString(text, redaction.secrets).redacted : text;
}

/**
 * Redacts every string in `value`. The value is first reduced to plain JSON,
 * so what gets redacted is exactly what would be written (a URL becomes its
 * href, binary data its index map), not an object the redactor would copy
 * without its prototype.
 */
function redactValue(value: unknown, redaction: LogRedaction | null): unknown {
  if (!redaction) return value;
  const plain: unknown = JSON.parse(JSON.stringify(value));
  return redactObject(plain, redaction.secrets);
}

// ---------------------------------------------------------------------------
// Delta logging
// ---------------------------------------------------------------------------

/**
 * Tracks which prompt messages delta logging has already written, so that
 * an entry carries only what is new, and notices when the prompt stops
 * extending what was logged: compaction replaces the history with a summary,
 * a failed turn is rolled back, a conversation is reset. The prompt then
 * shrinks, or one of the logged messages changes, and the next entry starts
 * over with the whole prompt.
 *
 * Messages are compared by a hash of their role and content that leaves out
 * `providerOptions`: the Anthropic prompt-cache strategy moves its
 * cache_control marker to a different message every turn, and that must not
 * count as a change.
 */
class PromptDeltaTracker {
  private logged: readonly string[] = [];

  /**
   * Records `prompt` as logged. Returns where its unlogged part starts: after
   * the messages logged before when it extends them, otherwise 0 with `reset`
   * set. The first prompt (or the first after `forget()`) starts at 0
   * without `reset`.
   */
  next(prompt: readonly unknown[]): { offset: number; reset: boolean } {
    const fingerprints = prompt.map(fingerprintMessage);
    const previous = this.logged;
    this.logged = fingerprints;
    if (previous.length === 0) return { offset: 0, reset: false };
    const extendsPrevious =
      fingerprints.length >= previous.length && previous.every((fingerprint, i) => fingerprint === fingerprints[i]);
    return extendsPrevious ? { offset: previous.length, reset: false } : { offset: 0, reset: true };
  }

  /** Forgets what was logged, so the next entry carries the whole prompt. */
  forget(): void {
    this.logged = [];
  }
}

/** SHA-256 of a prompt message's role and content, without providerOptions. */
function fingerprintMessage(message: unknown): string {
  const hash = createHash('sha256');
  if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
    const { role, content } = message as { role?: unknown; content?: unknown };
    hash
      .update(typeof role === 'string' ? role : '')
      .update('\0')
      .update(jsonText(withoutProviderOptions(content)));
  } else {
    hash.update(jsonText(message));
  }
  return hash.digest('hex');
}

/** JSON text of `value`, or '' for a value JSON cannot represent (undefined, a function). */
function jsonText(value: unknown): string {
  const text = JSON.stringify(value) as string | undefined;
  return text ?? '';
}

/** `content` with each part's providerOptions left out (string content is returned as is). */
function withoutProviderOptions(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: unknown) =>
    part !== null && typeof part === 'object' && !Array.isArray(part)
      ? Object.fromEntries(Object.entries(part).filter(([key]) => key !== 'providerOptions'))
      : part,
  );
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/** Appends entries, best effort: a failure is reported once and never thrown. */
class LogWriter {
  private readonly path: string;
  private reported = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Builds and appends one entry. Returns false when it could not be written. */
  write(build: () => LlmLogEntry): boolean {
    try {
      appendPrivateLog(this.path, JSON.stringify(build()) + '\n');
      return true;
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  private report(err: unknown): void {
    if (this.reported) return;
    this.reported = true;
    const message = `[llm-log] Cannot write ${this.path}; LLM calls continue unlogged: ${
      err instanceof Error ? err.message : String(err)
    }`;
    // Sessions capture the logger; offline callers (the pipeline) have none.
    if (logger.isActive()) logger.warn(message);
    else process.stderr.write(`${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function extractTextFromContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((part): part is { type: string; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}
