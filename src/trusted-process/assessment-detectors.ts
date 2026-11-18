/**
 * Deterministic detectors for the outbound content assessment.
 *
 * Pure, synchronous checks over the outbound-content arguments of one tool
 * call (message bodies, commit messages, URLs; see
 * `RoleDefinition.outboundContent`). They look for data an agent could
 * smuggle out through a channel the policy allows: encoded blobs (base64,
 * base32, hex, byte lists), high-entropy strings such as raw credentials,
 * Caesar/rot13 ciphertext, invisible characters, and transfers too large or
 * too machine-like to be a message. A finding never contains the content
 * itself, only fixed phrases, sizes and counts.
 *
 * The checks are heuristics tuned to let ordinary prose, code snippets,
 * markdown, links, commit hashes (40 hex digits) and UUIDs through while
 * catching blobs of roughly 30 bytes and more. They cannot see data spread
 * thinly over many calls or hidden in word choice; the optional LLM
 * intelligibility check (assessment.ts) and human review cover more. Every
 * scan is linear in the input and bounded (`CONTENT_LIMITS`).
 */

import type { OutboundContentKind } from '../types/argument-roles.js';
import type { ContentAssessmentFinding } from '../types/audit.js';

/** One outbound-content value of a call: an argument value (or a string inside it) and how to read it. */
export interface OutboundValue {
  /** The annotated argument it came from. */
  readonly argument: string;
  readonly kind: OutboundContentKind;
  readonly value: string;
}

/** Deterministic check identifiers, as recorded in `ContentAssessmentFinding.check`. */
export type DeterministicCheck =
  | 'base64'
  | 'hex'
  | 'byte-sequence'
  | 'high-entropy'
  | 'rot-n'
  | 'reversed'
  | 'hidden-characters'
  | 'size'
  | 'encoded-ratio';

/**
 * Thresholds of the deterministic checks. Sizes are in characters (UTF-16
 * code units for the size check, ASCII characters everywhere else).
 */
export const CONTENT_LIMITS = {
  /** A text value longer than this is flagged as a bulk transfer rather than a message. */
  maxTextChars: 32_768,
  /** A URL longer than this is flagged. */
  maxUrlChars: 2_048,
  /** Content beyond this many characters per call is not analysed (the size check has flagged it). */
  maxAnalysedChars: 262_144,
  /**
   * Base64 / base32 tokens: a run of the base64 alphabets that looks random
   * (see `looksRandom`) counts from `minTokenChars`; one token of
   * `flagTokenChars` (30 bytes of base64), or `flagTotalChars` across the
   * call, is flagged.
   */
  base64: { minTokenChars: 20, flagTokenChars: 40, flagTotalChars: 64 },
  /**
   * Hex tokens (digits and letters a-f): count from `minTokenChars`; a token
   * of `flagTokenChars` (32 bytes) or `flagTotalChars` across the call is
   * flagged. A 40-digit commit hash, or two, passes.
   */
  hex: { minTokenChars: 16, flagTokenChars: 64, flagTotalChars: 96 },
  /** Byte lists (`de ad be ef`, `0xde, 0xad`, `\xde\xad`, `[222, 173, ...]`): this many bytes in a row. */
  byteSequence: { flagBytes: 32 },
  /**
   * Whitespace-free tokens of printable ASCII from `minTokenChars` whose
   * character entropy reaches `minEntropyBits` (ascii85, base91, uuencode,
   * printable ciphertext).
   */
  highEntropy: { minTokenChars: 48, minEntropyBits: 5.3 },
  /** Caesar / rot-N: a shift that turns at least `minMatches` words, and `minShare` of all words, into common English. */
  rot: { minWords: 6, minMatches: 4, minShare: 0.3 },
  /** Invisible format characters (zero-width, tags, variation selectors), ZWJ and U+FE0F excepted. */
  hiddenCharacters: { flagCount: 16 },
  /**
   * The size ratio: a text that is mostly base64-like tokens, at least
   * `minEncodedChars` of them making up `minShare` of its non-space
   * characters (a short message that is little more than a key or a token
   * below the base64 thresholds). Hex tokens are left out: a short message
   * naming a commit is mostly its 40-digit hash.
   */
  encodedRatio: { minEncodedChars: 32, minShare: 0.5 },
} as const;

