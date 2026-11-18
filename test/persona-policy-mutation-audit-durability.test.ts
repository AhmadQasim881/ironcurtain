/**
 * Crash consistency of the policy-mutation log: an append makes its record
 * durable before it moves the chain head. The head is fsynced when it is
 * replaced, so a head that reached the disk ahead of its record would make a
 * power loss look like records removed from the end of the log (and every
 * later append would chain from a head the log never reaches).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const trace = vi.hoisted(() => ({ events: [] as string[], fdPaths: new Map<number, string>() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>): number => {
      const fd = actual.openSync(...args);
      trace.fdPaths.set(fd, String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number): void => {
      trace.events.push(`fsync ${basename(trace.fdPaths.get(fd) ?? '?')}`);
      actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string): void => {
      trace.events.push(`rename ${basename(to)}`);
      actual.renameSync(from, to);
    },
  };
});

import { PolicyMutationAuditLog, verifyPolicyMutationLog } from '../src/persona/policy-mutation-audit.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-audit-durability-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  trace.events.length = 0;
  trace.fdPaths.clear();
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('policy-mutation log durability', () => {
  it('fsyncs the appended record before the head is replaced', () => {
    expect(new PolicyMutationAuditLog().append('cli', 'createPersona', 'p')).toBeDefined();

    const recordSynced = trace.events.indexOf('fsync policy-mutation.jsonl');
    const headMoved = trace.events.indexOf('rename policy-mutation.head.json');
    expect(recordSynced).toBeGreaterThanOrEqual(0);
    expect(headMoved).toBeGreaterThan(recordSynced);
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: true, records: 1 });
  });
});
