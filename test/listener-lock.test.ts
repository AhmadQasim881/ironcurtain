/**
 * The escalation listener's single-instance lock and its process handling:
 *
 * - the lock is a process-lock owner record (pid, process-start identity,
 *   token): a crashed listener's lock is reclaimed, also when its pid was
 *   reused by another process, and only a live listener keeps others out;
 * - release removes only the lock this listener published;
 * - SIGHUP (closed terminal) and SIGTERM release the lock and exit;
 * - the listener leaves sessions owned by a live mux to that mux;
 * - it runs only with a terminal on stdin and stderr (without one it refuses
 *   before taking the lock: test/cli-help-integration.test.ts);
 * - isPidAlive counts EPERM (another user's process) as alive and never
 *   probes a process group.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installListenerExitHandlers,
  listenerHasTerminal,
  shouldListenerWatch,
} from '../src/escalation/listener-command.js';
import { acquireListenerLock, isListenerLockHeld, isPidAlive } from '../src/escalation/listener-lock.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';
import type { ProcessLockOwner } from '../src/docker-workload/process-lock.js';

const SELF_IDENTITY = 'listener-self-start';

function identityForPid(pid: number): string | undefined {
  return pid === process.pid ? SELF_IDENTITY : pid === 4242 ? 'a-different-process-start' : undefined;
}

function owner(overrides: Partial<ProcessLockOwner> = {}): ProcessLockOwner {
  return {
    schemaVersion: 1,
    pid: 4242,
    processIdentity: 'crashed-listener-start',
    token: '00000000-0000-4000-8000-0000000000bb',
    createdAtMs: Date.now() - 60_000,
    ...overrides,
  };
}

describe('escalation listener lock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ic-listener-lock-'));
    lockPath = join(dir, 'escalation-listener.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a second listener out while the first is alive, and is free after release', () => {
    const first = acquireListenerLock(lockPath, { processIdentityForPid: identityForPid });
    expect(first).toBeDefined();
    expect(isListenerLockHeld(lockPath, { processIdentityForPid: identityForPid })).toBe(true);
    expect(acquireListenerLock(lockPath, { processIdentityForPid: identityForPid })).toBeUndefined();

    first?.release();
    first?.release(); // idempotent
    expect(existsSync(lockPath)).toBe(false);
    expect(isListenerLockHeld(lockPath, { processIdentityForPid: identityForPid })).toBe(false);
  });

  it('reclaims the lock of a crashed listener whose pid now belongs to another process', () => {
    // pid 4242 is alive, but it is not the process that took the lock.
    writeFileSync(lockPath, `${JSON.stringify(owner())}\n`);
    expect(isListenerLockHeld(lockPath, { processIdentityForPid: identityForPid })).toBe(false);

    const lock = acquireListenerLock(lockPath, { processIdentityForPid: identityForPid });
    expect(lock).toBeDefined();
    expect((JSON.parse(readFileSync(lockPath, 'utf-8')) as ProcessLockOwner).pid).toBe(process.pid);
    lock?.release();
  });

  it('reclaims a lock file left in the previous plain-pid format once it is not fresh', () => {
    writeFileSync(lockPath, '4242');
    // A record that does not parse and was written moments ago could be
    // mid-publication: hands off.
    expect(acquireListenerLock(lockPath, { processIdentityForPid: identityForPid })).toBeUndefined();

    const aMinuteAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, aMinuteAgo, aMinuteAgo);
    const lock = acquireListenerLock(lockPath, { processIdentityForPid: identityForPid });
    expect(lock).toBeDefined();
    lock?.release();
  });

  it('never removes a lock it no longer owns', () => {
    const lock = acquireListenerLock(lockPath, { processIdentityForPid: identityForPid });
    const replacement = `${JSON.stringify(owner({ pid: process.pid, processIdentity: SELF_IDENTITY, token: 'x' }))}\n`;
    rmSync(lockPath);
    writeFileSync(lockPath, replacement);

    expect(() => lock?.release()).not.toThrow();
    expect(readFileSync(lockPath, 'utf-8')).toBe(replacement);
  });
});

describe('escalation listener exit handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['SIGHUP', 129],
    ['SIGTERM', 143],
  ] as const)('releases the lock and exits on %s', (signal, code) => {
    const release = vi.fn();
    const cleanup = vi.fn();
    const exit = vi.fn();
    const remove = installListenerExitHandlers({ path: '/unused', release }, cleanup, exit);
    try {
      process.emit(signal, signal);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(code);
    } finally {
      remove();
    }
  });

  it('removes its handlers on a normal shutdown', () => {
    const counts = (): number[] => ['SIGHUP', 'SIGTERM', 'exit'].map((event) => process.listenerCount(event));
    const before = counts();
    const remove = installListenerExitHandlers({ path: '/unused', release: vi.fn() }, vi.fn(), vi.fn());
    expect(counts()).toEqual(before.map((count) => count + 1));
    remove();
    expect(counts()).toEqual(before);
  });
});

describe('escalation listener session ownership', () => {
  function registration(overrides: Partial<PtySessionRegistration> = {}): PtySessionRegistration {
    return {
      sessionId: 'sess-1',
      escalationDir: '/tmp/unused',
      label: 'session',
      startedAt: new Date().toISOString(),
      pid: process.pid,
      ...overrides,
    };
  }

  it('leaves a session owned by a live mux to that mux', () => {
    expect(shouldListenerWatch(registration({ muxId: 'mux-1', muxPid: process.pid }))).toBe(false);
  });

  it('watches unowned sessions and sessions whose mux is gone', () => {
    expect(shouldListenerWatch(registration())).toBe(true);
    expect(shouldListenerWatch(registration({ muxId: 'mux-1', muxPid: 2 ** 30 }))).toBe(true);
  });
});

describe('escalation listener terminal check', () => {
  it('needs a terminal on both stdin (decisions) and stderr (the dashboard)', () => {
    expect(listenerHasTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(listenerHasTerminal({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(listenerHasTerminal({}, { isTTY: true })).toBe(false);
    expect(listenerHasTerminal({ isTTY: true }, {})).toBe(false);
  });
});

describe('isPidAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports this process alive and a nonexistent pid dead', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 30)).toBe(false);
  });

  it('counts a process of another user (EPERM) as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    expect(isPidAlive(1)).toBe(true);
  });

  it('never treats 0, a negative or a fractional pid as a live process', () => {
    const kill = vi.spyOn(process, 'kill');
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
