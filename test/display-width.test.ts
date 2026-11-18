import { describe, expect, it } from 'vitest';

import {
  codePointWidth,
  displayWidth,
  fitsWidth,
  truncateToWidth,
  wrapToWidth,
} from '../src/terminal/display-width.js';

describe('displayWidth', () => {
  it('counts ASCII and Latin text one cell per character', () => {
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('hello world')).toBe(11);
    expect(displayWidth('naïve café')).toBe(10);
  });

  it('counts East Asian wide and fullwidth characters as two cells', () => {
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('한국어')).toBe(6);
    expect(displayWidth('ＡＢＣ')).toBe(6);
    expect(displayWidth('a日b')).toBe(4);
    expect(codePointWidth(0x4e00)).toBe(2);
    expect(codePointWidth(0x303f)).toBe(1); // the narrow gap inside the CJK block
    expect(codePointWidth(0x20000)).toBe(2);
  });

  it('counts emoji as two cells, including VS16 and flag sequences', () => {
    expect(displayWidth('😀')).toBe(2);
    expect(displayWidth('⚡')).toBe(2); // default emoji presentation
    expect(displayWidth('☺')).toBe(1); // default text presentation
    expect(displayWidth('☺\ufe0f')).toBe(2); // forced into emoji presentation
    expect(displayWidth('🇩🇪')).toBe(2); // regional indicator pair
    expect(displayWidth('👍🏽')).toBe(2); // skin-tone modifier takes no cell
  });

  it('gives combining marks, controls and format characters no cells', () => {
    expect(displayWidth('e\u0301')).toBe(1);
    expect(displayWidth('\u001b[2J')).toBe(3);
    expect(displayWidth('a\u200bb\u202ec')).toBe(3);
    expect(codePointWidth(0x0000)).toBe(0);
    expect(codePointWidth(0x200d)).toBe(0);
  });
});

describe('truncateToWidth', () => {
  it('returns text that fits unchanged', () => {
    expect(truncateToWidth('hello', 5)).toBe('hello');
    expect(truncateToWidth('hello', 10)).toBe('hello');
    expect(truncateToWidth('', 3)).toBe('');
  });

  it('cuts by cells and marks the cut with an ellipsis', () => {
    expect(truncateToWidth('hello world', 5)).toBe('hell…');
    expect(truncateToWidth('abcdef', 3)).toBe('ab…');
    expect(truncateToWidth('abcdef', 1)).toBe('…');
  });

  it('never splits a wide character or a grapheme cluster', () => {
    expect(truncateToWidth('日本語テキスト', 7)).toBe('日本語…');
    expect(truncateToWidth('日本語', 4)).toBe('日…'); // 日本 would be 4 and leave no room for the marker
    expect(truncateToWidth('e\u0301e\u0301e\u0301', 2)).toBe('e\u0301…');
    expect(displayWidth(truncateToWidth('a😀b😀c', 4))).toBeLessThanOrEqual(4);
  });

  it('returns the empty string for a zero or negative budget and honours a custom marker', () => {
    expect(truncateToWidth('abc', 0)).toBe('');
    expect(truncateToWidth('abc', -2)).toBe('');
    expect(truncateToWidth('abcdef', 5, '...')).toBe('ab...');
    expect(truncateToWidth('abcdef', 2, '...')).toBe('..');
  });
});

