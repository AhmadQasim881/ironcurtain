/**
 * Stateful filter for untrusted output that is written straight to the user's
 * real terminal (the raw `ironcurtain start --pty` relay and Apple Container's
 * runtime-native exec).
 *
 * A container agent owns the bytes of its own terminal screen, but not the
 * user's terminal emulator. Raw output could otherwise write the host clipboard
 * (OSC 52), set the window title or a hyperlink target (OSC 0/1/2, OSC 8), post
 * desktop notifications or trigger file transfers (OSC 9/777/1337), ask the
 * terminal to type replies into the host shell (title, DECRQSS, XTGETTCAP and
 * screen-checksum reports), resize or move the window, hard-reset the terminal
 * (RIS), switch it out of UTF-8 or into 8-bit controls, or lock the keyboard.
 * Screen and scrollback erases (ED, including `CSI 3 J`) are forwarded: TUIs
 * rely on them for full redraws, and they remove text rather than inject it.
 *
 * The filter parses ECMA-48 incrementally, so a sequence split across chunks is
 * classified as a whole, and forwards only:
 *   - printable text and the C0 controls BEL, BS, HT, LF, VT, FF, CR, SO, SI;
 *   - complete CSI sequences on an allowlist: SGR, cursor movement, erase,
 *     insert/delete, scroll regions, an allowlist of DEC private modes
 *     (alternate screen, cursor visibility, bracketed paste, mouse and focus
 *     reporting, synchronized output, ...), cursor style, the kitty keyboard
 *     push/pop, and the report requests whose replies are fixed numeric
 *     formats (DA1/DA2, DSR 5/6, DECXCPR, DECRQM, the kitty keyboard query),
 *     which TUIs such as crossterm need at startup;
 *   - a few complete escape sequences: DECSC/DECRC, keypad modes, IND/NEL/HTS/
 *     RI and character-set designation.
 * Every control string (OSC, DCS, APC, PM, SOS) is dropped whole, in 7-bit and
 * C1 form. Malformed, unterminated or overlong sequences are dropped, and C1
 * controls are never forwarded, so the real terminal is always in its ground
 * state between forwarded units: no later byte can complete a sequence the
 * filter did not approve.
 *
 * The filter also records which terminal modes the forwarded output changed,
 * and {@link TerminalOutputFilter.restoreSequence} returns the sequence that
 * puts them back when the relay ends (leave the alternate screen, turn off
 * mouse, focus and bracketed-paste reporting, pop kitty keyboard flags, show
 * the cursor, reset attributes and character sets).
 *
 * Leaf module: no IronCurtain imports.
 */

import { StringDecoder } from 'node:string_decoder';

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const DEL = 0x7f;
const SO = 0x0e;
const SI = 0x0f;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;

/** C0 controls that keep the terminal in its ground state and are forwarded. */
const FORWARDED_C0 = new Set([BEL, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, SO, SI]);

/** Longest CSI parameter/intermediate run accepted (truecolor SGR fits easily). */
const MAX_CSI_LENGTH = 256;
/** Longest escape intermediate run accepted. */
const MAX_ESCAPE_INTERMEDIATES = 4;
/** Largest repeat count forwarded for REP (`CSI n b`): legitimate use is bounded by the line width. */
const MAX_REPEAT_COUNT = 4096;
/** Cap on tracked kitty keyboard pushes, matching the protocol's bounded stack. */
const MAX_KITTY_DEPTH = 256;

/** Every code point that needs the state machine rather than the text fast path. */
// eslint-disable-next-line no-control-regex
const SPECIAL_CODE_POINT = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Final bytes of plain (no private marker, no intermediate) CSI cursor/edit/scroll operations. */
const PLAIN_CSI_FINALS = new Set('@ABCDEFGHIJKLMPSTXZ`adefg');

/**
 * DEC private modes a TUI may change, with the state the terminal starts in
 * (true = set). Modes not listed (keyboard-locking, meta/backarrow key,
 * 132-column, autorepeat, unsolicited theme/resize reports, ...) are dropped.
 */
