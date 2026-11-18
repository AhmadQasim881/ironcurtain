/**
 * The one place untrusted text is made safe to show on a terminal.
 *
 * Agent-derived strings (tool arguments, escalation reasons, file and session
 * names, remote error messages, agent prose) reach the user's real terminal.
 * Raw control characters there can move the cursor and overwrite what an
 * approval prompt shows, set the clipboard (OSC 52), change the window title,
 * or make the terminal type replies into IronCurtain's stdin. Bidi overrides,
 * zero-width characters and variation selectors make the rendered text differ
 * from the real text.
 *
 * - {@link toDisplayText} renders every control character, invisible format
 *   character and other default-ignorable code point as a visible escape (an
 *   emoji keeps its presentation selector). Nothing is dropped and nothing is
 *   truncated unless a `maxLength` is given, in which case the cut is marked
 *   explicitly.
 * - {@link toTerminalKitText} additionally escapes terminal-kit's `^` markup
 *   and `%` format characters, for text passed to styled `term(...)` calls.
 * - {@link stripTerminalSequences} removes escape sequences and control
 *   characters from agent markdown/prose that is rendered rather than quoted.
 * - {@link escapeBidiControls} makes the bidi embedding, override and isolate
 *   characters in such prose visible, so it displays in its real order.
 * - {@link toTerminalSafeJson} serializes machine output (`--json`) so that it
 *   stays inert when it lands on a terminal, and parses to the same value.
 *
 * Escapes use JSON-style spellings (`\n`, `\r`, `\t`, `\u001b`, `\u{e0041}`)
 * so text that was already JSON-quoted reads consistently. The mapping is not
 * injective: a literal backslash is shown as-is. Quote with JSON first when
 * the exact value must be recoverable from the screen.
 */

