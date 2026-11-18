/** Provider-neutral, bounded SSE event framing. */

import { StringDecoder } from 'node:string_decoder';

export interface SseEventFrame {
  readonly eventType: string;
  /** Exact decoded data payload, with multi-line data joined by `\n`. */
  readonly dataUtf8: string;
}

export interface SseEventFramerLimits {
  readonly maxStreamBytes: number;
  readonly maxLineBytes: number;
  readonly maxEventBytes: number;
  readonly maxEvents: number;
}

export const DEFAULT_SSE_EVENT_FRAMER_LIMITS: SseEventFramerLimits = Object.freeze({
  maxStreamBytes: 32 * 1024 * 1024,
  maxLineBytes: 2 * 1024 * 1024,
  maxEventBytes: 4 * 1024 * 1024,
  maxEvents: 100_000,
});

export type SseFramingFailureReason =
  'stream-limit' | 'line-limit' | 'event-limit' | 'event-count-limit' | 'already-ended';

export class SseFramingError extends Error {
  constructor(
    readonly reason: SseFramingFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'SseFramingError';
  }
}

/**
 * True when `error` is an exceeded framing limit (stream bytes, line, event or
 * event count): a resource condition of one stream, as opposed to misuse of
 * the framer (`already-ended`).
 */
export function isSseFramingLimitError(error: unknown): error is SseFramingError {
  return error instanceof SseFramingError && error.reason !== 'already-ended';
}

export interface SseFramingLimitExceeded {
  readonly reason: SseFramingFailureReason;
  readonly message: string;
}

export interface SseEventFramerOptions {
  readonly limits?: Partial<SseEventFramerLimits>;
  /**
   * Opt-in lenient mode. Without it, an exceeded limit throws
   * `SseFramingError` and framing ends. With it, the first exceeded limit is
   * reported here and the framer continues *degraded*: the stream-byte and
   * event-count limits stop applying (the caller bounds the total), and a line
   * or event over its limit is dropped whole, without being retained, while
   * framing resumes at the next event. Memory stays bounded by the line and
   * event limits.
   */
  readonly onLimit?: (exceeded: SseFramingLimitExceeded) => void;
}

function limit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

/**
 * Incremental SSE framer with correct CR/LF/CRLF and split-UTF-8 handling.
 * It emits only complete events, except that `finish()` emits a pending data
 * event at EOF to preserve the existing trajectory capture behavior.
 */
export class SseEventFramer {
  private readonly decoder = new StringDecoder('utf8');
  private readonly limits: SseEventFramerLimits;
  private readonly onLimit?: (exceeded: SseFramingLimitExceeded) => void;
  private lineFragments: string[] = [];
  private lineBytes = 0;
  private currentEventType = '';
  private currentDataLines: string[] = [];
  private currentDataSeen = false;
  private currentDataBytes = 0;
  private eventCount = 0;
  private streamBytes = 0;
  private skipLeadingLf = false;
  private ended = false;
  /** Lenient mode only: a limit was exceeded and framing continues degraded. */
  private degradedState = false;
  /** Lenient mode only: the rest of the current line is discarded. */
  private skippingLine = false;
  /** Lenient mode only: the current event is discarded at its end. */
  private droppingEvent = false;
  private droppedEventCount = 0;

  constructor(options: SseEventFramerOptions = {}) {
    this.limits = Object.freeze({
      maxStreamBytes: limit(
        'maxStreamBytes',
        options.limits?.maxStreamBytes ?? DEFAULT_SSE_EVENT_FRAMER_LIMITS.maxStreamBytes,
      ),
      maxLineBytes: limit('maxLineBytes', options.limits?.maxLineBytes ?? DEFAULT_SSE_EVENT_FRAMER_LIMITS.maxLineBytes),
      maxEventBytes: limit(
        'maxEventBytes',
        options.limits?.maxEventBytes ?? DEFAULT_SSE_EVENT_FRAMER_LIMITS.maxEventBytes,
      ),
      maxEvents: limit('maxEvents', options.limits?.maxEvents ?? DEFAULT_SSE_EVENT_FRAMER_LIMITS.maxEvents),
    });
    this.onLimit = options.onLimit;
  }

  /** True once a lenient framer has exceeded a limit. */
  get degraded(): boolean {
    return this.degradedState;
  }

  /** Events a lenient framer dropped because a line or the event exceeded its limit. */
  get droppedEvents(): number {
    return this.droppedEventCount;
  }

  feed(chunk: Buffer, sink: (frame: SseEventFrame) => void): void {
    if (this.ended) throw new SseFramingError('already-ended', 'cannot feed an ended SSE framer');
    if (!this.degradedState && this.streamBytes + chunk.length > this.limits.maxStreamBytes) {
      this.limitExceeded('stream-limit', 'SSE stream exceeds configured byte limit');
    }
    this.streamBytes += chunk.length;
    this.processText(this.decoder.write(chunk), sink);
  }

