import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendRegularFileNoFollow,
  readIdentifiedUntrustedRegularFile,
  readRegularFileFollowingLinks,
  readUntrustedRegularFile,
  UntrustedFileError,
  writeFileNoFollowAtomic,
  type UntrustedFileErrorCode,
} from '../src/hardened-fs.js';

const posix = process.platform !== 'win32';
const hasDevZero = posix && existsSync('/dev/zero');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ironcurtain-untrusted-fs-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

function makeFifo(path: string): void {
  execFileSync('mkfifo', [path]);
}

type ChildOperation =
  | { readonly op: 'read'; readonly path: string; readonly maxBytes: number }
  | { readonly op: 'readFollowing'; readonly path: string; readonly maxBytes: number }
  | { readonly op: 'write'; readonly dir: string; readonly name: string; readonly data: string }
  | { readonly op: 'append'; readonly path: string; readonly data: string; readonly create?: boolean };

/**
 * Run operations in a separate Node process with a hard timeout. A regression
 * that opens a FIFO or device without O_NONBLOCK blocks the whole event loop,
 * which an in-process test could never time out; here the child is killed and
 * the test fails instead of hanging the worker.
 */
function runInChild(operations: readonly ChildOperation[]): Array<{ ok: boolean; code?: string; length?: number }> {
  const moduleUrl = pathToFileURL(resolve('src/hardened-fs.ts')).href;
  const program = [
    `import { readUntrustedRegularFile, readRegularFileFollowingLinks, writeFileNoFollowAtomic, appendRegularFileNoFollow } from ${JSON.stringify(moduleUrl)};`,
    'const results = [];',
    'for (const operation of JSON.parse(process.argv[1])) {',
    '  try {',
    "    if (operation.op === 'read') {",
    '      const { bytes } = readUntrustedRegularFile(operation.path, { maxBytes: operation.maxBytes });',
    '      results.push({ ok: true, length: bytes.length });',
    "    } else if (operation.op === 'readFollowing') {",
    '      const { bytes } = readRegularFileFollowingLinks(operation.path, { maxBytes: operation.maxBytes });',
    '      results.push({ ok: true, length: bytes.length });',
    "    } else if (operation.op === 'write') {",
    '      writeFileNoFollowAtomic(operation.dir, operation.name, operation.data);',
    '      results.push({ ok: true });',
    '    } else {',
    '      appendRegularFileNoFollow(operation.path, operation.data, { maxBytes: 1024, create: operation.create });',
    '      results.push({ ok: true });',
    '    }',
    '  } catch (error) {',
    '    results.push({ ok: false, code: error.code ?? String(error) });',
    '  }',
    '}',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n');
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', program, JSON.stringify(operations)],
    { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' },
  );
  expect(child.error, 'child process must finish before the hard timeout').toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as Array<{ ok: boolean; code?: string; length?: number }>;
}

describe('readUntrustedRegularFile', () => {
  it('reads a regular file up to and including maxBytes', () => {
    const path = join(root, 'file.txt');
    writeFileSync(path, 'hello');
    expect(readUntrustedRegularFile(path, { maxBytes: 5 })).toEqual({ bytes: Buffer.from('hello'), truncated: false });
    writeFileSync(join(root, 'empty'), '');
    expect(readUntrustedRegularFile(join(root, 'empty'), { maxBytes: 0 }).bytes.length).toBe(0);
  });

  it('enforces the size cap, or truncates explicitly when asked', () => {
    const path = join(root, 'big.bin');
    writeFileSync(path, Buffer.alloc(200_000, 0x61));
    expect(codeOf(() => readUntrustedRegularFile(path, { maxBytes: 199_999 }))).toBe('TOO_LARGE');
    const truncated = readUntrustedRegularFile(path, { maxBytes: 70_000, oversize: 'truncate' });
    expect(truncated.truncated).toBe(true);
    expect(truncated.bytes.length).toBe(70_000);
    expect(readUntrustedRegularFile(path, { maxBytes: 200_000 }).bytes.length).toBe(200_000);
  });

  it('refuses absolute, relative and dangling symlinks without following them', () => {
    const target = join(root, 'secret');
    writeFileSync(target, 'secret');
    symlinkSync(target, join(root, 'absolute'));
    symlinkSync('secret', join(root, 'relative'));
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));
    for (const name of ['absolute', 'relative', 'dangling']) {
      expect(codeOf(() => readUntrustedRegularFile(join(root, name), { maxBytes: 100 }))).toBe('SYMLINK');
    }
  });

  it('reports the identity of the file it read, so a caller can detect a swapped parent', () => {
    mkdirSync(join(root, 'inside'));
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'inside', 'config'), 'inside');
    writeFileSync(join(root, 'elsewhere', 'config'), 'elsewhere');
    const path = join(root, 'inside', 'config');

    const first = readIdentifiedUntrustedRegularFile(path, { maxBytes: 100 });
    expect(first.bytes.toString()).toBe('inside');
    expect(first.truncated).toBe(false);
    expect(first.identity).toEqual({ dev: lstatSync(path).dev, ino: lstatSync(path).ino });

    // A parent directory swapped for a symlink redirects the read (O_NOFOLLOW
    // guards only the last component); the identity no longer matches the
    // file at the vetted path once the swap is undone.
    renameSync(join(root, 'inside'), join(root, 'inside.real'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'inside'));
    const redirected = readIdentifiedUntrustedRegularFile(path, { maxBytes: 100 });
    rmSync(join(root, 'inside'));
    renameSync(join(root, 'inside.real'), join(root, 'inside'));
    expect(redirected.bytes.toString()).toBe('elsewhere');
    expect(redirected.identity.ino).not.toBe(lstatSync(path).ino);

    expect(codeOf(() => readIdentifiedUntrustedRegularFile('relative', { maxBytes: 1 }))).toBe('INVALID_PATH');
  });

  it('refuses directories, missing paths and relative paths', () => {
    mkdirSync(join(root, 'dir'));
    expect(codeOf(() => readUntrustedRegularFile(join(root, 'dir'), { maxBytes: 100 }))).toBe('NOT_REGULAR_FILE');
    expect(codeOf(() => readUntrustedRegularFile(join(root, 'nope'), { maxBytes: 100 }))).toBe('NOT_FOUND');
    writeFileSync(join(root, 'plain'), 'x');
    expect(codeOf(() => readUntrustedRegularFile(join(root, 'plain', 'below'), { maxBytes: 100 }))).toBe('NOT_FOUND');
    expect(codeOf(() => readUntrustedRegularFile('relative/path', { maxBytes: 100 }))).toBe('INVALID_PATH');
    expect(() => readUntrustedRegularFile(join(root, 'plain'), { maxBytes: -1 })).toThrow(RangeError);
  });

  it.skipIf(process.platform !== 'linux')(
    'reports a read failure on a regular file as IO_ERROR, not a raw errno',
    () => {
      // /proc/self/mem is a regular file whose read at offset 0 fails with EIO.
      let caught: unknown;
      try {
        readUntrustedRegularFile('/proc/self/mem', { maxBytes: 16 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UntrustedFileError);
      expect(caught).toMatchObject({ code: 'IO_ERROR', cause: expect.objectContaining({ code: 'EIO' }) });
    },
  );

  it.skipIf(!hasDevZero)('rejects a FIFO, a character device and a symlink to /dev/zero without blocking', () => {
    const fifo = join(root, 'fifo');
    makeFifo(fifo);
    const deviceLink = join(root, 'zero');
    symlinkSync('/dev/zero', deviceLink);
    const results = runInChild([
      { op: 'read', path: fifo, maxBytes: 1024 },
      { op: 'read', path: '/dev/zero', maxBytes: 1024 },
      { op: 'read', path: deviceLink, maxBytes: 1024 },
    ]);
    expect(results).toEqual([
      { ok: false, code: 'NOT_REGULAR_FILE' },
      { ok: false, code: 'NOT_REGULAR_FILE' },
      { ok: false, code: 'SYMLINK' },
    ]);
  });
});

