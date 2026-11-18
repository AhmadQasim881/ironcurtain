import { describe, it, expect } from 'vitest';
import {
  MIN_SECRET_LENGTH,
  REDACTED_SECRET,
  prepareRedactionSecrets,
  redactObject,
  redactString,
} from '../src/trusted-process/audit-redactor.js';

// ── redactString ───────────────────────────────────────────────────────

describe('redactString', () => {
  // Credit cards
  it('redacts a valid Visa card number', () => {
    const { redacted, changed } = redactString('card is 4111111111111111');
    expect(changed).toBe(true);
    expect(redacted).toContain('4111');
    expect(redacted).not.toContain('4111111111111111');
  });

  it('redacts a card number with spaces', () => {
    const { redacted, changed } = redactString('4111 1111 1111 1111');
    expect(changed).toBe(true);
    expect(redacted).not.toContain('4111 1111 1111 1111');
  });

  it('redacts a card number with dashes', () => {
    const { redacted, changed } = redactString('4111-1111-1111-1111');
    expect(changed).toBe(true);
    expect(redacted).not.toContain('4111-1111-1111-1111');
  });

  it('does not redact a number that fails Luhn', () => {
    const { redacted, changed } = redactString('4111111111111112');
    expect(changed).toBe(false);
    expect(redacted).toBe('4111111111111112');
  });

  // SSNs
  it('redacts a valid SSN with dashes', () => {
    const { redacted, changed } = redactString('SSN: 123-45-6789');
    expect(changed).toBe(true);
    expect(redacted).toContain('***-**-6789');
    expect(redacted).not.toContain('123-45');
  });

  it('leaves a bare 9-digit identifier intact (an SSN is recognised by its separators)', () => {
    // Issue numbers, order ids and timestamps are 9-digit runs far more
    // often than SSNs; redacting them corrupted legitimate audit data.
    for (const text of ['issue 123456789', 'ssn 123456789', 'order 987654321 shipped']) {
      const { redacted, changed } = redactString(text);
      expect(changed).toBe(false);
      expect(redacted).toBe(text);
    }
  });

  it('does not treat a space-separated digit run as an SSN', () => {
    const { redacted, changed } = redactString('rooms 123 45 6789');
    expect(changed).toBe(false);
    expect(redacted).toBe('rooms 123 45 6789');
  });

  it('does not redact SSN with area 000', () => {
    const { redacted, changed } = redactString('000-12-3456');
    expect(changed).toBe(false);
    expect(redacted).toBe('000-12-3456');
  });

  it('does not redact SSN with area 666', () => {
    const { redacted, changed } = redactString('666-12-3456');
    expect(changed).toBe(false);
    expect(redacted).toBe('666-12-3456');
  });

  it('does not redact SSN with area 900+', () => {
    const { redacted, changed } = redactString('900-12-3456');
    expect(changed).toBe(false);
    expect(redacted).toBe('900-12-3456');
  });

  it('does not redact SSN with group 00', () => {
    const { redacted, changed } = redactString('123-00-4567');
    expect(changed).toBe(false);
    expect(redacted).toBe('123-00-4567');
  });

  it('does not redact SSN with serial 0000', () => {
    const { redacted, changed } = redactString('123-45-0000');
    expect(changed).toBe(false);
    expect(redacted).toBe('123-45-0000');
  });

  // API keys
  it('redacts an OpenAI-style API key', () => {
    // Construct key at runtime to avoid push protection false positives
    const key = 'sk-' + 'abcdefghijklmnopqrstuvwxyz1234';
    const { redacted, changed } = redactString('key: ' + key);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(key);
    expect(redacted).toContain('sk-a');
  });

  it('redacts a GitHub PAT', () => {
    // Construct token at runtime to avoid push protection false positives
    const token = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const { redacted, changed } = redactString('token ' + token);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(token);
  });

  it('redacts an AWS access key', () => {
    // Construct key at runtime to avoid push protection false positives
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const { redacted, changed } = redactString(key);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(key);
  });

  it('redacts a Slack bot token', () => {
    // Use a constructed token to avoid push protection false positives
    const token = ['xoxb', '1234567890', 'abcdefghijklmnopqrst'].join('-');
    const { redacted, changed } = redactString(token);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(token);
  });

  // Key formats of the providers IronCurtain itself handles. Every sample
  // is assembled at runtime so secret scanners never see a key-shaped
  // literal; `keep` is the prefix the mask preserves for diagnosability.
  const providerKeys: ReadonlyArray<{ name: string; key: string; keep: string }> = [
    {
      name: 'Anthropic API key',
      key: 'sk-ant-api03-' + 'Ab1'.repeat(30) + '_-' + 'Zz9'.repeat(5) + 'AA',
      keep: 'sk-a',
    },
    { name: 'Anthropic OAuth token', key: 'sk-ant-oat01-' + 'Qq2'.repeat(30), keep: 'sk-a' },
    { name: 'OpenAI project key', key: 'sk-proj-' + 'Rr3'.repeat(20) + '_' + 'Ss4'.repeat(10), keep: 'sk-p' },
    { name: 'OpenAI service-account key', key: 'sk-svcacct-' + 'Tt5'.repeat(20), keep: 'sk-s' },
    { name: 'OpenAI user key', key: 'sk-None-' + 'Uu6'.repeat(16), keep: 'sk-N' },
    { name: 'OpenRouter key', key: 'sk-or-v1-' + '0123456789abcdef'.repeat(4), keep: 'sk-o' },
    {
      name: 'GitHub fine-grained PAT',
      key: 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0K1' + '_' + 'x'.repeat(59),
      keep: 'gith',
    },
    { name: 'GitHub OAuth token', key: 'gho_' + 'abcdefghijklmnopqrstuvwxyz0123456789', keep: 'gho_' },
    { name: 'GitHub user-to-server token', key: 'ghu_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', keep: 'ghu_' },
    { name: 'GitHub refresh token', key: 'ghr_' + 'a1'.repeat(38), keep: 'ghr_' },
    { name: 'Google API key', key: 'AIza' + 'SyD-abcdefghijklmnopqrstuvwxyz01234', keep: 'AIza' },
    // 39 characters ending in '-' (one Google key in 64 does): a trailing
    // word boundary would leave it unredacted.
    { name: 'Google API key ending in a dash', key: 'AIza' + 'SyD_abcdefghijklmnopqrstuvwxyz0123-', keep: 'AIza' },
    { name: 'Google OAuth access token', key: 'ya29.' + 'a0AfH6SMB'.repeat(6), keep: 'ya29' },
    { name: 'Slack app token', key: 'xapp-1-A0123456789-1234567890123-' + 'abcdef0123456789abcdef', keep: 'xapp' },
    { name: 'Slack rotating token', key: 'xoxe-1-' + 'My0'.repeat(12), keep: 'xoxe' },
    { name: 'AWS temporary access key', key: 'ASIA' + 'IOSFODNN7EXAMPLE', keep: 'ASIA' },
  ];
  for (const { name, key, keep } of providerKeys) {
    it(`redacts a ${name}`, () => {
      const { redacted, changed } = redactString(`token: ${key} (copied from .env)`);
      expect(changed).toBe(true);
      expect(redacted).not.toContain(key);
      expect(redacted).toContain(keep);
      expect(redacted).toContain('(copied from .env)');
    });
  }

  it('redacts a JSON Web Token', () => {
    const jwt = [
      'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');
    const { redacted, changed } = redactString(`id_token=${jwt}`);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(jwt);
    expect(redacted).toContain('id_token=eyJ');
  });

  it('redacts any bearer credential and keeps the scheme keyword', () => {
    const token = 'bearer-token-' + 'opaque0123456789'.repeat(2);
    const { redacted, changed } = redactString(`Authorization: Bearer ${token}`);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(token);
    expect(redacted).toMatch(/^Authorization: Bearer bear\.\.\./);
  });

  it('matches the bearer scheme in any case (HTTP auth schemes are case-insensitive)', () => {
    const token = 'opaque0123456789'.repeat(2);
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const { redacted, changed } = redactString(`authorization: ${scheme} ${token}`);
      expect(changed).toBe(true);
      expect(redacted).not.toContain(token);
      expect(redacted).toBe(`authorization: ${scheme} opaq...6789`);
    }
  });

  it('masks a whole token even when a digit run inside it passes the card check', () => {
    // A Slack bot token's 13-digit segment, and a digit run inside an
    // Anthropic key, that the Luhn check accepts. Masking that run as a
    // card first split the token and wrote the rest of it in clear.
    const luhnValid13 = '1000000000009';
    const cardShaped = redactString(`card ${luhnValid13}`);
    expect(cardShaped.changed).toBe(true);

    const slackSecret = 'abcdefghijklmnopqrstuvwx';
    const slack = ['xoxb', '1234567890', luhnValid13, slackSecret].join('-');
    const anthropicTail = 'Zz9'.repeat(14);
    const anthropic = 'sk-ant-api03-' + '4111111111111111-' + anthropicTail;

    const { redacted } = redactString(
      `SLACK_BOT_TOKEN=${slack}\nANTHROPIC_API_KEY=${anthropic}\ncard 4111111111111111`,
    );
    expect(redacted).toBe('SLACK_BOT_TOKEN=xoxb...uvwx\nANTHROPIC_API_KEY=sk-a...9Zz9\ncard 4111 ******** 1111');
    expect(redacted).not.toContain(slackSecret.slice(0, 20));
    expect(redacted).not.toContain(anthropicTail.slice(0, 20));
  });

  it('leaves ordinary hyphenated and underscored identifiers alone', () => {
    for (const text of [
      'task-list-item-with-many-hyphenated-segments-in-it',
      'desk-top-background-image-selection-helper-v2',
      'ghostscript_printing_queue_default_settings_file',
      'see https://example.com/sk-learn-based-pipelines-and-more-content',
    ]) {
      const { redacted, changed } = redactString(text);
      expect(changed).toBe(false);
      expect(redacted).toBe(text);
    }
  });

  // No matches
  it('returns unchanged text when no patterns match', () => {
    const { redacted, changed } = redactString('hello world, nothing sensitive here');
    expect(changed).toBe(false);
    expect(redacted).toBe('hello world, nothing sensitive here');
  });

  it('handles empty string', () => {
    const { redacted, changed } = redactString('');
    expect(changed).toBe(false);
    expect(redacted).toBe('');
  });

  // Multiple patterns in one string
  it('redacts multiple patterns in a single string', () => {
    const { redacted, changed } = redactString('SSN: 123-45-6789 card: 4111111111111111');
    expect(changed).toBe(true);
    expect(redacted).toContain('***-**-6789');
    expect(redacted).not.toContain('4111111111111111');
  });
});

