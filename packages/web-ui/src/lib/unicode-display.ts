/**
 * Visible rendering of invisible and direction-changing characters.
 *
 * Agent-chosen strings (tool arguments, escalation reasons and context,
 * whitelist descriptions, server and tool names) are shown to the human who
 * approves or denies a tool call. A bidi override (U+202E and friends) makes
 * the browser display a value in a different order than the real one, zero-
 * width and other format characters hide content, and C0/C1 controls break a
 * line up. `JSON.stringify` escapes only quotes, backslashes and C0 controls,
 * so the rest reaches the DOM unchanged.
 *
 * `segmentDisplayText` splits a string into plain text runs and escape
 * markers so a component can highlight the markers; `toDisplayText` joins
 * them into one string. The escape spelling (`\n`, `\t`, `\u202e`,
 * `\u{e0041}`) mirrors `src/terminal/display-sanitize.ts`, so the web UI and
 * the terminal render the same text the same way. Nothing is dropped.
 */

export interface DisplayTextSegment {
  readonly kind: 'text' | 'escape';
  /** The text run, or the escape marker (`\u202e`) for one code point. */
  readonly value: string;
  /** Code point of an escaped character; absent for plain text runs. */
  readonly codePoint?: number;
}

export interface DisplayTextOptions {
  /**
   * Keep line feeds and tabs so multi-line text keeps its shape (inside a
   * `<pre>`); CRLF becomes LF. Default false: every control character,
   * including LF and tab, becomes a visible escape.
   */
  readonly multiline?: boolean;
  /**
   * Return at most this many `escape` segments. Escapes after that are still
   * spelled out (`\u200b`) but folded into the surrounding `text` run, so a
   * component rendering one element per escape stays bounded however many
   * invisible characters an agent packs into a value. Default: no limit.
   */
  readonly maxEscapeSegments?: number;
}

/**
 * Code points rendered as escapes: C0 controls, DEL, C1 controls, every
 * Unicode format character (Cf: bidi embeddings/overrides/isolates U+202A-
 * U+202E and U+2066-U+2069, U+061C, zero-width U+200B-U+200F, U+2060-U+2064,
 * soft hyphen, BOM U+FEFF, tag characters U+E0001-U+E007F, ...), the line and
 * paragraph separators U+2028/U+2029, lone surrogates, and every other
 * default-ignorable code point, which displays as nothing: the variation
 * selectors U+FE00-U+FE0F and U+E0100-U+E01EF (one per byte is how "emoji
 * smuggling" hides a payload), the combining grapheme joiner U+034F, the
 * Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, the Khmer inherent vowels
 * U+17B4/U+17B5, the Mongolian free variation selectors and the reserved
 * default-ignorable ranges. The one exception, an emoji's own presentation
 * selector, is {@link isEmojiPresentationSelector}.
 */
const ESCAPED_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

