/**
 * inspectRepositoryForPolicy fails closed: an unexpected error from the
 * repository inspection becomes a structural escalation (a human decides),
 * never an exception out of policy evaluation and never a silent allow.
 * Separate file because the module mock applies to every test in a file.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/security/git-hardening.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/security/git-hardening.js')>();
  return {
    ...actual,
    inspectRepoConfig: () => {
      throw new Error('unexpected inspection failure');
    },
  };
});

const { inspectRepositoryForPolicy } = await import('../src/trusted-process/git-structural-rules.js');

describe('inspectRepositoryForPolicy', () => {
  it('reports an untrusted repository when the inspection throws', () => {
    for (const sandboxRoot of [undefined, '/sandbox']) {
      const reason = inspectRepositoryForPolicy('/sandbox/repo', sandboxRoot);
      expect(reason).toContain('the repository could not be inspected');
      expect(reason).toContain('human approval is required');
    }
  });
});