// ── Known credential values ────────────────────────────────────────────

describe('known credential values', () => {
  // Deliberately matches none of the format patterns: only the exact
  // value tells the redactor this is a credential.
  const secret = 'not-a-known-format-' + 'c0nf1gured-secret-value';

  it('prepareRedactionSecrets drops short, empty and duplicate values and orders longest first', () => {
    expect('short'.length).toBeLessThan(MIN_SECRET_LENGTH);
    const prepared = prepareRedactionSecrets([
      'short',
      '',
      undefined,
      null,
      'abcdefgh',
      secret,
      secret,
      'abcdefgh-longer',
    ]);
    expect(prepared).toEqual([secret, 'abcdefgh-longer', 'abcdefgh']);
  });

  it('redacts an exact configured credential whatever its format', () => {
    const { redacted, changed } = redactString(`GITHUB_TOKEN=${secret}\n`, prepareRedactionSecrets([secret]));
    expect(changed).toBe(true);
    expect(redacted).toBe(`GITHUB_TOKEN=${REDACTED_SECRET}\n`);
  });

  it('redacts every occurrence, in nested structures too', () => {
    const result = redactObject(
      { content: `${secret} and again ${secret}`, nested: [{ note: secret }], count: 3 },
      prepareRedactionSecrets([secret]),
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.content).toBe(`${REDACTED_SECRET} and again ${REDACTED_SECRET}`);
    expect(result.nested[0].note).toBe(REDACTED_SECRET);
    expect(result.count).toBe(3);
  });

  it('leaves text without a known value unchanged', () => {
    const { redacted, changed } = redactString('nothing to see here', prepareRedactionSecrets([secret]));
    expect(changed).toBe(false);
    expect(redacted).toBe('nothing to see here');
  });
});

