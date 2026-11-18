/**
 * Pure helpers for the builtin session's message history.
 *
 * - Bounded text rendering of messages and tool results, used by the
 *   compaction summarizer (which must never receive tool-call/tool-result
 *   parts) and by the tool-result trimmer.
 * - Neutralization of the tags IronCurtain uses to frame its own notes in
 *   the history, so text quoted from tool output cannot close a frame or
 *   forge a message boundary: every tag opener in untrusted text
 *   (escapeUntrustedTags), only frame tags in the user's own text
 *   (escapeFrameTags).
 * - The note recorded when a turn fails after some of its steps finished,
 *   and the size estimate the session uses to manage context between steps.
 *
 * No dependency on AgentSession or on the AI SDK runtime.
 */

import type { ModelMessage } from 'ai';

/**
 * Every user-role message IronCurtain itself writes into the history (the
 * compaction summary and the failed-turn note) starts with this prefix.
 * Only the session and the compactor create user-role messages; tool output
 * reaches the history only inside tool and assistant messages, so it can
 * never produce a message that starts this way.
 */
export const IRONCURTAIN_MESSAGE_PREFIX = '<ironcurtain_';

/** True for a user-role message written by IronCurtain rather than sent by the user. */
export function isIronCurtainMessage(message: ModelMessage): boolean {
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(IRONCURTAIN_MESSAGE_PREFIX)
  );
}

/**
 * Tag names IronCurtain uses to frame history text: the summary frame, the
 * failed-turn note, and the transcript handed to the summarizer.
 */
const FRAME_TAG_PATTERN =
  /<\s*(\/?)\s*(ironcurtain_[a-z0-9_]*|earlier_user_messages|user_message|summary_notes|earlier_summary|transcript|message|tool_call|tool_result)(?=[\s/>]|$)/gi;

/**
 * Escapes the opening `<` of every IronCurtain frame tag in `text` (also
 * spaced variants such as `< /message>`), so the user's own text, which the
 * summary keeps verbatim, cannot accidentally close a frame. Other markup is
 * left untouched. Only for trusted text: it matches the ASCII tag names, so
 * invisible or look-alike characters slip past it. Untrusted text goes
 * through escapeUntrustedTags.
 */
export function escapeFrameTags(text: string): string {
  return text.replace(FRAME_TAG_PATTERN, '&lt;$1$2');
}

/**
 * Characters a model may read as the `<` that opens a tag: `<` itself, its
 * small and fullwidth forms (which NFKC folds to `<`), and the angle
 * brackets and arrowheads drawn like it.
 */
const TAG_OPENERS = /[<\u02C2\u2039\u2329\u27E8\u3008\uFE64\uFF1C]/gu;

/** Characters a model may read as the `/` of a closing tag (after NFKC folding). */
const TAG_SLASHES: ReadonlySet<string> = new Set(['/', '\\', '\u2044', '\u2215', '\u29F8']);

/**
 * Code points that render as nothing: zero-width spaces and joiners, soft
 * hyphens, bidi controls, variation selectors and tag characters. They can
 * hide inside a tag without changing how a model reads it.
 */
const INVISIBLE = /^\p{Default_Ignorable_Code_Point}$/u;
const WHITESPACE = /^\s+$/u;
const TAG_NAME_START = /^[\p{L}_]/u;

/**
 * True when the text from `index` reads as the rest of a tag opening: after
 * any whitespace and invisible characters, an optional slash, then a letter
 * (of any script) or `_`. Characters are compared in NFKC form, so
 * fullwidth slashes and letters count as their ASCII forms.
 */
function startsTagName(text: string, index: number): boolean {
  let slashSeen = false;
  let i = index;
  while (i < text.length) {
    const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
    i += char.length;
    if (INVISIBLE.test(char)) continue;
    const folded = char.normalize('NFKC');
    if (WHITESPACE.test(folded)) continue;
    if (!slashSeen && TAG_SLASHES.has(folded)) {
      slashSeen = true;
      continue;
    }
    return TAG_NAME_START.test(folded);
  }
  return false;
}

/**
 * Escapes, in untrusted text (tool output, the agent's replies and code,
 * notes a summarization model wrote), the opening `<` of anything a model
 * could read as a tag: a `<` or look-alike followed by an optional slash
 * and a letter, with any whitespace or invisible characters in between.
 * It does not depend on the tag name, so look-alike letters, fullwidth
 * forms, and zero-width characters inside a name cannot slip a frame tag
 * through. Other uses of `<` (`a <= b`, `<!--`, `<3`) are left alone; a
 * spaced comparison such as `a < b` is escaped too, which costs only
 * readability.
 */
