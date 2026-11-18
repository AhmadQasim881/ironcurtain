import { describe, expect, it, vi } from 'vitest';
import type { PolicyMutationVerifyResult } from '../src/persona/policy-mutation-audit.js';

const verification = vi.hoisted(
  () =>
    ({
      ok: false,
      records: 0,
      legacyRecords: 0,
      notes: ['Neutral note\u0085\u202e\u034f'],
      problem: { file: 'neutral.jsonl', reason: 'Neutral reason\u0085\u202e\u034f' },
    }) satisfies PolicyMutationVerifyResult,
);

vi.mock('../src/persona/policy-mutation-audit.js', () => ({ verifyPolicyMutationLog: () => verification }));

import { runAuditCommand } from '../src/audit/audit-command.js';

describe('audit verify JSON output', () => {
  it('escapes display-sensitive notes while retaining the entire result', async () => {
    let out = '';
    expect(
      await runAuditCommand(['verify', '--json'], {
        write: (text) => {
          out += text;
        },
      }),
    ).toBe(1);
    expect(out).not.toMatch(/\u0085|\u202e|\u034f/u);
    expect(JSON.parse(out)).toEqual(verification);
  });
});
