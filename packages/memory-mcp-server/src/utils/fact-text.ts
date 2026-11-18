/**
 * The canonical form store-time dedup compares: two memories whose canonical forms
 * are equal state the same fact in the same words and are merged without asking an
 * LLM. Normalization is deliberately shallow: Unicode NFC, case folding, collapsed
 * whitespace and dropped trailing full stops or exclamation marks. Word order and
 * every other character are kept, so 'prefers TypeScript over Python' never equals
 * 'prefers Python over TypeScript', nor 'production' 'staging'. Anything short of
 * equality is left to consolidation's LLM judgment.
 *
 * NFC, not NFKC: canonical equivalence only joins different encodings of the same
 * characters (a precomposed 'é' and 'e' plus a combining accent), whereas compatibility
 * folding changes meaning: NFKC turns '10⁶' into '106', and with the default model
 * "a quota of 10⁶ requests" and "a quota of 106 requests" measure under
 * EXACT_DEDUP_DISTANCE in a longer sentence, so the second fact would be dropped.
 */
export function normalizeFactText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/[\s.!]+$/u, '')
    .trim();
}
