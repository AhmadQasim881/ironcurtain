/**
 * The daemon singleton lock (src/daemon/daemon-lock.ts): one holder at a
 * time, reclaimable after its owner died, released on demand and on exit.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireDaemonLock, DAEMON_LOCK_BUSY, isDaemonLockBusyError } from '../src/daemon/daemon-lock.js';

describe('daemon lock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ironcurtain-daemon-lock-'));
    lockPath = join(dir, 'daemon.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('admits one holder and names it to the next contender', () => {
    const held = acquireDaemonLock(lockPath);
    try {
      let thrown: unknown;
      try {
        acquireDaemonLock(lockPath);
      } catch (error) {
        thrown = error;
      }
      expect(isDaemonLockBusyError(thrown)).toBe(true);
      expect(thrown).toMatchObject({ code: DAEMON_LOCK_BUSY, ownerPid: process.pid, lockPath });
      expect((thrown as Error).message).toContain(lockPath);
    } finally {
      held.release();
    }
  });

  it('can be taken again once released, and release is idempotent', () => {
    const first = acquireDaemonLock(lockPath);
    first.release();
    first.release();
    expect(existsSync(lockPath)).toBe(false);

    const second = acquireDaemonLock(lockPath);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
    second.release();
  });

  it('reclaims a lock whose recorded owner is no longer running', () => {
    // Same pid, different process-start identity: the recorded owner is gone
    // and the pid was reused (here, by this process).
    writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        processIdentity: 'a-process-that-has-exited',
        token: '00000000-0000-4000-8000-000000000001',
        createdAtMs: Date.now() - 60_000,
      }) + '\n',
      { mode: 0o600 },
    );
    const lock = acquireDaemonLock(lockPath);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).not.toMatchObject({
      processIdentity: 'a-process-that-has-exited',
    });
    lock.release();
  });

  it('creates a missing IronCurtain home owner-only', () => {
    const home = join(dir, 'fresh-home');
    const lock = acquireDaemonLock(join(home, 'daemon.lock'));
    try {
      expect(statSync(home).mode & 0o777).toBe(0o700);
    } finally {
      lock.release();
    }
  });

  it('releases on process exit, and stops listening for exit once released', () => {
    const before = process.listenerCount('exit');
    const lock = acquireDaemonLock(lockPath);
    expect(process.listenerCount('exit')).toBe(before + 1);

    // Simulate the exit hook firing (as process.exit() would).
    const listeners = process.listeners('exit');
    const hook = listeners[listeners.length - 1];
    hook.call(process, 0);
    expect(existsSync(lockPath)).toBe(false);

    lock.release();
    expect(process.listenerCount('exit')).toBe(before);
  });
});
