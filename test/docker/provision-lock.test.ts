import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { provisionLockPath, tryAcquireProvisionLock, withProvisionLock } from '../../src/docker/provision-lock.js';

const SELF_IDENTITY = 'self-process-start-fixture';

/** Identity resolver for tests: only this process is alive. */
function onlySelfAlive(pid: number): string | undefined {
  return pid === process.pid ? SELF_IDENTITY : undefined;
}

/** A complete owner record for a process that no longer exists. */
function writeDeadOwnerLock(path: string, pid = 2 ** 30): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      pid,
      processIdentity: 'dead-process-start',
      token: '00000000-0000-4000-8000-00000000dead',
      createdAtMs: Date.now() - 60_000,
    })}\n`,
    { mode: 0o600 },
  );
}

function ownerToken(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { token: string }).token;
}

describe('withProvisionLock', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'provision-lock-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    for (const name of readdirSync(dirname(cacheDir))) {
      if (name.startsWith(`${basename(cacheDir)}.`)) rmSync(join(dirname(cacheDir), name), { force: true });
    }
  });

  it('runs the critical section and releases the lock afterward', async () => {
    let ran = false;
    const result = await withProvisionLock(cacheDir, async () => {
      ran = true;
      // The lock is a sibling file while held, never inside the cache dir.
      expect(existsSync(provisionLockPath(cacheDir))).toBe(true);
      expect(readdirSync(cacheDir)).toEqual([]);
      return 'done';
    });

    expect(ran).toBe(true);
    expect(result).toBe('done');
    expect(existsSync(provisionLockPath(cacheDir))).toBe(false);
  });

  it('releases the lock even when the critical section throws', async () => {
    await expect(
      withProvisionLock(cacheDir, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(existsSync(provisionLockPath(cacheDir))).toBe(false);
  });

  it('serializes two concurrent critical sections on the same cache dir', async () => {
    const events: string[] = [];
    const enter = (tag: string) => events.push(`enter-${tag}`);
    const exit = (tag: string) => events.push(`exit-${tag}`);

    const slow = withProvisionLock(cacheDir, async () => {
      enter('A');
      await new Promise((r) => setTimeout(r, 150));
      exit('A');
    });
    // Start B shortly after A so A wins the lock first.
    await new Promise((r) => setTimeout(r, 20));
    const fast = withProvisionLock(cacheDir, async () => {
      enter('B');
      exit('B');
    });

    await Promise.all([slow, fast]);

    // B must not interleave inside A's critical section.
    expect(events).toEqual(['enter-A', 'exit-A', 'enter-B', 'exit-B']);
  });

  it('lets concurrent sections on DIFFERENT cache dirs run in parallel', async () => {
    const other = mkdtempSync(join(tmpdir(), 'provision-lock-other-'));
    try {
      const events: string[] = [];
      const a = withProvisionLock(cacheDir, async () => {
        events.push('enter-A');
        await new Promise((r) => setTimeout(r, 100));
        events.push('exit-A');
      });
      const b = withProvisionLock(other, async () => {
        events.push('enter-B');
        events.push('exit-B');
      });
      await Promise.all([a, b]);
      // Distinct locks → B runs while A is still sleeping (interleaved).
      expect(events.indexOf('enter-B')).toBeLessThan(events.indexOf('exit-A'));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('times out when the lock cannot be acquired within maxWaitMs', async () => {
    // Hold the lock for longer than the waiter's tolerance.
    const holder = withProvisionLock(cacheDir, async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await new Promise((r) => setTimeout(r, 20));

    await expect(withProvisionLock(cacheDir, async () => 'never', { maxWaitMs: 100 })).rejects.toThrow(
      /Failed to acquire provisioning lock/,
    );

    await holder;
  });

  it('never steals from a live holder, however long it has held the lock', async () => {
    const held = tryAcquireProvisionLock(cacheDir);
    if (held === undefined) throw new Error('expected to acquire the lock');
    try {
      // An old lock owned by a live process is not stale.
      const old = new Date(Date.now() - 24 * 60 * 60_000);
      utimesSync(provisionLockPath(cacheDir), old, old);
      await expect(withProvisionLock(cacheDir, async () => 'stolen', { maxWaitMs: 300 })).rejects.toThrow(
        /Failed to acquire provisioning lock/,
      );
      expect(ownerToken(provisionLockPath(cacheDir))).toBe(held.owner.token);
    } finally {
      held.release();
    }
  });

  it('does not steal a fresh owner record that is not yet complete', async () => {
    // A malformed record within the grace window is treated as mid-publication.
    writeFileSync(provisionLockPath(cacheDir), '', { mode: 0o600 });
    await expect(withProvisionLock(cacheDir, async () => 'stolen', { maxWaitMs: 300 })).rejects.toThrow(
      /Failed to acquire provisioning lock/,
    );
  });

  it('reclaims a malformed owner record older than the grace window', async () => {
    const lockPath = provisionLockPath(cacheDir);
    writeFileSync(lockPath, 'not-json', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const result = await withProvisionLock(cacheDir, async () => 'reclaimed', { maxWaitMs: 2_000 });
    expect(result).toBe('reclaimed');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reclaims a lock whose holder process is dead', async () => {
    writeDeadOwnerLock(provisionLockPath(cacheDir));
    const result = await withProvisionLock(cacheDir, async () => 'reclaimed', { maxWaitMs: 2_000 });
    expect(result).toBe('reclaimed');
  });

  it('reclaims a reused PID only when its process-start identity differs', () => {
    const lockPath = provisionLockPath(cacheDir);
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 4242,
        processIdentity: 'original-start',
        token: '00000000-0000-4000-8000-000000004242',
        createdAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );

    // Same PID, same start identity: the original owner is still alive.
    const busy = tryAcquireProvisionLock(cacheDir, {
      processIdentityForPid: (pid) => (pid === process.pid ? SELF_IDENTITY : 'original-start'),
    });
    expect(busy).toBeUndefined();

    // Same PID, different start identity: the PID was reused, the lock is stale.
    const held = tryAcquireProvisionLock(cacheDir, {
      processIdentityForPid: (pid) => (pid === process.pid ? SELF_IDENTITY : 'reused-start'),
    });
    if (held === undefined) throw new Error('expected to reclaim the reused-PID lock');
    expect(ownerToken(lockPath)).toBe(held.owner.token);
    held.release();
  });

  it('leaves exactly one holder when two contenders take over the same stale lock', () => {
    const lockPath = provisionLockPath(cacheDir);
    writeDeadOwnerLock(lockPath);

    // Interleave the race deterministically: contender A has judged the lock
    // stale (its identity probe of the dead owner is the last step before the
    // takeover) when contender B completes its own takeover. The mkdir-based
    // lock this replaced deleted B's fresh lock here and let A in as well.
    let contenderB: ReturnType<typeof tryAcquireProvisionLock>;
    let raced = false;
    const contenderA = tryAcquireProvisionLock(cacheDir, {
      processIdentityForPid: (pid) => {
        if (pid === process.pid) return SELF_IDENTITY;
        if (!raced) {
          raced = true;
          contenderB = tryAcquireProvisionLock(cacheDir, { processIdentityForPid: onlySelfAlive });
        }
        return undefined; // the original owner is dead
      },
    });

    expect(raced).toBe(true);
    const holders = [contenderA, contenderB].filter((handle) => handle !== undefined);
    expect(holders).toHaveLength(1);
    expect(contenderA).toBeUndefined();
    const [holder] = holders;
    expect(ownerToken(lockPath)).toBe(holder.owner.token);
    // Only the published lock remains: no capture or candidate aliases.
    expect(readdirSync(dirname(lockPath)).filter((name) => name.startsWith(basename(lockPath)))).toEqual([
      basename(lockPath),
    ]);
    holder.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release removes only the lock this holder published', () => {
    const held = tryAcquireProvisionLock(cacheDir);
    if (held === undefined) throw new Error('expected to acquire the lock');
    // Simulate the lock being replaced behind the holder's back.
    rmSync(provisionLockPath(cacheDir));
    writeDeadOwnerLock(provisionLockPath(cacheDir), 4343);
    expect(() => held.release()).toThrow(/ownership was lost/);
    // The foreign record was left alone.
    expect(ownerToken(provisionLockPath(cacheDir))).toBe('00000000-0000-4000-8000-00000000dead');
  });

  it('fails a successful critical section whose lock was lost, instead of reporting it done', async () => {
    await expect(
      withProvisionLock(cacheDir, async () => {
        rmSync(provisionLockPath(cacheDir));
        writeDeadOwnerLock(provisionLockPath(cacheDir), 4444);
        return 'done';
      }),
    ).rejects.toThrow(/ownership was lost/);
  });
});

describe('withProvisionLock across processes', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'provision-lock-processes-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * Starts one contender process. It waits for the shared start signal, takes
   * the lock, and appends `enter`/`exit` events (with a high-resolution clock)
   * to its own file while holding it.
   */
  function startContender(cacheDir: string, signalPath: string, index: number): Promise<void> {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'docker', 'provision-lock.ts')).href;
    const program = `
      import { existsSync, appendFileSync } from 'node:fs';
      import { withProvisionLock } from ${JSON.stringify(moduleUrl)};
      const [cacheDir, signalPath, eventsPath] = process.argv.slice(1);
      while (!existsSync(signalPath)) await new Promise((r) => setTimeout(r, 5));
      await withProvisionLock(cacheDir, async () => {
        appendFileSync(eventsPath, JSON.stringify({ event: 'enter', at: Number(process.hrtime.bigint()) }) + '\\n');
        await new Promise((r) => setTimeout(r, 40));
        appendFileSync(eventsPath, JSON.stringify({ event: 'exit', at: Number(process.hrtime.bigint()) }) + '\\n');
      }, { maxWaitMs: 60_000, retryIntervalMs: 10 });
    `;
    const eventsPath = join(workDir, `events-${index}.jsonl`);
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', program, cacheDir, signalPath, eventsPath],
        { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', rejectPromise);
      child.once('exit', (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`contender ${index} exited ${String(code)}: ${stderr}`));
      });
    });
  }

  it('lets exactly one process at a time take over a stale lock', async () => {
    const cacheDir = join(workDir, 'cache');
    mkdirSync(cacheDir);
    writeDeadOwnerLock(provisionLockPath(cacheDir));
    const signalPath = join(workDir, 'go');
    const contenders = Array.from({ length: 5 }, (_, index) => startContender(cacheDir, signalPath, index));
    // Let every contender start up and spin on the signal, then release them together.
    await new Promise((r) => setTimeout(r, 1_500));
    writeFileSync(signalPath, '');
    await Promise.all(contenders);

    const intervals = readdirSync(workDir)
      .filter((name) => name.startsWith('events-'))
      .map((name) => {
        const events = readFileSync(join(workDir, name), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { event: string; at: number });
        expect(events.map((entry) => entry.event)).toEqual(['enter', 'exit']);
        return { enter: events[0].at, exit: events[1].at };
      })
      .sort((left, right) => left.enter - right.enter);

    expect(intervals).toHaveLength(5);
    for (let index = 1; index < intervals.length; index += 1) {
      // Each holder entered only after the previous one left.
      expect(intervals[index].enter).toBeGreaterThan(intervals[index - 1].exit);
    }
    expect(existsSync(provisionLockPath(cacheDir))).toBe(false);
  }, 60_000);
});
