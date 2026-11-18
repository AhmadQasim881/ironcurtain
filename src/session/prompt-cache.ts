/**
 * Prompt caching strategies for multi-turn sessions.
 *
 * Anthropic models benefit from explicit cache-control markers on system
 * prompts, tool definitions, and conversation history breakpoints.
 * OpenAI and Google cache automatically, so they use the NoOp strategy.
 *
 * Anthropic accepts at most four breakpoints per request (the AI SDK drops
 * any beyond that, the latest first). A builtin session's requests use
 * exactly four: the system prompt, the tool definitions, the history before
 * the turn's user message (reused by the next turn), and the end of the
 * step's prompt (reused by the next step of the same turn).
 */

import type { ModelMessage, SystemModelMessage, ToolSet } from 'ai';
import { parseModelId } from '../config/model-provider.js';

const ANTHROPIC_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
} as const;

/**
 * Strategy for applying provider-specific prompt caching hints.
 * Implementations are stateless — safe to share across turns.
 */
export interface PromptCacheStrategy {
  /** Wrap the system prompt with cache-control metadata (if supported). */
  wrapSystemPrompt(prompt: string): string | SystemModelMessage;

  /**
   * Add cache-control metadata to the tool definitions (if supported): one
   * breakpoint on the last tool caches every definition before it too.
   */
  wrapTools(tools: ToolSet): ToolSet;

  /**
   * Add a cache breakpoint to the conversation history so the provider
   * can cache everything up to (but not including) the latest user message.
   * Returns a shallow copy — never mutates the input array or its elements.
   */
  applyHistoryBreakpoint(messages: readonly ModelMessage[]): ModelMessage[];

  /**
   * Add a cache breakpoint on the last message of one step's prompt (the
   * user message in a turn's first step, the newest tool result after
   * that), so the next step of the turn reads everything up to it from the
   * cache instead of paying for the growing tail again. Applied to each
   * step's prompt separately (the AI SDK's `prepareStep`): the history the
   * session keeps never carries it. Returns a shallow copy — never mutates
   * the input array or its elements.
   */
  applyStepBreakpoint(messages: readonly ModelMessage[]): ModelMessage[];
}

/** `message` with Anthropic's cache-control merged into its provider options. */
function withCacheControl(message: ModelMessage): ModelMessage {
  return {
    ...message,
    providerOptions: {
      ...message.providerOptions,
      ...ANTHROPIC_CACHE_CONTROL,
    },
  };
}

/**
 * Anthropic-specific strategy: marks system prompt, tools, a history
 * breakpoint and a per-step breakpoint with `cacheControl: { type: 'ephemeral' }`.
 */
export class AnthropicCacheStrategy implements PromptCacheStrategy {
  wrapSystemPrompt(prompt: string): SystemModelMessage {
    return {
      role: 'system',
      content: prompt,
      providerOptions: ANTHROPIC_CACHE_CONTROL,
    };
  }

  wrapTools(tools: ToolSet): ToolSet {
    // The provider sends the tools in this order; a breakpoint on the last
    // one caches all of them while using a single breakpoint however many
    // tools there are.
    const entries = Object.entries(tools);
    return Object.fromEntries(
      entries.map(([name, def], index) => [
        name,
        index === entries.length - 1 ? { ...def, providerOptions: ANTHROPIC_CACHE_CONTROL } : def,
      ]),
    );
  }

  applyHistoryBreakpoint(messages: readonly ModelMessage[]): ModelMessage[] {
    const copy = [...messages];
    if (copy.length < 2) return copy;

    // Mark the second-to-last message (the one before the newest user message)
    // so everything up to that point is cached.
    const idx = copy.length - 2;
    copy[idx] = withCacheControl(copy[idx]);
    return copy;
  }

  applyStepBreakpoint(messages: readonly ModelMessage[]): ModelMessage[] {
    const copy = [...messages];
    if (copy.length === 0) return copy;
    const idx = copy.length - 1;
    copy[idx] = withCacheControl(copy[idx]);
    return copy;
  }
}

/**
 * No-op strategy for providers that cache automatically (OpenAI, Google)
 * or for unknown providers where we don't want to add metadata.
 */
export class NoOpCacheStrategy implements PromptCacheStrategy {
  wrapSystemPrompt(prompt: string): string {
    return prompt;
  }

  wrapTools(tools: ToolSet): ToolSet {
    return tools;
  }

  applyHistoryBreakpoint(messages: readonly ModelMessage[]): ModelMessage[] {
    return [...messages];
  }

  applyStepBreakpoint(messages: readonly ModelMessage[]): ModelMessage[] {
    return [...messages];
  }
}

/**
 * Factory: selects the right cache strategy based on the model's provider.
 */
export function createCacheStrategy(qualifiedModelId: string): PromptCacheStrategy {
  const { provider } = parseModelId(qualifiedModelId);
  if (provider === 'anthropic') {
    return new AnthropicCacheStrategy();
  }
  return new NoOpCacheStrategy();
}
