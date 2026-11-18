import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  escapeBidiControls,
  stripTerminalSequences,
  toDisplayText,
  toTerminalKitText,
  toTerminalSafeJson,
} from '../src/terminal/display-sanitize.js';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;

/**
 * Every code point a terminal acts on or that renders invisibly, which must
 * never survive toDisplayText. The presentation selectors U+FE0E/U+FE0F are
 * left out: one that belongs to an emoji is kept (see the tests below).
 */
const UNSAFE_SINGLE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|(?![\ufe0e\ufe0f])\p{Default_Ignorable_Code_Point}/u;
const UNSAFE_MULTILINE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|(?![\ufe0e\ufe0f])\p{Default_Ignorable_Code_Point}/u;
/** The presentation selectors, which no emoji in {@link HOSTILE} could carry. */
const PRESENTATION_SELECTOR = /[\ufe0e\ufe0f]/u;
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

/** A hostile payload covering every class the sanitizer must neutralize. */
const HOSTILE = [
  'tool:',
  `${ESC}[2J${ESC}[H`, // CSI: clear screen, home
  `${ESC}]52;c;cm0gLXJmIH4K${BEL}`, // OSC 52 clipboard write
  `${ESC}]0;fake title${ST}`, // OSC title via ST
  `${ESC}[6n`, // CSI device status report (terminal types a reply)
  '\u009b31m', // 8-bit CSI
  '\u009d52;c;eA==\u009c', // 8-bit OSC with 8-bit ST
  '\u0085', // NEL
  `file\u202Etxt.exe`, // RLO
  '\u2066\u2067\u2068\u2069', // isolates
  '\u061c\u200b\u200c\u200d\u200e\u200f', // ALM, zero-width, LRM/RLM
  '\u2028\u2029', // line/paragraph separators
  '\ufeff', // BOM
  '\u{e0041}\u{e0042}', // tag characters (ASCII smuggling)
  '\u00ad', // soft hyphen
  '\u3164\u115f\u1160\uffa0', // Hangul fillers
  '\u034f\u17b4\u17b5\u180b', // CGJ, Khmer inherent vowels, Mongolian free variation selector
  '\u{e0100}\u{e0101}\ufe00', // variation selectors (emoji smuggling: one per byte)
  'x\ufe0f\ufe0e', // presentation selectors after a letter
  '\u2065\u{e0000}', // reserved default-ignorable code points
  '\u007f', // DEL
  '\r', // carriage return (overwrites the line start)
  '\u0000\b',
].join('');