const DEC_MODE_DEFAULTS: ReadonlyMap<number, boolean> = new Map([
  [1, false], // DECCKM application cursor keys
  [5, false], // DECSCNM reverse video
  [6, false], // DECOM origin mode
  [7, true], // DECAWM autowrap
  [9, false], // X10 mouse reporting
  [25, true], // DECTCEM cursor visible
  [47, false], // alternate screen (legacy)
  [66, false], // DECNKM application keypad
  [1000, false], // mouse button reporting
  [1002, false], // mouse drag reporting
  [1003, false], // mouse motion reporting
  [1004, false], // focus reporting
  [1005, false], // UTF-8 mouse encoding
  [1006, false], // SGR mouse encoding
  [1007, false], // alternate scroll
  [1015, false], // urxvt mouse encoding
  [1016, false], // SGR pixel mouse encoding
  [1047, false], // alternate screen
  [1048, false], // save/restore cursor (stateless; never restored)
  [1049, false], // alternate screen with saved cursor
  [2004, false], // bracketed paste
  [2026, false], // synchronized output
]);

/** Alternate-screen modes, in the order teardown prefers to leave them. */
const ALT_SCREEN_MODES = [1049, 1047, 47] as const;
/** Modes teardown handles specially (or never restores) instead of the generic reset. */
const SPECIAL_RESTORE_MODES = new Set([25, 47, 1047, 1048, 1049, 2026]);

/** ANSI (non-private) modes forwarded; only insert mode is used by TUIs. */
const ANSI_INSERT_MODE = 4;

type ParserState =
  'ground' | 'escape' | 'escape-intermediate' | 'csi' | 'csi-ignore' | 'control-string' | 'control-string-escape';

type KittyScreen = 'main' | 'alt';

/** Terminal state changed by forwarded output that teardown must restore. */
class TerminalModeTracker {
  private readonly decModes = new Map<number, boolean>();
  private readonly kittyDepth: Record<KittyScreen, number> = { main: 0, alt: 0 };
  insertMode = false;
  keypadApplication = false;
  scrollRegion = false;
  charsets = false;
  cursorStyle = false;
  modifyOtherKeys = false;

  setDecMode(mode: number, value: boolean): void {
    const wasAlt = this.altScreenActive();
    this.decModes.set(mode, value);
    // A screen switch discards the kitty stack of the screen that was left
    // in conforming terminals; never pop entries the alternate screen lost.
    if (wasAlt && !this.altScreenActive()) this.kittyDepth.alt = 0;
  }

  decMode(mode: number): boolean {
    return this.decModes.get(mode) ?? DEC_MODE_DEFAULTS.get(mode) ?? false;
  }

  altScreenActive(): boolean {
    return ALT_SCREEN_MODES.some((mode) => this.decMode(mode));
  }

  private screen(): KittyScreen {
    return this.altScreenActive() ? 'alt' : 'main';
  }

  kittyPush(): void {
    const screen = this.screen();
    this.kittyDepth[screen] = Math.min(MAX_KITTY_DEPTH, this.kittyDepth[screen] + 1);
  }

  kittyPop(count: number): void {
    const screen = this.screen();
    this.kittyDepth[screen] = Math.max(0, this.kittyDepth[screen] - count);
  }

  /** The sequence that returns every tracked change to the terminal's starting state. */
  restoreSequence(): string {
    let out = '';
    if (this.decMode(2026)) out += '\x1b[?2026l';
    if (this.altScreenActive()) {
      if (this.kittyDepth.alt > 0) out += `\x1b[<${this.kittyDepth.alt}u`;
      const mode = ALT_SCREEN_MODES.find((candidate) => this.decMode(candidate));
      out += `\x1b[?${mode ?? 1049}l`;
    }
    if (this.kittyDepth.main > 0) out += `\x1b[<${this.kittyDepth.main}u`;
    if (this.modifyOtherKeys) out += '\x1b[>4m';
    for (const [mode, initial] of DEC_MODE_DEFAULTS) {
      if (SPECIAL_RESTORE_MODES.has(mode) || this.decMode(mode) === initial) continue;
      out += `\x1b[?${mode}${initial ? 'h' : 'l'}`;
    }
    if (this.keypadApplication) out += '\x1b>';
    if (this.insertMode) out += '\x1b[4l';
    // DECSTBM homes the cursor; save and restore it around the reset.
    if (this.scrollRegion) out += '\x1b7\x1b[r\x1b8';
    if (this.charsets) out += '\x0f\x1b(B';
    if (this.cursorStyle) out += '\x1b[0 q';
    return `${out}\x1b[0m\x1b[?25h`;
  }
}

function parseNumberList(params: string): number[] | undefined {
  if (!/^[0-9]+(?:;[0-9]+)*$/u.test(params)) return undefined;
  return params.split(';').map(Number);
}

