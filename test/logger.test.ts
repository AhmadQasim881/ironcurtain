import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import * as logger from '../src/logger.js';

/** Content of a log file, or '' when nothing was ever written to it. */
function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

/** Lets other queued work run (a macrotask turn). */
function tick(): Promise<void> {
  return new Promise((resolveTick) => setTimeout(resolveTick, 1));
}

describe('Logger', () => {
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    logDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-logger-'));
    logFile = resolve(logDir, 'test.log');
  });

  afterEach(() => {
    logger.teardown(); // Always restore console, even if a test fails
    rmSync(logDir, { recursive: true, force: true });
  });

  it('writes entries with timestamp and level', () => {
    logger.setup({ logFilePath: logFile });
    logger.info('hello world');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('INFO ');
    expect(content).toContain('hello world');
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });

  it('intercepts console.log and redirects to file', () => {
    logger.setup({ logFilePath: logFile });
    console.log('third-party noise');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('[console.log] third-party noise');
  });

  it('intercepts console.error and redirects to file', () => {
    logger.setup({ logFilePath: logFile });
    console.error('some error');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('[console.error] some error');
  });

  it('restores console methods on teardown', () => {
    const originalLog = console.log;
    logger.setup({ logFilePath: logFile });
    expect(console.log).not.toBe(originalLog);
    logger.teardown();
    expect(console.log).toBe(originalLog);
  });

  it('is a no-op when not set up', () => {
    // Should not throw, should not write anywhere
    logger.info('this goes nowhere');
    logger.error('neither does this');
  });

  it('is idempotent when setup() called twice without teardown()', () => {
    logger.setup({ logFilePath: logFile });
    // Second call should be a no-op, not throw
    logger.setup({ logFilePath: logFile });
    logger.info('after double setup');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('after double setup');
  });

  it('retargets to a new path when setup() is called with a different path', () => {
    // Simulates workflow state transitions: state A sets up, forgets to
    // teardown, state B calls setup() with its own path. setup() must
    // redirect writes to state B's file without losing the console
    // hijack or requiring a full re-init.
    const logFileA = resolve(logDir, 'state-a.log');
    const logFileB = resolve(logDir, 'state-b.log');

    logger.setup({ logFilePath: logFileA });
    logger.info('goes to A');

    // Retarget without teardown
    logger.setup({ logFilePath: logFileB });
    logger.info('goes to B');
    logger.teardown();

    const contentA = readFileSync(logFileA, 'utf-8');
    const contentB = readFileSync(logFileB, 'utf-8');

    // State A's file has only state A's write (plus the init line).
    expect(contentA).toContain('goes to A');
    expect(contentA).not.toContain('goes to B');

    // State B's file has only state B's write (plus the retarget line).
    expect(contentB).toContain('goes to B');
    expect(contentB).not.toContain('goes to A');
    expect(contentB).toContain('Logger retargeted');
  });

  it('session-like handoff: teardown + re-setup routes writes to the new log', () => {
    // Session A claims logger, writes, tears down. Session B claims
    // logger with a new path, writes, tears down. Writes must not
    // co-mingle. This is the regression guard for the workflow
    // per-state log bug: previously state B's setup was a no-op
    // because the singleton was still marked active from state A.
    const logFileA = resolve(logDir, 'session-a.log');
    const logFileB = resolve(logDir, 'session-b.log');

    logger.setup({ logFilePath: logFileA });
    logger.info('from A');
    logger.teardown();

    logger.setup({ logFilePath: logFileB });
    logger.info('from B');
    logger.teardown();

    const contentA = readFileSync(logFileA, 'utf-8');
    const contentB = readFileSync(logFileB, 'utf-8');

    expect(contentA).toContain('from A');
    expect(contentA).not.toContain('from B');
    expect(contentB).toContain('from B');
    expect(contentB).not.toContain('from A');
  });

  it('teardown() is idempotent', () => {
    logger.setup({ logFilePath: logFile });
    logger.teardown();
    logger.teardown(); // Should not throw
  });

  it('teardown() is safe when never set up', () => {
    logger.teardown(); // Should not throw
  });

  it("formats non-string console arguments as Node's console does", () => {
    // util.format, not JSON: the console used to print JSON.stringify output,
    // which dropped Error details and threw on circular objects and BigInt.
    logger.setup({ logFilePath: logFile });
    console.log('count:', 42, { key: 'value' });
    console.log('%s has %d items', 'list', 3);
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain("[console.log] count: 42 { key: 'value' }");
    expect(content).toContain('[console.log] list has 3 items');
  });

  it('writes all four log levels', () => {
    logger.setup({ logFilePath: logFile });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.teardown();

    const content = readFileSync(logFile, 'utf-8');
    expect(content).toContain('DEBUG d');
    expect(content).toContain('INFO  i');
    expect(content).toContain('WARN  w');
    expect(content).toContain('ERROR e');
  });

  it('isActive() reflects lifecycle state', () => {
    expect(logger.isActive()).toBe(false);
    logger.setup({ logFilePath: logFile });
    expect(logger.isActive()).toBe(true);
    logger.teardown();
    expect(logger.isActive()).toBe(false);
  });

  describe('console replacements never throw', () => {
    it('logs a circular object instead of throwing', () => {
      logger.setup({ logFilePath: logFile });
      const cyclic: Record<string, unknown> = { name: 'loop' };
      cyclic.self = cyclic;
      expect(() => console.log('state:', cyclic)).not.toThrow();
      expect(() => console.error(cyclic)).not.toThrow();
      logger.teardown();

      const content = read(logFile);
      expect(content).toContain("[console.log] state: <ref *1> { name: 'loop', self: [Circular *1] }");
      expect(content).toContain('[console.error] <ref *1>');
    });

    it('logs BigInt values', () => {
      logger.setup({ logFilePath: logFile });
      expect(() => console.warn({ n: 10n })).not.toThrow();
      expect(() => console.debug(2n ** 70n)).not.toThrow();
      logger.teardown();

      const content = read(logFile);
      expect(content).toContain('[console.warn] { n: 10n }');
      expect(content).toContain('[console.debug] 1180591620717411303424n');
    });

    it('keeps the message and stack of a logged Error', () => {
      logger.setup({ logFilePath: logFile });
      console.error('failed:', new Error('boom'));
      logger.teardown();

      const content = read(logFile);
      expect(content).toContain('[console.error] failed: Error: boom');
      expect(content).toMatch(/\n\s+at .*logger\.test\.ts/);
    });

    it('survives values that cannot be inspected or stringified', () => {
      logger.setup({ logFilePath: logFile });
      const hostile = {
        [inspect.custom]: () => {
          throw new Error('inspector exploded');
        },
        toString: () => {
          throw new Error('toString exploded');
        },
      };
      expect(() => console.log('before', hostile, 'after')).not.toThrow();
      expect(() => console.log(Object.create(null), Symbol('tag'), undefined)).not.toThrow();
      logger.teardown();

      const content = read(logFile);
      expect(content).toContain('[console.log] before [unprintable value] after');
      expect(content).toContain('[console.log] [Object: null prototype] {} Symbol(tag) undefined');
    });

    it('formatConsoleArgs falls back to String() per argument', () => {
      const throwing = {
        [inspect.custom]: () => {
          throw new Error('no');
        },
      };
      expect(logger.formatConsoleArgs(['a', 1, throwing])).toBe('a 1 [object Object]');
    });
  });

  describe('claims', () => {
    it('release() gives back one claim and the previous claimant keeps logging', () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      const sessionLog = resolve(logDir, 'session.log');
      const daemon = logger.setup({ logFilePath: daemonLog });
      const session = logger.setup({ logFilePath: sessionLog });
      logger.info('while the session is open');
      logger.release(session);
      logger.info('after the session closed');
      console.log('console after the session closed');

      expect(logger.isActive()).toBe(true);
      expect(read(sessionLog)).toContain('while the session is open');
      expect(read(sessionLog)).not.toContain('after the session closed');
      expect(read(daemonLog)).toContain('after the session closed');
      expect(read(daemonLog)).toContain('[console.log] console after the session closed');
      logger.release(daemon);
      expect(logger.isActive()).toBe(false);
    });

    it('releasing an older claim leaves the newer one in place', () => {
      const first = resolve(logDir, 'first.log');
      const second = resolve(logDir, 'second.log');
      const a = logger.setup({ logFilePath: first });
      logger.setup({ logFilePath: second });
      logger.release(a);
      logger.info('still the newest claim');
      expect(read(second)).toContain('still the newest claim');
      expect(read(first)).not.toContain('still the newest claim');
    });

    it('restores the console only once the last claim is released', () => {
      const originalLog = console.log;
      const a = logger.setup({ logFilePath: resolve(logDir, 'a.log') });
      const b = logger.setup({ logFilePath: resolve(logDir, 'b.log') });
      logger.release(a);
      expect(console.log).not.toBe(originalLog);
      logger.release(b);
      expect(console.log).toBe(originalLog);
    });

    it('release() is idempotent, ignores undefined and never touches another claim', () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      const daemon = logger.setup({ logFilePath: daemonLog });
      const session = logger.setup({ logFilePath: resolve(logDir, 'session.log') });
      logger.release(session);
      logger.release(session);
      logger.release(undefined);
      logger.info('daemon still logging');
      expect(read(daemonLog)).toContain('daemon still logging');
      expect(logger.isActive()).toBe(true);
      logger.release(daemon);
    });

    it('teardown() drops every claim', () => {
      const originalLog = console.log;
      logger.setup({ logFilePath: resolve(logDir, 'a.log') });
      logger.setup({ logFilePath: resolve(logDir, 'b.log') });
      logger.teardown();
      expect(logger.isActive()).toBe(false);
      expect(console.log).toBe(originalLog);
    });

    it('two sessions log to their own files and the daemon log continues after one closes', async () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      const logA = resolve(logDir, 'session-a.log');
      const logB = resolve(logDir, 'session-b.log');
      // The daemon's claim is process-wide: its own (unbound) lines stay in
      // daemon.log while newer session claims exist.
      const daemon = logger.setup({ logFilePath: daemonLog, processWide: true });

      // A session's work: interleaved with the other's across async turns,
      // through module-level logger calls and console output alike.
      async function sessionWork(name: string, rounds: number): Promise<void> {
        for (let round = 0; round < rounds; round++) {
          await tick();
          logger.info(`${name} step ${round}`);
          console.warn(`${name} console ${round}`);
          // A timer started inside the session's work keeps its claim.
          await new Promise<void>((done) =>
            setTimeout(() => {
              logger.info(`${name} timer ${round}`);
              done();
            }, 1),
          );
        }
      }

      const a = logger.setup({ logFilePath: logA });
      const b = logger.setup({ logFilePath: logB });
      const runA = logger.runWithClaim(a, () => sessionWork('A', 3));
      const runB = logger.runWithClaim(b, () => sessionWork('B', 6));
      logger.info('daemon while both run');
      console.error('daemon console while both run');
      await runA;
      logger.release(a); // session A closes while B still runs
      logger.info('daemon after A closed');
      await runB;
      logger.release(b);
      logger.info('daemon after B closed');

      const contentA = read(logA);
      const contentB = read(logB);
      const d = read(daemonLog);
      for (let round = 0; round < 3; round++) {
        expect(contentA).toContain(`A step ${round}`);
        expect(contentA).toContain(`[console.warn] A console ${round}`);
        expect(contentA).toContain(`A timer ${round}`);
      }
      for (let round = 0; round < 6; round++) {
        expect(contentB).toContain(`B step ${round}`);
        expect(contentB).toContain(`B timer ${round}`);
      }
      expect(contentA).not.toMatch(/\bB (step|console|timer)|daemon/);
      expect(contentB).not.toMatch(/\bA (step|console|timer)|daemon/);
      expect(d).toContain('daemon while both run');
      expect(d).toContain('[console.error] daemon console while both run');
      expect(d).toContain('daemon after A closed');
      expect(d).toContain('daemon after B closed');
      expect(d).not.toMatch(/\b[AB] (step|console|timer)/);
      logger.release(daemon);
    });

    it('without a process-wide claim, unbound lines go to the newest claim', () => {
      const olderLog = resolve(logDir, 'older.log');
      const newerLog = resolve(logDir, 'newer.log');
      logger.setup({ logFilePath: olderLog });
      const newer = logger.setup({ logFilePath: newerLog });
      logger.info('to the newest');
      logger.release(newer);
      logger.info('back to the older');
      expect(read(newerLog)).toContain('to the newest');
      expect(read(olderLog)).not.toContain('to the newest');
      expect(read(olderLog)).toContain('back to the older');
    });

    it('a process-wide claim keeps unbound lines while newer claims exist', () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      const sessionLog = resolve(logDir, 'session.log');
      const daemon = logger.setup({ logFilePath: daemonLog, processWide: true });
      const session = logger.setup({ logFilePath: sessionLog });
      logger.info('daemon line');
      logger.runWithClaim(session, () => logger.info('session line'));
      expect(read(daemonLog)).toContain('daemon line');
      expect(read(daemonLog)).not.toContain('session line');
      expect(read(sessionLog)).toContain('session line');
      expect(read(sessionLog)).not.toContain('daemon line');
      logger.release(session);
      logger.release(daemon);
    });

    it('lines bound to a released claim go to the newest live claim', async () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      const sessionLog = resolve(logDir, 'session.log');
      const daemon = logger.setup({ logFilePath: daemonLog });
      const session = logger.setup({ logFilePath: sessionLog });
      let late: Promise<void> = Promise.resolve();
      logger.runWithClaim(session, () => {
        late = tick().then(() => logger.info('late line from a closed session'));
      });
      logger.release(session);
      await late;
      expect(read(daemonLog)).toContain('late line from a closed session');
      expect(read(sessionLog)).not.toContain('late line from a closed session');
      logger.release(daemon);
    });

    it('runWithClaim(undefined) runs the function unchanged', () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      const daemon = logger.setup({ logFilePath: daemonLog });
      expect(logger.runWithClaim(undefined, () => 42)).toBe(42);
      logger.runWithClaim(undefined, () => logger.info('unbound'));
      expect(read(daemonLog)).toContain('unbound');
      logger.release(daemon);
    });
  });

  describe('size-based rotation', () => {
    const rotation = { maxBytes: 300, maxFiles: 2 };
    const filler = 'x'.repeat(60);

    function logLines(count: number, prefix: string): void {
      for (let index = 0; index < count; index++) logger.info(`${prefix} ${index} ${filler}`);
    }

    it("rotates the claim's file before it would pass maxBytes and keeps at most maxFiles copies", () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      const claim = logger.setup({ logFilePath: daemonLog, processWide: true, rotation });
      logLines(30, 'line');
      logger.release(claim);

      const names = readdirSync(logDir).sort();
      expect(names).toEqual(['daemon.log', 'daemon.log.1', 'daemon.log.2']);
      for (const name of names) expect(statSync(resolve(logDir, name)).size).toBeLessThanOrEqual(rotation.maxBytes);
      // The newest lines are in the live file, the ones before in .1, older in .2.
      expect(read(daemonLog)).toContain('line 29 ');
      expect(read(`${daemonLog}.1`)).not.toContain('line 29 ');
      expect(read(`${daemonLog}.2`)).not.toContain('line 0 ');
      // Rotated files keep the owner-only mode of the log.
      expect(statSync(`${daemonLog}.1`).mode & 0o777).toBe(0o600);
    });

    it('never rotates a claim without rotation (a session log)', () => {
      const sessionLog = resolve(logDir, 'session.log');
      const claim = logger.setup({ logFilePath: sessionLog });
      logLines(30, 'line');
      logger.release(claim);
      expect(readdirSync(logDir)).toEqual(['session.log']);
      expect(statSync(sessionLog).size).toBeGreaterThan(rotation.maxBytes);
    });

    it("rotates the daemon log, not the session log the daemon's session writes, while both claims are live", () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      const sessionLog = resolve(logDir, 'session.log');
      const daemon = logger.setup({ logFilePath: daemonLog, processWide: true, rotation });
      const session = logger.setup({ logFilePath: sessionLog });
      logger.runWithClaim(session, () => logLines(30, 'session'));
      logLines(30, 'daemon');
      logger.release(session);
      logger.release(daemon);
      expect(existsSync(`${sessionLog}.1`)).toBe(false);
      expect(read(sessionLog)).toContain('session 29 ');
      expect(existsSync(`${daemonLog}.1`)).toBe(true);
      expect(read(daemonLog)).not.toContain('session ');
    });

    it('rotates a file that was already over the limit when the claim was taken', () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      writeFileSync(daemonLog, 'y'.repeat(1000));
      const claim = logger.setup({ logFilePath: daemonLog, rotation });
      logger.info('after restart');
      logger.release(claim);
      expect(read(`${daemonLog}.1`)).toContain('y'.repeat(1000));
      expect(read(daemonLog)).toContain('after restart');
    });

    it('ignores unusable rotation options instead of throwing', () => {
      const daemonLog = resolve(logDir, 'daemon.log');
      const claim = logger.setup({ logFilePath: daemonLog, rotation: { maxBytes: 0, maxFiles: 0 } });
      logLines(10, 'line');
      logger.release(claim);
      expect(readdirSync(logDir)).toEqual(['daemon.log']);
    });
  });
});
