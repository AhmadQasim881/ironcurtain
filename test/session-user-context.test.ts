/**
 * The session's user-context.json writes: a human turn is recorded with its
 * source and time; a system-generated turn clears the file, and the clear
 * fails closed (the previous human message never survives it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearSessionUserContext, recordSessionUserContext } from '../src/escalation/session-user-context.js';
import { readUserContext } from '../src/trusted-process/auto-approver.js';

/** When set, the atomic write the module uses fails (a full disk, say). */
const writeFailure = vi.hoisted(() => ({ fail: false }));

vi.mock('../src/escalation/escalation-watcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/escalation/escalation-watcher.js')>();
  return {
    ...actual,
    atomicWriteJsonSync: (filePath: string, data: unknown): void => {
      if (writeFailure.fail) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      actual.atomicWriteJsonSync(filePath, data);
    },
  };
});

describe('session user context', () => {
  let escalationDir: string;
  const contextPath = (): string => join(escalationDir, 'user-context.json');

  beforeEach(() => {
    escalationDir = mkdtempSync(join(tmpdir(), 'ic-session-user-context-'));
    writeFailure.fail = false;
  });

  afterEach(() => {
    rmSync(escalationDir, { recursive: true, force: true });
  });

  it('records a human turn with its source and the time it was sent', () => {
    const before = Date.now();
    recordSessionUserContext(escalationDir, 'push my changes to origin');

    const raw = JSON.parse(readFileSync(contextPath(), 'utf-8')) as Record<string, unknown>;
    expect(raw.userMessage).toBe('push my changes to origin');
    expect(raw.source).toBe('session-direct');
    expect(new Date(raw.timestamp as string).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(readUserContext(escalationDir)?.userMessage).toBe('push my changes to origin');
  });

  it('clears a recorded human message for a system-generated turn', () => {
    recordSessionUserContext(escalationDir, 'push my changes to origin');

    clearSessionUserContext(escalationDir);

    const raw = JSON.parse(readFileSync(contextPath(), 'utf-8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ userMessage: '', source: 'system-generated' });
    expect(readUserContext(escalationDir)).toBeNull();
  });

  it('removes the previous human message even when the marker cannot be written', () => {
    recordSessionUserContext(escalationDir, 'push my changes to origin');
    writeFailure.fail = true;

    clearSessionUserContext(escalationDir);

    // Fail closed: no context is left that could authorize the system turn.
    expect(existsSync(contextPath())).toBe(false);
    expect(readUserContext(escalationDir)).toBeNull();
  });

  it('ignores a missing escalation directory', () => {
    const missing = join(escalationDir, 'not-created-yet');
    expect(() => recordSessionUserContext(missing, 'hello')).not.toThrow();
    expect(() => clearSessionUserContext(missing)).not.toThrow();
    expect(readUserContext(missing)).toBeNull();
  });
});