// ---------------------------------------------------------------------------
// Entropy and character classes
// ---------------------------------------------------------------------------

/** Shannon entropy of the string's characters, in bits per character (0 for the empty string). */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let length = 0;
  for (const count of counts.values()) length += count;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

type CharClass = 'upper' | 'lower' | 'digit' | 'other';

function charClass(code: number): CharClass {
  if (code >= 0x41 && code <= 0x5a) return 'upper';
  if (code >= 0x61 && code <= 0x7a) return 'lower';
  if (code >= 0x30 && code <= 0x39) return 'digit';
  return 'other';
}

/** Share of adjacent character pairs whose class (upper, lower, digit, other) differs. */
function classTransitionRate(token: string): number {
  if (token.length < 2) return 0;
  let transitions = 0;
  let previous = charClass(token.charCodeAt(0));
  for (let i = 1; i < token.length; i++) {
    const current = charClass(token.charCodeAt(i));
    if (current !== previous) transitions++;
    previous = current;
  }
  return transitions / (token.length - 1);
}

function classesOf(token: string): Set<CharClass> {
  const classes = new Set<CharClass>();
  for (let i = 0; i < token.length; i++) classes.add(charClass(token.charCodeAt(i)));
  return classes;
}

const HEX_TOKEN = /^[0-9a-fA-F]+$/;
const BASE32_TOKEN = /^(?:[A-Z2-7]+|[a-z2-7]+)$/;

/**
 * True when a base64- or base32-alphabet token reads as random data rather
 * than a word, an identifier or a path.
 *
 * Mixed-case tokens (base64): identifiers change character class at word
 * boundaries only (`getUserById2FactorAuthTokenV2` changes on under 40% of
 * adjacent pairs), random base64 on about 65% of them (at least 45% for 99%
 * of random tokens of 40 characters). Single-case tokens (base32, `A-Z2-7`)
 * hardly change class at all, so they need several digits instead: words in
 * capitals are separated by spaces or underscores, not by digits 2-7.
 * Either way the token must use most of the distinct characters that random
 * data of its length uses (entropy is bounded by log2(length) for short
 * tokens and by the alphabet for long ones).
 */
function looksRandom(token: string): boolean {
  const classes = classesOf(token);
  if (!classes.has('digit')) return false;
  if (BASE32_TOKEN.test(token)) {
    let digits = 0;
    for (let i = 0; i < token.length; i++) if (charClass(token.charCodeAt(i)) === 'digit') digits++;
    if (token.length < 24 || digits < 2) return false;
    return shannonEntropy(token) >= Math.min(Math.log2(token.length), 5) * 0.75;
  }
  if (!(classes.has('upper') && classes.has('lower'))) return false;
  if (classTransitionRate(token) < (token.length < 32 ? 0.4 : 0.45)) return false;
  return shannonEntropy(token) >= Math.min(Math.log2(token.length), 6) * 0.75;
}

// ---------------------------------------------------------------------------
// Token scans
// ---------------------------------------------------------------------------

/** Lengths of the encoded-looking tokens found in one piece of text. */
interface TokenStats {
  readonly base64: number[];
  readonly hex: number[];
}

/** Characters of the base64 and base64url alphabets (padding handled separately). */
function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x5f || // _
    code === 0x2d // -
  );
}

/**
 * Splits a run of base64-alphabet characters the way prose uses those
 * characters: a run with more slashes than base64 has (one in 64) is a path,
 * a run with more `-`/`_` than base64url has is a kebab- or snake-case name,
 * and each part is judged on its own.
 */
