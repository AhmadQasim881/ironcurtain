/**
 * Token-stream text made safe for the `ironcurtain observe` views.
 *
 * Everything `observe` shows is untrusted: model output (text and thinking
 * deltas, tool names and inputs, the model name and stop reason) and the
 * agent's own tool results, which the MITM proxy copies from the agent's
 * outgoing requests. Written raw, escape sequences in it could spoof the
 * view the human relies on, hide the agent's activity, retitle the terminal
 * or set the clipboard (OSC 52). The token-stream bus stays faithful (the
 * `--json` and web consumers get the exact text); the views sanitize at the
 * sink, with the shared helpers in terminal/display-sanitize.ts:
 *
 * - {@link observedProse}: prose rendered as text (plain-mode text deltas).
 * - {@link observedLine}: one line of prose in a fixed-width panel line.
 * - {@link observedField}: a single-line field shown quoted (tool names,
 *   tool input and results, error messages, event types, reasons).
 * - {@link isDrawableRainChar}: a character the rain may draw.
 *
 * A delta can end in the middle of an escape sequence; every control
 * character is removed (or escaped) on its own, so the remainder of a split
 * sequence arrives as inert printable text.
 */

import { escapeBidiControls, stripTerminalSequences, toDisplayText } from '../terminal/display-sanitize.js';

/**
 * Streamed prose for a terminal: escape sequences and control characters
 * removed except line feed and tab (CRLF becomes LF), bidi controls made
 * visible so text displays in its real order.
 */
export function observedProse(text: string): string {
  return escapeBidiControls(stripTerminalSequences(text));
}

/**
 * One line of streamed prose for a panel line of fixed width: as
 * {@link observedProse}, with tabs and line feeds as spaces, because a tab
 * would move the cursor past the panel's own layout. Callers split on line
 * feeds first where a line break means a new line.
 */
export function observedLine(text: string): string {
  return observedProse(text).replace(/[\t\n]/gu, ' ');
}

/**
 * A single-line field: every control, invisible and bidi character shown as
 * a visible escape (`\u001b`), so nothing in it acts on the terminal and
 * nothing is hidden. Non-strings (a malformed event) are shown as their
 * string form.
 */
export function observedField(value: unknown): string {
  return toDisplayText(typeof value === 'string' ? value : String(value));
}

/** Characters the rain never draws: controls, format (bidi, zero-width), separators, lone surrogates. */
const UNDRAWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/** Whether the rain may draw `char` (one code point of untrusted text) at a cell. */
export function isDrawableRainChar(char: string): boolean {
  return char !== '' && !UNDRAWABLE.test(char);
}