describe('optimized paths', () => {
  /** The straightforward algorithms the optimized helpers must match. */
  const referenceWidth = (text: string): number => {
    const codePoints = Array.from(text);
    let width = 0;
    for (let i = 0; i < codePoints.length; i += 1) {
      const codePoint = codePoints[i].codePointAt(0) ?? 0;
      const next = i + 1 < codePoints.length ? (codePoints[i + 1].codePointAt(0) ?? -1) : -1;
      const flag = (c: number): boolean => c >= 0x1f1e6 && c <= 0x1f1ff;
      if (flag(codePoint) && flag(next)) {
        width += 2;
        i += 1;
      } else if (next === 0xfe0f && /^\p{Extended_Pictographic}$/u.test(codePoints[i])) {
        width += 2;
        i += 1;
      } else {
        width += codePointWidth(codePoint);
      }
    }
    return width;
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const referenceTruncate = (text: string, maxWidth: number, marker = '…'): string => {
    if (!(maxWidth > 0)) return '';
    if (referenceWidth(text) <= maxWidth) return text;
    const budget = maxWidth - referenceWidth(marker);
    if (budget < 0) return referenceTruncate(marker, maxWidth, '');
    let used = 0;
    let kept = '';
    for (const { segment } of segmenter.segment(text)) {
      const width = referenceWidth(segment);
      if (used + width > budget) break;
      kept += segment;
      used += width;
    }
    return kept + marker;
  };
  const referenceWrap = (text: string, width: number): string[] => {
    const limit = Math.max(1, Math.floor(width));
    const rows: string[] = [];
    let current = '';
    let used = 0;
    for (const { segment } of segmenter.segment(text)) {
      const segmentWidth = referenceWidth(segment);
      if (used > 0 && used + segmentWidth > limit) {
        rows.push(current);
        current = '';
        used = 0;
      }
      current += segment;
      used += segmentWidth;
    }
    rows.push(current);
    return rows;
  };

  it('match the straightforward algorithms on random text', () => {
    const pool = [
      'a',
      'b',
      ' ',
      '~',
      '日',
      'Ｆ',
      '😀',
      '🇩',
      '🇪',
      '☺',
      '\ufe0f',
      '\u0301',
      '\u200d',
      '\u001b',
      '\ud800',
      'é',
    ];
    let seed = 5;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 600; round += 1) {
      const sample = Array.from(
        { length: Math.floor(random() * 30) },
        () => pool[Math.floor(random() * pool.length)],
      ).join('');
      const width = Math.floor(random() * 25) - 2;
      expect(displayWidth(sample)).toBe(referenceWidth(sample));
      expect(truncateToWidth(sample, width)).toBe(referenceTruncate(sample, width));
      expect(truncateToWidth(sample, width + 0.5, '...')).toBe(referenceTruncate(sample, width + 0.5, '...'));
      expect(wrapToWidth(sample, width)).toEqual(referenceWrap(sample, width));
    }
  });

  it('truncate a multi-megabyte string at the cost of the width', () => {
    const ascii = 'x'.repeat(5_000_000);
    const mixed = `${'日本語のテキスト'.repeat(500_000)}\u001b`;
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) {
      expect(truncateToWidth(ascii, 10)).toBe('xxxxxxxxx…');
      expect(truncateToWidth(mixed, 10)).toBe('日本語の…');
    }
    // Measuring or segmenting the whole string each time would take many seconds.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('fitsWidth', () => {
  it('agrees with displayWidth', () => {
    for (const [text, width] of [
      ['', 0],
      ['abc', 3],
      ['abcd', 3],
      ['日本', 4],
      ['日本', 3],
      ['e\u0301x', 2],
      ['😀', 1],
    ] as const) {
      expect(fitsWidth(text, width)).toBe(displayWidth(text) <= width);
    }
  });

  it('answers for a multi-megabyte string at the cost of the width', () => {
    // An escalation reason or whitelist pattern can embed a long agent value, and the
    // picker asks on every frame whether its row was cut.
    const wide = 'é'.repeat(5_000_000);
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) {
      expect(fitsWidth(wide, 70)).toBe(false);
      expect(fitsWidth(`${'x'.repeat(4_000_000)}日`, 70)).toBe(false);
    }
    // Measuring the whole string each time would take many seconds.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('wrapToWidth', () => {
  it('hard-wraps by cells and keeps every character', () => {
    expect(wrapToWidth('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
    expect(wrapToWidth('日本語', 4)).toEqual(['日本', '語']);
    expect(wrapToWidth('a日本', 2)).toEqual(['a', '日', '本']);
    expect(wrapToWidth('', 5)).toEqual(['']);
    expect(wrapToWidth('abc', 10)).toEqual(['abc']);
  });

  it('gives a cluster wider than the width its own row rather than dropping it', () => {
    expect(wrapToWidth('日', 1)).toEqual(['日']);
  });
});