describe('toDisplayText', () => {
  it('renders ESC, CSI, OSC 52, C1 and bidi controls as visible escapes', () => {
    expect(toDisplayText(`a${ESC}[2Jb`)).toBe('a\\u001b[2Jb');
    expect(toDisplayText(`${ESC}]52;c;ZXZpbA==${BEL}`)).toBe('\\u001b]52;c;ZXZpbA==\\u0007');
    expect(toDisplayText('\u009b31m\u0085')).toBe('\\u009b31m\\u0085');
    expect(toDisplayText('file\u202Etxt.exe')).toBe('file\\u202etxt.exe');
    expect(toDisplayText('\u2066x\u2069')).toBe('\\u2066x\\u2069');
    expect(toDisplayText('\u061c\u200b\u200f\u2028\u2029\ufeff\u00ad\u007f')).toBe(
      '\\u061c\\u200b\\u200f\\u2028\\u2029\\ufeff\\u00ad\\u007f',
    );
    expect(toDisplayText('\u{e0041}')).toBe('\\u{e0041}');
    expect(toDisplayText('\ud800x')).toBe('\\ud800x');
  });

  it('leaves no control or invisible format character in a hostile payload', () => {
    const single = toDisplayText(HOSTILE);
    expect(single).not.toMatch(UNSAFE_SINGLE_LINE);
    expect(single).not.toMatch(PRESENTATION_SELECTOR);
    expect(single).not.toContain('\n');
    const multi = toDisplayText(HOSTILE, { multiline: true });
    expect(multi).not.toMatch(UNSAFE_MULTILINE);
    expect(multi).not.toMatch(PRESENTATION_SELECTOR);
  });

  it('escapes line breaks and tabs in single-line mode and keeps them in multiline mode', () => {
    expect(toDisplayText('a\nb\tc')).toBe('a\\nb\\tc');
    expect(toDisplayText('a\nb\tc', { multiline: true })).toBe('a\nb\tc');
    expect(toDisplayText('a\r\nb', { multiline: true })).toBe('a\nb');
    expect(toDisplayText('a\rb', { multiline: true })).toBe('a\\rb');
    expect(toDisplayText('a\r\nb')).toBe('a\\r\\nb');
  });

  it('keeps printable Unicode, emoji and backslashes unchanged', () => {
    const text = 'C:\\Users\\dev — naïve 日本語 😀 ^%$';
    expect(toDisplayText(text)).toBe(text);
  });

  it('renders the default-ignorable code points that display as nothing as escapes', () => {
    // A payload hidden in variation selectors, one per byte ("emoji smuggling").
    expect(toDisplayText(`ok${String.fromCodePoint(0xe0100, 0xe0101, 0xe0102, 0xe0103, 0xe0104, 0xe0105)}`)).toBe(
      'ok\\u{e0100}\\u{e0101}\\u{e0102}\\u{e0103}\\u{e0104}\\u{e0105}',
    );
    expect(toDisplayText('a\u3164b')).toBe('a\\u3164b');
    expect(toDisplayText('a\u034fb')).toBe('a\\u034fb');
    expect(toDisplayText('\u115f\u1160\uffa0\u17b4\u17b5')).toBe('\\u115f\\u1160\\uffa0\\u17b4\\u17b5');
    expect(toDisplayText('\u180b\u180c\u180d\u180f\ufe00\ufe0d')).toBe('\\u180b\\u180c\\u180d\\u180f\\ufe00\\ufe0d');
    expect(toDisplayText('\u2065\ufff0\u{e0000}\u{e0080}\u{e0fff}')).toBe(
      '\\u2065\\ufff0\\u{e0000}\\u{e0080}\\u{e0fff}',
    );
    expect(toDisplayText('line\u3164\nnext', { multiline: true })).toBe('line\\u3164\nnext');
    expect(toDisplayText('a\u3164b', { maxLength: 8 })).toBe('a\\u3164b');
  });

  it('keeps the one presentation selector of an emoji and escapes every other variation selector', () => {
    // An emoji presentation selector after a pictograph (the red heart, the
    // warning sign), a text presentation selector, and a keycap.
    for (const emoji of [
      '\u2764\ufe0f',
      'warning \u26a0\ufe0f!',
      '\u21a9\ufe0e',
      '\u{1f3f3}\ufe0f',
      '1\ufe0f\u20e3 #\ufe0f\u20e3',
    ]) {
      expect(toDisplayText(emoji)).toBe(emoji);
      expect(toDisplayText(emoji, { multiline: true })).toBe(emoji);
    }
    // After a letter, a digit outside a keycap, a space or nothing it hides
    // a bit; a run of selectors is never an emoji.
    expect(toDisplayText('a\ufe0fb')).toBe('a\\ufe0fb');
    expect(toDisplayText('1\ufe0f')).toBe('1\\ufe0f');
    expect(toDisplayText(' \ufe0e')).toBe(' \\ufe0e');
    expect(toDisplayText('\ufe0fx')).toBe('\\ufe0fx');
    expect(toDisplayText('\u2764\ufe0f\ufe0f')).toBe('\u2764\\ufe0f\\ufe0f');
    expect(toDisplayText('\u2764\ufe0f\u{e0100}')).toBe('\u2764\\ufe0f\\u{e0100}');
    expect(toDisplayText('\u2764\ufe0e\ufe0f')).toBe('\u2764\\ufe0e\\ufe0f');
    expect(toDisplayText('\u{1f600}\ufe00')).toBe('\u{1f600}\\ufe00');
    // A cut keeps the selector with its emoji or escapes it like the rest.
    expect(toDisplayText('\u2764\ufe0f\u2764\ufe0f', { maxLength: 4 })).toBe('\u2764\ufe0f\u2764\ufe0f');
  });

  it('never truncates unless asked', () => {
    const long = `${'x'.repeat(200_000)}${ESC}`;
    expect(toDisplayText(long)).toBe(`${'x'.repeat(200_000)}\\u001b`);
  });

  it('marks a requested truncation and never splits an escape', () => {
    const cut = toDisplayText('x'.repeat(100), { maxLength: 30 });
    expect(Array.from(cut).length).toBeLessThanOrEqual(30);
    const match = /^(x*)\.\.\.\[\+(\d+) chars\]$/u.exec(cut);
    expect(match).not.toBeNull();
    expect((match?.[1].length ?? 0) + Number(match?.[2])).toBe(100);

    const escapes = toDisplayText(ESC.repeat(20), { maxLength: 40 });
    const body = escapes.replace(/\.\.\.\[\+\d+ chars\]$/u, '');
    expect(body).toMatch(/^(?:\\u001b)*$/u);
    expect(escapes).toMatch(/\.\.\.\[\+\d+ chars\]$/u);

    expect(toDisplayText('abc', { maxLength: 3 })).toBe('abc');
    expect(toDisplayText('abcdef', { maxLength: 0 })).toBe('...[+6 chars]');
    expect(() => toDisplayText('x', { maxLength: -1 })).toThrow(RangeError);
    expect(() => toDisplayText('x', { maxLength: Number.NaN })).toThrow(RangeError);
  });

  it('matches the plain per-code-point rendering on random input, with and without a cap', () => {
    // The straightforward algorithm: render every code point, then cut whole tokens.
    const reference = (value: string, multiline: boolean, maxLength?: number): string => {
      const text = multiline ? value.replace(/\r\n/gu, '\n') : value;
      const characters = Array.from(text);
      const tokens = characters.map((character, index) => {
        if (multiline && (character === '\n' || character === '\t')) return character;
        if (!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u.test(character)) return character;
        const previous = characters[index - 1] ?? '';
        const next = characters[index + 1] ?? '';
        const ofEmoji =
          (character === '\ufe0e' || character === '\ufe0f') &&
          !/^\p{Variation_Selector}$/u.test(next) &&
          (/^\p{Extended_Pictographic}$/u.test(previous) ||
            (character === '\ufe0f' && next === '\u20e3' && /^[0-9#*]$/u.test(previous)));
        if (ofEmoji) return character;
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint === 0x0a) return '\\n';
        if (codePoint === 0x0d) return '\\r';
        if (codePoint === 0x09) return '\\t';
        return codePoint > 0xffff ? `\\u{${codePoint.toString(16)}}` : `\\u${codePoint.toString(16).padStart(4, '0')}`;
      });
      if (maxLength === undefined) return tokens.join('');
      const length = (token: string): number => Array.from(token).length;
      if (tokens.reduce((sum, token) => sum + length(token), 0) <= maxLength) return tokens.join('');
      const budget = Math.max(0, Math.floor(maxLength) - `...[+${characters.length} chars]`.length);
      let used = 0;
      let kept = 0;
      while (kept < tokens.length && used + length(tokens[kept]) <= budget) used += length(tokens[kept++]);
      return `${tokens.slice(0, kept).join('')}...[+${characters.length - kept} chars]`;
    };
    const pool = [
      'a',
      'Z',
      ' ',
      '\n',
      '\t',
      '\r',
      '\r\n',
      ESC,
      BEL,
      '\u009b',
      '\u202e',
      '\u200b',
      '日',
      '😀',
      '\ud800',
      '\udc00',
      '\u{e0041}',
      '\u2764',
      '1',
      '\ufe0e',
      '\ufe0f',
      '\u20e3',
      '\u{e0100}',
      '\u3164',
      '\u034f',
    ];
    let seed = 11;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 500; round += 1) {
      const sample = Array.from(
        { length: Math.floor(random() * 40) },
        () => pool[Math.floor(random() * pool.length)],
      ).join('');
      const maxLength = round % 3 === 0 ? undefined : Math.floor(random() * 60);
      for (const multiline of [false, true]) {
        expect(toDisplayText(sample, { multiline, maxLength })).toBe(reference(sample, multiline, maxLength));
      }
    }
  });

  it('cuts a multi-megabyte value at the cost of the cap', () => {
    const huge = `${'a'.repeat(4_000_000)}${ESC}`;
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) {
      expect(toDisplayText(huge, { maxLength: 40 })).toBe(`${'a'.repeat(21)}...[+3999980 chars]`);
    }
    // Rendering the whole value each time would take many seconds.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('neutralizes randomized mixes of controls and text', () => {
    const pool = [
      'a',
      ' ',
      '\n',
      '\t',
      '\r',
      ESC,
      '[',
      ']',
      '\\',
      BEL,
      '\u009b',
      '\u009d',
      '\u202e',
      '\u200b',
      '😀',
      '\u3164',
      '\u{e0100}',
    ];
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 200; round += 1) {
      const sample = Array.from({ length: 40 }, () => pool[Math.floor(random() * pool.length)]).join('');
      expect(toDisplayText(sample)).not.toMatch(UNSAFE_SINGLE_LINE);
      expect(toDisplayText(sample, { multiline: true })).not.toMatch(UNSAFE_MULTILINE);
    }
  });
});

