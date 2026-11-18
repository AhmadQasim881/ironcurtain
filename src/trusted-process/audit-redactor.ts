/**
 * PII/credential redactor for audit log entries.
 *
 * Scans string values in audit entry arguments and result content for
 * sensitive data patterns (credit cards, SSNs, API keys and tokens) and
 * replaces them with masked versions before writing to the JSONL audit
 * log. On top of the patterns, the exact credential values IronCurtain
 * itself holds (configured server credentials, provider API keys, OAuth
 * tokens) are replaced wherever they appear, so a key the agent copied
 * out of a workspace file never lands in the audit log in clear.
 *
 * Redaction is enabled by default via the `auditRedaction.enabled` user
 * config flag. When disabled, entries pass through unchanged (preserving
 * full forensic logging).
 */

// ── Pattern definitions ────────────────────────────────────────────────

/**
 * Credit card: 13–19 digits possibly separated by single spaces or dashes.
 * Each repetition matches exactly one digit + optional separator, avoiding
 * nested quantifiers that cause exponential backtracking (ReDoS).
 * Validated with Luhn checksum after extraction.
 */
const CREDIT_CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

/**
 * US Social Security Number written with its separators: 3-2-4 digit
 * groups joined by dashes. Separators are required: a bare 9-digit number
 * is far more often an issue number, an order id or a timestamp than an
 * SSN, and redacting it would corrupt legitimate audit data.
 */
const SSN_RE = /\b(\d{3})-(\d{2})-(\d{4})\b/g;

/**
 * API keys and tokens from the providers IronCurtain itself handles, plus a
 * few other common formats. Each alternative is anchored on a provider
 * prefix so that ordinary hyphenated words never match:
 *
 *   - `sk-ant-…`                 Anthropic API keys (`sk-ant-api03-…`) and
 *                                OAuth tokens (`sk-ant-oat01-…`)
 *   - `sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`, `sk-None-…`
 *                                OpenAI project, service-account, admin and user keys
 *   - `sk-or-…`                  OpenRouter keys (`sk-or-v1-…`)
 *   - `sk-…`                     legacy OpenAI-style keys (alphanumeric only)
 *   - `github_pat_…`             GitHub fine-grained personal access tokens
 *   - `gh[opsru]_…`              GitHub classic PAT (ghp), OAuth (gho), user-to-server
 *                                (ghu), server-to-server (ghs) and refresh (ghr) tokens
 *   - `AIza…`                    Google API keys
 *   - `ya29.…`                   Google OAuth access tokens
 *   - `xox[a-z]-…`, `xapp-…`     Slack bot/user/app tokens
 *   - `AKIA…`, `ASIA…`           AWS access key ids (long-lived and temporary)
 *   - `eyJ…`.`…`.`…`             JSON Web Tokens
 *
 * Every alternative starts at a word boundary. Only the fixed-length AWS id
 * also ends at one (so it never matches the start of a longer run); the
 * others are greedy and end where their character class ends. A trailing
 * `\b` there would make a key that ends in `-` give back characters until
 * it fell below its minimum length -- one Google key in 64 ends in `-` and
 * would not be redacted at all.
 */
const API_KEY_RE = new RegExp(
  [
    'sk-ant-[A-Za-z0-9_-]{20,}',
    'sk-(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}',
    'sk-or-[A-Za-z0-9_-]{20,}',
    'sk-[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{22,}',
    'gh[opsru]_[A-Za-z0-9]{36,}',
    'AIza[A-Za-z0-9_-]{35,}',
    'ya29\\.[A-Za-z0-9._-]{20,}',
    'xox[a-z]-[A-Za-z0-9-]{20,}',
    'xapp-[A-Za-z0-9-]{20,}',
    'A(?:KIA|SIA)[A-Z0-9]{16}\\b',
    'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
  ]
    .map((alt) => `\\b${alt}`)
    .join('|'),
  'g',
);

/**
 * `Bearer <token>`: any bearer credential, such as an HTTP `Authorization`
 * header value. The scheme keyword is kept, the credential is masked. HTTP
 * auth schemes are case-insensitive, so `bearer` and `BEARER` match too.
 */
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi;

// SSN area numbers that are never valid.
const INVALID_SSN_AREAS = new Set(['000', '666']);

/**
 * Known credential values shorter than this are not redacted by exact
 * match: a 1–7 character "secret" is not a credential any provider issues,
 * and replacing such a short string everywhere it occurs would mangle
 * unrelated audit data (paths, tool names, prose).
 */
export const MIN_SECRET_LENGTH = 8;

/** Replacement for an exact known credential value. */
export const REDACTED_SECRET = '***REDACTED***';

// ── Log redaction settings ─────────────────────────────────────────────

/**
 * Redaction a log writer other than the audit log applies before writing
 * (full-detail LLM interaction logs, interactions.jsonl): every pattern in
 * this module plus the exact credential values in `secrets`, prepared with
 * `prepareRedactionSecrets`. Writers take `LogRedaction | null`, where null
 * writes verbatim (audit redaction turned off).
 */
