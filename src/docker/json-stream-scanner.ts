/**
 * Incremental, bounded JSON scanner for registry metadata.
 *
 * The registry proxies must read documents of tens of megabytes (an npm
 * packument for `@prisma/client` is about 68 MB) without holding the parsed
 * document in memory. This scanner reads a JSON text chunk by chunk, keeps
 * only a small amount of state per open container, and reports the children
 * of the containers its visitor asks for:
 *
 * - their path (member names and array indexes from the root),
 * - their absolute byte range, from the member name's opening quote (or the
 *   value, for an array element) to one past the value's last byte,
 * - and, when the visitor asks for it, the decoded string value.
 *
 * Containers the visitor does not track are skipped without decoding member
 * names or strings. The whole input is still checked against the JSON grammar
 * (RFC 8259), so a document the scanner accepts has exactly the structure
 * `JSON.parse` would give it. A tracked object with a repeated member name is
 * refused: `JSON.parse` keeps the last value, and a filter that read the first
 * one would decide on different data than the client receives.
 *
 * Errors are {@link JsonScanError}s with fixed messages. They never quote the
 * document, so a caller can put the message in an audit record.
 */

/** One step of a JSON path: an object member name or an array index. */
export type JsonPathSegment = string | number;

export type JsonContainerKind = 'object' | 'array';
export type JsonValueKind = JsonContainerKind | 'string' | 'number' | 'boolean' | 'null';

/** A complete child of a tracked container, or the root value (path `[]`). */
export interface JsonScanChild {
  /** Valid only during the visitor call; copy it to keep it. */
  readonly path: readonly JsonPathSegment[];
  readonly kind: JsonValueKind;
  /** Absolute offset of the member name's opening quote; for an array element or the root, of the value. */
  readonly start: number;
  /** Absolute offset of the value's first byte. */
  readonly valueStart: number;
  /** Absolute offset one past the value's last byte. */
  readonly end: number;
  /** The decoded string, for a string value the visitor asked to capture. */
  readonly text?: string;
}

export interface JsonScanVisitor {
  /**
   * Whether the children of the container at `path` are reported. Asked for
   * the root container and for each container child of a tracked container,
   * never for containers inside an untracked one.
   */
  readonly track: (path: readonly JsonPathSegment[], kind: JsonContainerKind) => boolean;
  /** Whether the string child at `path` (of a tracked container) is decoded. */
  readonly capture?: (path: readonly JsonPathSegment[]) => boolean;
  /** Called once per child of a tracked container when it ends, and once for the root value. */
  readonly child: (child: JsonScanChild) => void;
}

export interface JsonScanLimits {
  /** Containers open at once. */
  readonly maxDepth: number;
  /** Encoded bytes of one member name of a tracked object. */
  readonly maxKeyBytes: number;
  /** Encoded bytes of one captured string value. */
  readonly maxCaptureBytes: number;
  /** Members or elements of one tracked container. */
  readonly maxTrackedMembers: number;
}

export const DEFAULT_JSON_SCAN_LIMITS: JsonScanLimits = Object.freeze({
  maxDepth: 512,
  maxKeyBytes: 4096,
  maxCaptureBytes: 8192,
  maxTrackedMembers: 1_000_000,
});

/** `malformed`: not a JSON text, or a repeated member name in a tracked object. `limit`: a bound was exceeded. */
export type JsonScanErrorCode = 'malformed' | 'limit';