/** Matches an empty parameter string or one decimal number. */
function isOptionalNumber(params: string): boolean {
  return /^[0-9]*$/u.test(params);
}

export class TerminalOutputFilter {
  private readonly decoder = new StringDecoder('utf8');
  private readonly modes = new TerminalModeTracker();
  private state: ParserState = 'ground';
  /** CSI parameter + intermediate bytes, or escape intermediates, collected so far. */
  private sequence = '';
  private forwarded = false;

  /** True once any output has been forwarded (and the terminal may need restoring). */
  get hasForwardedOutput(): boolean {
    return this.forwarded;
  }

  /** Filter one chunk. Bytes are decoded as UTF-8 across chunk boundaries. */
  write(chunk: string | Uint8Array): string {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const out = this.process(text);
    if (out.length > 0) this.forwarded = true;
    return out;
  }

  /**
   * End of stream: decode any partial UTF-8 character and drop an incomplete
   * escape sequence, so a truncated sequence can never be completed later.
   */
  end(): string {
    const out = this.process(this.decoder.end());
    this.state = 'ground';
    this.sequence = '';
    if (out.length > 0) this.forwarded = true;
    return out;
  }

  /** Sequence restoring every terminal mode the forwarded output changed. */
  restoreSequence(): string {
    return this.modes.restoreSequence();
  }

  private process(text: string): string {
    let out = '';
    let index = 0;
    while (index < text.length) {
      if (this.state === 'ground') {
        SPECIAL_CODE_POINT.lastIndex = index;
        const match = SPECIAL_CODE_POINT.exec(text);
        const end = match === null ? text.length : match.index;
        if (end > index) out += text.slice(index, end);
        if (match === null) break;
        out += this.ground(text.charCodeAt(end));
        index = end + 1;
        continue;
      }
      const code = text.charCodeAt(index);
      const result = this.step(code, text[index]);
      out += result.output;
      if (result.consumed) index += 1;
    }
    return out;
  }

  /** Handle one special code point in the ground state. */
  private ground(code: number): string {
    switch (code) {
      case ESC:
        this.state = 'escape';
        return '';
      case C1_CSI:
        this.enterCsi();
        return '';
      case C1_OSC:
      case C1_DCS:
      case C1_SOS:
      case C1_PM:
      case C1_APC:
        this.state = 'control-string';
        return '';
    }
    return this.executeC0(code);
  }

  /** Forward an allowed C0 control; drop everything else (C0, DEL, C1). */
  private executeC0(code: number): string {
    if (!FORWARDED_C0.has(code)) return '';
    if (code === SO) this.modes.charsets = true;
    return String.fromCharCode(code);
  }

  private enterCsi(): void {
    this.state = 'csi';
    this.sequence = '';
  }

  /** One code unit in a non-ground state. `consumed: false` reprocesses it in the new state. */
  private step(code: number, character: string): { output: string; consumed: boolean } {
    switch (this.state) {
      case 'escape':
        return this.escape(code, character);
      case 'escape-intermediate':
        return this.escapeIntermediate(code, character);
      case 'csi':
        return this.csi(code, character);
      case 'csi-ignore':
        return this.csiIgnore(code);
      case 'control-string':
        return this.controlString(code);
      case 'control-string-escape':
        return this.controlStringEscape(code);
      default:
        this.state = 'ground';
        return { output: '', consumed: false };
    }
  }

  /**
   * Shared handling of controls inside escape and CSI sequences: ESC restarts,
   * CAN/SUB abort, other C0 controls execute without ending the sequence (as
   * in a VT500 parser), DEL is ignored. Returns undefined for other code units.
   */
  private sequenceControl(code: number): { output: string; consumed: boolean } | undefined {
    if (code === ESC) {
      this.state = 'escape';
      this.sequence = '';
      return { output: '', consumed: true };
    }
    if (code === CAN || code === SUB) {
      this.state = 'ground';
      this.sequence = '';
      return { output: '', consumed: true };
    }
    if (code < 0x20) return { output: this.executeC0(code), consumed: true };
    if (code === DEL) return { output: '', consumed: true };
    if (code >= 0x80) {
      // Not part of any 7-bit sequence (a C1 control or text): abandon the
      // sequence and let the ground state classify this code unit.
      this.state = 'ground';
      this.sequence = '';
      return { output: '', consumed: false };
    }
    return undefined;
  }

