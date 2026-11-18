import { describe, expect, it } from 'vitest';
import {
  SseEventFramer,
  SseFramingError,
  type SseEventFrame,
  type SseEventFramerLimits,
} from '../../src/docker/llm-observation/sse-event-framer.js';

function frameChunks(chunks: readonly Buffer[]): SseEventFrame[] {
  const frames: SseEventFrame[] = [];
  const framer = new SseEventFramer();
  for (const chunk of chunks) framer.feed(chunk, (frame) => frames.push(frame));
  framer.finish((frame) => frames.push(frame));
  return frames;
}

describe('SseEventFramer', () => {
  it('frames CR, LF, CRLF, comments, unknown fields, and multi-line data', () => {
    const wire =
      ': heartbeat\r' +
      'event: greeting\r\n' +
      'id: ignored\n' +
      'data: hello\r\n' +
      'data: world\r\n' +
      '\r\n' +
      'data: tail';
    expect(frameChunks([Buffer.from(wire)])).toEqual([
      { eventType: 'greeting', dataUtf8: 'hello\nworld' },
      { eventType: '', dataUtf8: 'tail' },
    ]);
  });

  it('is invariant at every byte split, including CRLF and multibyte UTF-8 splits', () => {
    const wire = Buffer.from('event: unicode\r\ndata: hé🚀\r\n\r\nevent: done\ndata: [DONE]\n\n', 'utf8');
    const expected = frameChunks([wire]);
    for (let split = 0; split <= wire.length; split++) {
      expect(frameChunks([wire.subarray(0, split), wire.subarray(split)])).toEqual(expected);
    }
    const bytewise = Array.from(wire, (_value, index) => wire.subarray(index, index + 1));
    expect(frameChunks(bytewise)).toEqual(expected);
  });

  it('bounds individual lines before retaining them', () => {
    const framer = new SseEventFramer({ limits: { maxLineBytes: 8 } });
    expect(() => framer.feed(Buffer.from('data: 123456789'), () => {})).toThrowError(SseFramingError);
  });

  it('bounds total stream work even when individual events are small', () => {
    const framer = new SseEventFramer({ limits: { maxStreamBytes: 8 } });
    framer.feed(Buffer.from('data: x'), () => {});
    expect(() => framer.feed(Buffer.from('\n\n'), () => {})).toThrow(/stream exceeds/);
  });

  it('bounds joined multi-line event payloads and event counts', () => {
    const eventLimited = new SseEventFramer({ limits: { maxEventBytes: 5 } });
    expect(() => eventLimited.feed(Buffer.from('data: abc\ndata: def\n'), () => {})).toThrow(/event exceeds/);

    const countLimited = new SseEventFramer({ limits: { maxEvents: 1 } });
    expect(() => countLimited.feed(Buffer.from('data: one\n\ndata: two\n\n'), () => {})).toThrow(/event count/);
  });

  it('does not emit events without data fields', () => {
    expect(frameChunks([Buffer.from('event: empty\n\nid: x\n\n')])).toEqual([]);
  });
});

describe('SseEventFramer lenient mode', () => {
  function lenientFrames(
    chunks: readonly Buffer[],
    limits: Partial<SseEventFramerLimits>,
  ): { frames: string[]; exceeded: string[]; dropped: number } {
    const frames: string[] = [];
    const exceeded: string[] = [];
    const framer = new SseEventFramer({ limits, onLimit: (limit) => exceeded.push(limit.reason) });
    for (const chunk of chunks) framer.feed(chunk, (frame) => frames.push(frame.dataUtf8));
    framer.finish((frame) => frames.push(frame.dataUtf8));
    expect(framer.degraded).toBe(exceeded.length > 0);
    return { frames, exceeded, dropped: framer.droppedEvents };
  }

  it('reports the first exceeded limit once and keeps framing past the stream and event-count limits', () => {
    const wire = Buffer.from('data: one\n\ndata: two\n\ndata: three\n\n');
    expect(lenientFrames([wire], { maxEvents: 1 })).toEqual({
      frames: ['one', 'two', 'three'],
      exceeded: ['event-count-limit'],
      dropped: 0,
    });
    expect(lenientFrames([Buffer.from('data: one\n\n'), Buffer.from('data: two\n\n')], { maxStreamBytes: 8 })).toEqual({
      frames: ['one', 'two'],
      exceeded: ['stream-limit'],
      dropped: 0,
    });
  });

  it('drops an oversized line or event whole without retaining it, then resumes at the next event', () => {
    const longLine = Buffer.from(`event: big\ndata: ${'x'.repeat(64)}\ndata: tail\n\ndata: next\n\n`);
    expect(lenientFrames([longLine], { maxLineBytes: 16 })).toEqual({
      frames: ['next'],
      exceeded: ['line-limit'],
      dropped: 1,
    });
    const longEvent = Buffer.from('data: abc\ndata: def\n\ndata: ok\n\n');
    expect(lenientFrames([longEvent], { maxEventBytes: 5 })).toEqual({
      frames: ['ok'],
      exceeded: ['event-limit'],
      dropped: 1,
    });
  });

  it('drops the same oversized event at every byte split', () => {
    const wire = Buffer.from(`data: ${'y'.repeat(40)}\r\n\r\ndata: usage\r\n\r\n`);
    const expected = lenientFrames([wire], { maxLineBytes: 16 });
    expect(expected.frames).toEqual(['usage']);
    for (let split = 0; split <= wire.length; split++) {
      expect(lenientFrames([wire.subarray(0, split), wire.subarray(split)], { maxLineBytes: 16 })).toEqual(expected);
    }
  });

  it('keeps strict mode for callers without an onLimit handler', () => {
    expect(() =>
      new SseEventFramer({ limits: { maxEvents: 1 } }).feed(Buffer.from('data: a\n\ndata: b\n\n'), () => {}),
    ).toThrow(SseFramingError);
  });
});
