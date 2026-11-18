/**
 * ToolResultTrimmer -- keeps a long builtin turn within the context window.
 *
 * Compaction runs only between turns, but one turn can run as many
 * execute_code steps as its step cap allows (resourceBudget.maxSteps, or
 * the safety cap when that is disabled), of up to 100 KB each. When a
 * step's input approaches the compaction threshold, the session asks the
 * trimmer to replace older large tool results with a short stub (a preview
 * plus a note that the result was trimmed). The tool call and its
 * toolCallId stay, so every call keeps its result and the history stays
 * valid for every provider.
 *
 * Trimming is sticky: once a result is trimmed, `apply()` replaces it in
 * every later step and in the stored history, so the history matches what
 * the model last saw and the prompt prefix stays stable for caching.
 *
 * Stubs are keyed by toolCallId. Providers give every call its own id, but
 * an OpenAI-compatible server may repeat one (some number calls per
 * response). A stub keyed by a shared id would replace every result with
 * that id, the newest one included, so an id that more than one result
 * carries is never trimmed: its stub is dropped and the id stays untrimmed
 * for the rest of the conversation. Fail-safe: the model may see more
 * text, never the wrong result.
 */

import type { ModelMessage, ToolModelMessage, ToolResultPart } from 'ai';
import { renderToolOutput } from './conversation-history.js';
import { formatKB } from './truncate-result.js';

type ToolResultOutput = ToolResultPart['output'];

export interface ToolResultTrimmerOptions {
  /** How many of the most recent tool results are always left intact. */
  readonly keepRecent: number;
  /** Results whose text is at most this many characters are never trimmed. */
  readonly minChars: number;
  /** Characters of the original result kept as a preview in the stub. */
  readonly previewChars: number;
}

export const DEFAULT_TOOL_RESULT_TRIMMER_OPTIONS: ToolResultTrimmerOptions = {
  keepRecent: 4,
  minChars: 2_000,
  previewChars: 300,
};

function isToolResultPart(part: ToolModelMessage['content'][number]): part is ToolResultPart {
  return part.type === 'tool-result';
}

/** Every tool result in `messages`, oldest first. */
function toolResults(messages: readonly ModelMessage[]): ToolResultPart[] {
  const results: ToolResultPart[] = [];
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (isToolResultPart(part)) results.push(part);
    }
  }
  return results;
}

export class ToolResultTrimmer {
  private readonly options: ToolResultTrimmerOptions;
  /** Stub output per trimmed toolCallId. */
  private readonly stubs = new Map<string, ToolResultOutput>();
  /** toolCallIds seen on more than one result: never trimmed (see the module comment). */
  private readonly sharedIds = new Set<string>();

  constructor(options: ToolResultTrimmerOptions = DEFAULT_TOOL_RESULT_TRIMMER_OPTIONS) {
    this.options = options;
  }

  /** Number of tool results trimmed so far in this conversation. */
  get trimmedCount(): number {
    return this.stubs.size;
  }

  /**
   * Marks every large tool result except the `keepRecent` most recent ones
   * for trimming. Returns how many results were newly marked. Pass the
   * whole conversation: shared ids are detected within `messages`.
   */
  markOlderResults(messages: readonly ModelMessage[]): number {
    const results = toolResults(messages);
    this.recordSharedIds(results);
    let marked = 0;
    for (const part of results.slice(0, Math.max(0, results.length - this.options.keepRecent))) {
      if (this.stubs.has(part.toolCallId) || this.sharedIds.has(part.toolCallId)) continue;
      const text = renderToolOutput(part.output);
      if (text.length <= this.options.minChars) continue;
      this.stubs.set(part.toolCallId, this.buildStub(part.output, text));
      marked++;
    }
    return marked;
  }

  /**
   * Returns `messages` with every marked tool result replaced by its stub.
   * Messages without a marked result are returned as the same objects.
   * Pass the whole conversation: shared ids are detected within `messages`.
   */
  apply(messages: readonly ModelMessage[]): ModelMessage[] {
    if (this.stubs.size === 0) return [...messages];
    this.recordSharedIds(toolResults(messages));
    if (this.stubs.size === 0) return [...messages];
    return messages.map((message) => {
      if (message.role !== 'tool') return message;
      const content = message.content.map((part) => {
        if (!isToolResultPart(part)) return part;
        const stub = this.stubs.get(part.toolCallId);
        return stub === undefined || part.output === stub ? part : { ...part, output: stub };
      });
      const changed = content.some((part, index) => part !== message.content[index]);
      return changed ? { ...message, content } : message;
    });
  }

  /** Forgets every trimmed result (a new conversation starts). */
  reset(): void {
    this.stubs.clear();
    this.sharedIds.clear();
  }

  /** Forgets trimmed results and shared ids that are no longer in `messages` (after compaction). */
  retainOnly(messages: readonly ModelMessage[]): void {
    if (this.stubs.size === 0 && this.sharedIds.size === 0) return;
    const present = new Set(toolResults(messages).map((part) => part.toolCallId));
    for (const id of [...this.stubs.keys()]) {
      if (!present.has(id)) this.stubs.delete(id);
    }
    for (const id of [...this.sharedIds]) {
      if (!present.has(id)) this.sharedIds.delete(id);
    }
  }

  /**
   * Records every toolCallId that more than one of `results` carries and
   * drops its stub, so it can never stand in for another result.
   */
  private recordSharedIds(results: readonly ToolResultPart[]): void {
    const seen = new Set<string>();
    for (const { toolCallId } of results) {
      if (!seen.has(toolCallId)) {
        seen.add(toolCallId);
        continue;
      }
      this.sharedIds.add(toolCallId);
      this.stubs.delete(toolCallId);
    }
  }

  private buildStub(output: ToolResultOutput, text: string): ToolResultOutput {
    // Re-running the whole code would repeat whatever it changed (a message
    // sent, a file written), so the stub asks for the reading part only.
    const value =
      `[IronCurtain trimmed this earlier tool result (${formatKB(text.length)}) to keep the conversation ` +
      'within the context limit. To see the full output, run only the part of the code that read it again; ' +
      'do not repeat actions that changed anything. It began:]\n' +
      `${text.slice(0, this.options.previewChars)}...`;
    const isError = output.type === 'error-text' || output.type === 'error-json';
    return isError ? { type: 'error-text', value } : { type: 'text', value };
  }
}
