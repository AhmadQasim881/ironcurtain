/**
 * Tests for `openDirectoryBelow` (src/hardened-fs.ts): listing a directory an
 * agent can rearrange, without being redirected outside a trusted root.
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDirectoryBelow, type DirectoryBelow } from '../src/hardened-fs.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';
import { startSymlinkRacer, type SymlinkRacer } from './helpers/symlink-racer.js';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-dir-below-')));
  root = join(base, 'root');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'inside.md'), 'inside\n');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function names(dir: DirectoryBelow): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of dir.entries) result.push(entry.name);
  return result.sort();
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error && 'code' in err ? String(err.code) : 'THROWN';
  }
  return undefined;
}

describe('openDirectoryBelow', () => {
  it('lists a directory below the root and reports its canonical path', async () => {
    symlinkSync('inside.md', join(root, 'sub', 'link.md'));
    const dir = await openDirectoryBelow(root, join(root, 'sub'));
    try {
      expect(dir.path).toBe(join(root, 'sub'));
      expect(await names(dir)).toEqual(['inside.md', 'link.md']);
      expect((await dir.lstatEntry('inside.md'))?.size).toBe(7);
      // Entries are never followed.
      expect((await dir.lstatEntry('link.md'))?.isSymbolicLink()).toBe(true);
      expect(await dir.lstatEntry('missing.md')).toBeUndefined();
      for (const bad of ['', '.', '..', '../sub/inside.md', 'a\0b']) {
        expect(await dir.lstatEntry(bad)).toBeUndefined();
      }
    } finally {
      await dir.close();
      await dir.close(); // idempotent
    }
    expect(await dir.lstatEntry('inside.md')).toBeUndefined();
  });

  it('reports the opened directory identity and names entries for a no-follow open', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'sub', 'link.md'));
    const dir = await openDirectoryBelow(root, join(root, 'sub'));
    try {
      const opened = await dir.stat();
      expect([opened.dev, opened.ino]).toEqual([lstatSync(join(root, 'sub')).dev, lstatSync(join(root, 'sub')).ino]);
      const entry = dir.entryPath('inside.md');
      expect(entry).toBeDefined();
      expect(lstatSync(entry ?? '').ino).toBe(lstatSync(join(root, 'sub', 'inside.md')).ino);
      // The final component is the caller's to open without following.
      expect(lstatSync(dir.entryPath('link.md') ?? '').isSymbolicLink()).toBe(true);
      for (const bad of ['', '.', '..', '../sub/inside.md', 'a\0b']) {
        expect(dir.entryPath(bad)).toBeUndefined();
      }
    } finally {
      await dir.close();
    }
    expect(dir.entryPath('inside.md')).toBeUndefined();
  });

  it('accepts the root itself only with allowRoot', async () => {
    expect(await errorCode(openDirectoryBelow(root, root))).toBe('OUTSIDE_ROOT');
    const dir = await openDirectoryBelow(root, root, { allowRoot: true });
    try {
      expect(dir.path).toBe(root);
      expect(await names(dir)).toEqual(['sub']);
    } finally {
      await dir.close();
    }
  });

  it('follows a symlink that stays below the root and refuses one that leaves it', async () => {
    symlinkSync('sub', join(root, 'alias'));
    symlinkSync(outside, join(root, 'escape'));
    const dir = await openDirectoryBelow(root, join(root, 'alias'));
    try {
      expect(dir.path).toBe(join(root, 'sub'));
    } finally {
      await dir.close();
    }
    expect(await errorCode(openDirectoryBelow(root, join(root, 'escape')))).toBe('OUTSIDE_ROOT');
    // A directory below an escaping component is outside too.
    mkdirSync(join(outside, 'deeper'));
    expect(await errorCode(openDirectoryBelow(root, join(root, 'escape', 'deeper')))).toBe('OUTSIDE_ROOT');
  });

  it('reports a missing path, a file and a relative path by code', async () => {
    expect(await errorCode(openDirectoryBelow(root, join(root, 'gone')))).toBe('NOT_FOUND');
    expect(await errorCode(openDirectoryBelow(root, join(root, 'sub', 'inside.md')))).toBe('NOT_DIRECTORY');
    expect(await errorCode(openDirectoryBelow(root, 'sub'))).toBe('INVALID_PATH');
  });

  it.skipIf(!fifoSupported)('refuses a FIFO without blocking on it', async () => {
    const fifo = join(root, 'pipe');
    makeFifo(fifo);
    const unblocker = startFifoUnblocker(fifo);
    const started = Date.now();
    try {
      expect(await errorCode(openDirectoryBelow(root, fifo))).toBe('NOT_DIRECTORY');
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  describe.skipIf(process.platform !== 'linux')('on Linux (through the open descriptor)', () => {
    let racer: SymlinkRacer | undefined;

    afterEach(() => {
      racer?.stop();
      racer = undefined;
    });

    it('keeps listing and sizing the opened directory after its path is swapped for a symlink', async () => {
      const dir = await openDirectoryBelow(root, join(root, 'sub'));
      try {
        // The agent moves the directory away and points the name outside the root.
        renameSync(join(root, 'sub'), join(root, 'moved'));
        symlinkSync(outside, join(root, 'sub'));

        expect(await names(dir)).toEqual(['inside.md']);
        expect((await dir.lstatEntry('inside.md'))?.size).toBe(7);
        // A path-based lookup would now find the outside file.
        expect(await dir.lstatEntry('secret.txt')).toBeUndefined();
      } finally {
        await dir.close();
      }
    });

    it('is never redirected outside the root by a symlink retargeted while it opens', async () => {
      mkdirSync(join(root, 'real'));
      writeFileSync(join(root, 'real', 'inside.md'), 'inside\n');
      symlinkSync('real', join(root, 'flip'));
      racer = await startSymlinkRacer(join(root, 'flip'), 'real', outside);

      let opened = 0;
      for (let i = 0; i < 1_500; i++) {
        let dir: DirectoryBelow;
        try {
          dir = await openDirectoryBelow(root, join(root, 'flip'));
        } catch (err) {
          // Refused when it landed outside: the expected outcome half the time.
          expect((err as { code?: string }).code).toBe('OUTSIDE_ROOT');
          continue;
        }
        try {
          opened++;
          expect(dir.path).toBe(join(root, 'real'));
          expect(await names(dir)).toEqual(['inside.md']);
          expect(await dir.lstatEntry('secret.txt')).toBeUndefined();
        } finally {
          await dir.close();
        }
      }
      expect(opened).toBeGreaterThan(0);
    }, 60_000);
  });
});