export interface DisplayTextOptions {
  /**
   * Keep line feeds and tabs so multi-line text keeps its shape; CRLF becomes
   * LF. Default false: every control character, including LF and tab, is
   * escaped and the result is a single line.
   */
  readonly multiline?: boolean;
  /**
   * Cap the rendered length, counted in code points of the escaped output (not
   * terminal cells). When the text is longer it is cut on an escape boundary
   * and `...[+N chars]` reports how many input characters were omitted. The
   * marker is kept even when `maxLength` is too small to hold it. Default: no
   * cap, the whole text is rendered.
   */
  readonly maxLength?: number;
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
 * default-ignorable ranges. The policy engine treats the same set as
 * invisible (`trusted-process/protected-paths.ts`). The one exception, an
 * emoji's own presentation selector, is {@link isEmojiPresentationSelector}.
 */
const ESCAPED_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

/** {@link ESCAPED_CODE_POINT} for multiline mode, where line feed and tab are kept. */
const ESCAPED_CODE_POINT_MULTILINE = /[^\P{Cc}\n\t]|[\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

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

function escapeCodePoint(codePoint: number): string {
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
 * Render one input code point (given as its string) for display. `previous`
 * is the code point before it ('' at the start) and `end` the index in `text`
 * just past it, for the context {@link isEmojiPresentationSelector} needs.
 */
function renderToken(character: string, multiline: boolean, previous: string, text: string, end: number): string {
  if (multiline && (character === '\n' || character === '\t')) return character;
  if (!ESCAPED_CODE_POINT.test(character)) return character;
  if (isEmojiPresentationSelector(character, previous, text.codePointAt(end))) return character;
  return escapeCodePoint(character.codePointAt(0) ?? 0);
}

/**
 * Rendered length of one token in code points: an escape is plain ASCII, and
 * a character rendered as itself is one code point (even a surrogate pair).
 */
function tokenLength(character: string, token: string): number {
  return token === character ? 1 : token.length;
}

/** Any UTF-16 surrogate unit, paired or not (deliberately no `u` flag). */
const SURROGATE_UNIT = /[\uD800-\uDFFF]/;

/** Code points in `text`, counting a lone surrogate as one, like the string iterator. */
function countCodePoints(text: string): number {
  if (!SURROGATE_UNIT.test(text)) return text.length;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

/**
 * Render untrusted text for a terminal or log: controls, bidi and invisible
 * format characters become visible escapes (see {@link DisplayTextOptions}).
 *
 * The string iterator yields a surrogate pair as one code point and a lone
 * surrogate on its own, so a lone surrogate is escaped rather than written to
 * a terminal. Cost is linear in the text, with a single scan when nothing
 * needs escaping; with `maxLength` the walk stops just past the cap, so
 * cutting a multi-megabyte value costs about as much as cutting a short one.
 */
export function toDisplayText(value: string, options: DisplayTextOptions = {}): string {
  const multiline = options.multiline === true;
  const maxLength = options.maxLength;
  if (maxLength !== undefined && !(Number.isFinite(maxLength) && maxLength >= 0)) {
    throw new RangeError(`toDisplayText maxLength must be a non-negative finite number: ${maxLength}`);
  }
  const text = multiline ? value.replace(/\r\n/gu, '\n') : value;
  if (maxLength !== undefined) return renderWithinLength(text, multiline, maxLength);
  if (!(multiline ? ESCAPED_CODE_POINT_MULTILINE : ESCAPED_CODE_POINT).test(text)) return text;
  let rendered = '';
  let previous = '';
  let end = 0;
  for (const character of text) {
    end += character.length;
    rendered += renderToken(character, multiline, previous, text, end);
    previous = character;
  }
  return rendered;
}

/** The `maxLength` case of {@link toDisplayText}. */
function renderWithinLength(text: string, multiline: boolean, maxLength: number): string {
  // Reserve room for the widest marker this cut can need, then keep whole
  // tokens only, so an escape is never split into a misleading fragment.
  const total = countCodePoints(text);
  const budget = Math.max(0, Math.floor(maxLength) - `...[+${total} chars]`.length);
  let rendered = '';
  let renderedLength = 0;
  let kept = '';
  let keptLength = 0;
  let keptCount = 0;
  let keeping = true;
  let previous = '';
  let end = 0;
  for (const character of text) {
    end += character.length;
    const token = renderToken(character, multiline, previous, text, end);
    previous = character;
    const length = tokenLength(character, token);
    if (keeping && keptLength + length <= budget) {
      kept += token;
      keptLength += length;
      keptCount += 1;
    } else {
      keeping = false;
    }
    rendered += token;
    renderedLength += length;
    // Past the cap: the kept prefix is final, because it already stopped
    // below the budget, which is below the cap.
    if (renderedLength > maxLength) return `${kept}...[+${total - keptCount} chars]`;
  }
  return rendered;
}

/**
 * Escape terminal-kit markup (`^` becomes `^^`) and format specifiers (`%`
 * becomes `%%`) in text that is already display-safe, so `term(...)`,
 * `term.bold(...)` and the other styled terminal-kit calls print it
 * literally. The escapes do not change the text's display width, so this is
 * the last step after any width-based truncation. Prefer
 * {@link toTerminalKitText} unless the text was sanitized and measured first.
 */
export function escapeTerminalKitMarkup(value: string): string {
  return value.replace(/\^/gu, '^^').replace(/%/gu, '%%');
}

/**
 * {@link toDisplayText}, then {@link escapeTerminalKitMarkup}, so the text is
 * printed literally by `term(...)`, `term.bold(...)` and the other styled
 * terminal-kit calls. Use it for every untrusted string passed to a
 * terminal-kit format string.
 */
export function toTerminalKitText(value: string, options: DisplayTextOptions = {}): string {
  return escapeTerminalKitMarkup(toDisplayText(value, options));
}

/*
 * Escape-sequence grammar (ECMA-48), in both the 7-bit (ESC-prefixed) and the
 * 8-bit C1 spelling, because terminals also act on C1 code points written as
 * UTF-8.
 *
 * - Control strings: OSC (ESC ] / U+009D), DCS (ESC P / U+0090), SOS (ESC X /
 *   U+0098), PM (ESC ^ / U+009E) and APC (ESC _ / U+009F), terminated by ST
 *   (ESC \ or U+009C) or BEL. The body may not contain other control
 *   characters (ECMA-48 allows only 0x08-0x0D and printables there); this
 *   also keeps every match attempt bounded by the next control character, so
 *   the scan stays linear on hostile input.
 * - CSI (ESC [ / U+009B): parameter bytes 0x30-0x3F, intermediate bytes
 *   0x20-0x2F, one final byte 0x40-0x7E.
 * - Other escapes (nF/Fp/Fe/Fs, e.g. ESC c, ESC ( 0, ESC # 8): ESC,
 *   intermediate bytes 0x20-0x2F, one final byte 0x30-0x7E.
 */
const CONTROL_STRING =
  // eslint-disable-next-line no-control-regex
  /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[^\u0000-\u0007\u000e-\u001f\u007f-\u009f]*(?:\u0007|\u001b\\|\u009c)/gu;
// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\u001b[ -/]*[0-~]/gu;
/** Every control character a terminal acts on, except tab and line feed. */
// eslint-disable-next-line no-control-regex
const REMAINING_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/**
 * Remove terminal control sequences and control characters from untrusted
 * prose before it is rendered (for example agent markdown passed to
 * `marked`). Complete CSI, OSC, DCS, APC, PM, SOS and other escape sequences
 * are removed in both 7-bit and C1 form; afterwards every remaining C0/C1
 * control character except tab and line feed is removed, so an unterminated
 * or malformed sequence can only leave inert printable text behind. CRLF
 * becomes LF. Printable text, including bidi and other format characters, is
 * kept: use {@link toDisplayText} where those must be visible.
 */
export function stripTerminalSequences(value: string): string {
  let text = value;
  // Removing one sequence can splice its neighbours into a new one, so each
  // pass applies the most specific grammar that still matches and the loop
  // repeats until nothing changes. Every pass is linear and only shrinks the
  // text; the pass cap bounds pathological splicing, and the final control
  // sweep below keeps the result safe either way.
  for (let pass = 0; pass < 64; pass += 1) {
    let next = text.replace(CONTROL_STRING, '');
    if (next === text) next = text.replace(CSI_SEQUENCE, '');
    if (next === text) next = text.replace(ESCAPE_SEQUENCE, '');
    if (next === text) break;
    text = next;
  }
  return text.replace(/\r\n/gu, '\n').replace(REMAINING_CONTROL, '');
}

/**
 * Bidi embedding, override and isolate controls (LRE, RLE, PDF, LRO, RLO,
 * LRI, RLI, FSI, PDI): the characters that make a terminal show text in a
 * different order than it is stored ("Trojan Source").
 */
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Render bidi embedding, override and isolate controls as visible escapes
 * (`\u202e`), so prose that is otherwise rendered as-is (agent markdown after
 * {@link stripTerminalSequences}) displays in its real order: a reversed file
 * name or a command shown in an answer cannot read differently from what a
 * copy of it contains. Other format characters are kept, because prose uses
 * them legitimately (zero-width joiners in emoji, soft hyphens, the
 * directional marks of right-to-left text).
 */
export function escapeBidiControls(value: string): string {
  return value.replace(BIDI_CONTROL, (character) => escapeCodePoint(character.codePointAt(0) ?? 0));
}

/**
 * The characters `JSON.stringify` leaves raw that a terminal acts on or that
 * change how text displays: DEL, the C1 controls (U+0080-U+009F, which
 * terminals also honour when written as UTF-8), every format character (bidi
 * controls, zero-width and tag characters, ...), the line and paragraph
 * separators, and the other default-ignorable code points (variation
 * selectors, Hangul fillers, ...), which display as nothing. Machine output
 * makes no exception for an emoji's presentation selector. `JSON.stringify`
 * already escapes the C0 controls and lone surrogates.
 */
const JSON_RAW_UNSAFE = /[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * `JSON.stringify(value)` with every character a terminal could act on
 * written as a `\uXXXX` escape (a surrogate pair as two escapes), so machine
 * output printed to a terminal (a `--json` result read by a human, or an
 * agent's tool output shown to its operator) cannot move the cursor, set the
 * clipboard or reorder text. The result parses to exactly the same value:
 * `JSON.stringify` emits these characters only inside string literals, where
 * a `\u` escape means the character itself.
 */
export function toTerminalSafeJson(value: Readonly<Record<string, unknown>> | readonly unknown[]): string {
  return toTerminalSafeJsonText(JSON.stringify(value));
}

/**
 * {@link toTerminalSafeJson} for text that is already the output of
 * `JSON.stringify` (a JSONL line produced elsewhere): the same escapes, the
 * same parsed value.
 */
export function toTerminalSafeJsonText(json: string): string {
  return json.replace(JSON_RAW_UNSAFE, (character) => {
    let escaped = '';
    for (let index = 0; index < character.length; index += 1) {
      escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`;
    }
    return escaped;
  });
}
