import { describe, expect, it } from 'vitest';
import { TerminalOutputFilter } from '../src/terminal/terminal-output-filter.js';

const ESC = '\x1b';
const OSC52_BEL = `${ESC}]52;c;ZWNobyBvd25lZA==\x07`;
const OSC52_ST = `${ESC}]52;c;ZWNobyBvd25lZA==${ESC}\\`;

function filterAll(...chunks: (string | Uint8Array)[]): string {
  const filter = new TerminalOutputFilter();
  return chunks.map((chunk) => filter.write(chunk)).join('') + filter.end();
}

/** Deterministic PRNG so a failing fuzz case is reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Output that the real terminal could act on beyond the allowlist. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_OUTPUT = /\x1b[\]P_^X\\cZ]|[\u0080-\u009f]|[\x00-\x06\x10-\x1a\x1c-\x1f\x7f]/u;

describe('TerminalOutputFilter', () => {
  it('forwards text, UTF-8, colors, cursor movement and erase unchanged', () => {
    const text = `plain ${ESC}[1;38;2;255;0;0mred${ESC}[0m ünïcødé 漢字 🎉\r\n${ESC}[2K${ESC}[1A${ESC}[G${ESC}[3;5H`;
    expect(filterAll(text)).toBe(text);
  });

  it('decodes UTF-8 split across chunks', () => {
    const bytes = Buffer.from('a🎉b漢', 'utf8');
    const chunks = [...bytes].map((byte) => Uint8Array.of(byte));
    expect(filterAll(...chunks)).toBe('a🎉b漢');
  });

  it('drops OSC 52 clipboard writes in every terminator and C1 form', () => {
    expect(filterAll(`before${OSC52_BEL}after`)).toBe('beforeafter');
    expect(filterAll(`before${OSC52_ST}after`)).toBe('beforeafter');
    expect(filterAll('before\u009d52;c;ZWNobw==\u009cafter')).toBe('beforeafter');
    expect(filterAll(`before${ESC}]52;c;?\x07after`)).toBe('beforeafter');
  });

  it('never forwards OSC 52 however the agent splits it across chunks', () => {
    const payload = Buffer.from(`x${OSC52_BEL}y${OSC52_ST}z`, 'utf8');
    for (let first = 1; first < payload.length; first += 1) {
      for (let second = first; second < payload.length; second += 3) {
        const output = filterAll(payload.subarray(0, first), payload.subarray(first, second), payload.subarray(second));
        expect(output).toBe('xyz');
      }
    }
  });

  it('drops hyperlinks, titles, notifications and other control strings', () => {
    const inputs = [
      `${ESC}]8;;https://evil.example/${ESC}\\click${ESC}]8;;${ESC}\\`,
      `${ESC}]0;fake IronCurtain approval\x07`,
      `${ESC}]2;title${ESC}\\`,
      `${ESC}]9;notify\x07`,
      `${ESC}]777;notify;a;b\x07`,
      `${ESC}]1337;File=name=eA==:AAAA\x07`,
      `${ESC}]7;file:///etc\x07`,
      `${ESC}]11;?\x07`,
      `${ESC}P$qm${ESC}\\`,
      `${ESC}Ptmux;${ESC}${ESC}]52;c;AA==\x07${ESC}\\`,
      `${ESC}_Gf=100,t=f;L2V0Yy9wYXNzd2Q=${ESC}\\`,
      `${ESC}^privacy${ESC}\\`,
      `${ESC}Xstart of string${ESC}\\`,
    ];
    for (const input of inputs) {
      expect(filterAll(`<${input}>`)).toBe(input.includes('click') ? '<click>' : '<>');
    }
  });

  it('drops report requests that echo text, window operations and terminal resets', () => {
    const dropped = [
      `${ESC}[21t`, // title report
      `${ESC}[20t`, // icon label report
      `${ESC}[8;100;300t`, // resize window
      `${ESC}[3;0;0t`, // move window
      `${ESC}[>q`, // XTVERSION
      `${ESC}[>0q`,
      `${ESC}[1;1;1;1;10;10*y`, // DECRQCRA screen checksum
      '\x05', // ENQ answerback
      `${ESC}Z`, // DECID
      `${ESC}c`, // RIS clears scrollback
      `${ESC}[2h`, // KAM locks the keyboard
      `${ESC}[20h`, // LNM changes what Enter sends
      `${ESC}[?1034h`, // meta key mode
      `${ESC}[?67h`, // backarrow key mode
      `${ESC}[?2031h`, // unsolicited theme reports
      `${ESC}[=1;1u`, // kitty flags set in place
      `${ESC}[5i`, // printer controller
      `${ESC}[10000b`, // runaway REP
      `${ESC}#8`, // DECALN
      `${ESC} G`, // 8-bit C1 responses
    ];
    for (const sequence of dropped) {
      expect(filterAll(`a${sequence}b`), JSON.stringify(sequence)).toBe('ab');
    }
  });

  it('forwards the numeric report requests TUIs need and the modes they use', () => {
    const forwarded = [
      `${ESC}[c`,
      `${ESC}[0c`,
      `${ESC}[>c`,
      `${ESC}[6n`,
      `${ESC}[5n`,
      `${ESC}[?6n`,
      `${ESC}[?2026$p`,
      `${ESC}[4$p`,
      `${ESC}[?u`,
      `${ESC}[>1u`,
      `${ESC}[<u`,
      `${ESC}[>4;2m`,
      `${ESC}[?1049h`,
      `${ESC}[?2004h`,
      `${ESC}[?1000;1006h`,
      `${ESC}[?25l`,
      `${ESC}[?2026h`,
      `${ESC}[2 q`,
      `${ESC}[1;20r`,
      `${ESC}7`,
      `${ESC}8`,
      `${ESC}=`,
      `${ESC}(0`,
      `${ESC}(B`,
      `${ESC}[4h`,
      `${ESC}[80b`,
    ];
    for (const sequence of forwarded) {
      expect(filterAll(`a${sequence}b`), JSON.stringify(sequence)).toBe(`a${sequence}b`);
    }
  });

  it('keeps only the allowlisted modes of a combined mode change', () => {
    expect(filterAll(`${ESC}[?1049;1034;2004h`)).toBe(`${ESC}[?1049;2004h`);
    expect(filterAll(`${ESC}[2;4h`)).toBe(`${ESC}[4h`);
    expect(filterAll(`${ESC}[?1034;67h`)).toBe('');
  });

  it('re-emits allowed C1 CSI sequences in 7-bit form and drops other C1 controls', () => {
    expect(filterAll('\u009b31mred')).toBe(`${ESC}[31mred`);
    expect(filterAll('a\u0085b\u0084c\u009cd')).toBe('abcd');
    expect(filterAll('a\u009b21tb')).toBe('ab');
  });

  it('drops raw 8-bit C1 bytes that are not valid UTF-8', () => {
    expect(filterAll(Uint8Array.of(0x61, 0x9b, 0x32, 0x31, 0x74, 0x62))).toBe('a�21tb');
  });

  it('drops an unterminated control string and resumes at the next escape', () => {
    const filter = new TerminalOutputFilter();
    expect(filter.write(`a${ESC}]52;c;AAAA`)).toBe('a');
    expect(filter.write('still clipboard data')).toBe('');
    expect(filter.write(`${ESC}[31mred`)).toBe(`${ESC}[31mred`);
  });

  it('cancels sequences on CAN and SUB and drops overlong CSI sequences', () => {
    expect(filterAll(`a${ESC}[3\x18b`)).toBe('ab');
    expect(filterAll(`a${ESC}]0;title\x1ab`)).toBe('ab');
    expect(filterAll(`a${ESC}[${'1;'.repeat(200)}mb`)).toBe('ab');
  });

  it('drops a truncated sequence at end of stream so it can never be completed', () => {
    const filter = new TerminalOutputFilter();
    expect(filter.write(`text${ESC}[?10`)).toBe('text');
    expect(filter.end()).toBe('');
    expect(filter.write('49h')).toBe('49h');
  });

  it('executes C0 controls inside a sequence without forwarding a partial sequence', () => {
    expect(filterAll(`${ESC}[3\n1m`)).toBe(`\n${ESC}[31m`);
  });

  it('restores only what the forwarded output changed', () => {
    const untouched = new TerminalOutputFilter();
    untouched.write('hello');
    // Never leaves an alternate screen it did not enter: xterm restores the
    // saved cursor on ?1049l even from the main screen.
    expect(untouched.restoreSequence()).toBe(`${ESC}[0m${ESC}[?25h`);

    const filter = new TerminalOutputFilter();
    filter.write(
      `${ESC}[>1u${ESC}[?1049h${ESC}[>3u${ESC}[?2004;1000;1006;1004h${ESC}[?25l${ESC}[?7l${ESC}=` +
        `${ESC}[2;10r${ESC}(0\x0e${ESC}[4 q${ESC}[>4;2m${ESC}[4h${ESC}[?2026h`,
    );
    const restore = filter.restoreSequence();
    expect(restore).toBe(
      `${ESC}[?2026l` +
        `${ESC}[<1u${ESC}[?1049l` +
        `${ESC}[<1u` +
        `${ESC}[>4m` +
        `${ESC}[?7h${ESC}[?1000l${ESC}[?1004l${ESC}[?1006l${ESC}[?2004l` +
        `${ESC}>${ESC}[4l${ESC}7${ESC}[r${ESC}8\x0f${ESC}(B${ESC}[0 q${ESC}[0m${ESC}[?25h`,
    );
  });

  it('tracks modes that the agent already reset itself', () => {
    const filter = new TerminalOutputFilter();
    filter.write(`${ESC}[?1049h${ESC}[?2004h${ESC}[>1u${ESC}[<u${ESC}[?2004l${ESC}[?1049l`);
    expect(filter.restoreSequence()).toBe(`${ESC}[0m${ESC}[?25h`);
  });

  it('only forwards output that is itself fully allowed (fuzzed)', () => {
    const random = prng(0x5eed);
    const alphabet = [
      ESC,
      '[',
      ']',
      'P',
      '_',
      '^',
      'X',
      '\\',
      '?',
      '>',
      '<',
      '=',
      ';',
      ':',
      '$',
      ' ',
      '0',
      '1',
      '2',
      '5',
      '9',
      'm',
      'h',
      'l',
      't',
      'q',
      'u',
      'c',
      'n',
      'Z',
      '\x07',
      '\x18',
      '\x05',
      '\n',
      '\u009b',
      '\u009d',
      '\u009c',
      'a',
      'é',
    ];
    for (let run = 0; run < 300; run += 1) {
      const filter = new TerminalOutputFilter();
      let output = '';
      for (let chunk = 0; chunk < 8; chunk += 1) {
        let text = '';
        const length = Math.floor(random() * 24);
        for (let index = 0; index < length; index += 1) text += alphabet[Math.floor(random() * alphabet.length)];
        output += filter.write(Buffer.from(text, 'utf8'));
      }
      output += filter.end();
      expect(output).not.toMatch(FORBIDDEN_IN_OUTPUT);
      // eslint-disable-next-line no-control-regex
      expect(output).not.toMatch(/\x1b\[[0-9;:]*t/u);
      // Forwarded output is a fixed point: everything in it passes the filter again.
      expect(filterAll(output)).toBe(output);
    }
  });
});
