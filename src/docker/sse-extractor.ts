/**
 * Token-stream extraction for the MITM proxy: the live view of an LLM
 * response (web UI, `observe`, the workflow token counter, OpenRouter's
 * authoritative cost).
 *
 * The extractor is a passive `ResponseObservationHub` consumer and never sits
 * in the upstream-to-client pipe; the forwarded bytes are untouched and never
 * wait on it. The hub decodes the response once (gzip, deflate, br), frames
 * SSE once with split-UTF-8 handling (a StringDecoder), and isolates this
 * consumer behind its own resource and exception limits. This module maps the
 * frames, or a buffered non-streaming JSON body, to TokenStreamEvents.
 *
 * Handles Anthropic and OpenAI SSE formats. Unknown providers emit a raw
 * event for every SSE event.
 */

import type { ResponseObservationConsumer } from './llm-observation/response-observation-hub.js';
import type { SseEventFrame } from './llm-observation/sse-event-framer.js';
import type { TokenStreamEvent, SseEventCallback, SseProvider } from './token-stream-types.js';

/**
 * Max decoded bytes of a non-streaming JSON response buffered for token
 * stream extraction. The response is still forwarded to the client unchanged;
 * past the cap only the extraction is skipped. This protects the proxy from
 * unbounded memory growth on very large completions.
 */
export const MAX_JSON_RESPONSE_CAPTURE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Safely extract a string from an unknown value. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Safely extract a number from an unknown value. */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

/** Safely extract a record from an unknown value. */
function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Safely extract an array from an unknown value. */
function arr(value: unknown): Array<Record<string, unknown>> | undefined {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : undefined;
}

/** First argument that is a number, else undefined (to distinguish absent from 0). */
function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === 'number') return value;
  return undefined;
}

/** OpenRouter-only usage fields surfaced on the `message_end` event (§10.2). */
interface OpenRouterUsageFields {
  readonly costUsd?: number;
  readonly cachedTokens?: number;
}

/**
 * Extracts OpenRouter's authoritative `usage.cost` (USD) and cache-read token
 * count from a terminal usage object. OpenRouter reports cache reads under a
 * DIFFERENT key per wire format (§10.2), so all three are accepted:
 *   - Anthropic skin (`/api/v1/messages`):        `cache_read_input_tokens`
 *   - Chat Completions (`/api/v1/chat/completions`): `prompt_tokens_details.cached_tokens`
 *   - Responses (`/api/v1/responses`):             `input_tokens_details.cached_tokens`
 * `cost` is a top-level field of the usage object on every skin. Native
 * (non-OpenRouter) usage objects carry none of these, so both fields come back
 * undefined and the event carries no extra data.
 */
