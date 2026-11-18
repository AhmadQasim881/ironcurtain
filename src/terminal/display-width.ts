/**
 * Terminal display width, in cells, for laying out text in boxes and columns.
 *
 * The mux draws untrusted strings (tool arguments, reasons, labels, paths)
 * inside bordered overlays. Cutting them by UTF-16 length lets a CJK or emoji
 * value overrun a box border or leave stale cells behind, and a cut that
 * counts code points mislabels how much it hid. These helpers count cells
 * instead. They expect display-safe text (see display-sanitize.ts); control
 * characters are still counted as zero cells so a stray one cannot widen a
 * layout.
 *
 * Rules, close enough to xterm's wcwidth and to terminal-kit's own string-kit
 * tables for layout purposes:
 * - control and format characters (Cc, Cf) and non-spacing or enclosing marks
 *   (Mn, Me) take no cells, as do emoji skin-tone modifiers;
 * - East Asian Wide and Fullwidth code points, emoji with default emoji
 *   presentation, pictographs followed by VS16 (U+FE0F) and regional-indicator
 *   pairs (flags) take two cells;
 * - everything else takes one cell.
 *
 * Zero-width-joiner sequences count as the sum of their parts, which
 * over-estimates on terminals that join them. Over-estimating only leaves a
 * gap before a border; under-estimating overruns it, so the bias is
 * deliberate.
 *
 * Cost. Approval overlays are redrawn with every frame of agent output, and
 * an argument can be megabytes long, so printable ASCII (the common case)
 * takes a fast path, and {@link truncateToWidth} stops reading once the cut
 * is known: its cost follows the width, not the length of the text.
 */

/** East Asian Wide (W) and Fullwidth (F) ranges, from EastAsianWidth.txt. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // angle brackets
  [0x2e80, 0x303e], // CJK Radicals Supplement .. CJK Symbols and Punctuation (U+303F is narrow)
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables and Radicals
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical Forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms .. Small Form Variants
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x16fe0, 0x16fe4], // Tangut and Nushu marks
  [0x17000, 0x18aff], // Tangut, Khitan
  [0x1b000, 0x1b16f], // Kana Supplement and Extended
  [0x1f200, 0x1f251], // Enclosed Ideographic Supplement
  [0x20000, 0x3fffd], // CJK Extension B .. Tertiary Ideographic Plane
];

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cc}\p{Cf}]$/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const VARIATION_SELECTOR_16 = 0xfe0f;
/** Text made only of printable ASCII: one cell per character, one character per cluster. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

/** Cells one code point takes on its own, without sequence context. */
export function codePointWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint >= 0x20 && codePoint < 0x7f) return 1;
  const character = String.fromCodePoint(codePoint);
  if (ZERO_WIDTH.test(character) || isEmojiModifier(codePoint)) return 0;
  if (EMOJI_PRESENTATION.test(character)) return 2;
  for (const [low, high] of WIDE_RANGES) {
    if (codePoint >= low && codePoint <= high) return 2;
  }
  return 1;
}

/** Cells the text takes on one terminal row (no wrapping considered). */
export function displayWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length;
  let width = 0;
  let index = 0;
  while (index < text.length) {
    // codePointAt yields a lone surrogate's own value, which counts as one cell.
    const codePoint = text.codePointAt(index) ?? 0;
    const nextIndex = index + (codePoint > 0xffff ? 2 : 1);
    const next = nextIndex < text.length ? (text.codePointAt(nextIndex) ?? -1) : -1;
    if (isRegionalIndicator(codePoint) && isRegionalIndicator(next)) {
      width += 2; // a flag
      index = nextIndex + 2;
      continue;
    }
    if (next === VARIATION_SELECTOR_16 && EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codePoint))) {
      width += 2; // text-presentation pictograph forced into emoji presentation
      index = nextIndex + 1;
      continue;
    }
    width += codePointWidth(codePoint);
    index = nextIndex;
  }
  return width;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Grapheme clusters of `text`, so a cut never separates a mark from its base. */
function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

/**
 * Cut `text` to at most `maxWidth` cells, ending with `marker` (default an
 * ellipsis) when anything was cut. Returns the text unchanged when it fits,
 * and the empty string when `maxWidth` is zero or negative. Reads only as
 * much of the text as the cut needs.
 */
export function truncateToWidth(text: string, maxWidth: number, marker = '…'): string {
  if (!(maxWidth > 0)) return '';
  const budget = maxWidth - displayWidth(marker);
  // Printable ASCII up to one character past the width decides the cut alone.
  const head = text.slice(0, Math.floor(maxWidth) + 1);
  if (PRINTABLE_ASCII.test(head)) {
    if (head.length <= maxWidth) return text; // head is the whole text
    if (budget < 0) return truncateToWidth(marker, maxWidth, '');
    return text.slice(0, Math.max(0, Math.floor(budget))) + marker;
  }
  // Segment a growing prefix, not the whole text: the segmenter copies its
  // input, and the cut is decided a few clusters past `maxWidth` cells.
  for (let length = Math.max(256, Math.ceil(maxWidth) * 8); ; length *= 4) {
    const complete = length >= text.length;
    const clusters = graphemes(complete ? text : text.slice(0, length));
    // The last cluster of a prefix may continue past it: never decide on it.
    if (!complete) clusters.pop();
    let used = 0;
    let kept = '';
    let keptBeforeBudget: string | null = null;
    for (const grapheme of clusters) {
      const width = displayWidth(grapheme);
      if (keptBeforeBudget === null && used + width > budget) keptBeforeBudget = kept;
      used += width;
      if (used > maxWidth) {
        if (budget < 0) return truncateToWidth(marker, maxWidth, '');
        return (keptBeforeBudget ?? kept) + marker;
      }
      kept += grapheme;
    }
    if (complete) return text;
  }
}

/**
 * Whether `text` fits in `maxWidth` cells. Like {@link truncateToWidth}, and
 * unlike comparing {@link displayWidth}, it reads only as much of the text as
 * the answer needs, so it is cheap for a value of any length.
 */
export function fitsWidth(text: string, maxWidth: number): boolean {
  return truncateToWidth(text, maxWidth) === text;
}

/**
 * Hard-wrap `text` into rows of at most `width` cells, splitting only between
 * grapheme clusters. Empty text yields one empty row; a cluster wider than
 * `width` gets a row of its own.
 */
export function wrapToWidth(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  if (PRINTABLE_ASCII.test(text)) {
    for (let start = 0; start < text.length; start += limit) rows.push(text.slice(start, start + limit));
    if (rows.length === 0) rows.push('');
    return rows;
  }
  let current = '';
  let used = 0;
  for (const { segment: grapheme } of graphemeSegmenter.segment(text)) {
    const graphemeWidth = displayWidth(grapheme);
    if (used > 0 && used + graphemeWidth > limit) {
      rows.push(current);
      current = '';
      used = 0;
    }
    current += grapheme;
    used += graphemeWidth;
  }
  rows.push(current);
  return rows;
}