export class JsonScanError extends Error {
  constructor(
    readonly code: JsonScanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JsonScanError';
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const LOWER_E = 0x65;
const UPPER_E = 0x45;

const OBJECT = 1;
const ARRAY = 2;
type ContainerCode = typeof OBJECT | typeof ARRAY;

// Scanner modes.
const EXPECT_VALUE = 0;
/** Just after `[`: a value or `]`. */
const EXPECT_VALUE_OR_CLOSE = 1;
/** Just after `{`: a member name or `}`. */
const EXPECT_KEY_OR_CLOSE = 2;
/** After `,` in an object. */
const EXPECT_KEY = 3;
const EXPECT_COLON = 4;
/** After a value inside a container: `,` or the closing bracket. */
const EXPECT_SEPARATOR = 5;
const IN_STRING = 6;
const IN_NUMBER = 7;
const IN_LITERAL = 8;
/** After the root value: only whitespace. */
const DONE = 9;

// Number grammar states (RFC 8259 section 6).
const N_MINUS = 0;
const N_ZERO = 1;
const N_INT = 2;
const N_DOT = 3;
const N_FRACTION = 4;
const N_EXPONENT_MARK = 5;
const N_EXPONENT_SIGN = 6;
const N_EXPONENT = 7;

const TRUE_BYTES = Uint8Array.from([0x74, 0x72, 0x75, 0x65]);
const FALSE_BYTES = Uint8Array.from([0x66, 0x61, 0x6c, 0x73, 0x65]);
const NULL_BYTES = Uint8Array.from([0x6e, 0x75, 0x6c, 0x6c]);

function malformed(message: string): JsonScanError {
  return new JsonScanError('malformed', message);
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function isDigit(byte: number): boolean {
  return byte >= DIGIT_0 && byte <= DIGIT_9;
}

function isHexDigit(byte: number): boolean {
  return isDigit(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

/** The single-character escapes: `"` `\` `/` `b` `f` `n` `r` `t`. */
function isSimpleEscape(byte: number): boolean {
  return (
    byte === QUOTE ||
    byte === BACKSLASH ||
    byte === 0x2f ||
    byte === 0x62 ||
    byte === 0x66 ||
    byte === 0x6e ||
    byte === 0x72 ||
    byte === 0x74
  );
}

/** The next number state after `byte`, or -1 when `byte` cannot continue the number. */
function nextNumberState(state: number, byte: number): number {
  switch (state) {
    case N_MINUS:
      if (byte === DIGIT_0) return N_ZERO;
      return isDigit(byte) ? N_INT : -1;
    case N_ZERO:
      if (byte === DOT) return N_DOT;
      return byte === LOWER_E || byte === UPPER_E ? N_EXPONENT_MARK : -1;
    case N_INT:
      if (isDigit(byte)) return N_INT;
      if (byte === DOT) return N_DOT;
      return byte === LOWER_E || byte === UPPER_E ? N_EXPONENT_MARK : -1;
    case N_DOT:
      return isDigit(byte) ? N_FRACTION : -1;
    case N_FRACTION:
      if (isDigit(byte)) return N_FRACTION;
      return byte === LOWER_E || byte === UPPER_E ? N_EXPONENT_MARK : -1;
    case N_EXPONENT_MARK:
      if (byte === PLUS || byte === MINUS) return N_EXPONENT_SIGN;
      return isDigit(byte) ? N_EXPONENT : -1;
    case N_EXPONENT_SIGN:
    case N_EXPONENT:
      return isDigit(byte) ? N_EXPONENT : -1;
    default:
      return -1;
  }
}

function isCompleteNumber(state: number): boolean {
  return state === N_ZERO || state === N_INT || state === N_FRACTION || state === N_EXPONENT;
}

/**
 * Scans one JSON text. Feed it with {@link write} and finish with {@link end};
 * both throw a {@link JsonScanError} (or whatever the visitor throws) and the
 * scanner is unusable afterwards.
 */
export class JsonStreamScanner {
  private readonly limits: JsonScanLimits;
  /** Absolute offset of the next chunk's first byte. */
  private offset = 0;
  private mode = EXPECT_VALUE;
  /** Containers open now. */
  private depth = 0;
  /** Tracked containers open now. They are always the outermost `tracked` of the open containers. */
  private tracked = 0;
  private readonly kinds: Uint8Array;
  /** Path of the child in progress of the innermost tracked container (or of that container, between children). */
  private readonly path: JsonPathSegment[] = [];
  // Per tracked container, indexed by its position among the tracked ones.
  private readonly frameNames: Array<Set<string> | undefined> = [];
  private readonly frameCount: number[] = [];
  private readonly frameKey: Array<string | undefined> = [];
  private readonly frameKeyStart: number[] = [];
  private readonly childStart: number[] = [];
  private readonly childValueStart: number[] = [];
  private rootStart = 0;
  // String in progress.
  private stringIsKey = false;
  private stringCapture = false;
  private stringStart = 0;
  /** 0: none; 1: after `\`; 5, 4, 3, 2: that many minus one hex digits of a `\u` escape still to come. */
  private escapeState = 0;
  private captured: Buffer[] = [];
  private capturedBytes = 0;
  private capturedEscaped = false;
  // Number or literal in progress.
  private numberState = N_INT;
  private literal: Uint8Array = TRUE_BYTES;
  private literalIndex = 0;
  private literalKind: 'boolean' | 'null' = 'boolean';
  private failed = false;
  private ended = false;

  constructor(
    private readonly visitor: JsonScanVisitor,
    limits: Partial<JsonScanLimits> = {},
  ) {
    this.limits = { ...DEFAULT_JSON_SCAN_LIMITS, ...limits };
    this.kinds = new Uint8Array(this.limits.maxDepth);
  }

  /** Bytes consumed so far. */
  get bytesScanned(): number {
    return this.offset;
  }

  write(chunk: Uint8Array): void {
    if (this.failed || this.ended) throw malformed('JSON scanner is no longer usable');
    try {
      const base = this.offset;
      const length = chunk.length;
      let index = 0;
      while (index < length) {
        const mode = this.mode;
        if (mode === IN_STRING) {
          index = this.scanString(chunk, index, base);
        } else if (mode === IN_NUMBER) {
          index = this.scanNumber(chunk, index, base);
        } else if (mode === IN_LITERAL) {
          index = this.scanLiteral(chunk, index, base);
        } else {
          const byte = chunk[index];
          if (!isWhitespace(byte)) this.structural(byte, base + index);
          index += 1;
        }
      }
      this.offset = base + length;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  /** Checks that the input held exactly one complete JSON value. */
  end(): void {
    if (this.failed || this.ended) throw malformed('JSON scanner is no longer usable');
    try {
      if (this.mode === IN_NUMBER && this.depth === 0) {
        if (!isCompleteNumber(this.numberState)) throw malformed('JSON number is incomplete');
        this.endValue('number', this.offset);
      }
      if (this.mode !== DONE) throw malformed('JSON document is truncated');
      this.ended = true;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  private structural(byte: number, offset: number): void {
    switch (this.mode) {
      case EXPECT_VALUE_OR_CLOSE:
        if (byte === CLOSE_BRACKET) {
          this.closeContainer(ARRAY, offset);
          return;
        }
        this.startValue(byte, offset);
        return;
      case EXPECT_VALUE:
        this.startValue(byte, offset);
        return;
      case EXPECT_KEY_OR_CLOSE:
        if (byte === CLOSE_BRACE) {
          this.closeContainer(OBJECT, offset);
          return;
        }
        this.startKey(byte, offset);
        return;
      case EXPECT_KEY:
        this.startKey(byte, offset);
        return;
      case EXPECT_COLON:
        if (byte !== COLON) throw malformed('JSON member name is not followed by a colon');
        this.mode = EXPECT_VALUE;
        return;
      case EXPECT_SEPARATOR: {
        const kind = this.kinds[this.depth - 1];
        if (byte === COMMA) {
          this.mode = kind === OBJECT ? EXPECT_KEY : EXPECT_VALUE;
        } else if (byte === CLOSE_BRACE && kind === OBJECT) {
          this.closeContainer(OBJECT, offset);
        } else if (byte === CLOSE_BRACKET && kind === ARRAY) {
          this.closeContainer(ARRAY, offset);
        } else {
          throw malformed('JSON value is not followed by a separator');
        }
        return;
      }
      default:
        throw malformed('JSON document has data after its value');
    }
  }

  private startKey(byte: number, offset: number): void {
    if (byte !== QUOTE) throw malformed('JSON object member does not start with a name');
    this.beginString(true, this.depth === this.tracked, offset);
  }

  private startValue(byte: number, offset: number): void {
    if (byte === QUOTE) {
      const reported = this.beginValue(offset);
      this.beginString(false, reported && (this.visitor.capture?.(this.path) ?? false), offset);
      return;
    }
    if (byte === OPEN_BRACE) {
      this.openContainer(OBJECT, offset);
      return;
    }
    if (byte === OPEN_BRACKET) {
      this.openContainer(ARRAY, offset);
      return;
    }
    if (byte === MINUS || isDigit(byte)) {
      this.beginValue(offset);
      this.numberState = byte === MINUS ? N_MINUS : byte === DIGIT_0 ? N_ZERO : N_INT;
      this.mode = IN_NUMBER;
      return;
    }
    if (byte === TRUE_BYTES[0] || byte === FALSE_BYTES[0] || byte === NULL_BYTES[0]) {
      this.beginValue(offset);
      this.literal = byte === TRUE_BYTES[0] ? TRUE_BYTES : byte === FALSE_BYTES[0] ? FALSE_BYTES : NULL_BYTES;
      this.literalKind = this.literal === NULL_BYTES ? 'null' : 'boolean';
      this.literalIndex = 1;
      this.mode = IN_LITERAL;
      return;
    }
    throw malformed('JSON value has an unexpected character');
  }

  /**
   * A value begins at `offset`. Records where the child of the innermost
   * tracked container starts and pushes its path segment. Returns whether the
   * value is reported (a child of a tracked container, or the root).
   */
  private beginValue(offset: number): boolean {
    if (this.depth === 0) {
      this.rootStart = offset;
      return true;
    }
    if (this.depth !== this.tracked) return false;
    const frame = this.tracked - 1;
    if (this.kinds[this.depth - 1] === OBJECT) {
      this.path.push(this.frameKey[frame] ?? '');
      this.childStart[frame] = this.frameKeyStart[frame];
    } else {
      const index = this.frameCount[frame];
      if (index >= this.limits.maxTrackedMembers) {
        throw new JsonScanError('limit', 'JSON array has more elements than the scanner tracks');
      }
      this.frameCount[frame] = index + 1;
      this.path.push(index);
      this.childStart[frame] = offset;
    }
    this.childValueStart[frame] = offset;
    return true;
  }

  /** A value ends just before `end`: report it if it is a reported child, then expect what follows it. */
  private endValue(kind: JsonValueKind, end: number, text?: string): void {
    if (this.depth === 0) {
      this.visitor.child({ path: this.path, kind, start: this.rootStart, valueStart: this.rootStart, end, text });
      this.mode = DONE;
      return;
    }
    if (this.depth === this.tracked) {
      const frame = this.tracked - 1;
      this.visitor.child({
        path: this.path,
        kind,
        start: this.childStart[frame],
        valueStart: this.childValueStart[frame],
        end,
        text,
      });
      this.path.pop();
    }
    this.mode = EXPECT_SEPARATOR;
  }

  private openContainer(code: ContainerCode, offset: number): void {
    const reported = this.beginValue(offset);
    if (this.depth >= this.limits.maxDepth) {
      throw new JsonScanError('limit', 'JSON document nests deeper than the scanner allows');
    }
    const kind: JsonContainerKind = code === OBJECT ? 'object' : 'array';
    const track = reported && this.visitor.track(this.path, kind);
    this.kinds[this.depth] = code;
    this.depth += 1;
    if (track) {
      const frame = this.tracked;
      this.tracked += 1;
      this.frameNames[frame] = code === OBJECT ? new Set() : undefined;
      this.frameCount[frame] = 0;
      this.frameKey[frame] = undefined;
    }
    this.mode = code === OBJECT ? EXPECT_KEY_OR_CLOSE : EXPECT_VALUE_OR_CLOSE;
  }

  private closeContainer(code: ContainerCode, offset: number): void {
    if (this.depth === this.tracked) {
      this.tracked -= 1;
      this.frameNames[this.tracked] = undefined;
    }
    this.depth -= 1;
    this.endValue(code === OBJECT ? 'object' : 'array', offset + 1);
  }

  private beginString(isKey: boolean, capture: boolean, offset: number): void {
    this.stringIsKey = isKey;
    this.stringCapture = capture;
    this.stringStart = offset;
    this.escapeState = 0;
    this.captured = [];
    this.capturedBytes = 0;
    this.capturedEscaped = false;
    this.mode = IN_STRING;
  }

  private scanString(chunk: Uint8Array, from: number, base: number): number {
    const length = chunk.length;
    let index = from;
    while (index < length) {
      if (this.escapeState !== 0) {
        const byte = chunk[index];
        if (this.escapeState === 1) {
          if (byte === 0x75) this.escapeState = 5;
          else if (isSimpleEscape(byte)) this.escapeState = 0;
          else throw malformed('JSON string has an invalid escape');
        } else {
          if (!isHexDigit(byte)) throw malformed('JSON string has an invalid unicode escape');
          this.escapeState = this.escapeState === 2 ? 0 : this.escapeState - 1;
        }
        if (this.stringCapture) this.appendCaptured(chunk, index, index + 1);
        index += 1;
        continue;
      }
      // The common case: run to the next quote, backslash or control character.
      let stop = index;
      while (stop < length) {
        const byte = chunk[stop];
        if (byte === QUOTE || byte === BACKSLASH || byte < 0x20) break;
        stop += 1;
      }
      if (this.stringCapture && stop > index) this.appendCaptured(chunk, index, stop);
      if (stop === length) return length;
      const byte = chunk[stop];
      if (byte === QUOTE) {
        this.finishString(base + stop + 1);
        return stop + 1;
      }
      if (byte !== BACKSLASH) throw malformed('JSON string has an unescaped control character');
      if (this.stringCapture) {
        this.capturedEscaped = true;
        this.appendCaptured(chunk, stop, stop + 1);
      }
      this.escapeState = 1;
      index = stop + 1;
    }
    return index;
  }

  private appendCaptured(chunk: Uint8Array, from: number, to: number): void {
    const limit = this.stringIsKey ? this.limits.maxKeyBytes : this.limits.maxCaptureBytes;
    this.capturedBytes += to - from;
    if (this.capturedBytes > limit) {
      throw new JsonScanError(
        'limit',
        this.stringIsKey ? 'JSON member name is longer than the scanner allows' : 'JSON string is longer than allowed',
      );
    }
    this.captured.push(Buffer.from(chunk.subarray(from, to)));
  }

  private finishString(end: number): void {
    const text = this.stringCapture ? this.decodeCaptured() : undefined;
    this.captured = [];
    if (!this.stringIsKey) {
      this.endValue('string', end, text);
      return;
    }
    if (text !== undefined) {
      const frame = this.tracked - 1;
      const names = this.frameNames[frame];
      if (names !== undefined) {
        if (names.has(text)) throw malformed('JSON object repeats a member name');
        if (names.size >= this.limits.maxTrackedMembers) {
          throw new JsonScanError('limit', 'JSON object has more members than the scanner tracks');
        }
        names.add(text);
      }
      this.frameKey[frame] = text;
      this.frameKeyStart[frame] = this.stringStart;
    }
    this.mode = EXPECT_COLON;
  }

  private decodeCaptured(): string {
    const raw = Buffer.concat(this.captured, this.capturedBytes).toString('utf8');
    if (!this.capturedEscaped) return raw;
    // The escapes were validated above, so this is a well-formed JSON string.
    return JSON.parse(`"${raw}"`) as string;
  }

  private scanNumber(chunk: Uint8Array, from: number, base: number): number {
    const length = chunk.length;
    let index = from;
    while (index < length) {
      const next = nextNumberState(this.numberState, chunk[index]);
      if (next < 0) {
        if (!isCompleteNumber(this.numberState)) throw malformed('JSON number is malformed');
        // The delimiter is not part of the number: leave it for the next mode.
        this.endValue('number', base + index);
        return index;
      }
      this.numberState = next;
      index += 1;
    }
    return length;
  }

  private scanLiteral(chunk: Uint8Array, from: number, base: number): number {
    const expected = this.literal;
    let index = from;
    while (index < chunk.length && this.literalIndex < expected.length) {
      if (chunk[index] !== expected[this.literalIndex]) throw malformed('JSON literal is malformed');
      this.literalIndex += 1;
      index += 1;
    }
    if (this.literalIndex === expected.length) this.endValue(this.literalKind, base + index);
    return index;
  }
}