describe('readRegularFileFollowingLinks', () => {
  it('reads a regular file, through absolute and relative symlinks, up to maxBytes', () => {
    const target = join(root, 'manifest.yaml');
    writeFileSync(target, 'name: x\n');
    symlinkSync(target, join(root, 'absolute.yaml'));
    symlinkSync('manifest.yaml', join(root, 'relative.yaml'));
    for (const name of ['manifest.yaml', 'absolute.yaml', 'relative.yaml']) {
      expect(readRegularFileFollowingLinks(join(root, name), { maxBytes: 8 })).toEqual({
        bytes: Buffer.from('name: x\n'),
        truncated: false,
      });
    }
  });

  it('enforces the size cap, or truncates explicitly when asked', () => {
    const path = join(root, 'big.yaml');
    writeFileSync(path, Buffer.alloc(100_000, 0x61));
    expect(codeOf(() => readRegularFileFollowingLinks(path, { maxBytes: 99_999 }))).toBe('TOO_LARGE');
    const truncated = readRegularFileFollowingLinks(path, { maxBytes: 70_000, oversize: 'truncate' });
    expect(truncated).toMatchObject({ truncated: true });
    expect(truncated.bytes.length).toBe(70_000);
  });

  it('refuses directories, missing and dangling paths, symlink loops and relative paths', () => {
    mkdirSync(join(root, 'dir'));
    symlinkSync(join(root, 'dir'), join(root, 'dir-link'));
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));
    symlinkSync('loop-b', join(root, 'loop-a'));
    symlinkSync('loop-a', join(root, 'loop-b'));
    const read = (path: string) => () => readRegularFileFollowingLinks(path, { maxBytes: 100 });
    expect(codeOf(read(join(root, 'dir')))).toBe('NOT_REGULAR_FILE');
    expect(codeOf(read(join(root, 'dir-link')))).toBe('NOT_REGULAR_FILE');
    expect(codeOf(read(join(root, 'missing')))).toBe('NOT_FOUND');
    expect(codeOf(read(join(root, 'dangling')))).toBe('NOT_FOUND');
    // A symlink loop is an I/O failure here, not the refused-final-link code.
    expect(codeOf(read(join(root, 'loop-a')))).toBe('IO_ERROR');
    expect(codeOf(read('relative/manifest.yaml'))).toBe('INVALID_PATH');
    expect(() => readRegularFileFollowingLinks(join(root, 'dir'), { maxBytes: -1 })).toThrow(RangeError);
  });

  it.skipIf(!hasDevZero)('rejects a FIFO, a character device and links to them without blocking', () => {
    const fifo = join(root, 'fifo');
    makeFifo(fifo);
    symlinkSync(fifo, join(root, 'fifo-link'));
    symlinkSync('/dev/zero', join(root, 'zero'));
    const results = runInChild([
      { op: 'readFollowing', path: fifo, maxBytes: 1024 },
      { op: 'readFollowing', path: join(root, 'fifo-link'), maxBytes: 1024 },
      { op: 'readFollowing', path: '/dev/zero', maxBytes: 1024 },
      { op: 'readFollowing', path: join(root, 'zero'), maxBytes: 1024 },
    ]);
    expect(results).toEqual([
      { ok: false, code: 'NOT_REGULAR_FILE' },
      { ok: false, code: 'NOT_REGULAR_FILE' },
      { ok: false, code: 'NOT_REGULAR_FILE' },
      { ok: false, code: 'NOT_REGULAR_FILE' },
    ]);
  });
});