/** Same set without the whitespace controls that are legitimate in multi-line text. */
const INVISIBLE_CODE_POINT = /(?![\n\r\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

const TEXT_PRESENTATION_SELECTOR = '\ufe0e';
const EMOJI_PRESENTATION_SELECTOR = '\ufe0f';
const COMBINING_ENCLOSING_KEYCAP = 0x20e3;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const KEYCAP_BASE = /^[0-9#*]$/u;
const VARIATION_SELECTOR = /^\p{Variation_Selector}$/u;

/**
 * True for the variation selector an ordinary emoji carries, which is shown
 * as itself: a single U+FE0F (emoji style) or U+FE0E (text style) directly
 * after a pictograph, as in the red heart U+2764 U+FE0F, or the U+FE0F of a
 * keycap (`1` U+FE0F U+20E3). It changes how the character before it is
 * drawn. Every other variation selector, a presentation selector anywhere
 * else (after a letter, a digit or a space, or at the start) and one in a run
 * of selectors draw nothing, so they could only hide data, and are escaped.
 * `previous` is the code point before it ('' at the start), `next` the code
 * point after it, if any.
 */
function isEmojiPresentationSelector(character: string, previous: string, next: number | undefined): boolean {
  if (character !== EMOJI_PRESENTATION_SELECTOR && character !== TEXT_PRESENTATION_SELECTOR) return false;
  if (next !== undefined && VARIATION_SELECTOR.test(String.fromCodePoint(next))) return false;
  if (PICTOGRAPH.test(previous)) return true;
  return character === EMOJI_PRESENTATION_SELECTOR && next === COMBINING_ENCLOSING_KEYCAP && KEYCAP_BASE.test(previous);
}

/** JSON-style spelling of one escaped code point. */
export function escapeCodePoint(codePoint: number): string {
  switch (codePoint) {
    case 0x0a:
      return '\\n';
    case 0x0d:
      return '\\r';
    case 0x09:
      return '\\t';
  }
  if (codePoint > 0xffff) return `\\u{${codePoint.toString(16)}}`;
  return `\\u${codePoint.toString(16).padStart(4, '0')}`;
}

/**
 * Split untrusted text into plain runs and escape markers. The string
 * iterator yields a surrogate pair as one element and a lone surrogate as its
 * own element, so the latter is escaped rather than rendered.
 */
export function segmentDisplayText(text: string, options: DisplayTextOptions = {}): DisplayTextSegment[] {
  const multiline = options.multiline === true;
  const maxEscapeSegments = options.maxEscapeSegments ?? Number.POSITIVE_INFINITY;
  const source = multiline ? text.replace(/\r\n/gu, '\n') : text;
  const segments: DisplayTextSegment[] = [];
  let escapeSegments = 0;
  let run = '';
  let previous = '';
  let end = 0;
  for (const character of source) {
    end += character.length;
    const keep =
      (multiline && (character === '\n' || character === '\t')) ||
      !ESCAPED_CODE_POINT.test(character) ||
      isEmojiPresentationSelector(character, previous, source.codePointAt(end));
    previous = character;
    if (keep) {
      run += character;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (escapeSegments >= maxEscapeSegments) {
      run += escapeCodePoint(codePoint);
      continue;
    }
    if (run !== '') {
      segments.push({ kind: 'text', value: run });
      run = '';
    }
    segments.push({ kind: 'escape', value: escapeCodePoint(codePoint), codePoint });
    escapeSegments += 1;
  }
  if (run !== '') segments.push({ kind: 'text', value: run });
  return segments;
}

/** {@link segmentDisplayText} joined back into one string. */
export function toDisplayText(text: string, options: DisplayTextOptions = {}): string {
  return segmentDisplayText(text, options)
    .map((segment) => segment.value)
    .join('');
}

const MAX_WALK_DEPTH = 32;

/** True when `text` has a code point {@link segmentDisplayText} escapes, other than LF, CR and tab. */
function hasInvisibleCodePoint(text: string): boolean {
  if (!INVISIBLE_CODE_POINT.test(text)) return false;
  let previous = '';
  let end = 0;
  for (const character of text) {
    end += character.length;
    if (
      INVISIBLE_CODE_POINT.test(character) &&
      !isEmojiPresentationSelector(character, previous, text.codePointAt(end))
    ) {
      return true;
    }
    previous = character;
  }
  return false;
}

/**
 * True when any string inside `value` (walked through arrays and plain
 * objects, keys included) contains an invisible or direction-changing code
 * point. Line feeds, carriage returns and tabs do not count: they are
 * ordinary in multi-line text, and neither does an emoji's presentation
 * selector. Used to decide whether to warn the reviewer.
 */
export function hasInvisibleCodePoints(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return hasInvisibleCodePoint(value);
  if (value === null || typeof value !== 'object' || depth >= MAX_WALK_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => hasInvisibleCodePoints(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => hasInvisibleCodePoint(key) || hasInvisibleCodePoints(item, depth + 1),
  );
}