  finish(sink: (frame: SseEventFrame) => void): void {
    if (this.ended) return;
    this.processText(this.decoder.end(), sink);
    if (this.lineFragments.length > 0 || this.skippingLine) this.finishLine(sink);
    if (this.droppingEvent) this.droppedEventCount++;
    else if (this.currentDataSeen) this.emitEvent(sink);
    this.ended = true;
  }

  /** Strict mode throws; lenient mode reports the first exceeded limit and degrades. */
  private limitExceeded(reason: SseFramingFailureReason, message: string): void {
    if (!this.onLimit) throw new SseFramingError(reason, message);
    if (this.degradedState) return;
    this.degradedState = true;
    this.onLimit(Object.freeze({ reason, message }));
  }

  private processText(text: string, sink: (frame: SseEventFrame) => void): void {
    let pos = 0;
    if (this.skipLeadingLf) {
      this.skipLeadingLf = false;
      if (text[0] === '\n') pos = 1;
    }

    // Remember the next LF and CR instead of searching again for every line:
    // a chunk with many lines and no CR would otherwise rescan its whole tail
    // for each line (quadratic in the chunk size). -1 means "none left".
    let nextLf = -2;
    let nextCr = -2;
    while (pos < text.length) {
      if (nextLf !== -1 && nextLf < pos) nextLf = text.indexOf('\n', pos);
      if (nextCr !== -1 && nextCr < pos) nextCr = text.indexOf('\r', pos);
      let lineEnd: number;
      if (nextLf === -1 && nextCr === -1) {
        this.appendLine(text.slice(pos));
        return;
      }
      if (nextCr === -1) lineEnd = nextLf;
      else if (nextLf === -1) lineEnd = nextCr;
      else lineEnd = Math.min(nextLf, nextCr);

      this.appendLine(text.slice(pos, lineEnd));
      this.finishLine(sink);
      const terminator = text[lineEnd];
      pos = lineEnd + 1;
      if (terminator === '\r') {
        if (pos < text.length && text[pos] === '\n') pos++;
        else if (pos === text.length) this.skipLeadingLf = true;
      }
    }
  }

  private appendLine(value: string): void {
    if (value.length === 0 || this.skippingLine) return;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (this.lineBytes + bytes > this.limits.maxLineBytes) {
      this.limitExceeded('line-limit', 'SSE line exceeds configured byte limit');
      // Lenient: discard the line and the event it belongs to.
      this.lineFragments = [];
      this.lineBytes = 0;
      this.skippingLine = true;
      this.dropCurrentEvent();
      return;
    }
    this.lineFragments.push(value);
    this.lineBytes += bytes;
  }

  private finishLine(sink: (frame: SseEventFrame) => void): void {
    if (this.skippingLine) {
      this.skippingLine = false;
      return;
    }
    const line = this.lineFragments.join('');
    this.lineFragments = [];
    this.lineBytes = 0;
    this.processLine(line, sink);
  }

  private processLine(line: string, sink: (frame: SseEventFrame) => void): void {
    if (line === '') {
      if (this.droppingEvent) {
        this.droppingEvent = false;
        this.droppedEventCount++;
      } else if (this.currentDataSeen) {
        this.emitEvent(sink);
      }
      this.currentEventType = '';
      this.currentDataLines = [];
      this.currentDataSeen = false;
      this.currentDataBytes = 0;
      return;
    }
    if (line.startsWith(':') || this.droppingEvent) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      this.currentEventType = value;
      return;
    }
    if (field !== 'data') return;

    const separatorBytes = this.currentDataSeen ? 1 : 0;
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (this.currentDataBytes + separatorBytes + valueBytes > this.limits.maxEventBytes) {
      this.limitExceeded('event-limit', 'SSE event exceeds configured byte limit');
      this.dropCurrentEvent();
      return;
    }
    this.currentDataLines.push(value);
    this.currentDataSeen = true;
    this.currentDataBytes += separatorBytes + valueBytes;
  }

  /** Lenient mode: stop retaining the current event; it is discarded at its end. */
  private dropCurrentEvent(): void {
    this.droppingEvent = true;
    this.currentDataLines = [];
    this.currentDataSeen = false;
    this.currentDataBytes = 0;
  }

  private emitEvent(sink: (frame: SseEventFrame) => void): void {
    if (!this.currentDataSeen) return;
    if (!this.degradedState && this.eventCount >= this.limits.maxEvents) {
      this.limitExceeded('event-count-limit', 'SSE event count exceeds configured limit');
    }
    this.eventCount++;
    sink(Object.freeze({ eventType: this.currentEventType, dataUtf8: this.currentDataLines.join('\n') }));
  }
}

/** Compatibility surface for trajectory reassemblers while they migrate. */
export class SseLineSplitter {
  private readonly framer: SseEventFramer;

  constructor(options: SseEventFramerOptions = {}) {
    this.framer = new SseEventFramer(options);
  }

  feed(chunk: Buffer, sink: (eventType: string, dataUtf8: string) => void): void {
    this.framer.feed(chunk, (frame) => sink(frame.eventType, frame.dataUtf8));
  }

  flush(sink: (eventType: string, dataUtf8: string) => void): void {
    this.framer.finish((frame) => sink(frame.eventType, frame.dataUtf8));
  }
}
