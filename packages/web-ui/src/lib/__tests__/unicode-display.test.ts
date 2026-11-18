import { describe, it, expect } from 'vitest';
import { escapeCodePoint, hasInvisibleCodePoints, segmentDisplayText, toDisplayText } from '../unicode-display.js';

describe('segmentDisplayText', () => {
  it('leaves ordinary text, including RTL letters and emoji, as one run', () => {
    expect(segmentDisplayText('hello שלום \u{1f600}')).toEqual([{ kind: 'text', value: 'hello שלום \u{1f600}' }]);
  });

  it('marks bidi overrides, isolates and marks as escapes', () => {
    const segments = segmentDisplayText('a\u202eb\u2066c\u2069d\u200ee\u061cf');
    expect(segments.filter((s) => s.kind === 'escape').map((s) => s.value)).toEqual([
      '\\u202e',
      '\\u2066',
      '\\u2069',
      '\\u200e',
      '\\u061c',
    ]);
    expect(segments.filter((s) => s.kind === 'text').map((s) => s.value)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('marks zero-width characters, BOM, soft hyphen, tags and separators', () => {
    expect(toDisplayText('x\u200by\u200cz\u200d\u2060\ufeff\u00ad\u{e0041}\u2028\u2029')).toBe(
      'x\\u200by\\u200cz\\u200d\\u2060\\ufeff\\u00ad\\u{e0041}\\u2028\\u2029',
    );
  });

  it('marks C0/C1 controls and lone surrogates', () => {
    expect(toDisplayText('a\u0007b\u001bc\u007fd\u0085e\ud800f')).toBe('a\\u0007b\\u001bc\\u007fd\\u0085e\\ud800f');
  });

  it('escapes newlines and tabs by default and keeps them in multiline mode', () => {
    expect(toDisplayText('a\nb\tc\r\nd')).toBe('a\\nb\\tc\\r\\nd');
    expect(toDisplayText('a\nb\tc\r\nd', { multiline: true })).toBe('a\nb\tc\nd');
  });

  it('folds escapes past maxEscapeSegments into text runs without dropping any', () => {
    const zwsp = String.fromCodePoint(0x200b);
    const text = `a${zwsp.repeat(5)}b${zwsp}`;
    const segments = segmentDisplayText(text, { maxEscapeSegments: 2 });
    expect(segments.filter((s) => s.kind === 'escape')).toHaveLength(2);
    expect(segments.map((s) => s.value).join('')).toBe(toDisplayText(text));
    expect(segments.at(-1)?.kind).toBe('text');
  });

  it('records the code point of each escape', () => {
    expect(segmentDisplayText('\u202e')).toEqual([{ kind: 'escape', value: '\\u202e', codePoint: 0x202e }]);
  });

  it('marks the default-ignorable code points that display as nothing', () => {
    // A payload hidden in variation selectors, one per byte ("emoji smuggling").
    const smuggled = `ok${String.fromCodePoint(0xe0100, 0xe0101, 0xe0102, 0xe0103, 0xe0104, 0xe0105)}`;
    expect(toDisplayText(smuggled)).toBe('ok\\u{e0100}\\u{e0101}\\u{e0102}\\u{e0103}\\u{e0104}\\u{e0105}');
    expect(segmentDisplayText(smuggled).filter((s) => s.kind === 'escape')).toHaveLength(6);
    expect(toDisplayText('a\u3164b')).toBe('a\\u3164b');
    expect(toDisplayText('a\u034fb')).toBe('a\\u034fb');
    expect(toDisplayText('\u115f\u1160\uffa0\u17b4\u17b5')).toBe('\\u115f\\u1160\\uffa0\\u17b4\\u17b5');
    expect(toDisplayText('\u180b\u180f\ufe00\ufe0d\u2065\u{e0000}')).toBe(
      '\\u180b\\u180f\\ufe00\\ufe0d\\u2065\\u{e0000}',
    );
    expect(toDisplayText('line\u3164\nnext', { multiline: true })).toBe('line\\u3164\nnext');
  });

  it('keeps the one presentation selector of an emoji and marks every other variation selector', () => {
    for (const emoji of ['\u2764\ufe0f', 'warning \u26a0\ufe0f!', '\u21a9\ufe0e', '1\ufe0f\u20e3']) {
      expect(segmentDisplayText(emoji)).toEqual([{ kind: 'text', value: emoji }]);
    }
    expect(toDisplayText('a\ufe0fb')).toBe('a\\ufe0fb');
    expect(toDisplayText('1\ufe0f')).toBe('1\\ufe0f');
    expect(toDisplayText('\ufe0fx')).toBe('\\ufe0fx');
    expect(toDisplayText('\u2764\ufe0f\ufe0f')).toBe('\u2764\\ufe0f\\ufe0f');
    expect(toDisplayText('\u2764\ufe0f\u{e0100}')).toBe('\u2764\\ufe0f\\u{e0100}');
    expect(toDisplayText('\u{1f600}\ufe00')).toBe('\u{1f600}\\ufe00');
  });
});

describe('escapeCodePoint', () => {
  it('uses JSON spellings for the common whitespace controls', () => {
    expect(escapeCodePoint(0x0a)).toBe('\\n');
    expect(escapeCodePoint(0x0d)).toBe('\\r');
    expect(escapeCodePoint(0x09)).toBe('\\t');
    expect(escapeCodePoint(0x1b)).toBe('\\u001b');
    expect(escapeCodePoint(0xe0041)).toBe('\\u{e0041}');
  });
});

describe('hasInvisibleCodePoints', () => {
  it('ignores clean values and plain whitespace controls', () => {
    expect(hasInvisibleCodePoints('plain text\nwith lines\tand tabs\r\n')).toBe(false);
    expect(hasInvisibleCodePoints({ path: '/etc/hosts', content: 'x', n: 3, ok: true, nothing: null })).toBe(false);
    expect(hasInvisibleCodePoints(undefined)).toBe(false);
  });

  it('finds invisible characters in nested values and in object keys', () => {
    expect(hasInvisibleCodePoints({ args: { path: '/tmp/\u202etxt.sh' } })).toBe(true);
    expect(hasInvisibleCodePoints(['ok', ['deeper', 'x\u200by']])).toBe(true);
    expect(hasInvisibleCodePoints({ ['key\u2066']: 'value' })).toBe(true);
    expect(hasInvisibleCodePoints('\u0007')).toBe(true);
  });

  it('finds variation selectors, fillers and other default-ignorable code points', () => {
    expect(
      hasInvisibleCodePoints(`ok${String.fromCodePoint(0xe0100, 0xe0101, 0xe0102, 0xe0103, 0xe0104, 0xe0105)}`),
    ).toBe(true);
    expect(hasInvisibleCodePoints({ body: 'a\u3164b' })).toBe(true);
    expect(hasInvisibleCodePoints(['a\u034fb'])).toBe(true);
    expect(hasInvisibleCodePoints({ ['key\u{e0100}']: 'value' })).toBe(true);
    expect(hasInvisibleCodePoints('a\ufe0f')).toBe(true);
    expect(hasInvisibleCodePoints('\u2764\ufe0f\ufe0f')).toBe(true);
  });

  it("does not warn about an emoji's presentation selector", () => {
    expect(hasInvisibleCodePoints('I \u2764\ufe0f this \u26a0\ufe0f 1\ufe0f\u20e3\n')).toBe(false);
    expect(hasInvisibleCodePoints({ ['\u2764\ufe0f']: ['\u21a9\ufe0e'] })).toBe(false);
  });

  it('terminates on self-referencing structures', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(hasInvisibleCodePoints(loop)).toBe(false);
  });
});