// ── redactObject ───────────────────────────────────────────────────────

describe('redactObject', () => {
  it('redacts string values in a flat object', () => {
    const result = redactObject({ path: '/tmp/foo', content: 'SSN: 123-45-6789' });
    expect(result.path).toBe('/tmp/foo');
    expect(result.content).toContain('***-**-6789');
  });

  it('redacts nested objects', () => {
    const result = redactObject({
      outer: {
        inner: 'card 4111111111111111',
      },
    });
    expect(result.outer.inner).not.toContain('4111111111111111');
  });

  it('redacts arrays of strings', () => {
    const result = redactObject(['safe text', 'SSN: 123-45-6789']);
    expect(result[0]).toBe('safe text');
    expect(result[1]).toContain('***-**-6789');
  });

  it('passes through numbers unchanged', () => {
    const result = redactObject({ count: 42 });
    expect(result.count).toBe(42);
  });

  it('passes through null', () => {
    expect(redactObject(null)).toBeNull();
  });

  it('passes through undefined', () => {
    const undef: unknown = undefined;
    expect(redactObject(undef)).toBeUndefined();
  });

  it('passes through booleans unchanged', () => {
    const result = redactObject({ flag: true });
    expect(result.flag).toBe(true);
  });

  it('handles deeply nested mixed structures', () => {
    // Construct key at runtime to avoid push protection false positives
    const key = 'sk-' + 'abcdefghijklmnopqrstuvwxyz1234';
    const input = {
      level1: {
        level2: [{ text: key }, { text: 'no secrets' }],
      },
    };
    const result = redactObject(input);
    const items = result.level1.level2;
    expect(items[0].text).not.toContain(key);
    expect(items[1].text).toBe('no secrets');
  });
});

