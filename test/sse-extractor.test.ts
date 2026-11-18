/**
 * Tests for the token-stream extractor: provider-specific mapping of SSE
 * frames to TokenStreamEvents (TokenStreamSseParser) and the
 * ResponseObservationHub consumer the MITM proxy attaches per response.
 *
 * Framing itself (line endings, chunk boundaries, split UTF-8, limits) is the
 * hub's SseEventFramer; these tests feed bytes through a real framer so the
 * extractor sees exactly what it sees in production.
 */

import { describe, it, expect } from 'vitest';
import * as zlib from 'node:zlib';
import { SseEventFramer } from '../src/docker/llm-observation/sse-event-framer.js';
import { ResponseObservationHub } from '../src/docker/llm-observation/response-observation-hub.js';
import {
  MAX_JSON_RESPONSE_CAPTURE_BYTES,
  TokenStreamSseParser,
  createTokenStreamConsumer,
} from '../src/docker/sse-extractor.js';
import type { SseProvider, TokenStreamEvent } from '../src/docker/token-stream-types.js';

/** Frame `input` (one or more chunks) and map every frame to events. */
function run(provider: SseProvider, input: string | string[] | Buffer[]): TokenStreamEvent[] {
  const events: TokenStreamEvent[] = [];
  const parser = new TokenStreamSseParser(provider, (event) => {
    events.push(event);
  });
  const framer = new SseEventFramer();
  const chunks = Array.isArray(input) ? input : [input];
  for (const chunk of chunks) {
    framer.feed(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk, (frame) => parser.onFrame(frame));
  }
  framer.finish((frame) => parser.onFrame(frame));
  return events;
}

/**
 * Drive one consumer through a real hub, as the proxy does, and resolve with
 * its events once the body ends (or the consumer detaches). Chunks are
 * written one event-loop turn apart, like network reads, so the hub's
 * bounded input queue drains between them.
 */
