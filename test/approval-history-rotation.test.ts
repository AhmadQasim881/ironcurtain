/**
 * Rotation of the approval history under concurrent writers. Two processes can
 * both find the history full; the first rotates it to `.1` and starts a fresh
 * file. The second must not rotate again: that would rename the fresh file
 * over `.1` and throw away the whole history the first one just saved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const control = vi.hoisted(() => ({ reportFullOnce: false }));

vi.mock('../src/hardened-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hardened-fs.js')>();
  return {
    ...actual,
    appendRegularFileNoFollow: (...args: Parameters<typeof actual.appendRegularFileNoFollow>): void => {
      if (control.reportFullOnce) {
        control.reportFullOnce = false;
        // What this process saw just before another one rotated the file.
        throw Object.assign(new Error('appending would grow the history beyond its limit'), { code: 'TOO_LARGE' });
      }
      actual.appendRegularFileNoFollow(...args);
    },
  };
});

import {
  GLOBAL_APPROVAL_SCOPE,
  readApprovalHistory,
  recordHumanApproval,
  type HumanApproval,
} from '../src/audit/approval-history.js';

let dir: string;
let historyPath: string;

const approval: HumanApproval = {
  serverName: 'filesystem',
  toolName: 'write_file',
  rule: 'escalate-write-outside-permitted-areas',
  constraints: [{ kind: 'directory', role: 'write-path', directory: '/srv/reports' }],
  description: 'Allow filesystem/write_file write-path within /srv/reports',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ironcurtain-approval-rotation-'));
  historyPath = join(dir, 'approval-history.jsonl');
  control.reportFullOnce = false;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('approval history rotation', () => {
  it('does not rotate a file another process already rotated', () => {
    // The other process: two approvals, rotated to .1, then one more approval
    // that started the fresh current file.
    expect(recordHumanApproval(GLOBAL_APPROVAL_SCOPE, approval, { path: historyPath })).toBe(true);
    expect(recordHumanApproval(GLOBAL_APPROVAL_SCOPE, approval, { path: historyPath })).toBe(true);
    writeFileSync(`${historyPath}.1`, readFileSync(historyPath));
    rmSync(historyPath);
    expect(recordHumanApproval(GLOBAL_APPROVAL_SCOPE, approval, { path: historyPath })).toBe(true);
    const rotated = readFileSync(`${historyPath}.1`, 'utf8');

    // This process found the file full before that rotation.
    control.reportFullOnce = true;
    expect(recordHumanApproval(GLOBAL_APPROVAL_SCOPE, approval, { path: historyPath })).toBe(true);

    expect(readFileSync(`${historyPath}.1`, 'utf8')).toBe(rotated);
    expect(readApprovalHistory({ path: historyPath })).toHaveLength(4);
  });
});