// ── AuditLog integration ───────────────────────────────────────────────

describe('AuditLog with redaction', () => {
  it('redacts when enabled', async () => {
    const { AuditLog } = await import('../src/trusted-process/audit-log.js');
    const tmpPath = `/tmp/audit-redact-test-${Date.now()}.jsonl`;
    const log = new AuditLog(tmpPath, { redact: true });

    log.log({
      timestamp: '2026-01-01T00:00:00.000Z',
      requestId: 'r1',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { content: 'SSN: 123-45-6789' },
      policyDecision: { status: 'allow' as const, rule: 'r', reason: 'r' },
      result: { status: 'success', content: 'card 4111111111111111' },
      durationMs: 10,
    });
    await log.close();

    const { readFileSync, unlinkSync } = await import('node:fs');
    const written = readFileSync(tmpPath, 'utf-8');
    expect(written).toContain('***-**-6789');
    expect(written).not.toContain('123-45-6789');
    expect(written).not.toContain('4111111111111111');
    unlinkSync(tmpPath);
  });

  it('does not redact when disabled', async () => {
    const { AuditLog } = await import('../src/trusted-process/audit-log.js');
    const tmpPath = `/tmp/audit-no-redact-test-${Date.now()}.jsonl`;
    const log = new AuditLog(tmpPath, { redact: false });

    log.log({
      timestamp: '2026-01-01T00:00:00.000Z',
      requestId: 'r1',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { content: 'SSN: 123-45-6789' },
      policyDecision: { status: 'allow' as const, rule: 'r', reason: 'r' },
      result: { status: 'success', content: 'card 4111111111111111' },
      durationMs: 10,
    });
    await log.close();

    const { readFileSync, unlinkSync } = await import('node:fs');
    const written = readFileSync(tmpPath, 'utf-8');
    expect(written).toContain('123-45-6789');
    expect(written).toContain('4111111111111111');
    unlinkSync(tmpPath);
  });

  it('redacts configured credential values when enabled', async () => {
    const { AuditLog } = await import('../src/trusted-process/audit-log.js');
    const secret = 'configured-credential-' + 'value-0123456789';
    const tmpPath = `/tmp/audit-secret-test-${Date.now()}.jsonl`;
    const log = new AuditLog(tmpPath, { redact: true, secrets: [secret, 'short', undefined] });

    log.log({
      timestamp: '2026-01-01T00:00:00.000Z',
      requestId: 'r1',
      serverName: 'fs',
      toolName: 'write_file',
      arguments: { path: '/workspace/.env', content: `GITHUB_TOKEN=${secret}` },
      policyDecision: { status: 'allow' as const, rule: 'r', reason: 'r' },
      result: { status: 'error', error: `backend rejected ${secret}` },
      durationMs: 10,
    });
    await log.close();

    const { readFileSync, unlinkSync } = await import('node:fs');
    const written = readFileSync(tmpPath, 'utf-8');
    expect(written).not.toContain(secret);
    expect(written).toContain(`GITHUB_TOKEN=${REDACTED_SECRET}`);
    expect(written).toContain(`backend rejected ${REDACTED_SECRET}`);
    // Metadata is untouched.
    expect(written).toContain('"path":"/workspace/.env"');
    unlinkSync(tmpPath);
  });

  it('writes configured credential values in clear when redaction is disabled', async () => {
    // `auditRedaction.enabled: false` means full forensic logging; the
    // known-value list is part of redaction and follows the same switch.
    const { AuditLog } = await import('../src/trusted-process/audit-log.js');
    const secret = 'configured-credential-' + 'value-0123456789';
    const tmpPath = `/tmp/audit-secret-off-test-${Date.now()}.jsonl`;
    const log = new AuditLog(tmpPath, { redact: false, secrets: [secret] });

    log.log({
      timestamp: '2026-01-01T00:00:00.000Z',
      requestId: 'r1',
      serverName: 'fs',
      toolName: 'write_file',
      arguments: { content: secret },
      policyDecision: { status: 'allow' as const, rule: 'r', reason: 'r' },
      result: { status: 'success' },
      durationMs: 10,
    });
    await log.close();

    const { readFileSync, unlinkSync } = await import('node:fs');
    expect(readFileSync(tmpPath, 'utf-8')).toContain(secret);
    unlinkSync(tmpPath);
  });

  it('does not redact by default (no options)', async () => {
    const { AuditLog } = await import('../src/trusted-process/audit-log.js');
    const tmpPath = `/tmp/audit-default-test-${Date.now()}.jsonl`;
    const log = new AuditLog(tmpPath);

    log.log({
      timestamp: '2026-01-01T00:00:00.000Z',
      requestId: 'r1',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { content: 'SSN: 123-45-6789' },
      policyDecision: { status: 'allow' as const, rule: 'r', reason: 'r' },
      result: { status: 'success' },
      durationMs: 10,
    });
    await log.close();

    const { readFileSync, unlinkSync } = await import('node:fs');
    const written = readFileSync(tmpPath, 'utf-8');
    expect(written).toContain('123-45-6789');
    unlinkSync(tmpPath);
  });
});