  private escape(code: number, character: string): { output: string; consumed: boolean } {
    const control = this.sequenceControl(code);
    if (control) return control;
    switch (character) {
      case '[':
        this.enterCsi();
        return { output: '', consumed: true };
      case ']':
      case 'P':
      case 'X':
      case '^':
      case '_':
        this.state = 'control-string';
        return { output: '', consumed: true };
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.state = 'escape-intermediate';
      this.sequence = character;
      return { output: '', consumed: true };
    }
    // Final byte 0x30-0x7E.
    this.state = 'ground';
    return { output: this.escapeSequence('', character), consumed: true };
  }

  private escapeIntermediate(code: number, character: string): { output: string; consumed: boolean } {
    const control = this.sequenceControl(code);
    if (control) return control;
    if (code >= 0x20 && code <= 0x2f) {
      // Overlong runs are kept only as a length, which no allowlist entry matches.
      if (this.sequence.length <= MAX_ESCAPE_INTERMEDIATES) this.sequence += character;
      return { output: '', consumed: true };
    }
    const intermediates = this.sequence;
    this.state = 'ground';
    this.sequence = '';
    return { output: this.escapeSequence(intermediates, character), consumed: true };
  }

  private csi(code: number, character: string): { output: string; consumed: boolean } {
    const control = this.sequenceControl(code);
    if (control) return control;
    if (code >= 0x40 && code <= 0x7e) {
      const body = this.sequence;
      this.state = 'ground';
      this.sequence = '';
      return { output: this.csiSequence(body, character), consumed: true };
    }
    // Parameter bytes (0x30-0x3F) may not follow an intermediate (0x20-0x2F).
    const hasIntermediate = /[ -/]/u.test(this.sequence);
    if ((code >= 0x30 && code <= 0x3f && hasIntermediate) || this.sequence.length >= MAX_CSI_LENGTH) {
      this.state = 'csi-ignore';
      this.sequence = '';
      return { output: '', consumed: true };
    }
    this.sequence += character;
    return { output: '', consumed: true };
  }

  private csiIgnore(code: number): { output: string; consumed: boolean } {
    const control = this.sequenceControl(code);
    if (control) return control;
    if (code >= 0x40 && code <= 0x7e) this.state = 'ground';
    return { output: '', consumed: true };
  }

  private controlString(code: number): { output: string; consumed: boolean } {
    if (code === BEL || code === CAN || code === SUB || code === C1_ST) {
      this.state = 'ground';
    } else if (code === ESC) {
      this.state = 'control-string-escape';
    }
    return { output: '', consumed: true };
  }

  private controlStringEscape(code: number): { output: string; consumed: boolean } {
    if (code === 0x5c) {
      // ESC \ (ST) ends the dropped string.
      this.state = 'ground';
      return { output: '', consumed: true };
    }
    // Any other byte after ESC aborts the string and starts a new escape.
    this.state = 'escape';
    return { output: '', consumed: false };
  }

  /** Allowlisted `ESC [intermediates] final` sequences. */
  private escapeSequence(intermediates: string, final: string): string {
    if (intermediates === '') {
      switch (final) {
        case '7': // DECSC
        case '8': // DECRC
        case 'D': // IND
        case 'E': // NEL
        case 'H': // HTS
        case 'M': // RI
          return `\x1b${final}`;
        case '=':
          this.modes.keypadApplication = true;
          return '\x1b=';
        case '>':
          this.modes.keypadApplication = false;
          return '\x1b>';
        default:
          return '';
      }
    }
    if (intermediates.length === 1 && '()*+'.includes(intermediates) && '0AB'.includes(final)) {
      if (!(intermediates === '(' && final === 'B')) this.modes.charsets = true;
      return `\x1b${intermediates}${final}`;
    }
    return '';
  }

