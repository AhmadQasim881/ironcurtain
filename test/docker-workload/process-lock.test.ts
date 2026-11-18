import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireProcessLock,
  getProcessStartIdentity,
  inspectProcessLock,
  ProcessLockBusyError,
  type ProcessLockOwner,
  type ProcessLockState,
} from '../../src/docker-workload/process-lock.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from '../helpers/fifo.js';

const processLockUrl = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'docker-workload', 'process-lock.ts'),
).href;
const hasDevZero = process.platform !== 'win32' && existsSync('/dev/zero');

const temporaryDirectories: string[] = [];
const SELF_IDENTITY = 'self-process-start-fixture';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function lockDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'docker-workload-process-lock-'));
  temporaryDirectories.push(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function lockPath(): string {
  return join(lockDirectory(), 'owner.lock');
}

function owner(overrides: Partial<ProcessLockOwner> = {}): ProcessLockOwner {
  return {
    schemaVersion: 1,
    pid: process.pid,
    processIdentity: SELF_IDENTITY,
    token: '00000000-0000-4000-8000-000000000001',
    createdAtMs: Date.now(),
    ...overrides,
  };
}

function identityForPid(pid: number): string | undefined {
  return pid === process.pid ? SELF_IDENTITY : undefined;
}

/** Install a distinct inode at `path`, the way a racing publisher would. */
function publishForeignLock(path: string, record: ProcessLockOwner): void {
  const staging = `${path}.foreign`;
  writeFileSync(staging, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(staging, path);
}

function entries(directory: string): string[] {
  return readdirSync(directory).sort();
}

function thrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to throw');
}

describe('Docker-workload process lock', () => {
  it('atomically publishes a complete owner and keeps a live contender out', () => {
    const path = lockPath();
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(held.owner);
    expect(() => acquireProcessLock(path, { processIdentityForPid: identityForPid })).toThrow(ProcessLockBusyError);

    held.release();
    expect(existsSync(path)).toBe(false);
  });

  it('never leaves a partial record or candidate alias beside the published lock', () => {
    const directory = lockDirectory();
    const path = join(directory, 'owner.lock');
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });

    // Publication links a fully written inode into place, so a contender can
    // never observe an empty placeholder, and no candidate alias survives.
    expect(entries(directory)).toEqual(['owner.lock']);
    held.release();
    expect(entries(directory)).toEqual([]);
  });

  it('reports the live owner pid on the busy error', () => {
    const path = lockPath();
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });
    const error = thrown(() => acquireProcessLock(path, { processIdentityForPid: identityForPid }));
    held.release();

    expect(error).toBeInstanceOf(ProcessLockBusyError);
    expect((error as ProcessLockBusyError).ownerPid).toBe(process.pid);
  });

  it('reclaims a lock whose owning PID is gone', () => {
    const path = lockPath();
    writeFileSync(path, `${JSON.stringify(owner({ pid: 4242, processIdentity: 'dead-process-start' }))}\n`, {
      mode: 0o600,
    });

    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });
    expect(held.owner.pid).toBe(process.pid);
    held.release();
  });

  it('reclaims a reused PID only when its process-start identity differs', () => {
    const path = lockPath();
    const reusedPid = 4242;
    const stale = owner({
      pid: reusedPid,
      processIdentity: 'old-process-start',
      token: '00000000-0000-4000-8000-000000000002',
    });
    writeFileSync(path, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    expect(() =>
      acquireProcessLock(path, {
        processIdentityForPid: (pid) => (pid === process.pid ? SELF_IDENTITY : 'old-process-start'),
      }),
    ).toThrow(ProcessLockBusyError);

    const held = acquireProcessLock(path, {
      processIdentityForPid: (pid) => {
        if (pid === process.pid) return SELF_IDENTITY;
        return pid === reusedPid ? 'new-process-start' : undefined;
      },
    });
    expect(held.owner.pid).toBe(process.pid);
    held.release();
  });

  it('stays busy when process-start adjudication throws', () => {
    const path = lockPath();
    writeFileSync(path, `${JSON.stringify(owner({ pid: 4242, processIdentity: 'unknown' }))}\n`, { mode: 0o600 });

    expect(() =>
      acquireProcessLock(path, {
        processIdentityForPid: (pid) => {
          if (pid === process.pid) return SELF_IDENTITY;
          throw new Error('process table unavailable');
        },
      }),
    ).toThrow(ProcessLockBusyError);
    expect(existsSync(path)).toBe(true);
  });

  it('does not reclaim a fresh malformed owner record as though publication completed', () => {
    const path = lockPath();
    writeFileSync(path, '', { mode: 0o600 });

    expect(() =>
      acquireProcessLock(path, {
        processIdentityForPid: identityForPid,
        malformedGraceMs: 5000,
      }),
    ).toThrow(ProcessLockBusyError);
    expect(existsSync(path)).toBe(true);
  });

  it('reclaims a malformed owner record once it is older than the grace window', () => {
    const path = lockPath();
    writeFileSync(path, 'not-json', { mode: 0o600 });

    const held = acquireProcessLock(path, {
      processIdentityForPid: identityForPid,
      malformedGraceMs: 0,
      now: () => Date.now() + 60_000,
    });
    expect(held.owner.pid).toBe(process.pid);
    held.release();
  });

  it('does not delete a lock that a racer published after the stale observation', () => {
    const directory = lockDirectory();
    const path = join(directory, 'owner.lock');
    const racer = owner({ pid: 4243, token: '00000000-0000-4000-8000-000000000004' });
    writeFileSync(path, `${JSON.stringify(owner({ pid: 4242, processIdentity: 'dead-process-start' }))}\n`, {
      mode: 0o600,
    });

    // Adjudication is the last step before reclaim, so swapping the inode there
    // mimics a racer publishing between the observation and the capture.
    let swapped = false;
    const error = thrown(() =>
      acquireProcessLock(path, {
        attempts: 1,
        processIdentityForPid: (pid) => {
          if (pid === process.pid) return SELF_IDENTITY;
          if (!swapped) {
            swapped = true;
            publishForeignLock(path, racer);
          }
          return undefined;
        },
      }),
    );

    expect(error).toBeInstanceOf(ProcessLockBusyError);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(racer);
    expect(entries(directory)).toEqual(['owner.lock']);
  });

  it('refuses to release once the published path is a different inode', () => {
    const path = lockPath();
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });
    const replacement = owner({ token: '00000000-0000-4000-8000-000000000003' });
    publishForeignLock(path, replacement);

    expect(() => held.release()).toThrow(/ownership was lost/u);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(replacement);
  });

  it('refuses to release once the lock has been removed', () => {
    const path = lockPath();
    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });
    rmSync(path);

    expect(() => held.release()).toThrow(/ownership was lost/u);
  });
});