describe('writeFileNoFollowAtomic', () => {
  function temporaries(dir: string): string[] {
    return readdirSync(dir).filter((name) => name.startsWith('.ironcurtain-tmp-'));
  }

  it('creates the file with exactly the requested mode and no leftovers', () => {
    writeFileNoFollowAtomic(root, 'CLAUDE.md', '# rules\n', 0o640);
    const path = join(root, 'CLAUDE.md');
    expect(readFileSync(path, 'utf8')).toBe('# rules\n');
    expect(statSync(path).mode & 0o777).toBe(0o640);
    writeFileNoFollowAtomic(root, 'bytes.bin', Uint8Array.from([1, 2, 3]));
    expect(statSync(join(root, 'bytes.bin')).mode & 0o777).toBe(0o600);
    expect(temporaries(root)).toEqual([]);
  });

  it('replaces absolute, relative and dangling symlinks and leaves their targets untouched', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const victim = join(outside, 'authorized_keys');
    writeFileSync(victim, 'original');
    const state = join(root, 'state');
    mkdirSync(state);
    symlinkSync(victim, join(state, 'absolute'));
    symlinkSync('../outside/authorized_keys', join(state, 'relative'));
    symlinkSync(join(outside, 'created-by-attacker'), join(state, 'dangling'));

    for (const name of ['absolute', 'relative', 'dangling']) {
      writeFileNoFollowAtomic(state, name, `written:${name}`);
      const entry = lstatSync(join(state, name));
      expect(entry.isSymbolicLink()).toBe(false);
      expect(entry.isFile()).toBe(true);
      expect(readFileSync(join(state, name), 'utf8')).toBe(`written:${name}`);
    }
    expect(readFileSync(victim, 'utf8')).toBe('original');
    expect(existsSync(join(outside, 'created-by-attacker'))).toBe(false);
    expect(temporaries(state)).toEqual([]);
  });

  it('replaces a hard link instead of writing through it', () => {
    const victim = join(root, 'victim');
    writeFileSync(victim, 'original');
    linkSync(victim, join(root, 'linked'));
    writeFileNoFollowAtomic(root, 'linked', 'new');
    expect(readFileSync(victim, 'utf8')).toBe('original');
    expect(readFileSync(join(root, 'linked'), 'utf8')).toBe('new');
  });

  it('fails on a directory at the name and leaves it and the directory clean', () => {
    mkdirSync(join(root, 'CLAUDE.md'));
    writeFileSync(join(root, 'CLAUDE.md', 'inner'), 'keep');
    expect(codeOf(() => writeFileNoFollowAtomic(root, 'CLAUDE.md', 'x'))).toBe('NOT_REGULAR_FILE');
    expect(readFileSync(join(root, 'CLAUDE.md', 'inner'), 'utf8')).toBe('keep');
    expect(temporaries(root)).toEqual([]);
  });

  it('refuses a symlinked or missing directory and names that are not one plain component', () => {
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(codeOf(() => writeFileNoFollowAtomic(join(root, 'link'), 'f', 'x'))).toBe('NOT_DIRECTORY');
    expect(codeOf(() => writeFileNoFollowAtomic(join(root, 'absent'), 'f', 'x'))).toBe('NOT_DIRECTORY');
    expect(readdirSync(join(root, 'real'))).toEqual([]);
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(256)]) {
      expect(codeOf(() => writeFileNoFollowAtomic(root, name, 'x'))).toBe('INVALID_PATH');
    }
    expect(codeOf(() => writeFileNoFollowAtomic('relative', 'f', 'x'))).toBe('INVALID_PATH');
    expect(() => writeFileNoFollowAtomic(root, 'f', 'x', 0o4755)).toThrow(RangeError);
  });

  it.skipIf(!posix)('replaces a FIFO at the name without blocking', () => {
    const state = join(root, 'state');
    mkdirSync(state);
    makeFifo(join(state, 'CLAUDE.md'));
    const results = runInChild([{ op: 'write', dir: state, name: 'CLAUDE.md', data: 'safe' }]);
    expect(results).toEqual([{ ok: true }]);
    expect(lstatSync(join(state, 'CLAUDE.md')).isFile()).toBe(true);
    expect(readFileSync(join(state, 'CLAUDE.md'), 'utf8')).toBe('safe');
  });
});

