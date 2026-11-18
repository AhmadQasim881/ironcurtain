import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pass-through mock with one seam: a hook that runs just before `openSync`, so a
// test can swap a directory for a symlink between the containment check and the
// open (the race the descriptor re-check exists for).
const fsHooks = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const openSync = (path: unknown, ...rest: unknown[]): number => {
    fsHooks.beforeOpen?.(String(path));
    return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
  };
  return { ...actual, openSync };
});

import {
  copyRegularFileBelow,
  displaceEntryNoFollow,
  ensureDirectoryBelow,
  ensureRealDirectoryNoFollow,
  hashUntrustedRegularFileBelow,
  readUntrustedRegularFileBelow,
  UntrustedFileError,
  type UntrustedFileErrorCode,
} from '../src/hardened-fs.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ironcurtain-below-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => {
  fsHooks.beforeOpen = undefined;
  rmSync(base, { recursive: true, force: true });
});

function codeOf(action: () => unknown): UntrustedFileErrorCode | 'no error' {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(UntrustedFileError);
    return (error as UntrustedFileError).code;
  }
  return 'no error';
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('readUntrustedRegularFileBelow', () => {
  it('can pin a canonical root while retaining the default host-alias behavior', () => {
    writeFileSync(join(root, 'ordinary.txt'), 'fixture');
    const alias = join(outside, 'root-alias');
    symlinkSync(realpathSync(root), alias);
    expect(readUntrustedRegularFileBelow(alias, 'ordinary.txt', { maxBytes: 7 }).bytes.toString()).toBe('fixture');
    expect(
      codeOf(() => readUntrustedRegularFileBelow(alias, 'ordinary.txt', { maxBytes: 7, canonicalRoot: true })),
    ).toBe('OUTSIDE_ROOT');
    expect(
      readUntrustedRegularFileBelow(realpathSync(root), 'ordinary.txt', {
        maxBytes: 7,
        canonicalRoot: true,
      }).bytes.toString(),
    ).toBe('fixture');
  });

  it('reads a regular file below the root', () => {
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'f.json'), '{"ok":true}');
    expect(readUntrustedRegularFileBelow(root, 'a/b/f.json', { maxBytes: 64 }).bytes.toString()).toBe('{"ok":true}');
  });

  it('reports a missing file or parent as NOT_FOUND', () => {
    expect(codeOf(() => readUntrustedRegularFileBelow(root, 'nope.json', { maxBytes: 64 }))).toBe('NOT_FOUND');
    expect(codeOf(() => readUntrustedRegularFileBelow(root, 'no/such/dir.json', { maxBytes: 64 }))).toBe('NOT_FOUND');
  });

  it('rejects anything but plain relative components', () => {
    for (const bad of ['', '/etc/passwd', '../x', 'a/../x', './x', 'a//x', 'a/', 'a\\b']) {
      expect(
        codeOf(() => readUntrustedRegularFileBelow(root, bad, { maxBytes: 64 })),
        bad,
      ).toBe('INVALID_PATH');
    }
  });

  it('refuses a directory component symlinked out of the root without reading the target', () => {
    writeFileSync(join(outside, 'result.json'), '{"verdict":"leak"}');
    symlinkSync(outside, join(root, 'sub'));
    expect(codeOf(() => readUntrustedRegularFileBelow(root, 'sub/result.json', { maxBytes: 64 }))).toBe('OUTSIDE_ROOT');
  });

  it('allows a directory component symlinked to another directory inside the root', () => {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'f.txt'), 'inside');
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    expect(readUntrustedRegularFileBelow(root, 'alias/f.txt', { maxBytes: 64 }).bytes.toString()).toBe('inside');
  });

  it('refuses a final-component symlink, even one pointing inside the root or at /dev/zero', () => {
    writeFileSync(join(root, 'real.txt'), 'inside');
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    symlinkSync('/dev/zero', join(root, 'zero'));
    expect(codeOf(() => readUntrustedRegularFileBelow(root, 'link.txt', { maxBytes: 64 }))).toBe('SYMLINK');
    expect(codeOf(() => readUntrustedRegularFileBelow(root, 'zero', { maxBytes: 64 }))).toBe('SYMLINK');
  });

  it('enforces the size cap', () => {
    writeFileSync(join(root, 'big'), Buffer.alloc(1025, 0x61));
    expect(codeOf(() => readUntrustedRegularFileBelow(root, 'big', { maxBytes: 1024 }))).toBe('TOO_LARGE');
  });

  it('works when the root itself is reached through a host symlink', () => {
    writeFileSync(join(root, 'f.txt'), 'via link');
    symlinkSync(root, join(base, 'root-link'));
    expect(readUntrustedRegularFileBelow(join(base, 'root-link'), 'f.txt', { maxBytes: 64 }).bytes.toString()).toBe(
      'via link',
    );
  });

  it('detects a parent directory swapped for an outside symlink between the check and the open', () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'result.json'), '{"verdict":"inside"}');
    writeFileSync(join(outside, 'result.json'), '{"verdict":"leak"}');
    const opened = join(realpathSync(root), 'sub', 'result.json');
    fsHooks.beforeOpen = (path) => {
      if (path !== opened) return;
      fsHooks.beforeOpen = undefined;
      renameSync(join(root, 'sub'), join(root, 'sub-old'));
      symlinkSync(outside, join(root, 'sub'));
    };

    expect(codeOf(() => readUntrustedRegularFileBelow(root, 'sub/result.json', { maxBytes: 64 }))).toBe('OUTSIDE_ROOT');
    expect(fsHooks.beforeOpen).toBeUndefined(); // the swap really happened
  });

  it.skipIf(!fifoSupported)('refuses a FIFO without blocking', () => {
    const fifo = join(root, 'pipe');
    makeFifo(fifo);
    const unblocker = startFifoUnblocker(fifo);
    const started = Date.now();
    try {
      expect(codeOf(() => readUntrustedRegularFileBelow(root, 'pipe', { maxBytes: 64 }))).toBe('NOT_REGULAR_FILE');
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('hashUntrustedRegularFileBelow', () => {
  it('streams a multi-chunk file into the same digest as hashing it whole', () => {
    const data = Buffer.alloc(300_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    mkdirSync(join(root, 'steps', 'step_0001_lane_0'), { recursive: true });
    writeFileSync(join(root, 'steps', 'step_0001_lane_0', 'code'), data);
    expect(hashUntrustedRegularFileBelow(root, 'steps/step_0001_lane_0/code', { maxBytes: data.length })).toBe(
      sha256(data),
    );
  });

  it('hashes an empty file and honours the algorithm option', () => {
    writeFileSync(join(root, 'empty'), '');
    expect(hashUntrustedRegularFileBelow(root, 'empty', { maxBytes: 0 })).toBe(sha256(''));
    writeFileSync(join(root, 'x'), 'abc');
    expect(hashUntrustedRegularFileBelow(root, 'x', { maxBytes: 3, algorithm: 'sha1' })).toBe(
      createHash('sha1').update('abc').digest('hex'),
    );
  });

  it('enforces the cap on the bytes read', () => {
    writeFileSync(join(root, 'big'), Buffer.alloc(70_000, 1));
    expect(codeOf(() => hashUntrustedRegularFileBelow(root, 'big', { maxBytes: 69_999 }))).toBe('TOO_LARGE');
  });

  it('applies the same containment and file-type rules as the read', () => {
    writeFileSync(join(outside, 'code'), 'outside');
    symlinkSync(outside, join(root, 'out'));
    symlinkSync('/dev/zero', join(root, 'zero'));
    expect(codeOf(() => hashUntrustedRegularFileBelow(root, 'out/code', { maxBytes: 64 }))).toBe('OUTSIDE_ROOT');
    expect(codeOf(() => hashUntrustedRegularFileBelow(root, 'zero', { maxBytes: 64 }))).toBe('SYMLINK');
    expect(codeOf(() => hashUntrustedRegularFileBelow(root, 'missing', { maxBytes: 64 }))).toBe('NOT_FOUND');
  });

  it.skipIf(!fifoSupported)('refuses a FIFO without blocking', () => {
    const fifo = join(root, 'code');
    makeFifo(fifo);
    const unblocker = startFifoUnblocker(fifo);
    const started = Date.now();
    try {
      expect(codeOf(() => hashUntrustedRegularFileBelow(root, 'code', { maxBytes: 64 }))).toBe('NOT_REGULAR_FILE');
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('ensureRealDirectoryNoFollow', () => {
  it('creates a missing directory and keeps an existing one', () => {
    const first = ensureRealDirectoryNoFollow(root, '.workflow');
    expect(first).toEqual({ path: join(root, '.workflow'), created: true });
    expect(lstatSync(first.path).isDirectory()).toBe(true);
    writeFileSync(join(first.path, 'keep'), 'x');

    const second = ensureRealDirectoryNoFollow(root, '.workflow');
    expect(second).toEqual({ path: join(root, '.workflow'), created: false });
    expect(readFileSync(join(second.path, 'keep'), 'utf-8')).toBe('x');
  });

  it('moves a symlinked directory aside without touching its target', () => {
    writeFileSync(join(outside, 'victim'), 'host data');
    symlinkSync(outside, join(root, '.workflow'));

    const result = ensureRealDirectoryNoFollow(root, '.workflow');

    expect(result.created).toBe(true);
    expect(lstatSync(result.path).isDirectory()).toBe(true);
    expect(lstatSync(result.path).isSymbolicLink()).toBe(false);
    expect(result.displacedTo).toMatch(/\.workflow\.ironcurtain-displaced-[0-9a-f]{12}$/);
    expect(readlinkSync(result.displacedTo ?? '')).toBe(outside);
    expect(readFileSync(join(outside, 'victim'), 'utf-8')).toBe('host data');
    expect(existsSync(join(outside, 'task'))).toBe(false);
  });

  it('moves a dangling symlink, a regular file and a FIFO aside', () => {
    symlinkSync(join(base, 'does-not-exist'), join(root, 'dangling'));
    writeFileSync(join(root, 'file'), 'user data');
    for (const name of ['dangling', 'file']) {
      const result = ensureRealDirectoryNoFollow(root, name);
      expect(lstatSync(result.path).isDirectory()).toBe(true);
      expect(result.displacedTo).toBeDefined();
    }
    expect(existsSync(join(base, 'does-not-exist'))).toBe(false);
    if (fifoSupported) {
      makeFifo(join(root, 'pipe'));
      const result = ensureRealDirectoryNoFollow(root, 'pipe');
      expect(lstatSync(result.path).isDirectory()).toBe(true);
      expect(lstatSync(result.displacedTo ?? '').isFIFO()).toBe(true);
    }
  });

  it('refuses a parent that is a symlink, and invalid names', () => {
    symlinkSync(outside, join(root, 'parent-link'));
    expect(codeOf(() => ensureRealDirectoryNoFollow(join(root, 'parent-link'), 'x'))).toBe('NOT_DIRECTORY');
    expect(existsSync(join(outside, 'x'))).toBe(false);
    expect(codeOf(() => ensureRealDirectoryNoFollow(root, '../escape'))).toBe('INVALID_PATH');
  });
});

describe('displaceEntryNoFollow', () => {
  it('returns undefined when nothing is at the name', () => {
    expect(displaceEntryNoFollow(root, 'absent')).toBeUndefined();
  });

  it('moves a directory aside intact', () => {
    mkdirSync(join(root, 'description.md'));
    writeFileSync(join(root, 'description.md', 'inner'), 'x');
    const moved = displaceEntryNoFollow(root, 'description.md');
    expect(moved).toBeDefined();
    expect(existsSync(join(root, 'description.md'))).toBe(false);
    expect(readFileSync(join(moved ?? '', 'inner'), 'utf-8')).toBe('x');
  });
});

describe('copyRegularFileBelow', () => {
  it('copies ordinary files between separate canonical roots with the same byte and mode checks', () => {
    writeFileSync(join(outside, 'example.txt'), 'ordinary fixture');
    const copied = copyRegularFileBelow(realpathSync(root), 'example.txt', 'nested/example.txt', {
      sourceRoot: realpathSync(outside),
      maxBytes: 16,
      mode: 0o755,
      createParents: true,
    });
    expect(copied).toBe(16);
    expect(readFileSync(join(root, 'nested', 'example.txt'), 'utf8')).toBe('ordinary fixture');
    expect(statSync(join(root, 'nested', 'example.txt')).mode & 0o777).toBe(0o755);
    expect(
      codeOf(() =>
        copyRegularFileBelow(realpathSync(root), 'example.txt', 'too-large.txt', {
          sourceRoot: realpathSync(outside),
          maxBytes: 15,
        }),
      ),
    ).toBe('TOO_LARGE');
    expect(existsSync(join(root, 'too-large.txt'))).toBe(false);
  });

  it('copies a regular file into new destination directories with the given mode', () => {
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    writeFileSync(join(root, 'src', 'deep', 'f.txt'), 'payload');

    const copied = copyRegularFileBelow(root, 'src/deep/f.txt', 'dst/a/b/f.txt', {
      maxBytes: 64,
      mode: 0o640,
      createParents: true,
    });

    expect(copied).toBe(7);
    expect(readFileSync(join(root, 'dst', 'a', 'b', 'f.txt'), 'utf-8')).toBe('payload');
    expect(statSync(join(root, 'dst', 'a', 'b', 'f.txt')).mode & 0o777).toBe(0o640);
  });

  it('streams a multi-chunk file and makes a missing directory only with createParents', () => {
    const data = Buffer.alloc(200_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 253;
    writeFileSync(join(root, 'big'), data);
    expect(codeOf(() => copyRegularFileBelow(root, 'big', 'missing/big', { maxBytes: data.length }))).toBe('NOT_FOUND');
    expect(existsSync(join(root, 'missing'))).toBe(false);

    copyRegularFileBelow(root, 'big', 'missing/big', { maxBytes: data.length, createParents: true });
    expect(sha256(readFileSync(join(root, 'missing', 'big')))).toBe(sha256(data));
  });

  it('refuses a destination that already exists instead of writing through it', () => {
    writeFileSync(join(root, 'f.txt'), 'attacker');
    writeFileSync(join(outside, 'victim'), 'host data');
    symlinkSync(join(outside, 'victim'), join(root, 'link'));
    symlinkSync(join(outside, 'created-by-follow'), join(root, 'dangling'));
    writeFileSync(join(root, 'existing'), 'keep');

    for (const destination of ['link', 'dangling', 'existing']) {
      expect(
        codeOf(() => copyRegularFileBelow(root, 'f.txt', destination, { maxBytes: 64 })),
        destination,
      ).toBe('CHANGED');
    }
    expect(readFileSync(join(outside, 'victim'), 'utf-8')).toBe('host data');
    expect(existsSync(join(outside, 'created-by-follow'))).toBe(false);
    expect(readFileSync(join(root, 'existing'), 'utf-8')).toBe('keep');
  });

  it('refuses a destination directory that leads out of the root, with or without createParents', () => {
    writeFileSync(join(root, 'f.txt'), 'attacker');
    symlinkSync(outside, join(root, 'out'));

    expect(codeOf(() => copyRegularFileBelow(root, 'f.txt', 'out/f.txt', { maxBytes: 64 }))).toBe('OUTSIDE_ROOT');
    expect(
      codeOf(() => copyRegularFileBelow(root, 'f.txt', 'out/new/f.txt', { maxBytes: 64, createParents: true })),
    ).toBe('NOT_DIRECTORY');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('detects a destination directory swapped for an outside link between the check and the open', () => {
    writeFileSync(join(root, 'f.txt'), 'attacker');
    mkdirSync(join(root, 'dst'));
    const created = join(realpathSync(root), 'dst', 'f.txt');
    fsHooks.beforeOpen = (path) => {
      if (path !== created) return;
      fsHooks.beforeOpen = undefined;
      renameSync(join(root, 'dst'), join(root, 'dst-old'));
      symlinkSync(outside, join(root, 'dst'));
    };

    expect(codeOf(() => copyRegularFileBelow(root, 'f.txt', 'dst/f.txt', { maxBytes: 64 }))).toBe('OUTSIDE_ROOT');
    expect(fsHooks.beforeOpen).toBeUndefined(); // the swap really happened
    if (process.platform === 'linux') {
      // Located through /proc/self/fd before a byte was written, then removed.
      expect(readdirSync(outside)).toEqual([]);
    } else {
      for (const name of readdirSync(outside)) expect(statSync(join(outside, name)).size).toBe(0);
    }
  });

  it('refuses a source that is a symlink, outside the root or too large, creating nothing', () => {
    writeFileSync(join(outside, 'secret'), 'host secret');
    symlinkSync(join(outside, 'secret'), join(root, 'link'));
    symlinkSync(outside, join(root, 'out'));
    writeFileSync(join(root, 'big'), Buffer.alloc(65, 1));

    expect(codeOf(() => copyRegularFileBelow(root, 'link', 'a', { maxBytes: 64 }))).toBe('SYMLINK');
    expect(codeOf(() => copyRegularFileBelow(root, 'out/secret', 'b', { maxBytes: 64 }))).toBe('OUTSIDE_ROOT');
    expect(codeOf(() => copyRegularFileBelow(root, 'big', 'c', { maxBytes: 64 }))).toBe('TOO_LARGE');
    expect(readdirSync(root).sort()).toEqual(['big', 'link', 'out']);
  });

  it.skipIf(!fifoSupported)('refuses a FIFO source without blocking', () => {
    const fifo = join(root, 'pipe');
    makeFifo(fifo);
    const unblocker = startFifoUnblocker(fifo);
    const started = Date.now();
    try {
      expect(codeOf(() => copyRegularFileBelow(root, 'pipe', 'copy', { maxBytes: 64 }))).toBe('NOT_REGULAR_FILE');
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(existsSync(join(root, 'copy'))).toBe(false);
  });
});

describe('ensureDirectoryBelow', () => {
  it('creates missing components and accepts existing real directories', () => {
    mkdirSync(join(root, 'a'));
    ensureDirectoryBelow(root, 'a/b/c');
    expect(lstatSync(join(root, 'a', 'b', 'c')).isDirectory()).toBe(true);
    ensureDirectoryBelow(root, 'a/b/c');
    expect(lstatSync(join(root, 'a', 'b', 'c')).isDirectory()).toBe(true);
  });

  it('refuses a component that is a symlink or a file, creating nothing behind it', () => {
    symlinkSync(outside, join(root, 'link'));
    writeFileSync(join(root, 'file'), 'x');
    expect(codeOf(() => ensureDirectoryBelow(root, 'link/new'))).toBe('NOT_DIRECTORY');
    expect(codeOf(() => ensureDirectoryBelow(root, 'file/new'))).toBe('NOT_DIRECTORY');
    expect(codeOf(() => ensureDirectoryBelow(root, '../escape'))).toBe('INVALID_PATH');
    expect(readdirSync(outside)).toEqual([]);
  });
});
