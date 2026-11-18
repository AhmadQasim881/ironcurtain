/**
 * Tests for the advisory file lock used by the job store. It is built on
 * docker-workload/process-lock: an owner record (pid, process-start
 * identity, token) published atomically, a dead owner's lock reclaimed by
 * exactly one contender, and release only of the lock this process holds.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, getJobLockPath, withFileLock } from '../src/cron/file-lock.js';
import type { ProcessLockOwner } from '../src/docker-workload/process-lock.js';

const TEST_DIR = resolve(tmpdir(), `ironcurtain-filelock-test-${process.pid}`);
const SELF_IDENTITY = 'self-process-start-fixture';

/** Process-start identities as a test sees them: this process only; every other pid is gone. */
function identityForPid(pid: number): string | undefined {
  return pid === process.pid ? SELF_IDENTITY : undefined;
}

/** A lock record left by a process that has since died. */
function staleOwner(): ProcessLockOwner {
  return {
    schemaVersion: 1,
    pid: 4242,
    processIdentity: 'dead-process-start',
    token: '00000000-0000-4000-8000-0000000000aa',
    createdAtMs: Date.now() - 60_000,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('file-lock', () => {
  describe('acquireLock', () => {
    it('publishes a complete owner record and removes it on release', async () => {
      const lockPath = join(TEST_DIR, 'test.lock');
      const lock = await acquireLock(lockPath, { processIdentityForPid: identityForPid });
      expect(lock).toBeDefined();

      const owner = JSON.parse(readFileSync(lockPath, 'utf-8')) as ProcessLockOwner;
      expect(owner).toMatchObject({ schemaVersion: 1, pid: process.pid, processIdentity: SELF_IDENTITY });
      expect(typeof owner.token).toBe('string');
      // Nothing but the lock itself: no candidate alias left beside it.
      expect(readdirSync(TEST_DIR)).toEqual(['test.lock']);

      lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    });

    it('waits while a live owner holds the lock, and gets it once released', async () => {
      const lockPath = join(TEST_DIR, 'test.lock');
      const first = await acquireLock(lockPath, { processIdentityForPid: identityForPid });

      const secondPromise = acquireLock(lockPath, { processIdentityForPid: identityForPid });
      setTimeout(() => first?.release(), 200);
      const second = await secondPromise;
      expect(second).toBeDefined();
      second?.release();
    });

    it('never takes over a live owner, however old its lock is, and gives up at the deadline', async () => {
      const lockPath = join(TEST_DIR, 'live.lock');
      writeFileSync(
        lockPath,
        `${JSON.stringify({ ...staleOwner(), pid: process.pid, processIdentity: SELF_IDENTITY, createdAtMs: 0 })}\n`,
      );

      const lock = await acquireLock(lockPath, { maxWaitMs: 150, processIdentityForPid: identityForPid });
      expect(lock).toBeUndefined();
      expect(existsSync(lockPath)).toBe(true);
    });

    it('reclaims a lock whose owner died', async () => {
      const lockPath = join(TEST_DIR, 'stale.lock');
      writeFileSync(lockPath, `${JSON.stringify(staleOwner())}\n`);

      const lock = await acquireLock(lockPath, { maxWaitMs: 0, processIdentityForPid: identityForPid });
      expect(lock).toBeDefined();
      expect((JSON.parse(readFileSync(lockPath, 'utf-8')) as ProcessLockOwner).pid).toBe(process.pid);
      lock?.release();
    });

    it('does not treat a fresh lock whose record is still incomplete as stale', async () => {
      const lockPath = join(TEST_DIR, 'fresh.lock');
      writeFileSync(lockPath, '');

      expect(await acquireLock(lockPath, { maxWaitMs: 0, processIdentityForPid: identityForPid })).toBeUndefined();
      expect(existsSync(lockPath)).toBe(true);
    });

    it('releases only its own lock: a lock that was replaced is left in place', async () => {
      const lockPath = join(TEST_DIR, 'replaced.lock');
      const lock = await acquireLock(lockPath, { processIdentityForPid: identityForPid });
      const foreign = `${JSON.stringify({ ...staleOwner(), pid: 4343, processIdentity: 'other-live-process' })}\n`;
      rmSync(lockPath);
      writeFileSync(lockPath, foreign);

      expect(() => lock?.release()).toThrow(/ownership was lost/u);
      expect(readFileSync(lockPath, 'utf-8')).toBe(foreign);
    });

    it('rejects when the lock directory does not exist (never creates it)', async () => {
      const lockPath = join(TEST_DIR, 'missing', 'x.lock');
      await expect(acquireLock(lockPath, { maxWaitMs: 0 })).rejects.toMatchObject({ code: 'ENOENT' });
      expect(existsSync(join(TEST_DIR, 'missing'))).toBe(false);
    });
  });

  describe('stale lock takeover across processes', () => {
    /**
     * Each contender (a separate Node process using the real OS process
     * table) waits for a shared start signal and tries the lock once. The
     * winner holds it until every contender has reported, so a slow
     * contender cannot slip in after the release.
     */
    const CONTENDER = `
      import { existsSync, writeFileSync } from 'node:fs';
      const [moduleUrl, lockPath, goPath, donePath, resultPath] = process.argv.slice(1);
      const { acquireLock } = await import(moduleUrl);
      writeFileSync(resultPath + '.ready', '');
      while (!existsSync(goPath)) await new Promise((r) => setTimeout(r, 2));
      const lock = await acquireLock(lockPath, { maxWaitMs: 0 });
      writeFileSync(resultPath, lock ? 'acquired' : 'busy');
      if (lock) {
        const deadline = Date.now() + 20000;
        while (!existsSync(donePath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        lock.release();
      }
    `;

    function runContender(
      lockPath: string,
      goPath: string,
      donePath: string,
      resultPath: string,
    ): Promise<number | null> {
      const moduleUrl = pathToFileURL(resolve('src/cron/file-lock.ts')).href;
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          CONTENDER,
          moduleUrl,
          lockPath,
          goPath,
          donePath,
          resultPath,
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
      return new Promise((done, fail) => {
        child.on('error', fail);
        child.on('exit', (code) => done(code));
      });
    }

    it('lets exactly one of several simultaneous contenders take over a stale lock', async () => {
      const lockPath = join(TEST_DIR, 'contended.lock');
      // A crashed owner: a pid that is not running now (pid_max is far below it).
      writeFileSync(lockPath, `${JSON.stringify({ ...staleOwner(), pid: 2 ** 30 })}\n`);
      const goPath = join(TEST_DIR, 'go');
      const donePath = join(TEST_DIR, 'done');
      const contenders = 5;
      const results = Array.from({ length: contenders }, (_, i) => join(TEST_DIR, `result-${i}`));

      const exits = results.map((resultPath) => runContender(lockPath, goPath, donePath, resultPath));
      const waitForFiles = async (paths: readonly string[], what: string): Promise<void> => {
        const deadline = Date.now() + 20_000;
        while (!paths.every((path) => existsSync(path))) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      // Start them together, once every one has loaded and polls for the signal.
      await waitForFiles(
        results.map((resultPath) => `${resultPath}.ready`),
        'the contenders to start',
      );
      writeFileSync(goPath, 'go');
      // Every contender has tried while the winner still holds the lock.
      await waitForFiles(results, 'every contender to try the lock');
      writeFileSync(donePath, 'done');
      expect(await Promise.all(exits)).toEqual(Array.from({ length: contenders }, () => 0));

      const outcomes = results.map((resultPath) => readFileSync(resultPath, 'utf-8'));
      expect(outcomes.filter((outcome) => outcome === 'acquired')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'busy')).toHaveLength(contenders - 1);
      // The winner released its lock; no capture or candidate file is left.
      expect(readdirSync(TEST_DIR).filter((name) => name.startsWith('contended.lock'))).toEqual([]);
    }, 30_000);
  });

  describe('withFileLock', () => {
    it('executes the function under lock and releases afterward', async () => {
      const lockPath = join(TEST_DIR, 'with.lock');
      let executed = false;

      await withFileLock(lockPath, () => {
        // Lock should be held during execution
        expect(existsSync(lockPath)).toBe(true);
        executed = true;
      });

      expect(executed).toBe(true);
      // Lock should be released after
      expect(existsSync(lockPath)).toBe(false);
    });

    it('releases lock even if function throws', async () => {
      const lockPath = join(TEST_DIR, 'throw.lock');

      await expect(
        withFileLock(lockPath, () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // Lock must be released despite the error
      expect(existsSync(lockPath)).toBe(false);
    });

    it('returns the value from the function', async () => {
      const lockPath = join(TEST_DIR, 'return.lock');
      const result = await withFileLock(lockPath, () => 42);
      expect(result).toBe(42);
    });

    it('supports async functions', async () => {
      const lockPath = join(TEST_DIR, 'async.lock');
      const result = await withFileLock(lockPath, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'async-result';
      });
      expect(result).toBe('async-result');
      expect(existsSync(lockPath)).toBe(false);
    });

    it('serializes two critical sections of one process', async () => {
      const lockPath = join(TEST_DIR, 'serial.lock');
      const order: string[] = [];
      const section = (name: string) => async (): Promise<void> => {
        order.push(`${name} start`);
        await new Promise((r) => setTimeout(r, 60));
        order.push(`${name} end`);
      };

      await Promise.all([withFileLock(lockPath, section('a')), withFileLock(lockPath, section('b'))]);
      expect(order).toEqual(['a start', 'a end', 'b start', 'b end']);
    });

    it('still returns the result when the lock was removed meanwhile (the job was deleted)', async () => {
      const lockPath = join(TEST_DIR, 'deleted.lock');
      const result = await withFileLock(lockPath, () => {
        rmSync(lockPath);
        return 'done';
      });
      expect(result).toBe('done');
    });

    it('throws when the lock cannot be acquired within the wait', async () => {
      const lockPath = join(TEST_DIR, 'held.lock');
      const held = await acquireLock(lockPath, { processIdentityForPid: identityForPid });
      await expect(
        withFileLock(lockPath, () => 'never', { maxWaitMs: 100, processIdentityForPid: identityForPid }),
      ).rejects.toThrow(/Failed to acquire file lock/u);
      held?.release();
    });
  });

  describe('getJobLockPath', () => {
    it('returns the job.lock file in the job directory', () => {
      const lockPath = getJobLockPath('/home/user/.ironcurtain/jobs/my-job');
      expect(lockPath).toBe('/home/user/.ironcurtain/jobs/my-job/job.lock');
    });
  });
});
