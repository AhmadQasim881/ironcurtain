/**
 * The Signal transport lock (src/signal/signal-lock.ts): one holder at a
 * time, named to the next contender; released on demand (idempotent, never
 * throwing) and on process exit.
 */

import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireSignalLock, isSignalLockBusyError, SIGNAL_LOCK_BUSY } from '../src/signal/signal-lock.js';

describe('Signal transport lock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ironcurtain-signal-lock-unit-'));
    lockPath = join(dir, 'signal.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('admits one holder and names it to the next contender', () => {
    const held = acquireSignalLock(lockPath);
    try {
      let thrown: unknown;
      try {
        acquireSignalLock(lockPath);
      } catch (error) {
        thrown = error;
      }
      expect(isSignalLockBusyError(thrown)).toBe(true);
      expect(thrown).toMatchObject({ code: SIGNAL_LOCK_BUSY, ownerPid: process.pid, lockPath });
      expect((thrown as Error).message).toBe(
        `Process ${process.pid} holds the IronCurtain Signal lock ${lockPath}: an ironcurtain bot, ` +
          'or an ironcurtain daemon with the Signal transport, already runs Signal for this home.',
      );
    } finally {
      held.release();
    }
  });

  it('can be taken again once released; release is idempotent and never throws', () => {
    const first = acquireSignalLock(lockPath);
    first.release();
    first.release();
    expect(existsSync(lockPath)).toBe(false);

    const second = acquireSignalLock(lockPath);
    // Someone removed the file: the lock is no longer ours, and release says nothing.
    unlinkSync(lockPath);
    expect(() => second.release()).not.toThrow();
  });

  it('creates a missing IronCurtain home owner-only', () => {
    const home = join(dir, 'fresh-home');
    const lock = acquireSignalLock(join(home, 'signal.lock'));
    try {
      expect(statSync(home).mode & 0o777).toBe(0o700);
    } finally {
      lock.release();
    }
  });

  it('releases on process exit, and stops listening for exit once released', () => {
    const before = process.listenerCount('exit');
    const lock = acquireSignalLock(lockPath);
    expect(process.listenerCount('exit')).toBe(before + 1);

    // Simulate the exit hook firing (as process.exit() would).
    const listeners = process.listeners('exit');
    listeners[listeners.length - 1].call(process, 0);
    expect(existsSync(lockPath)).toBe(false);
    expect(process.listenerCount('exit')).toBe(before);

    lock.release();
    expect(process.listenerCount('exit')).toBe(before);
  });
});