async function observe(
  options: { provider: SseProvider; streaming: boolean; contentEncoding?: string },
  wire: readonly Buffer[],
): Promise<TokenStreamEvent[]> {
  const events: TokenStreamEvent[] = [];
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const consumer = createTokenStreamConsumer({
    id: 'token-stream',
    provider: options.provider,
    streaming: options.streaming,
    onEvent: (event) => events.push(event),
  });
  const hub = new ResponseObservationHub({
    contentEncoding: options.contentEncoding,
    frameSse: options.streaming,
    consumers: [
      {
        ...consumer,
        onEnd: () => {
          consumer.onEnd?.();
          settle();
        },
        onDetach: (detached) => {
          consumer.onDetach?.(detached);
          settle();
        },
      },
    ],
  });
  for (const chunk of wire) {
    hub.write(chunk);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  hub.end();
  await settled;
  return events;
}

describe('TokenStreamSseParser', () => {
  describe('Anthropic format', () => {
    it('parses text_delta events', () => {
      const sse = [
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n',
        '\n',
      ].join('');

      const events = run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'Hello' });
    });

    it('parses tool_use events from content_block_start', () => {
      const sse = [
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"read_file","input":{}}}\n',
        '\n',
      ].join('');

      const events = run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_use', toolName: 'read_file', inputDelta: '' });
    });

    it('parses tool_use input_json_delta events', () => {
      const sse = [
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\""}}\n',
        '\n',
      ].join('');

      const events = run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_use', toolName: '', inputDelta: '{"path":"' });
    });

    it('parses message_start events', () => {
      const sse = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-20250514","role":"assistant"}}\n',
        '\n',
      ].join('');

      const events = run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'message_start', model: 'claude-sonnet-4-20250514' });
    });

    it('parses message_end from message_delta, including OpenRouter cost and cache reads', () => {
      const sse = [
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42,"cache_read_input_tokens":900,"cost":0.0123}}\n',
        '\n',
      ].join('');

      const events = run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'message_end',
        stopReason: 'end_turn',
        outputTokens: 42,
        costUsd: 0.0123,
        cachedTokens: 900,
      });
    });

    it('parses error events', () => {
      const sse = [
        'event: error\n',
        'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n',
        '\n',
      ].join('');

      const events = run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'error', message: 'Overloaded' });
    });

    it('emits raw for malformed JSON, named after the SSE event', () => {
      const sse = ['event: content_block_delta\n', 'data: {not valid json}\n', '\n'].join('');

      const events = run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'raw', eventType: 'content_block_delta' });
    });

    it('handles a complete multi-event Anthropic stream', () => {
      const sse = [
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-20250514","role":"assistant"}}\n',
        '\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n',
        '\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n',
        '\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n',
        '\n',
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n',
        '\n',
      ].join('');

      const events = run('anthropic', sse);

      expect(events).toHaveLength(5);
      expect(events[0]).toMatchObject({ kind: 'message_start' });
      expect(events[1]).toMatchObject({ kind: 'text_delta', text: 'Hi' });
      expect(events[2]).toMatchObject({ kind: 'text_delta', text: ' there' });
      expect(events[3]).toMatchObject({ kind: 'message_end', stopReason: 'end_turn' });
      expect(events[4]).toMatchObject({ kind: 'raw', eventType: 'message_stop' });
    });

    it('ignores SSE comment lines (OpenRouter keep-alives)', () => {
      const sse =
        ': OPENROUTER PROCESSING\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n';

      expect(run('anthropic', sse)).toEqual([expect.objectContaining({ kind: 'text_delta', text: 'ok' })]);
    });
  });

  describe('OpenAI format', () => {
    it('parses text content deltas', () => {
      const sse = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n',
        '\n',
      ].join('');

      const events = run('openai', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'Hello' });
    });

    it('parses tool_calls deltas', () => {
      const sse = [
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"function":{"name":"read_file","arguments":"{\\"p"}}]}}]}\n',
        '\n',
      ].join('');

      const events = run('openai', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_use', toolName: 'read_file', inputDelta: '{"p' });
    });

    it('parses [DONE] as message_end', () => {
      const events = run('openai', 'data: [DONE]\n\n');

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'message_end', stopReason: 'stop' });
    });

    it('parses model info as message_start', () => {
      const sse = [
        'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[]}\n',
        '\n',
        'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"Hi"}}]}\n',
        '\n',
      ].join('');

      const events = run('openai', sse);

      // First chunk has empty choices + model => message_start
      // Second chunk has content => text_delta
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]).toMatchObject({ kind: 'message_start', model: 'gpt-4o' });
      expect(events[1]).toMatchObject({ kind: 'text_delta', text: 'Hi' });
    });

    it('emits raw for malformed JSON', () => {
      const events = run('openai', 'data: not-json-at-all\n\n');

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'raw', eventType: 'parse_error' });
    });

    it('parses finish_reason from empty delta chunk', () => {
      // OpenAI commonly sends {delta: {}, finish_reason: "stop"} before [DONE]
      const sse = [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
        '\n',
        'data: [DONE]\n',
        '\n',
      ].join('');

      const events = run('openai', sse);

      // First: message_end from the finish_reason in the empty-delta chunk
      // Second: message_end from [DONE]
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'message_end', stopReason: 'tool_calls' });
      expect(events[1]).toMatchObject({ kind: 'message_end', stopReason: 'stop' });
    });

    it('surfaces OpenRouter cost from a Responses terminal event', () => {
      const sse =
        'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2,"input_tokens_details":{"cached_tokens":900},"cost":0.0123}}}\n\n';

      expect(run('openai', sse)).toEqual([
        expect.objectContaining({ kind: 'message_end', stopReason: 'completed', costUsd: 0.0123, cachedTokens: 900 }),
      ]);
    });
  });

  describe('unknown provider', () => {
    it('emits one raw event per SSE event', () => {
      const events = run('unknown', 'event: something\ndata: {"foo":"bar"}\n\ndata: second\n\n');

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'raw', eventType: 'unknown_provider', data: '{"foo":"bar"}' });
      expect(events[1]).toMatchObject({ kind: 'raw', eventType: 'unknown_provider', data: 'second' });
    });
  });

  describe('framing', () => {
    it('reassembles SSE lines split across chunks', () => {
      // Split a single data line across two chunks
      const chunk1 = 'event: content_block_delta\ndata: {"type":"content_block_de';
      const chunk2 = 'lta","index":0,"delta":{"type":"text_delta","text":"split"}}\n\n';

      const events = run('anthropic', [chunk1, chunk2]);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'split' });
    });

    it('handles CRLF line endings', () => {
      const sse =
        'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"crlf"}}\r\n\r\n';

      const events = run('anthropic', sse);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'crlf' });
    });

    it('keeps a multibyte character split across chunks intact', () => {
      const bytes = Buffer.from(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"naïve 🌍"}}\n\n',
      );
      const splitAt = bytes.indexOf(Buffer.from('🌍')) + 1;

      const events = run('anthropic', [bytes.subarray(0, splitAt), bytes.subarray(splitAt)]);

      expect(events).toEqual([expect.objectContaining({ kind: 'text_delta', text: 'naïve 🌍' })]);
    });

    it('processes a final event without a trailing blank line at end of stream', () => {
      const input = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"flushed"}}';

      const events = run('anthropic', input);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'flushed' });
    });
  });

  describe('error handling', () => {
    it('an error in the onEvent callback does not stop later events', () => {
      const events: TokenStreamEvent[] = [];
      let callCount = 0;
      const parser = new TokenStreamSseParser('anthropic', (event) => {
        callCount++;
        if (callCount === 1) throw new Error('callback exploded');
        events.push(event);
      });
      const framer = new SseEventFramer();
      const input = [
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}\n',
        '\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"second"}}\n',
        '\n',
      ].join('');

      framer.feed(Buffer.from(input, 'utf-8'), (frame) => parser.onFrame(frame));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'second' });
    });
  });
});