function classifyRun(run: string, stats: { base64: number[]; hex: number[] }, depth = 0): void {
  if (run.length < CONTENT_LIMITS.hex.minTokenChars) return;
  let slashes = 0;
  let joiners = 0;
  let plus = 0;
  for (let i = 0; i < run.length; i++) {
    const code = run.charCodeAt(i);
    if (code === 0x2f) slashes++;
    else if (code === 0x2d || code === 0x5f) joiners++;
    else if (code === 0x2b) plus++;
  }
  if (depth < 3) {
    if (slashes > 0 && slashes * 16 > run.length) {
      for (const part of run.split('/')) classifyRun(part, stats, depth + 1);
      return;
    }
    if (joiners > 0 && joiners * 12 > run.length) {
      for (const part of run.split(/[-_]/)) classifyRun(part, stats, depth + 1);
      return;
    }
    if (plus > 0 && plus * 16 > run.length) {
      for (const part of run.split('+')) classifyRun(part, stats, depth + 1);
      return;
    }
  }
  if (HEX_TOKEN.test(run)) {
    const classes = classesOf(run);
    if (classes.has('digit') && (classes.has('lower') || classes.has('upper'))) stats.hex.push(run.length);
    return;
  }
  if (run.length >= CONTENT_LIMITS.base64.minTokenChars && looksRandom(run)) stats.base64.push(run.length);
}

/** Finds base64-, base32- and hex-like tokens in text. */
function scanTokens(text: string): TokenStats {
  const stats = { base64: [] as number[], hex: [] as number[] };
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const inRun = i < text.length && isBase64Char(text.charCodeAt(i));
    if (inRun) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      classifyRun(text.slice(start, i), stats);
      start = -1;
    }
  }
  return stats;
}

/**
 * Longest run of byte values written one by one: two-digit hex bytes
 * separated by spaces, commas, colons or dashes, `0x`/`\x` prefixed bytes,
 * or a comma-separated list of decimal numbers from 0 to 255.
 */