describe('inspectProcessLock', () => {
  it('reports free, held and stale locks the way acquisition would adjudicate them', () => {
    const path = lockPath();
    expect(inspectProcessLock(path, { processIdentityForPid: identityForPid })).toEqual({ kind: 'free' });

    const held = acquireProcessLock(path, { processIdentityForPid: identityForPid });
    expect(inspectProcessLock(path, { processIdentityForPid: identityForPid })).toEqual({
      kind: 'held',
      ownerPid: process.pid,
    });
    held.release();

    writeFileSync(path, `${JSON.stringify(owner({ pid: 4242, processIdentity: 'dead-process-start' }))}\n`, {
      mode: 0o600,
    });
    expect(inspectProcessLock(path, { processIdentityForPid: identityForPid })).toEqual({
      kind: 'stale',
      ownerPid: 4242,
    });
    // Looking never modifies the lock.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: 4242 });
  });

  it('fails closed: an owner it cannot adjudicate and a fresh partial record count as held', () => {
    const path = lockPath();
    writeFileSync(path, `${JSON.stringify(owner({ pid: 4242, processIdentity: 'unknown' }))}\n`, { mode: 0o600 });
    expect(
      inspectProcessLock(path, {
        processIdentityForPid: () => {
          throw new Error('process table unavailable');
        },
      }),
    ).toEqual({ kind: 'held', ownerPid: 4242 });

    writeFileSync(path, '', { mode: 0o600 });
    expect(inspectProcessLock(path, { processIdentityForPid: identityForPid, malformedGraceMs: 5000 })).toEqual({
      kind: 'held',
      ownerPid: undefined,
    });
    expect(
      inspectProcessLock(path, {
        processIdentityForPid: identityForPid,
        malformedGraceMs: 0,
        now: () => Date.now() + 60_000,
      }),
    ).toEqual({ kind: 'stale', ownerPid: undefined });
  });

  it('uses the real process table by default', () => {
    const path = lockPath();
    const held = acquireProcessLock(path);
    try {
      expect(inspectProcessLock(path)).toEqual({ kind: 'held', ownerPid: process.pid });
    } finally {
      held.release();
    }
  });
});

interface ChildLockResult {
  readonly inspected: string;
  readonly acquired: string;
  readonly ms: number;
}

/**
 * Inspects and then tries to acquire each lock path in a separate Node process
 * killed after a hard timeout, so a blocking open fails the test instead of
 * freezing this worker. Put a FIFO first: a regressed (blocking) read then
 * stalls there and never reaches a device it would read without end.
 */