describe('createTokenStreamConsumer', () => {
  const SSE =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7,"cost":0.5}}\n\n';
  const JSON_BODY = JSON.stringify({
    model: 'claude-x',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 4, cost: 0.25, cache_read_input_tokens: 2 },
  });

  for (const encoding of ['gzip', 'br', 'deflate'] as const) {
    const compress = (body: string): Buffer =>
      encoding === 'gzip'
        ? zlib.gzipSync(body)
        : encoding === 'br'
          ? zlib.brotliCompressSync(body)
          : zlib.deflateSync(body);

    it(`decodes a ${encoding} SSE stream into events`, async () => {
      const wire = compress(SSE);
      const events = await observe({ provider: 'anthropic', streaming: true, contentEncoding: encoding }, [
        wire.subarray(0, 7),
        wire.subarray(7),
      ]);

      expect(events.map((event) => event.kind)).toEqual(['message_start', 'text_delta', 'message_end']);
      expect(events[2]).toMatchObject({ outputTokens: 7, costUsd: 0.5 });
    });

    it(`decodes a ${encoding} JSON body into events`, async () => {
      const events = await observe({ provider: 'anthropic', streaming: false, contentEncoding: encoding }, [
        compress(JSON_BODY),
      ]);

      expect(events.map((event) => event.kind)).toEqual(['message_start', 'text_delta', 'message_end']);
      expect(events[2]).toMatchObject({ inputTokens: 3, outputTokens: 4, costUsd: 0.25, cachedTokens: 2 });
    });
  }

  it('skips a JSON body larger than the extraction cap, emitting nothing', async () => {
    const big = JSON.stringify({ content: [{ type: 'text', text: 'x'.repeat(MAX_JSON_RESPONSE_CAPTURE_BYTES) }] });
    const events = await observe({ provider: 'anthropic', streaming: false }, [Buffer.from(big)]);
    expect(events).toEqual([]);
  });

  it('marks a stream that outgrew its event cap and still delivers the terminal usage', async () => {
    const delta =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"z"}}\n\n';
    const terminal =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":100001,"cost":1.5}}\n\n';
    const block = Buffer.from(delta.repeat(5_000));
    const wire: Buffer[] = Array<Buffer>(21).fill(block);
    wire.push(Buffer.from(terminal));

    const events = await observe({ provider: 'anthropic', streaming: true }, wire);

    expect(events.filter((event) => event.kind === 'raw' && event.eventType === 'truncated')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'text_delta')).toHaveLength(100_000);
    expect(events.at(-1)).toMatchObject({ kind: 'message_end', outputTokens: 100_001, costUsd: 1.5 });
  });
});