export function escapeUntrustedTags(text: string): string {
  return text.replace(TAG_OPENERS, (opener: string, offset: number) =>
    startsTagName(text, offset + opener.length) ? '&lt;' : opener,
  );
}

/**
 * Caps `text` at about `maxChars` characters, keeping the head and the tail
 * around an explicit omission marker.
 */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.ceil(maxChars * 0.75);
  const tailChars = Math.max(0, maxChars - headChars);
  const omitted = text.length - headChars - tailChars;
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';
  return `${text.slice(0, headChars)}\n[... ${omitted} characters omitted ...]\n${tail}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON text for a value, or a short placeholder for values JSON cannot encode. */
export function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    // JSON.stringify returns undefined for functions and symbols at runtime.
    const json = JSON.stringify(value) as string | undefined;
    if (json !== undefined) return json;
  } catch {
    // Circular structures and BigInt values: fall through.
  }
  return typeof value === 'bigint' ? value.toString() : '[value not representable as JSON]';
}

/** Plain text of a tool result's `output` (a `ToolResultOutput`), whatever its type. */
export function renderToolOutput(output: unknown): string {
  if (!isRecord(output)) return stringifyValue(output);
  switch (output.type) {
    case 'text':
      return stringifyValue(output.value);
    case 'json':
      return stringifyValue(output.value);
    case 'error-text':
    case 'error-json':
      return `Error: ${stringifyValue(output.value)}`;
    case 'execution-denied':
      return typeof output.reason === 'string' ? `Execution denied: ${output.reason}` : 'Execution denied';
    case 'content':
      return Array.isArray(output.value)
        ? output.value
            .map((part: unknown) =>
              isRecord(part) && part.type === 'text' ? stringifyValue(part.text) : '[non-text content omitted]',
            )
            .join('\n')
        : stringifyValue(output.value);
    default:
      return stringifyValue(output);
  }
}

/** Plain text of a message's content; non-text parts are named, not rendered. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyValue(content);
  return content
    .map((part: unknown) => {
      if (!isRecord(part)) return stringifyValue(part);
      if (part.type === 'text') return stringifyValue(part.text);
      if (part.type === 'image') return '[image omitted]';
      if (part.type === 'file') return '[file omitted]';
      return '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

/** A tool name safe to place in a tag attribute. */
function attributeSafeName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'tool';
}

export interface TranscriptLimits {
  /** Cap for each user or assistant text. */
  readonly textChars: number;
  /** Cap for each tool-call input (the code an execute_code call ran). */
  readonly codeChars: number;
  /** Cap for each tool result. */
  readonly resultChars: number;
  /** Cap for the whole transcript; the oldest messages are left out first. */
  readonly totalChars: number;
}

export interface Transcript {
  readonly text: string;
  /** How many of the oldest messages were left out to respect `totalChars`. */
  readonly omittedMessages: number;
}

/** Text of a tool call: the code for execute_code, the JSON input otherwise. */
function renderToolCallInput(input: unknown): string {
  if (isRecord(input) && typeof input.code === 'string') return input.code;
  return stringifyValue(input);
}

function renderToolResult(
  part: { readonly toolName?: unknown; readonly output?: unknown },
  limits: TranscriptLimits,
): string {
  const body = escapeUntrustedTags(capText(renderToolOutput(part.output), limits.resultChars));
  return `<tool_result name="${attributeSafeName(part.toolName)}">\n${body}\n</tool_result>`;
}

function renderMessage(message: ModelMessage, limits: TranscriptLimits): string | undefined {
  if (message.role === 'tool') {
    const results = message.content.flatMap((part) =>
      part.type === 'tool-result' ? [renderToolResult(part, limits)] : [],
    );
    return results.length > 0 ? `<message role="tool">\n${results.join('\n')}\n</message>` : undefined;
  }

  if (message.role === 'assistant') {
    if (typeof message.content === 'string') {
      const text = escapeUntrustedTags(capText(message.content, limits.textChars));
      return text.length > 0 ? `<message role="assistant">\n${text}\n</message>` : undefined;
    }
    const parts: string[] = [];
    for (const part of message.content as readonly unknown[]) {
      if (!isRecord(part)) continue;
      if (part.type === 'text') {
        const text = stringifyValue(part.text);
        if (text.length > 0) parts.push(escapeUntrustedTags(capText(text, limits.textChars)));
      } else if (part.type === 'tool-call') {
        const code = escapeUntrustedTags(capText(renderToolCallInput(part.input), limits.codeChars));
        parts.push(`<tool_call name="${attributeSafeName(part.toolName)}">\n${code}\n</tool_call>`);
      } else if (part.type === 'tool-result') {
        parts.push(renderToolResult(part, limits));
      } else if (part.type === 'file') {
        parts.push('[file omitted]');
      }
      // Reasoning and approval parts are left out: they add size, not context.
    }
    return parts.length > 0 ? `<message role="assistant">\n${parts.join('\n')}\n</message>` : undefined;
  }

  // A user-role message can embed text the user did not write (a workflow
  // prompt carries upstream agents' output), so it is escaped like the rest.
  const role = isIronCurtainMessage(message) ? 'ironcurtain' : message.role;
  const text = escapeUntrustedTags(capText(contentText(message.content), limits.textChars));
  return `<message role="${role}">\n${text}\n</message>`;
}

/**
 * Renders messages as one bounded, text-only transcript for the summarizer.
 *
 * Tool calls and tool results become plain text, so the summarizer request
 * carries no tool parts: it needs no tool definitions and cannot fail on a
 * tool call whose result is missing. Every part is capped, every tag opener
 * in the content is escaped (tool output cannot forge a `<message
 * role="user">` boundary, not even with invisible or look-alike
 * characters), and when the transcript exceeds `totalChars` the oldest
 * messages are left out.
 */
export function renderTranscript(messages: readonly ModelMessage[], limits: TranscriptLimits): Transcript {
  const entries: string[] = [];
  for (const message of messages) {
    const entry = renderMessage(message, limits);
    if (entry !== undefined) entries.push(entry);
  }
  let total = entries.reduce((sum, entry) => sum + entry.length + 1, 0);
  let start = 0;
  while (start < entries.length - 1 && total > limits.totalChars) {
    total -= entries[start].length + 1;
    start++;
  }
  return { text: entries.slice(start).join('\n'), omittedMessages: start };
}

/**
 * Characters per token assumed for tool output when estimating its size.
 * Code and JSON run at about 3 (prose at about 4), so this errs high.
 */
const CHARS_PER_TOKEN_ESTIMATE = 3;

/** The parts of a finished step (an AI SDK `StepResult`) the estimate reads. */
export interface FinishedStepSize {
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly content?: readonly unknown[];
}

/**
 * Estimated input tokens of the request that follows a finished step: the
 * step's reported input and output plus an estimate for the tool results
 * it appended, which no provider has counted yet. The reported input alone
 * can be far too low: one step can append several 100 KB results, enough
 * to push the next request past the model's context window before a
 * threshold based on reported input is ever reached.
 */
export function estimateNextInputTokens(step: FinishedStepSize): number {
  let resultChars = 0;
  for (const part of step.content ?? []) {
    if (!isRecord(part)) continue;
    if (part.type === 'tool-result') {
      resultChars += stringifyValue(part.output).length;
    } else if (part.type === 'tool-error') {
      resultChars += (part.error instanceof Error ? part.error.message : stringifyValue(part.error)).length;
    }
  }
  const input = step.usage?.inputTokens ?? 0;
  const output = step.usage?.outputTokens ?? 0;
  return input + output + Math.ceil(resultChars / CHARS_PER_TOKEN_ESTIMATE);
}

/** Budget dimensions (ResourceBudgetTracker) as the failed-turn note names them. */
const BUDGET_DIMENSION_NAMES: ReadonlyMap<string, string> = new Map([
  ['tokens', 'token'],
  ['steps', 'step'],
  ['wall_clock', 'time'],
  ['cost', 'cost'],
]);

/**
 * A short, fixed-vocabulary description of why a turn failed, for the
 * failed-turn note: the budget that ran out, or the error's class name.
 * Never the error message, which can carry provider or model text.
 */
export function describeTurnFailure(error: unknown, budgetDimension?: string): string {
  if (budgetDimension !== undefined) {
    return `its ${BUDGET_DIMENSION_NAMES.get(budgetDimension) ?? 'resource'} budget ran out`;
  }
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? `an error occurred (${name})` : 'an error occurred';
}

/**
 * The note recorded after the steps a failed turn finished, so the agent
 * does not forget (and repeat) actions those steps already took. The step
 * that was in progress when the turn failed recorded nothing, so its
 * outcome is unknown. The note holds only fixed text and `reason` (from
 * `describeTurnFailure`): no tool output and no error text from a provider.
 */
export function buildInterruptedTurnNote(reason: string, completedSteps: number): ModelMessage {
  const steps = completedSteps === 1 ? '1 step' : `${completedSteps} steps`;
  return {
    role: 'user',
    content:
      '<ironcurtain_note>\n' +
      `IronCurtain: the previous turn stopped early because ${reason}. ` +
      `Before it stopped, the agent finished ${steps}; they are recorded above. ` +
      "If the agent had started another step, that step's outcome is unknown: " +
      'code it ran may have partly or fully taken effect. ' +
      'Check the current state before repeating any action that has side effects.\n' +
      '</ironcurtain_note>',
  };
}