function lockInChild(paths: readonly string[]): ChildLockResult[] {
  const program = [
    `import { acquireProcessLock, inspectProcessLock } from ${JSON.stringify(processLockUrl)};`,
    'const results = [];',
    'for (const path of JSON.parse(process.argv[1])) {',
    '  const started = Date.now();',
    '  const inspected = inspectProcessLock(path).kind;',
    '  let acquired;',
    '  try {',
    '    acquireProcessLock(path).release();',
    "    acquired = 'acquired';",
    '  } catch (error) {',
    '    acquired = error.name;',
    '  }',
    '  results.push({ inspected, acquired, ms: Date.now() - started });',
    '}',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', program, JSON.stringify(paths)],
    { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' },
  );
  expect(child.error, 'the lock must be examined before the hard timeout').toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as ChildLockResult[];
}

// A lock path can sit in a directory IronCurtain did not write (the run lock of
// a run directory being imported, FU-07): what is there is never opened unless
// it is a regular file, and never reclaimed.
describe('special entries at a lock path', () => {
  it.skipIf(!fifoSupported)('never opens a FIFO there: it counts as held and stays in place', () => {
    const path = lockPath();
    makeFifo(path);
    // A regressed (blocking) read is released by the unblocker after 5 s and
    // then fails the elapsed-time bound instead of hanging the worker.
    const unblocker = startFifoUnblocker(path, 5);
    const started = Date.now();
    let inspected: ProcessLockState;
    let acquireError: unknown;
    try {
      inspected = inspectProcessLock(path, { processIdentityForPid: identityForPid, malformedGraceMs: 0 });
      acquireError = thrown(() =>
        acquireProcessLock(path, { processIdentityForPid: identityForPid, malformedGraceMs: 0 }),
      );
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(inspected).toEqual({ kind: 'held', ownerPid: undefined });
    expect(acquireError).toBeInstanceOf(ProcessLockBusyError);
    expect(lstatSync(path).isFIFO()).toBe(true);
  });

  it('never follows a symlink there, even to the well-formed record of a dead owner', () => {
    const directory = lockDirectory();
    const path = join(directory, 'owner.lock');
    const target = join(directory, 'elsewhere.json');
    const record = `${JSON.stringify(owner({ pid: 4242, processIdentity: 'dead-process-start' }))}\n`;
    writeFileSync(target, record, { mode: 0o600 });
    symlinkSync(target, path);

    const options = { processIdentityForPid: identityForPid, malformedGraceMs: 0 };
    expect(inspectProcessLock(path, options)).toEqual({ kind: 'held', ownerPid: undefined });
    expect(() => acquireProcessLock(path, options)).toThrow(ProcessLockBusyError);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(record);
    expect(entries(directory)).toEqual(['elsewhere.json', 'owner.lock']);

    // A directory there was already never reclaimed; it still is not.
    const dirPath = join(lockDirectory(), 'owner.lock');
    mkdirSync(dirPath);
    expect(inspectProcessLock(dirPath, options)).toEqual({ kind: 'held', ownerPid: undefined });
    expect(() => acquireProcessLock(dirPath, options)).toThrow(ProcessLockBusyError);
    expect(lstatSync(dirPath).isDirectory()).toBe(true);
  });

  it.skipIf(!fifoSupported || !hasDevZero)(
    'refuses a FIFO, a link to one and a link to /dev/zero promptly, without reading them',
    () => {
      const directory = lockDirectory();
      const fifo = join(directory, 'fifo.lock');
      makeFifo(fifo);
      symlinkSync(fifo, join(directory, 'fifo-link.lock'));
      symlinkSync('/dev/zero', join(directory, 'zero.lock'));

      const results = lockInChild([fifo, join(directory, 'fifo-link.lock'), join(directory, 'zero.lock')]);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).toMatchObject({ inspected: 'held', acquired: 'ProcessLockBusyError' });
        expect(result.ms).toBeLessThan(2_000);
      }
      expect(lstatSync(fifo).isFIFO()).toBe(true);
      expect(lstatSync(join(directory, 'zero.lock')).isSymbolicLink()).toBe(true);
    },
    40_000,
  );
});

describe('process-start identity', () => {
  // The non-Linux branch reads `ps -o lstart`, which procps also prints, so it
  // runs wherever /bin/ps exists. Docker-workload leases persist this identity
  // for hours, across host sleep and travel between time zones.
  it.skipIf(!existsSync('/bin/ps'))('reads the ps start time independently of the observer time zone', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      vi.stubEnv('TZ', 'AAA+5');
      const beforeTravel = getProcessStartIdentity(process.pid);
      vi.stubEnv('TZ', 'BBB-9');
      const afterTravel = getProcessStartIdentity(process.pid);

      expect(beforeTravel).toMatch(/\d{2}:\d{2}:\d{2} \d{4}$/u);
      expect(afterTravel).toBe(beforeTravel);
    } finally {
      vi.unstubAllEnvs();
      if (platform !== undefined) Object.defineProperty(process, 'platform', platform);
    }
  });
});
