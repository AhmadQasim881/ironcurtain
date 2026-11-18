/**
 * Framing limits of the trajectory reassemblers (MITM-11).
 *
 * The reassemblers used to build their SSE splitter with the metrics
 * observer's defaults (32 MiB stream, 2 MiB line, 4 MiB event, 100,000
 * events), and an exceeded limit was flattened into a plain ReassemblyError
 * that poisoned the whole capture session. They now frame with
 * TRAJECTORY_SSE_FRAMER_LIMITS, consistent with TRAJECTORY_DECODER_LIMITS,
 * and keep the framer's SseFramingError so the tap can drop just the
 * exchange.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SSE_EVENT_FRAMER_LIMITS, SseFramingError } from '../../src/docker/llm-observation/sse-event-framer.js';
import {
  AnthropicReassembler,
  ReassemblyError,
  ResponsesReassembler,
  createReassembler,
} from '../../src/docker/trajectory-reassembler.js';
import {
  TRAJECTORY_DECODER_LIMITS,
  TRAJECTORY_MAX_RAW_RESPONSE_BYTES,
  TRAJECTORY_SSE_FRAMER_LIMITS,
} from '../../src/docker/trajectory-limits.js';

const MIB = 1024 * 1024;

const MESSAGE_START =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"c","content":[],"stop_reason":null,"stop_sequence":null,"usage":{}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
const MESSAGE_END =
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function textDelta(text: string): string {
  return `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`;
}

/** The value `fn` throws (undefined when it returns). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('trajectory framing limits', () => {
  it('are finite, follow the decoder limits, and exceed the metrics defaults', () => {
    for (const value of Object.values(TRAJECTORY_SSE_FRAMER_LIMITS)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(TRAJECTORY_SSE_FRAMER_LIMITS.maxStreamBytes).toBe(TRAJECTORY_DECODER_LIMITS.maxDecodedBytes);
    expect(TRAJECTORY_MAX_RAW_RESPONSE_BYTES).toBe(TRAJECTORY_DECODER_LIMITS.maxDecodedBytes);
    expect(TRAJECTORY_SSE_FRAMER_LIMITS.maxLineBytes).toBeLessThanOrEqual(TRAJECTORY_SSE_FRAMER_LIMITS.maxStreamBytes);
    expect(TRAJECTORY_SSE_FRAMER_LIMITS.maxEventBytes).toBeLessThanOrEqual(TRAJECTORY_SSE_FRAMER_LIMITS.maxStreamBytes);
    for (const key of ['maxStreamBytes', 'maxLineBytes', 'maxEventBytes', 'maxEvents'] as const) {
      expect(TRAJECTORY_SSE_FRAMER_LIMITS[key]).toBeGreaterThan(DEFAULT_SSE_EVENT_FRAMER_LIMITS[key]);
    }
  });

  it('accept a single line past the metrics 2 MiB line cap', () => {
    const reassembler = new AnthropicReassembler();
    const text = 'a'.repeat(Math.floor(2.5 * MIB));
    reassembler.push(Buffer.from(MESSAGE_START + textDelta(text) + MESSAGE_END));
    const result = reassembler.finalize();
    expect(result.bodyUtf8.length).toBeGreaterThan(text.length);
  });

  it('accept a stream past the metrics 32 MiB stream cap', () => {
    const reassembler = new AnthropicReassembler();
    reassembler.push(Buffer.from(MESSAGE_START));
    const delta = Buffer.from(textDelta('b'.repeat(MIB)));
    for (let i = 0; i < 34; i++) reassembler.push(delta);
    reassembler.push(Buffer.from(MESSAGE_END));
    expect(reassembler.finalize().bodyUtf8.length).toBeGreaterThan(34 * MIB);
  });

  it('accept more events than the metrics 100,000-event cap', () => {
    const reassembler = new AnthropicReassembler();
    reassembler.push(Buffer.from(MESSAGE_START));
    const block = Buffer.from(textDelta('c').repeat(1_000));
    for (let i = 0; i < 101; i++) reassembler.push(block);
    reassembler.push(Buffer.from(MESSAGE_END));
    const result = reassembler.finalize();
    expect(result.events.length).toBe(101_000 + 5);
  });

  it('keep the SseFramingError type when a limit is exceeded, instead of a plain ReassemblyError', () => {
    const reassembler = new AnthropicReassembler({ framerLimits: { maxEvents: 10 } });
    reassembler.push(Buffer.from(MESSAGE_START + textDelta('d').repeat(20) + MESSAGE_END));

    const thrown = thrownBy(() => reassembler.finalize());
    expect(thrown).toBeInstanceOf(SseFramingError);
    expect(thrown).not.toBeInstanceOf(ReassemblyError);
    expect((thrown as SseFramingError).reason).toBe('event-count-limit');
  });

  it('report the line and stream limits by reason', () => {
    const lines = new ResponsesReassembler({ framerLimits: { maxLineBytes: 64, maxEventBytes: 64 } });
    lines.push(Buffer.from(`data: {"type":"response.created","response":{"id":"${'r'.repeat(100)}"}}\n\n`));
    const lineError = thrownBy(() => lines.finalize());
    expect(lineError).toBeInstanceOf(SseFramingError);
    expect((lineError as SseFramingError).reason).toBe('line-limit');

    const stream = createReassembler('api.anthropic.com', '/v1/messages', { framerLimits: { maxStreamBytes: 128 } });
    expect(stream).toBeDefined();
    stream?.push(Buffer.from(MESSAGE_START + MESSAGE_END));
    const streamError = thrownBy(() => stream?.finalize());
    expect(streamError).toBeInstanceOf(SseFramingError);
    expect((streamError as SseFramingError).reason).toBe('stream-limit');
  });

  it('still raise a plain ReassemblyError for a parser fault', () => {
    const reassembler = new AnthropicReassembler();
    reassembler.push(
      Buffer.from(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[]}}\n\n' +
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":9}\n\n',
      ),
    );
    const thrown = thrownBy(() => reassembler.finalize());
    expect(thrown).toBeInstanceOf(ReassemblyError);
    expect(thrown).not.toBeInstanceOf(SseFramingError);
  });
});
