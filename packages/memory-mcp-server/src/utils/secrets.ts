/**
 * Secret values in text an agent asks memory to keep.
 *
 * Memories are stored in plain SQLite, sent to the memory LLM, and replayed into
 * later sessions' briefings, so a secret that lands in memory outlives the session
 * that saw it and reaches every later session of the namespace. Memory therefore
 * never keeps secret values: `memory_store` rejects content and tags that contain
 * one (the agent can store where the secret lives instead), and `memory_ingest`
 * removes them from a blob before extraction.
 *
 * The patterns follow IronCurtain's audit-log redactor (provider-prefixed API keys
 * and tokens, bearer credentials, Luhn-valid card numbers, US SSNs with their
 * separators), plus private-key blocks, credentials embedded in URLs, and
 * passwords or keys written as an assignment. Every pattern is anchored on a
 * prefix, a keyword or a fixed shape, and none nests quantifiers.
 */

/**
 * Provider-prefixed API keys and tokens (the audit redactor's list): Anthropic,
 * OpenAI, OpenRouter, GitHub, Google, Slack and AWS keys, and JSON Web Tokens.
 */
const PROVIDER_KEY_SOURCE = [
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
  .join('|');

/** `Bearer <token>`, any scheme spelling; the token is group 1. */
const BEARER_SOURCE = '\\bBearer\\s+([A-Za-z0-9._~+/=-]{20,})';

/**
 * A PEM private key (RSA, EC, OpenSSH, PKCS#8, encrypted): the BEGIN line through
 * its END line when one follows within 20000 characters, else the BEGIN line.
 */
const PRIVATE_KEY_SOURCE =
  '-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:[\\s\\S]{0,20000}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)?';

/** A URL with a password in its userinfo, `scheme://user:password@host`; the password is group 1. */
const URL_CREDENTIAL_SOURCE = '\\b[A-Za-z][A-Za-z0-9+.-]{0,20}://[^\\s/:@]{1,256}:([^\\s/@]{1,256})(?=@)';

/**
 * A password, passphrase, key or token given as an assignment or a statement:
 * `password: hunter2`, `api_key=abc123…`, `the wifi password is cat123`. The value
 * must contain a digit, and a value that starts like a path or a reference (`/`,
 * `~`, `.`, `$`, `<`, `{`, `%`, `(`, `[`) is not one: storing where a secret lives
 * (`private key: ~/.ssh/id_ed25519`, `api_key = $OPENAI_API_KEY`) is exactly what
 * an agent should do instead.
 */
const CREDENTIAL_KEYWORD =
  '(?:password|passwd|passphrase|api[ _-]?key|secret[ _-]?key|access[ _-]?key|private[ _-]?key|' +
  'client[ _-]?secret|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|bearer[ _-]?token)';
const CREDENTIAL_ASSIGNMENT_SOURCE =
  `\\b${CREDENTIAL_KEYWORD}\\b(?:\\s*[:=]\\s*|\\s+(?:is|was)\\s+)["'\`]?` +
  '((?![/~.$<{%(\\[])(?=[^\\s"\'`,;]*\\d)[^\\s"\'`,;]{4,})';

/**
 * Card numbers: 13-19 digits, optionally grouped by single spaces or dashes, that
 * start like a card network's number (2-6) and pass the Luhn check. The leading
 * digit keeps epoch-millisecond timestamps (which start with 1) out.
 */
const CARD_SOURCE = '\\b\\d(?:[ -]?\\d){12,18}\\b';

/** US SSNs written with their separators (3-2-4 digit groups). */
const SSN_SOURCE = '\\b(\\d{3})-(\\d{2})-(\\d{4})\\b';

interface SecretPattern {
  readonly kind: string;
  readonly source: string;
  readonly flags: string;
  /**
   * The group holding the secret value itself, which ends the match; redaction
   * replaces only it and keeps the keyword or scheme before it. Absent: the whole
   * match is the secret.
   */
  readonly valueGroup?: number;
  /** Further check on a match (the Luhn sum, the SSN area rules). */
  readonly accept?: (match: RegExpExecArray) => boolean;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'an API key or token', source: PROVIDER_KEY_SOURCE, flags: 'g' },
  { kind: 'a bearer token', source: BEARER_SOURCE, flags: 'gi', valueGroup: 1 },
  { kind: 'a private key', source: PRIVATE_KEY_SOURCE, flags: 'g' },
  { kind: 'a password in a URL', source: URL_CREDENTIAL_SOURCE, flags: 'g', valueGroup: 1 },
  { kind: 'a password, key or token', source: CREDENTIAL_ASSIGNMENT_SOURCE, flags: 'gi', valueGroup: 1 },
  { kind: 'a payment card number', source: CARD_SOURCE, flags: 'g', accept: (m) => isCardNumber(m[0]) },
  { kind: 'a social security number', source: SSN_SOURCE, flags: 'g', accept: isPlausibleSsn },
];

/** Replacement for a removed secret value. */
export const REDACTED_SECRET_MARKER = '[secret removed]';

function isCardNumber(raw: string): boolean {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19 || !/^[2-6]/.test(digits)) return false;
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

function isPlausibleSsn(match: RegExpExecArray): boolean {
  const [, area = '', group = '', serial = ''] = match;
  return area !== '000' && area !== '666' && Number(area) < 900 && group !== '00' && serial !== '0000';
}

/**
 * What kind of secret `text` contains (for an error message), or undefined when it
 * contains none.
 */
export function findSecret(text: string): string | undefined {
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (let match = re.exec(text); match !== null; match = re.exec(text)) {
      if (pattern.accept === undefined || pattern.accept(match)) return pattern.kind;
    }
  }
  return undefined;
}

/** `text` with every secret value replaced by {@link REDACTED_SECRET_MARKER}, and how many were. */
export function redactSecrets(text: string): { text: string; count: number } {
  let result = text;
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let out = '';
    let last = 0;
    // Every pattern consumes at least one character, so exec() always advances.
    for (let match = re.exec(result); match !== null; match = re.exec(result)) {
      if (pattern.accept !== undefined && !pattern.accept(match)) continue;
      const end = match.index + match[0].length;
      const value = pattern.valueGroup === undefined ? match[0] : (match[pattern.valueGroup] ?? match[0]);
      out += result.slice(last, end - value.length) + REDACTED_SECRET_MARKER;
      last = end;
      count++;
    }
    result = out + result.slice(last);
  }
  return { text: result, count };
}

/**
 * Throws when `text` contains a secret value. `field` names the argument in the
 * error, which tells the agent what to store instead.
 */
export function assertNoSecret(text: string, field: string): void {
  const kind = findSecret(text);
  if (kind === undefined) return;
  throw new Error(
    `${field} appears to contain ${kind}. Memory never stores secret values: ` +
      'store where the secret is kept (for example "the deploy key is in 1Password"), not the secret itself.',
  );
}