  /** Allowlisted CSI sequences, re-emitted in 7-bit form. */
  private csiSequence(body: string, final: string): string {
    const marker = body.length > 0 && '<=>?'.includes(body[0]) ? body[0] : '';
    const rest = body.slice(marker.length);
    const intermediateStart = rest.search(/[ -/]/u);
    const params = intermediateStart === -1 ? rest : rest.slice(0, intermediateStart);
    const intermediates = intermediateStart === -1 ? '' : rest.slice(intermediateStart);
    // Parameters are digits and separators only; a second marker is malformed.
    if (!/^[0-9:;]*$/u.test(params)) return '';
    const emit = (): string => `\x1b[${body}${final}`;

    switch (marker) {
      case '':
        return this.plainCsi(params, intermediates, final, emit);
      case '?':
        return this.decPrivateCsi(params, intermediates, final, emit);
      case '>':
        return intermediates === '' ? this.greaterCsi(params, final, emit) : '';
      case '<':
        // Kitty keyboard protocol: pop entries from the flags stack.
        if (intermediates !== '' || final !== 'u' || !isOptionalNumber(params)) return '';
        this.modes.kittyPop(Math.max(1, Number(params || '1')));
        return emit();
      default:
        return '';
    }
  }

  private plainCsi(params: string, intermediates: string, final: string, emit: () => string): string {
    if (intermediates === ' ') {
      // DECSCUSR cursor style.
      if (final !== 'q' || !/^[0-6]?$/u.test(params)) return '';
      this.modes.cursorStyle = params !== '' && params !== '0';
      return emit();
    }
    if (intermediates === '$') {
      // DECRQM: the reply is a fixed numeric report.
      return final === 'p' && /^[0-9]+$/u.test(params) ? emit() : '';
    }
    if (intermediates !== '') return '';
    if (PLAIN_CSI_FINALS.has(final)) return emit();
    switch (final) {
      case 'b': {
        // REP: bounded so a short sequence cannot make the terminal render without end.
        if (!isOptionalNumber(params) || Number(params || '1') > MAX_REPEAT_COUNT) return '';
        return emit();
      }
      case 'm':
        return emit();
      case 'h':
      case 'l':
        return this.ansiModes(params, final);
      case 'r':
        this.modes.scrollRegion = params !== '';
        return emit();
      case 's':
      case 'u':
        // SCOSC/SCORC only; with parameters these mean margins (DECSLRM) or other things.
        return params === '' ? emit() : '';
      case 'c':
        // DA1.
        return params === '' || params === '0' ? emit() : '';
      case 'n':
        // DSR operating status / cursor position.
        return params === '5' || params === '6' ? emit() : '';
      default:
        // Window manipulation and title/size reports (t), printer control (i),
        // DECREQTPARM (x), and everything unknown.
        return '';
    }
  }

  private ansiModes(params: string, final: string): string {
    const modes = parseNumberList(params);
    if (!modes?.includes(ANSI_INSERT_MODE)) return '';
    this.modes.insertMode = final === 'h';
    return `\x1b[${ANSI_INSERT_MODE}${final}`;
  }

  private decPrivateCsi(params: string, intermediates: string, final: string, emit: () => string): string {
    if (intermediates === '$') {
      // DECRQM (DEC modes): fixed numeric report.
      return final === 'p' && /^[0-9]+$/u.test(params) ? emit() : '';
    }
    if (intermediates !== '') return '';
    switch (final) {
      case 'h':
      case 'l': {
        const allowed = (parseNumberList(params) ?? []).filter((mode) => DEC_MODE_DEFAULTS.has(mode));
        if (allowed.length === 0) return '';
        for (const mode of allowed) {
          if (mode !== 1048) this.modes.setDecMode(mode, final === 'h');
        }
        return `\x1b[?${allowed.join(';')}${final}`;
      }
      case 'n':
        // DECXCPR extended cursor position report.
        return params === '6' ? emit() : '';
      case 'u':
        // Kitty keyboard flags query: numeric reply.
        return params === '' ? emit() : '';
      case 'J':
      case 'K':
        // DECSED/DECSEL selective erase.
        return /^[0-2]?$/u.test(params) ? emit() : '';
      default:
        return '';
    }
  }

  private greaterCsi(params: string, final: string, emit: () => string): string {
    switch (final) {
      case 'c':
        // DA2.
        return params === '' || params === '0' ? emit() : '';
      case 'u':
        // Kitty keyboard protocol: push flags.
        if (!isOptionalNumber(params)) return '';
        this.modes.kittyPush();
        return emit();
      case 'm': {
        // XTMODKEYS, modifyOtherKeys only.
        if (!/^4(?:;[0-2])?$/u.test(params)) return '';
        // `4` alone resets the resource; `4;0` turns the feature off.
        this.modes.modifyOtherKeys = params !== '4' && params !== '4;0';
        return emit();
      }
      default:
        // XTVERSION (q), title modes (t), pointer mode (p), and the rest.
        return '';
    }
  }
}
