/**
 * Matching cost of the approval whitelist. An exact pattern for a
 * multi-file call holds one constraint per file, and `match` runs for every
 * escalated call under the coordinator's call mutex, so each path value of
 * the call is canonicalized once per match, however many constraints it is
 * compared with (not once per constraint).
 *
 * `resolveRealPath` is wrapped so the test can count canonicalizations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolAnnotation } from '../src/pipeline/types.js';
import { resolveRealPath } from '../src/types/argument-roles.js';
import {
  createApprovalWhitelist,
  extractWhitelistCandidates,
  type WhitelistContext,
} from '../src/trusted-process/approval-whitelist.js';

vi.mock('../src/types/argument-roles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/types/argument-roles.js')>();
  return { ...actual, resolveRealPath: vi.fn(actual.resolveRealPath) };
});

const annotation: ToolAnnotation = {
  toolName: 'read_multiple_files',
  serverName: 'filesystem',
  comment: 'Read several files',
  args: { paths: ['read-path'] },
};
const context: WhitelistContext = { escalatedRoles: ['read-path'] };

describe('whitelist matching cost', () => {
  let dir: string;
  let files: string[];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'wl-cost-')));
    files = Array.from({ length: 40 }, (_, i) => join(dir, `f${i}.txt`));
    for (const file of files) writeFileSync(file, 'x');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('canonicalizes each path of a call once, however many files the exact pattern names', () => {
    const { patterns, ipcs } = extractWhitelistCandidates(
      'filesystem',
      'read_multiple_files',
      { paths: files },
      annotation,
      context,
      'esc-cost',
      'test reason',
    );
    expect(ipcs[0].scope).toBe('exact');
    expect(patterns[0].constraints).toHaveLength(files.length);
    const whitelist = createApprovalWhitelist();
    whitelist.add(patterns[0]);

    // Reversed: each value matches the last constraint it is compared with.
    const call = { paths: [...files].reverse() };
    vi.mocked(resolveRealPath).mockClear();
    expect(whitelist.match('filesystem', 'read_multiple_files', call, annotation, context).matched).toBe(true);
    expect(vi.mocked(resolveRealPath)).toHaveBeenCalledTimes(files.length);

    // A call with one file the pattern does not name stops at that file.
    vi.mocked(resolveRealPath).mockClear();
    const stranger = join(dir, 'not-approved.txt');
    expect(
      whitelist.match('filesystem', 'read_multiple_files', { paths: [stranger, ...files] }, annotation, context)
        .matched,
    ).toBe(false);
    expect(vi.mocked(resolveRealPath)).toHaveBeenCalledTimes(1);
  });
});