function longestByteSequence(text: string): number {
  let longest = 0;

  // Hex bytes, one per token. `\xde\xad` has no separators: split on `\x`.
  let current = 0;
  for (const raw of text.split(/[\s,;:-]+/)) {
    const pieces = raw.includes('\\x') ? raw.split('\\x').filter((p) => p !== '') : [raw];
    for (const piece of pieces) {
      const token = piece.startsWith('0x') || piece.startsWith('0X') ? piece.slice(2) : piece;
      if (token.length === 2 && HEX_TOKEN.test(token)) {
        current++;
        if (current > longest) longest = current;
      } else if (piece !== '') {
        current = 0;
      }
    }
  }

  // Decimal byte lists: [222, 173, 190, ...].
  current = 0;
  for (const piece of text.split(',')) {
    const value = piece.trim().replace(/^\[|\]$/g, '');
    if (/^\d{1,3}$/.test(value) && Number(value) <= 255) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/** Whitespace-free printable-ASCII tokens long and random enough to be encoded or encrypted data. */
function countHighEntropyTokens(text: string): number {
  let count = 0;
  for (const token of text.split(/\s+/)) {
    if (token.length < CONTENT_LIMITS.highEntropy.minTokenChars) continue;
    if (!/^[\x21-\x7e]+$/.test(token)) continue;
    if (classesOf(token).size < 3) continue;
    if (shannonEntropy(token) >= CONTENT_LIMITS.highEntropy.minEntropyBits) count++;
  }
  return count;
}

/**
 * Invisible characters that can carry hidden data in text a human reviews:
 * Unicode format characters (zero-width spaces and joiners, bidi controls,
 * tag characters) and variation selectors. The zero-width joiner and the
 * emoji presentation selector U+FE0F, which ordinary emoji use, are not
 * counted.
 */
const HIDDEN_CHARACTER = /(?!\u200d)\p{Cf}|[\ufe00-\ufe0e]|[\u{e0100}-\u{e01ef}]/gu;

function countHiddenCharacters(text: string): number {
  return text.match(HIDDEN_CHARACTER)?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Caesar / rot-N
// ---------------------------------------------------------------------------

/**
 * Frequent English words of three letters or more. Shorter words are left
 * out: under some shift almost any short word becomes one.
 */
const COMMON_WORDS: ReadonlySet<string> = new Set(
  (
    'the and for are but not you all any can had her was one our out day get has him his how man new now old see ' +
    'two way who did its let put say she too use that with have this will your from they know want been good much ' +
    'some time very when come here just like long make many more only over such take than them well were what which ' +
    'their there would about could other these first after where should because while into also back then those ' +
    'through being before same right think year work people state still every under never again another found ' +
    'great between own last might must because down each tell does part place both thing give most even need ' +
    'password secret token key keys data file files user name email address account login credit card number ' +
    'phone private send please thanks hello dear meeting today tomorrow attached report'
  ).split(' '),
);

const LETTER_WORD = /[A-Za-z]{3,}/g;

function shiftWord(word: string, shift: number): string {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    out += String.fromCharCode(((word.charCodeAt(i) - 0x61 + shift) % 26) + 0x61);
  }
  return out;
}

/** The letters of an ASCII word in reverse order. */
function reverseWord(word: string): string {
  let out = '';
  for (let i = word.length - 1; i >= 0; i--) out += word[i];
  return out;
}

/** A simple cipher the text reads as English under: a Caesar shift (1-25; 13 is rot13) or reversal. */
type CipherMatch = { readonly shift: number } | { readonly reversed: true };

/**
 * The Caesar shift, or the reversal of every word, that turns markedly more
 * of the text's words into common English words than the text has as it is,
 * or undefined when none does.
 */
function detectCipher(text: string): CipherMatch | undefined {
  const words = (text.slice(0, 20_000).match(LETTER_WORD) ?? []).map((w) => w.toLowerCase());
  if (words.length < CONTENT_LIMITS.rot.minWords) return undefined;
  const countMatches = (transform: (word: string) => string): number => {
    let matches = 0;
    for (const word of words) if (COMMON_WORDS.has(transform(word))) matches++;
    return matches;
  };
  const plain = countMatches((word) => word);
  const significant = (matches: number): boolean =>
    matches >= CONTENT_LIMITS.rot.minMatches &&
    matches >= words.length * CONTENT_LIMITS.rot.minShare &&
    matches >= plain * 2 + 2;

  let best: { shift: number; matches: number } | undefined;
  for (let shift = 1; shift < 26; shift++) {
    const matches = countMatches((word) => shiftWord(word, shift));
    if (best === undefined || matches > best.matches) best = { shift, matches };
  }
  if (best !== undefined && significant(best.matches)) return { shift: best.shift };
  if (significant(countMatches(reverseWord))) return { reversed: true };
  return undefined;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** A URL split into the parts that carry data to the destination, plus problems found while splitting it. */
interface UrlParts {
  readonly parts: string[];
  /** Percent-escapes in parts that do not decode to UTF-8 text (raw bytes). */
  readonly undecodableEscapes: number;
}

function decodeComponent(part: string): { text: string; undecodable: number } {
  try {
    return { text: decodeURIComponent(part), undecodable: 0 };
  } catch {
    return { text: part, undecodable: (part.match(/%[0-9a-fA-F]{2}/g) ?? []).length };
  }
}

/**
 * The host labels, credentials, path segments, query keys and values and the
 * fragment of a URL, each percent-decoded. A string that does not parse as a
 * URL is returned whole.
 */
function urlParts(value: string): UrlParts {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { parts: [value], undecodableEscapes: 0 };
  }
  const parts: string[] = [];
  let undecodableEscapes = 0;
  const add = (raw: string): void => {
    if (raw === '') return;
    const { text, undecodable } = decodeComponent(raw);
    parts.push(text);
    undecodableEscapes += undecodable;
  };
  for (const label of url.hostname.split('.')) add(label);
  add(url.username);
  add(url.password);
  for (const segment of url.pathname.split('/')) add(segment);
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  for (const pair of query.split('&')) {
    for (const piece of pair.split('=')) add(piece.replace(/\+/g, ' '));
  }
  add(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  return { parts, undecodableEscapes };
}

// ---------------------------------------------------------------------------
// Assessment of a call
// ---------------------------------------------------------------------------

interface ArgumentTotals {
  base64Chars: number;
  base64Longest: number;
  hexChars: number;
  hexLongest: number;
  longestByteSequence: number;
  highEntropyTokens: number;
  hiddenCharacters: number;
  /** Text values only: encoded characters and non-space characters, for the ratio check. */
  encodedChars: number;
  nonSpaceChars: number;
  cipher?: CipherMatch;
  oversize?: string;
}

function emptyTotals(): ArgumentTotals {
  return {
    base64Chars: 0,
    base64Longest: 0,
    hexChars: 0,
    hexLongest: 0,
    longestByteSequence: 0,
    highEntropyTokens: 0,
    hiddenCharacters: 0,
    encodedChars: 0,
    nonSpaceChars: 0,
  };
}

function addTokens(totals: ArgumentTotals, text: string, countForRatio: boolean): void {
  const stats = scanTokens(text);
  for (const length of stats.base64) {
    totals.base64Chars += length;
    totals.base64Longest = Math.max(totals.base64Longest, length);
  }
  for (const length of stats.hex) {
    totals.hexChars += length;
    totals.hexLongest = Math.max(totals.hexLongest, length);
  }
  totals.longestByteSequence = Math.max(totals.longestByteSequence, longestByteSequence(text));
  totals.highEntropyTokens += countHighEntropyTokens(text);
  totals.hiddenCharacters += countHiddenCharacters(text);
  if (countForRatio) {
    totals.encodedChars += stats.base64.reduce((sum, n) => sum + n, 0);
    totals.nonSpaceChars += text.replace(/\s+/g, '').length;
  }
}

function analyseValue(totals: ArgumentTotals, value: OutboundValue): void {
  if (value.kind === 'url') {
    if (value.value.length > CONTENT_LIMITS.maxUrlChars) {
      totals.oversize ??= `a URL of ${value.value.length} characters (limit ${CONTENT_LIMITS.maxUrlChars})`;
      return;
    }
    const { parts, undecodableEscapes } = urlParts(value.value);
    for (const part of parts) addTokens(totals, part, false);
    // Percent-escapes that do not decode to UTF-8 text are raw bytes.
    totals.longestByteSequence = Math.max(totals.longestByteSequence, undecodableEscapes);
    totals.cipher ??= detectCipher(parts.join(' '));
    return;
  }
  if (value.value.length > CONTENT_LIMITS.maxTextChars) {
    totals.oversize ??= `${value.value.length} characters of text (limit ${CONTENT_LIMITS.maxTextChars})`;
    return;
  }
  addTokens(totals, value.value, true);
  totals.cipher ??= detectCipher(value.value);
}

/** Per-argument findings from the totals of every value of that argument. */
function findingsFor(argument: string, totals: ArgumentTotals): ContentAssessmentFinding[] {
  const findings: ContentAssessmentFinding[] = [];
  const add = (check: DeterministicCheck, detail: string): void => {
    findings.push({ argument, check, detail });
  };
  if (totals.oversize !== undefined) add('size', `unusually large outbound content: ${totals.oversize}`);
  const b64 = CONTENT_LIMITS.base64;
  if (totals.base64Longest >= b64.flagTokenChars || totals.base64Chars >= b64.flagTotalChars) {
    add(
      'base64',
      `base64-like encoded data: ${totals.base64Chars} characters, longest run ${totals.base64Longest} characters`,
    );
  }
  const hex = CONTENT_LIMITS.hex;
  if (totals.hexLongest >= hex.flagTokenChars || totals.hexChars >= hex.flagTotalChars) {
    add('hex', `hex-encoded data: ${totals.hexChars} hex digits, longest run ${totals.hexLongest}`);
  }
  if (totals.longestByteSequence >= CONTENT_LIMITS.byteSequence.flagBytes) {
    add('byte-sequence', `a list of ${totals.longestByteSequence} raw byte values`);
  }
  if (totals.highEntropyTokens > 0) {
    add('high-entropy', `${totals.highEntropyTokens} high-entropy token(s) of encoded or encrypted-looking text`);
  }
  if (totals.cipher !== undefined) {
    if ('reversed' in totals.cipher) {
      add('reversed', 'text that reads as English only when its words are reversed');
    } else {
      const { shift } = totals.cipher;
      add('rot-n', `text that reads as English only after ${shift === 13 ? 'rot13' : `a Caesar shift of ${shift}`}`);
    }
  }
  if (totals.hiddenCharacters >= CONTENT_LIMITS.hiddenCharacters.flagCount) {
    add('hidden-characters', `${totals.hiddenCharacters} invisible format characters`);
  }
  const ratio = CONTENT_LIMITS.encodedRatio;
  if (
    findings.length === 0 &&
    totals.encodedChars >= ratio.minEncodedChars &&
    totals.encodedChars >= totals.nonSpaceChars * ratio.minShare
  ) {
    add(
      'encoded-ratio',
      `${totals.encodedChars} of ${totals.nonSpaceChars} non-space characters are encoded-looking tokens`,
    );
  }
  return findings;
}

/**
 * Encoded data split across several arguments of one call (part in a title,
 * part in a body): the base64 and hex totals of the whole call against the
 * same thresholds, when no single argument reached them.
 */
function splitAcrossArguments(
  totalsByArgument: ReadonlyMap<string, ArgumentTotals>,
  findings: readonly ContentAssessmentFinding[],
): ContentAssessmentFinding[] {
  if (totalsByArgument.size < 2) return [];
  const names = [...totalsByArgument.keys()].join(', ');
  const split: ContentAssessmentFinding[] = [];
  let base64 = 0;
  let hex = 0;
  for (const totals of totalsByArgument.values()) {
    base64 += totals.base64Chars;
    hex += totals.hexChars;
  }
  if (base64 >= CONTENT_LIMITS.base64.flagTotalChars && !findings.some((f) => f.check === 'base64')) {
    split.push({
      argument: names,
      check: 'base64',
      detail: `base64-like encoded data split across arguments: ${base64} characters`,
    });
  }
  if (hex >= CONTENT_LIMITS.hex.flagTotalChars && !findings.some((f) => f.check === 'hex')) {
    split.push({ argument: names, check: 'hex', detail: `hex-encoded data split across arguments: ${hex} hex digits` });
  }
  return split;
}

/**
 * Runs every deterministic check over the outbound values of one call and
 * returns what they found (empty when the content passes). Values of the
 * same argument are judged together, so data split across the strings of
 * one argument (array items, header values) still adds up, and the encoded
 * totals of all arguments are checked once more for the whole call.
 */
export function detectOutboundContent(values: readonly OutboundValue[]): ContentAssessmentFinding[] {
  const totalsByArgument = new Map<string, ArgumentTotals>();
  const findings: ContentAssessmentFinding[] = [];
  let analysed = 0;
  for (const value of values) {
    let totals = totalsByArgument.get(value.argument);
    if (totals === undefined) {
      totals = emptyTotals();
      totalsByArgument.set(value.argument, totals);
    }
    analysed += value.value.length;
    if (analysed > CONTENT_LIMITS.maxAnalysedChars) {
      findings.push({
        argument: value.argument,
        check: 'size',
        detail: `unusually large outbound content: more than ${CONTENT_LIMITS.maxAnalysedChars} characters in one call`,
      });
      break;
    }
    analyseValue(totals, value);
  }
  for (const [argument, totals] of totalsByArgument) findings.push(...findingsFor(argument, totals));
  findings.push(...splitAcrossArguments(totalsByArgument, findings));
  return findings;
}