describe('appendRegularFileNoFollow', () => {
  it('appends to a regular file within the cap', () => {
    const path = join(root, '.gitignore');
    writeFileSync(path, 'node_modules/\n');
    appendRegularFileNoFollow(path, '.workflow/\n', { maxBytes: 1024 });
    expect(readFileSync(path, 'utf8')).toBe('node_modules/\n.workflow/\n');
  });

  it('refuses to grow a file past the cap and leaves it unchanged', () => {
    const path = join(root, 'capped');
    writeFileSync(path, '0123456789');
    expect(codeOf(() => appendRegularFileNoFollow(path, 'abc', { maxBytes: 12 }))).toBe('TOO_LARGE');
    expect(readFileSync(path, 'utf8')).toBe('0123456789');
    appendRegularFileNoFollow(path, 'ab', { maxBytes: 12 });
    expect(readFileSync(path, 'utf8')).toBe('0123456789ab');
  });

  it('refuses symlinks, including dangling ones in create mode, and leaves targets untouched', () => {
    const victim = join(root, 'bashrc');
    writeFileSync(victim, 'original');
    symlinkSync(victim, join(root, 'absolute'));
    symlinkSync('bashrc', join(root, 'relative'));
    symlinkSync(join(root, 'not-yet'), join(root, 'dangling'));
    for (const name of ['absolute', 'relative']) {
      expect(codeOf(() => appendRegularFileNoFollow(join(root, name), 'x', { maxBytes: 1024 }))).toBe('SYMLINK');
    }
    expect(codeOf(() => appendRegularFileNoFollow(join(root, 'dangling'), 'x', { maxBytes: 1024, create: true }))).toBe(
      'SYMLINK',
    );
    expect(readFileSync(victim, 'utf8')).toBe('original');
    expect(existsSync(join(root, 'not-yet'))).toBe(false);
  });

  it('refuses a hard-linked file, which would also change the other name', () => {
    const victim = join(root, 'victim');
    writeFileSync(victim, 'original');
    linkSync(victim, join(root, 'gitignore'));
    expect(codeOf(() => appendRegularFileNoFollow(join(root, 'gitignore'), 'x', { maxBytes: 1024 }))).toBe(
      'HARD_LINKED',
    );
    expect(readFileSync(victim, 'utf8')).toBe('original');
  });

  it('refuses a missing file unless create is set, and then creates it exclusively with the mode', () => {
    const path = join(root, 'new-file');
    expect(codeOf(() => appendRegularFileNoFollow(path, 'x', { maxBytes: 1024 }))).toBe('NOT_FOUND');
    // An oversized payload is refused before anything is created.
    expect(codeOf(() => appendRegularFileNoFollow(path, 'too long', { maxBytes: 4, create: true }))).toBe('TOO_LARGE');
    expect(existsSync(path)).toBe(false);
    appendRegularFileNoFollow(path, 'first\n', { maxBytes: 1024, create: true, mode: 0o640 });
    expect(readFileSync(path, 'utf8')).toBe('first\n');
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('refuses directories and relative paths', () => {
    mkdirSync(join(root, 'dir'));
    expect(codeOf(() => appendRegularFileNoFollow(join(root, 'dir'), 'x', { maxBytes: 1024 }))).toBe(
      'NOT_REGULAR_FILE',
    );
    expect(codeOf(() => appendRegularFileNoFollow('relative', 'x', { maxBytes: 1024 }))).toBe('INVALID_PATH');
  });

  it.skipIf(!hasDevZero)('refuses a FIFO and a symlink to a device without blocking', () => {
    makeFifo(join(root, 'fifo'));
    symlinkSync('/dev/null', join(root, 'devnull'));
    const results = runInChild([
      { op: 'append', path: join(root, 'fifo'), data: 'x' },
      { op: 'append', path: join(root, 'devnull'), data: 'x', create: true },
    ]);
    expect(results).toEqual([
      { ok: false, code: 'NOT_REGULAR_FILE' },
      { ok: false, code: 'SYMLINK' },
    ]);
  });
});