interface CapturedTerminal {
  (text: string): void;
  bold(text: string): void;
}

/** A real terminal-kit Terminal writing into memory. */
async function captureTerminalKit(): Promise<{ term: CapturedTerminal; output: () => Promise<string> }> {
  const terminalKit = await import('terminal-kit');
  const createTerminal = terminalKit.default.createTerminal as (options: Record<string, unknown>) => CapturedTerminal;
  const stdout = new PassThrough();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
  let written = '';
  stdout.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  const term = createTerminal({ stdin, stdout, generic: 'xterm-256color', appId: 'xterm-256color', isTTY: true });
  return {
    term,
    output: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return written;
    },
  };
}

/** Remove the SGR styling terminal-kit itself emits, leaving the visible text. */
function visibleText(rendered: string): string {
  // eslint-disable-next-line no-control-regex
  return rendered.replace(/\u001b\[[0-9;]*m/gu, '');
}

describe('toTerminalKitText', () => {
  it('escapes markup and format characters on top of the display escapes', () => {
    expect(toTerminalKitText('^R100% %s ^[red]x')).toBe('^^R100%% %%s ^^[red]x');
    expect(toTerminalKitText(`${ESC}[1m^`)).toBe('\\u001b[1m^^');
  });

  it('makes terminal-kit print hostile text literally, with no control bytes', async () => {
    const { term, output } = await captureTerminalKit();
    const hostile = `^R100% %s ^[red]x ${HOSTILE}`;
    term(toTerminalKitText(hostile));
    term.bold(toTerminalKitText('^^ %d'));
    const rendered = visibleText(await output());
    expect(rendered).toBe(`${toDisplayText(hostile)}${toDisplayText('^^ %d')}`);
    expect(rendered).not.toMatch(TERMINAL_CONTROL);
  });
});

describe('stripTerminalSequences', () => {
  it('removes CSI, OSC (BEL and ST), DCS, APC, PM and SOS sequences', () => {
    expect(stripTerminalSequences(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(stripTerminalSequences(`a${ESC}]52;c;cm0gLXJmIH4K${BEL}b`)).toBe('ab');
    expect(stripTerminalSequences(`a${ESC}]52;c;cm0gLXJmIH4K${ST}b`)).toBe('ab');
    expect(stripTerminalSequences(`${ESC}]8;;https://evil.example${ST}click${ESC}]8;;${ST}`)).toBe('click');
    expect(stripTerminalSequences(`a${ESC}P1$r0m${ST}b`)).toBe('ab');
    expect(stripTerminalSequences(`a${ESC}_payload${ST}b`)).toBe('ab');
    expect(stripTerminalSequences(`a${ESC}^privacy${ST}b`)).toBe('ab');
    expect(stripTerminalSequences(`a${ESC}Xstring${ST}b`)).toBe('ab');
  });

  it('removes the 8-bit C1 forms', () => {
    expect(stripTerminalSequences('a\u009b2Jb')).toBe('ab');
    expect(stripTerminalSequences('a\u009d52;c;eA==\u009cb')).toBe('ab');
    expect(stripTerminalSequences('a\u0090q\u009cb\u0085c')).toBe('abc');
  });

  it('removes two-character and charset escapes', () => {
    expect(stripTerminalSequences(`a${ESC}cb${ESC}(0c${ESC}#8d${ESC}7e${ESC}=f`)).toBe('abcdef');
  });

  it('keeps text, tabs and line feeds; normalizes CRLF and drops other controls', () => {
    expect(stripTerminalSequences('# Title\r\n\n\tcode\r\nend')).toBe('# Title\n\n\tcode\nend');
    expect(stripTerminalSequences(`over\rwrite${BEL}\u0000\u007f\b`)).toBe('overwrite');
    expect(stripTerminalSequences('file\u202Etxt')).toBe('file\u202Etxt');
  });

  it('leaves only inert text from spliced, unterminated or malformed sequences', () => {
    expect(stripTerminalSequences(`${ESC}${ESC}[0m[31mred`)).toBe('red');
    expect(stripTerminalSequences(`x\u0090${ESC}[0m${ST}y`)).toBe('xy');
    // An unterminated OSC loses its introducer; the body is left as inert text.
    expect(stripTerminalSequences(`x${ESC}]52;c;abc`)).toBe('x52;c;abc');
    expect(stripTerminalSequences(`x${ESC}[`)).toBe('x');
    expect(stripTerminalSequences(HOSTILE)).not.toMatch(TERMINAL_CONTROL);
  });

  it('stays linear on hostile repetition', () => {
    const hostile = `${'\u009da'.repeat(100_000)}${`${ESC}]`.repeat(100_000)}${'x'.repeat(100_000)}`;
    const started = performance.now();
    const result = stripTerminalSequences(hostile);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result).not.toMatch(TERMINAL_CONTROL);
  });
});

describe('escapeBidiControls', () => {
  it('renders every bidi embedding, override and isolate control as a visible escape', () => {
    expect(escapeBidiControls('file\u202Etxt.exe')).toBe('file\\u202etxt.exe');
    expect(escapeBidiControls('\u202A\u202B\u202C\u202D\u2066\u2067\u2068\u2069')).toBe(
      '\\u202a\\u202b\\u202c\\u202d\\u2066\\u2067\\u2068\\u2069',
    );
  });

  it('keeps text and the format characters prose uses legitimately', () => {
    const prose = 'שלום\u200F (RTL mark), soft\u00ADhyphen, family 👨\u200D👩\u200D👧, plain ASCII';
    expect(escapeBidiControls(prose)).toBe(prose);
  });
});

describe('toTerminalSafeJson', () => {
  it('parses back to the same value and leaves nothing a terminal acts on', () => {
    const value = {
      text: HOSTILE,
      [`key${ESC}[2J\u202e`]: ['\u009b31m', 'caf\u00e9 \u{1f600}', 'line\nbreak'],
      nested: { n: 1, flag: true, none: null },
    };

    const json = toTerminalSafeJson(value);

    expect(JSON.parse(json)).toEqual(value);
    expect(json).not.toMatch(UNSAFE_SINGLE_LINE);
    // Printable non-ASCII text is left alone.
    expect(json).toContain('caf\u00e9 \u{1f600}');
  });

  it('writes C1 controls, bidi, zero-width and tag characters as \\u escapes', () => {
    expect(toTerminalSafeJson({ v: '\u009b31m\u0085' })).toBe('{"v":"\\u009b31m\\u0085"}');
    expect(toTerminalSafeJson({ v: 'a\u202eb\u200bc\u2028d\u007f' })).toBe('{"v":"a\\u202eb\\u200bc\\u2028d\\u007f"}');
    // An astral format character becomes its surrogate pair.
    expect(toTerminalSafeJson({ v: '\u{e0041}' })).toBe('{"v":"\\udb40\\udc41"}');
    // So do the other default-ignorable code points, variation selectors included.
    const hidden = { v: `ok\u{e0100}\u3164\u034f\u2764\ufe0f` };
    expect(toTerminalSafeJson(hidden)).toBe('{"v":"ok\\udb40\\udd00\\u3164\\u034f\u2764\\ufe0f"}');
    expect(JSON.parse(toTerminalSafeJson(hidden))).toEqual(hidden);
    // JSON.stringify's own escapes (C0, quotes, backslashes) are unchanged.
    expect(toTerminalSafeJson([`${ESC}"\\`])).toBe('["\\u001b\\"\\\\"]');
  });
});
