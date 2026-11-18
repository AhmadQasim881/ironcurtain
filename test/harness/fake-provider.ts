/**
 * Fake Anthropic provider for the agent-loop / adversarial test harness.
 *
 * The builtin agent's loop ({@link AgentSession.sendMessage}) is a real
 * `generateText` call with the real `@ai-sdk/anthropic` provider. Tests that
 * replace `generateText` with a `vi.fn()` (test/session.test.ts) never exercise
 * the SDK's actual message shapes or the provider's request contract, so a
 * regression that splits a tool_use/tool_result pair or drops the `tools`
 * definition (the auto-compaction corruption of SES-5) is invisible to them.
 *
 * This module builds a real `@ai-sdk/anthropic` model whose HTTP transport is a
 * fake `fetch` that:
 *
 *   1. Validates every request body the way the real Messages API does — the
 *      two rules a corrupt history trips first:
 *        - every `tool_use` block is followed, in the next message, by a
 *          `tool_result` with the same id (and vice-versa);
 *        - a request that carries any `tool_use`/`tool_result` block must also
 *          define `tools`.
 *      A violation is answered with a 400 `invalid_request_error`, exactly as
 *      the API does, so the agent loop surfaces it as a thrown error rather
 *      than silently "passing".
 *   2. Plays a scripted sequence of assistant turns (tool calls and final
 *      text), recording every request so a test can assert on the pairing the
 *      loop actually sent.
 *
 * No network and no credentials: the model never leaves the process. The
 * validator is exported on its own so a test can prove it is a real oracle
 * (it rejects a hand-built unpaired request), not a no-op.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV3 } from '@ai-sdk/provider';

/** A content block as it appears in an Anthropic Messages request/response. */
interface AnthropicBlock {
  readonly type: string;
  readonly id?: string;
  readonly tool_use_id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly text?: string;
}

interface AnthropicMessage {
  readonly role: string;
  readonly content: string | readonly AnthropicBlock[];
}

/** The subset of an Anthropic Messages request body the validator reads. */
export interface AnthropicRequestBody {
  readonly messages: readonly AnthropicMessage[];
  readonly tools?: unknown;
  readonly system?: unknown;
}

function blocksOf(message: AnthropicMessage): readonly AnthropicBlock[] {
  return typeof message.content === 'string' ? [] : message.content;
}

/**
 * Validates an Anthropic Messages request body against the two contract rules
 * a corrupt agent history trips first. Returns the API-style error message, or
 * `null` when the body is well-formed.
 *
 * This mirrors the real Messages API checks the audit scratch repros relied on
 * (scratchpad/audit/ses/repro-compaction.mts): a `tool_use` must be answered by
 * a `tool_result` in the immediately following message, a `tool_result` must be
 * preceded by its `tool_use`, and any request containing tool blocks must also
 * define `tools`.
 */
export function validateAnthropicMessages(body: AnthropicRequestBody): string | null {
  const messages = body.messages;
  let anyToolBlock = false;

  for (let i = 0; i < messages.length; i++) {
    for (const block of blocksOf(messages[i])) {
      if (block.type === 'tool_use') {
        anyToolBlock = true;
        const next = messages[i + 1] as AnthropicMessage | undefined;
        const paired =
          next !== undefined && blocksOf(next).some((b) => b.type === 'tool_result' && b.tool_use_id === block.id);
        if (!paired) {
          return `messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${String(block.id)}`;
        }
      }
      if (block.type === 'tool_result') {
        anyToolBlock = true;
        const prev = messages[i - 1] as AnthropicMessage | undefined;
        const paired =
          prev !== undefined && blocksOf(prev).some((b) => b.type === 'tool_use' && b.id === block.tool_use_id);
        if (!paired) {
          return `messages.${i}.content: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${String(block.tool_use_id)}`;
        }
      }
    }
  }

  if (anyToolBlock && body.tools === undefined) {
    return 'Requests which include `tool_use` or `tool_result` blocks must define tools.';
  }
  return null;
}

/** One scripted assistant turn the fake provider plays. */
export type ScriptedTurn =
  | {
      /** Emit a `tool_use` block that calls `execute_code` with this TypeScript. */
      readonly kind: 'tool';
      readonly code: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    }
  | {
      /** Emit a final text answer and end the turn. */
      readonly kind: 'text';
      readonly text: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    };

export interface ScriptedAnthropicFetch {
  /** The fake `fetch` to hand to {@link createAnthropic}. */
  readonly fetch: typeof globalThis.fetch;
  /** Every request body the agent loop sent, newest last. */
  readonly requests: AnthropicRequestBody[];
  /** The validator rejections the loop provoked (empty when every request paired cleanly). */
  readonly rejections: string[];
  /** Replace the remaining scripted turns (e.g. between conversation turns). */
  setScript(turns: readonly ScriptedTurn[]): void;
}

function toolUseResponse(turn: Extract<ScriptedTurn, { kind: 'tool' }>, index: number): unknown {
  return {
    id: `msg_${index}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'tool_use', id: `toolu_${index}`, name: 'execute_code', input: { code: turn.code } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: turn.inputTokens ?? 1000, output_tokens: turn.outputTokens ?? 20 },
  };
}

function textResponse(turn: Extract<ScriptedTurn, { kind: 'text' }>, index: number): unknown {
  return {
    id: `msg_${index}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: turn.text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: turn.inputTokens ?? 1000, output_tokens: turn.outputTokens ?? 20 },
  };
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function badRequest(message: string): Response {
  return jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message } }, 400);
}

/**
 * Builds a fake Anthropic `fetch` that validates pairing on every request and
 * plays `turns` in order (repeating a final text turn once exhausted, so a loop
 * that overruns its script still terminates). Each `fetch` call corresponds to
 * one step of the agent loop.
 */
export function createScriptedAnthropicFetch(turns: readonly ScriptedTurn[]): ScriptedAnthropicFetch {
  let script: ScriptedTurn[] = [...turns];
  let step = 0;
  const requests: AnthropicRequestBody[] = [];
  const rejections: string[] = [];

  const fetch: typeof globalThis.fetch = (_input, init) => {
    const raw = init?.body;
    if (typeof raw !== 'string') {
      return Promise.resolve(badRequest('fake provider expects a JSON string body'));
    }
    const body = JSON.parse(raw) as AnthropicRequestBody;
    requests.push(body);

    const violation = validateAnthropicMessages(body);
    if (violation) {
      rejections.push(violation);
      return Promise.resolve(badRequest(violation));
    }

    step += 1;
    const turn = script.shift() ?? { kind: 'text', text: 'done' };
    const payload = turn.kind === 'tool' ? toolUseResponse(turn, step) : textResponse(turn, step);
    return Promise.resolve(jsonResponse(payload, 200));
  };

  return {
    fetch,
    requests,
    rejections,
    setScript(next: readonly ScriptedTurn[]): void {
      script = [...next];
    },
  };
}

/**
 * Builds a real `@ai-sdk/anthropic` `LanguageModelV3` whose HTTP transport is
 * `fetch`. The API key is a dummy — the fake `fetch` never authenticates — and
 * nothing leaves the process.
 */
export function buildAnthropicModel(fetch: typeof globalThis.fetch, modelId = 'claude-sonnet-4-6'): LanguageModelV3 {
  return createAnthropic({ apiKey: 'test-key', fetch })(modelId);
}