export interface LogRedaction {
  readonly secrets: readonly string[];
}

/** The patterns only, without exact credential values: the default when no configuration is at hand. */
export const PATTERN_ONLY_REDACTION: LogRedaction = Object.freeze({ secrets: Object.freeze([]) });

// ── Luhn checksum ──────────────────────────────────────────────────────

function luhnCheck(digits: string): boolean {
  if (!digits || !/^\d+$/.test(digits)) return false;
  let total = 0;
  for (let i = digits.length - 1, alt = false; i >= 0; i--, alt = !alt) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}

// ── Redaction helpers ──────────────────────────────────────────────────

function redactCreditCard(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length <= 8) return '*'.repeat(digits.length);
  return digits.slice(0, 4) + ' ' + '*'.repeat(digits.length - 8) + ' ' + digits.slice(-4);
}

function redactSsn(_area: string, _group: string, serial: string): string {
  return `***-**-${serial}`;
}

function redactApiKey(raw: string): string {
  if (raw.length > 8) return raw.slice(0, 4) + '...' + raw.slice(-4);
  return raw.slice(0, 4) + '...';
}

// ── Known secrets ──────────────────────────────────────────────────────

/**
 * Normalizes a list of known credential values for exact-match redaction:
 * drops empty, non-string and too-short values, de-duplicates, and orders
 * longest first so that a credential which contains another (a token and
 * its prefix, say) is replaced whole before the shorter one is tried.
 */
export function prepareRedactionSecrets(values: Iterable<string | undefined | null>): readonly string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    if (value.length < MIN_SECRET_LENGTH) continue;
    unique.add(value);
  }
  return [...unique].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every occurrence of each known credential value with
 * `***REDACTED***`. Plain substring replacement, no patterns: this is the
 * same mechanism the MCP relay applies to backend stderr before it reaches
 * the session log.
 */
function redactKnownSecrets(text: string, secrets: readonly string[]): { redacted: string; changed: boolean } {
  let result = text;
  let changed = false;
  for (const secret of secrets) {
    if (result.includes(secret)) {
      result = result.replaceAll(secret, REDACTED_SECRET);
      changed = true;
    }
  }
  return { redacted: result, changed };
}

// ── String redaction ───────────────────────────────────────────────────

/**
 * Redacts all recognized PII/credential patterns in a single string,
 * plus every exact `secrets` value (prepared with `prepareRedactionSecrets`).
 * Returns the redacted string and whether any redaction occurred.
 */
export function redactString(text: string, secrets: readonly string[] = []): { redacted: string; changed: boolean } {
  // Known credential values first: they are the strongest signal and must
  // win even when a pattern would otherwise mask only part of the value.
  const known = redactKnownSecrets(text, secrets);
  let result = known.redacted;
  let changed = known.changed;

  // API keys and tokens, before the digit-run passes below: a credit-card
  // or SSN mask inside a token (a Slack token's 13-digit segment can pass
  // the Luhn check) would split it, and the rest of the token would no
  // longer match its pattern and be written in clear.
  result = result.replace(API_KEY_RE, (match) => {
    changed = true;
    return redactApiKey(match);
  });

  // Bearer credentials (any format), keeping the scheme keyword. A token
  // that the passes above already masked is too short to match again.
  result = result.replace(BEARER_RE, (_match, scheme: string, token: string) => {
    changed = true;
    return `${scheme}${redactApiKey(token)}`;
  });

  // Credit cards (Luhn-validated)
  result = result.replace(CREDIT_CARD_RE, (match) => {
    const digits = match.replace(/[^0-9]/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhnCheck(digits)) return match;
    changed = true;
    return redactCreditCard(match);
  });

  // SSNs
  result = result.replace(SSN_RE, (match, area: string, group: string, serial: string) => {
    if (INVALID_SSN_AREAS.has(area)) return match;
    if (Number(area) >= 900) return match;
    if (group === '00') return match;
    if (serial === '0000') return match;
    changed = true;
    return redactSsn(area, group, serial);
  });

  return { redacted: result, changed };
}

// ── Deep object redaction ──────────────────────────────────────────────

/**
 * Recursively walks an object, redacting string values that contain
 * PII/credential patterns or any exact `secrets` value. Returns a deep
 * copy with redacted values. Non-string primitives, nulls, and undefined
 * pass through unchanged.
 */
export function redactObject<T>(obj: T, secrets: readonly string[] = []): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    const { redacted } = redactString(obj, secrets);
    return redacted as unknown as T;
  }

  if (Array.isArray(obj)) {
    const mapped: unknown[] = obj.map((item: unknown) => redactObject(item, secrets));
    return mapped as unknown as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = redactObject(value, secrets);
    }
    return result as T;
  }

  return obj;
}
