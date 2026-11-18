/**
 * The shared primitives behind every config and credential write:
 * writePrivateFileAtomicSync (atomic, owner-only, symlink-preserving) and
 * withFileLockSync (the cross-process read-modify-write lock).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveFinalSymlinks, writePrivateFileAtomicSync } from '../src/util/atomic-write.js';
import { FileLockTimeoutError, fileLockPath, withFileLockSync } from '../src/util/file-lock.js';

/** Runs `fn` with the given process umask (the vitest pool forks, so umask is settable). */
function withUmask<T>(mask: number, fn: () => T): T {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('writePrivateFileAtomicSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'private-write-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file owner-only under a group-writable umask (002)', () => {
    const target = join(dir, 'config.json');
    withUmask(0o002, () => writePrivateFileAtomicSync(target, '{"secret":"value"}\n'));
    expect(readFileSync(target, 'utf8')).toBe('{"secret":"value"}\n');
    expect(modeOf(target)).toBe(0o600);
  });

  it('gives exactly 0600 even under a umask that strips owner bits', () => {
    const target = join(dir, 'token.json');
    withUmask(0o277, () => writePrivateFileAtomicSync(target, 'x'));
    expect(modeOf(target)).toBe(0o600);
  });

  it('replaces a world-readable file with an owner-only one and leaves no temporary file', () => {
    const target = join(dir, 'config.json');
    writeFileSync(target, 'old', { mode: 0o644 });
    withUmask(0o002, () => writePrivateFileAtomicSync(target, 'new'));
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(modeOf(target)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('replaces the target of a symlink and keeps the link (dotfile managers)', () => {
    const dotfiles = join(dir, 'dotfiles');
    const home = join(dir, 'home');
    mkdirSync(dotfiles);
    mkdirSync(home);
    const real = join(dotfiles, 'config.json');
    const link = join(home, 'config.json');
    writeFileSync(real, 'old', { mode: 0o644 });
    symlinkSync(real, link);

    writePrivateFileAtomicSync(link, 'new');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('new');
    expect(modeOf(real)).toBe(0o600);
    expect(readdirSync(dotfiles)).toEqual(['config.json']);
    expect(readdirSync(home)).toEqual(['config.json']);
  });

  it('follows relative and chained links, and creates the target of a dangling link', () => {
    const real = join(dir, 'real.json');
    symlinkSync('real.json', join(dir, 'hop.json'));
    symlinkSync('hop.json', join(dir, 'link.json'));

    // Relative targets resolve from the link's real directory (macOS's tmpdir is itself behind a symlink).
    expect(resolveFinalSymlinks(join(dir, 'link.json'))).toBe(join(realpathSync(dir), 'real.json'));
    writePrivateFileAtomicSync(join(dir, 'link.json'), 'created');

    expect(readFileSync(real, 'utf8')).toBe('created');
    expect(lstatSync(join(dir, 'link.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'hop.json')).isSymbolicLink()).toBe(true);
  });

  it('resolves a relative ".." link from the real directory holding it, as every reader does', () => {
    // Physically: <dir>/mnt/ic/config.json -> ../dotfiles/config.json, i.e. <dir>/mnt/dotfiles/config.json.
    mkdirSync(join(dir, 'mnt', 'ic'), { recursive: true });
    mkdirSync(join(dir, 'mnt', 'dotfiles'));
    const real = join(dir, 'mnt', 'dotfiles', 'config.json');
    writeFileSync(real, 'old', { mode: 0o644 });
    symlinkSync('../dotfiles/config.json', join(dir, 'mnt', 'ic', 'config.json'));
    // The path used to reach it goes through a symlinked directory, and the lexical
    // reading of the link (<dir>/home/dotfiles/config.json) names a different file.
    mkdirSync(join(dir, 'home', 'dotfiles'), { recursive: true });
    const decoy = join(dir, 'home', 'dotfiles', 'config.json');
    writeFileSync(decoy, 'decoy');
    symlinkSync(join(dir, 'mnt', 'ic'), join(dir, 'home', '.ironcurtain'));
    const spelled = join(dir, 'home', '.ironcurtain', 'config.json');

    writePrivateFileAtomicSync(spelled, 'new');

    expect(readFileSync(spelled, 'utf8')).toBe('new');
    expect(readFileSync(real, 'utf8')).toBe('new');
    expect(modeOf(real)).toBe(0o600);
    expect(readFileSync(decoy, 'utf8')).toBe('decoy');
    expect(lstatSync(join(dir, 'mnt', 'ic', 'config.json')).isSymbolicLink()).toBe(true);
  });

  it('writes through a symlinked parent directory', () => {
    const realDir = join(dir, 'real-home');
    mkdirSync(realDir);
    symlinkSync(realDir, join(dir, 'linked-home'));

    writePrivateFileAtomicSync(join(dir, 'linked-home', 'config.json'), 'data');

    expect(readFileSync(join(realDir, 'config.json'), 'utf8')).toBe('data');
    expect(modeOf(join(realDir, 'config.json'))).toBe(0o600);
  });

  it('refuses a symlink loop', () => {
    symlinkSync('b.json', join(dir, 'a.json'));
    symlinkSync('a.json', join(dir, 'b.json'));
    expect(() => writePrivateFileAtomicSync(join(dir, 'a.json'), 'x')).toThrow(/symbolic links/);
  });

  it('fails without creating anything when the directory is missing', () => {
    expect(() => writePrivateFileAtomicSync(join(dir, 'missing', 'config.json'), 'x')).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('withFileLockSync', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'file-lock-'));
    target = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeOwnerRecord(pid: number, processIdentity: string): void {
    writeFileSync(
      fileLockPath(target),
      `${JSON.stringify({
        schemaVersion: 1,
        pid,
        processIdentity,
        token: '00000000-0000-4000-8000-000000000001',
        createdAtMs: Date.now() - 60_000,
      })}\n`,
      { mode: 0o600 },
    );
  }

  it('holds <file>.lock while fn runs and removes it afterwards', () => {
    const result = withFileLockSync(target, () => {
      expect(existsSync(`${target}.lock`)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('releases the lock when fn throws, and rethrows its error', () => {
    expect(() =>
      withFileLockSync(target, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(fileLockPath(target))).toBe(false);
  });

  it('is not reentrant: a nested request fails at once instead of waiting for itself', () => {
    const started = Date.now();
    expect(() => withFileLockSync(target, () => withFileLockSync(target, () => 'inner'))).toThrow(/not reentrant/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(fileLockPath(target))).toBe(false);
  });

  it('reclaims a lock left behind by a process that died', () => {
    writeOwnerRecord(2 ** 30, 'dead-process');
    const identities = (pid: number) => (pid === process.pid ? 'self' : undefined);
    expect(withFileLockSync(target, () => 'ran', { processIdentityForPid: identities })).toBe('ran');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('waits for a live holder, then gives up with FILE_LOCK_TIMEOUT without running fn', () => {
    writeOwnerRecord(4242, 'live-4242');
    const identities = (pid: number) => (pid === process.pid ? 'self' : pid === 4242 ? 'live-4242' : undefined);
    let ran = false;
    let caught: unknown;
    try {
      withFileLockSync(
        target,
        () => {
          ran = true;
        },
        { processIdentityForPid: identities, maxWaitMs: 60, retryIntervalMs: 5 },
      );
    } catch (error) {
      caught = error;
    }
    expect(ran).toBe(false);
    expect(caught).toBeInstanceOf(FileLockTimeoutError);
    expect((caught as FileLockTimeoutError).code).toBe('FILE_LOCK_TIMEOUT');
    expect((caught as FileLockTimeoutError).ownerPid).toBe(4242);
    // The live holder's lock is never stolen.
    expect(JSON.parse(readFileSync(fileLockPath(target), 'utf8'))).toMatchObject({ pid: 4242 });
  });
});