function extractOpenRouterUsage(usage: Record<string, unknown> | undefined): OpenRouterUsageFields {
  if (!usage) return {};
  const promptDetails = obj(usage['prompt_tokens_details']);
  const inputDetails = obj(usage['input_tokens_details']);
  const cachedTokens = firstNumber(
    usage['cache_read_input_tokens'],
    promptDetails?.['cached_tokens'],
    inputDetails?.['cached_tokens'],
  );
  return {
    ...(typeof usage['cost'] === 'number' ? { costUsd: usage['cost'] } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

function makeMessageEnd(
  stopReason: string,
  inputTokens: number,
  outputTokens: number,
  usage?: OpenRouterUsageFields,
): TokenStreamEvent {
  return {
    kind: 'message_end',
    stopReason,
    inputTokens,
    outputTokens,
    // `usage` (from extractOpenRouterUsage) already contains ONLY the defined
    // OpenRouter fields, so spreading it omits absent keys without re-guarding.
    ...(usage ?? {}),
    timestamp: Date.now(),
  };
}

/**
 * Maps decoded SSE event frames of one response to TokenStreamEvents.
 *
 * Framing (line endings, multi-line data, split UTF-8, size limits) is the
 * hub's SseEventFramer's job; this class only interprets the payloads. If
 * parsing fails for an event, a `raw` event is emitted instead. Listener
 * errors are swallowed: one broken subscriber must not stop the stream.
 */
export class TokenStreamSseParser {
  constructor(
    private readonly provider: SseProvider,
    private readonly onEvent: SseEventCallback,
  ) {}

  onFrame(frame: SseEventFrame): void {
    if (this.provider === 'unknown') {
      this.emitSafe({ kind: 'raw', eventType: 'unknown_provider', data: frame.dataUtf8, timestamp: Date.now() });
      return;
    }
    if (this.provider === 'anthropic') {
      this.parseAnthropicData(frame.dataUtf8, frame.eventType);
    } else {
      this.parseOpenaiData(frame.dataUtf8);
    }
  }

  private parseAnthropicData(data: string, eventType: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      this.emitSafe({ kind: 'raw', eventType: eventType || 'parse_error', data, timestamp: Date.now() });
      return;
    }

    const root = obj(parsed);
    if (!root) return;

    const type = str(root['type']);
    const now = Date.now();

    if (type === 'message_start') {
      const message = obj(root['message']);
      this.emitSafe({ kind: 'message_start', model: str(message?.['model'], 'unknown'), timestamp: now });
      return;
    }

    if (type === 'content_block_delta') {
      const delta = obj(root['delta']);
      if (!delta) return;

      const deltaType = str(delta['type']);
      if (deltaType === 'text_delta') {
        this.emitSafe({ kind: 'text_delta', text: str(delta['text']), timestamp: now });
        return;
      }
      if (deltaType === 'input_json_delta') {
        this.emitSafe({ kind: 'tool_use', toolName: '', inputDelta: str(delta['partial_json']), timestamp: now });
        return;
      }
    }

    if (type === 'content_block_start') {
      const block = obj(root['content_block']);
      if (str(block?.['type']) === 'tool_use') {
        this.emitSafe({ kind: 'tool_use', toolName: str(block?.['name']), inputDelta: '', timestamp: now });
        return;
      }
    }

    if (type === 'message_delta') {
      const delta = obj(root['delta']);
      const usage = obj(root['usage']);
      this.emitSafe(
        makeMessageEnd(str(delta?.['stop_reason']), 0, num(usage?.['output_tokens']), extractOpenRouterUsage(usage)),
      );
      return;
    }

    if (type === 'message_stop') {
      this.emitSafe({ kind: 'raw', eventType: 'message_stop', data, timestamp: now });
      return;
    }

    if (type === 'error') {
      const error = obj(root['error']);
      this.emitSafe({ kind: 'error', message: str(error?.['message'], data), timestamp: now });
      return;
    }

    // Unknown Anthropic event type -- emit as raw.
    this.emitSafe({ kind: 'raw', eventType: type || eventType || 'unknown', data, timestamp: now });
  }

  private parseOpenaiData(data: string): void {
    if (data.trim() === '[DONE]') {
      this.emitSafe(makeMessageEnd('stop', 0, 0));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      this.emitSafe({ kind: 'raw', eventType: 'parse_error', data, timestamp: Date.now() });
      return;
    }

    const root = obj(parsed);
    if (!root) return;

    // OpenRouter Responses wire (Codex): the terminal `response.completed` /
    // `response.done` event carries authoritative usage under `response.usage`.
    // The rest of this parser understands only the chat-completions `choices`
    // shape, so without this branch the Responses cost/cache is dropped (§10.2).
    const rootType = str(root['type']);
    if (rootType === 'response.completed' || rootType === 'response.done') {
      const response = obj(root['response']);
      const status = str(response?.['status']) || 'stop';
      this.emitSafe(makeMessageEnd(status, 0, 0, extractOpenRouterUsage(obj(response?.['usage']))));
      return;
    }

    const now = Date.now();
    const choices = arr(root['choices']);
    if (!choices || choices.length === 0) {
      const model = typeof root['model'] === 'string' ? root['model'] : undefined;
      if (model) {
        this.emitSafe({ kind: 'message_start', model, timestamp: now });
        return;
      }
      this.emitSafe({ kind: 'raw', eventType: 'openai_chunk', data, timestamp: now });
      return;
    }

    const choice = choices[0];
    const delta = obj(choice['delta']);
    if (!delta) {
      const finishReason = str(choice['finish_reason']) || undefined;
      if (finishReason) {
        this.emitSafe(makeMessageEnd(finishReason, 0, 0, extractOpenRouterUsage(obj(root['usage']))));
      }
      return;
    }

    if (typeof delta['content'] === 'string') {
      this.emitSafe({ kind: 'text_delta', text: delta['content'], timestamp: now });
      return;
    }

    const toolCalls = arr(delta['tool_calls']);
    if (toolCalls && toolCalls.length > 0) {
      const tc = toolCalls[0];
      const fn = obj(tc['function']);
      this.emitSafe({
        kind: 'tool_use',
        toolName: str(fn?.['name']),
        inputDelta: str(fn?.['arguments']),
        timestamp: now,
      });
      return;
    }

    // Empty delta with finish_reason (common OpenAI pattern for stream end).
    // OpenRouter rides authoritative usage on this final chunk (§10.2).
    const finishReason = str(choice['finish_reason']) || undefined;
    if (finishReason) {
      this.emitSafe(makeMessageEnd(finishReason, 0, 0, extractOpenRouterUsage(obj(root['usage']))));
      return;
    }

    // Unknown delta shape -- emit as raw.
    this.emitSafe({ kind: 'raw', eventType: 'openai_delta', data, timestamp: now });
  }

  /** Invoke the callback, swallowing any listener errors. */
  private emitSafe(event: TokenStreamEvent): void {
    emitSafe(this.onEvent, event);
  }
}

function emitSafe(onEvent: SseEventCallback, event: TokenStreamEvent): void {
  try {
    onEvent(event);
  } catch {
    // Listener errors must never propagate into observation.
  }
}

/**
 * Token stream events of a non-streaming JSON response body (decoded bytes).
 * Emits message_start (model), text_delta (content), and message_end (usage,
 * plus OpenRouter's authoritative `usage.cost` and cache reads). Returns no
 * events for a body that is not a JSON object.
 */
export function tokenStreamEventsFromJson(body: Buffer): TokenStreamEvent[] {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = obj(JSON.parse(body.toString('utf-8')) as unknown);
  } catch {
    return []; // Not valid JSON -- nothing to extract
  }
  if (!parsed) return [];

  const events: TokenStreamEvent[] = [];
  const now = Date.now();

  // Anthropic format: { model, content: [{type: 'text', text: '...'}], usage: {input_tokens, output_tokens}, stop_reason }
  const model = typeof parsed['model'] === 'string' ? parsed['model'] : null;
  if (model) events.push({ kind: 'message_start', model, timestamp: now });

  // Extract text from content blocks (Anthropic) or choices (OpenAI)
  for (const block of arr(parsed['content']) ?? []) {
    const b = obj(block);
    if (b?.['type'] === 'text' && typeof b['text'] === 'string') {
      events.push({ kind: 'text_delta', text: b['text'], timestamp: now });
    }
  }
  for (const choice of arr(parsed['choices']) ?? []) {
    const message = obj(obj(choice)?.['message']);
    if (typeof message?.['content'] === 'string') {
      events.push({ kind: 'text_delta', text: message['content'], timestamp: now });
    }
  }

  // Usage and stop reason. Anthropic: input_tokens/output_tokens; OpenAI: prompt_tokens/completion_tokens.
  const usage = obj(parsed['usage']);
  const stopReason = typeof parsed['stop_reason'] === 'string' ? parsed['stop_reason'] : 'stop';
  const inputTokens = firstNumber(usage?.['input_tokens'], usage?.['prompt_tokens']) ?? 0;
  const outputTokens = firstNumber(usage?.['output_tokens'], usage?.['completion_tokens']) ?? 0;
  events.push(makeMessageEnd(stopReason, inputTokens, outputTokens, extractOpenRouterUsage(usage)));
  return events;
}

/**
 * Output of `createBoundedJsonResponseCapture` -- the stateful hooks used to
 * drive a bounded capture over a chunked response stream.
 */
export interface BoundedJsonResponseCapture {
  /** Feed a chunk into the capture buffer. Always safe to call. */
  onData(chunk: Buffer): void;
  /**
   * Signal end-of-stream. The callback receives the concatenated buffer,
   * or `null` if the capture overflowed and was discarded.
   */
  onEnd(onComplete: (body: Buffer | null) => void): void;
}

/**
 * Create a size-bounded capture for a JSON response body.
 *
 * Up to `maxBytes` of data is accumulated into an internal chunk array.
 * Once that threshold is crossed, any already-buffered chunks are released
 * (so large responses do not pin memory) and further chunks are ignored.
 */
export function createBoundedJsonResponseCapture(
  maxBytes: number = MAX_JSON_RESPONSE_CAPTURE_BYTES,
): BoundedJsonResponseCapture {
  let chunks: Buffer[] = [];
  let capturedBytes = 0;

  return {
    onData(chunk: Buffer): void {
      if (capturedBytes > maxBytes) return;
      capturedBytes += chunk.length;
      if (capturedBytes > maxBytes) {
        chunks = [];
        return;
      }
      chunks.push(chunk);
    },
    onEnd(onComplete: (body: Buffer | null) => void): void {
      if (capturedBytes > maxBytes) {
        onComplete(null);
        return;
      }
      const body = Buffer.concat(chunks);
      chunks = [];
      onComplete(body);
    },
  };
}

export interface TokenStreamConsumerOptions {
  /** Unique among the consumers of one hub. */
  readonly id: string;
  readonly provider: SseProvider;
  /** True for an SSE response (frames); false for a buffered JSON body. */
  readonly streaming: boolean;
  /** Receives every extracted event; it is called from the hub's observation pump, never from forwarding. */
  readonly onEvent: SseEventCallback;
}

/**
 * The token stream's `ResponseObservationHub` consumer for one response.
 *
 * SSE: frames map to events as they arrive. Past this consumer's hub limits
 * (decoded bytes, event count, framing) it keeps only usage-bearing events
 * (usage scan), so the final `message_end` and its cost still arrive; a
 * `raw`/`truncated` event marks where the live text stopped.
 *
 * JSON: decoded bytes are buffered up to MAX_JSON_RESPONSE_CAPTURE_BYTES (the
 * hub detaches the consumer past it) and extracted when the body ends.
 */
export function createTokenStreamConsumer(options: TokenStreamConsumerOptions): ResponseObservationConsumer {
  const { id, onEvent } = options;
  if (options.streaming) {
    const parser = new TokenStreamSseParser(options.provider, onEvent);
    return {
      id,
      onSseEvent: (frame) => parser.onFrame(frame),
      usageScanAfterLimits: true,
      onDegrade: () => emitSafe(onEvent, { kind: 'raw', eventType: 'truncated', data: '', timestamp: Date.now() }),
    };
  }
  const capture = createBoundedJsonResponseCapture(MAX_JSON_RESPONSE_CAPTURE_BYTES);
  return {
    id,
    maxDecodedBytes: MAX_JSON_RESPONSE_CAPTURE_BYTES,
    onDecodedChunk: (chunk) => capture.onData(chunk),
    onEnd: () =>
      capture.onEnd((body) => {
        if (body === null) return; // overflowed -- skip extraction
        for (const event of tokenStreamEventsFromJson(body)) emitSafe(onEvent, event);
      }),
  };
}
