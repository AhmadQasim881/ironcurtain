import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  describeHostCommandFailure,
  hostCommandSucceeded,
  runHostCommand,
  type HostCommandResult,
} from '../../src/workflow/host-command-runner.js';
import { killPids, waitForTreePids, waitUntilDead, writeTreeScript } from './host-process-helpers.js';

const NODE = process.execPath;
const POSIX = process.platform !== 'win32';

describe('runHostCommand', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-command-runner-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs argv in the given working directory and captures stdout', async () => {
    const result = await runHostCommand([NODE, '-e', 'process.stdout.write(process.cwd())'], {
      cwd: dir,
      timeoutMs: 20_000,
    });

    expect(hostCommandSucceeded(result)).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(realpathSync(result.stdout)).toBe(realpathSync(dir));
  });

  it('passes arguments verbatim, without a shell', async () => {
    const result = await runHostCommand([NODE, '-e', 'process.stdout.write(process.argv[1])', '$(touch pwned); `id`'], {
      cwd: dir,
      timeoutMs: 20_000,
    });

    expect(result.stdout).toBe('$(touch pwned); `id`');
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  it('closes stdin, so a command that reads it sees EOF instead of hanging', async () => {
    const result = await runHostCommand(
      [
        NODE,
        '-e',
        "let n = 0; process.stdin.on('data', (c) => { n += c.length; }); process.stdin.on('end', () => process.stdout.write('eof:' + n));",
      ],
      { cwd: dir, timeoutMs: 20_000 },
    );

    expect(hostCommandSucceeded(result)).toBe(true);
    expect(result.stdout).toBe('eof:0');
  });

  describe('failures', () => {
    it('reports a non-zero exit with its stderr', async () => {
      const result = await runHostCommand(
        [NODE, '-e', "process.stdout.write('out'); process.stderr.write('boom'); process.exit(2)"],
        { cwd: dir, timeoutMs: 20_000 },
      );

      expect(hostCommandSucceeded(result)).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.failure).toBeUndefined();
      expect(describeHostCommandFailure(['node'], result)).toBe('boom');
    });

    it('falls back to stdout when a failing command writes nothing to stderr', async () => {
      const result = await runHostCommand([NODE, '-e', "process.stdout.write('FAILED test_x'); process.exit(1)"], {
        cwd: dir,
        timeoutMs: 20_000,
      });

      expect(describeHostCommandFailure(['pytest'], result)).toBe('FAILED test_x');
    });

    it('falls back to the exit status when a failing command prints nothing', async () => {
      const result = await runHostCommand([NODE, '-e', 'process.exit(3)'], { cwd: dir, timeoutMs: 20_000 });

      expect(describeHostCommandFailure(['make', 'check'], result)).toBe('command "make" exited with code 3');
    });

    it('reports a missing program as a spawn failure', async () => {
      const result = await runHostCommand(['ironcurtain-no-such-program-xyz'], { cwd: dir, timeoutMs: 20_000 });

      expect(hostCommandSucceeded(result)).toBe(false);
      expect(result.failure?.kind).toBe('spawn');
      expect(result.failure?.message).toContain('cannot start command "ironcurtain-no-such-program-xyz"');
      expect(result.failure?.message).toContain('ENOENT');
      expect(describeHostCommandFailure(['ironcurtain-no-such-program-xyz'], result)).toContain('ENOENT');
    });

    it('reports an argv that cannot be passed to the OS as a spawn failure', async () => {
      const result = await runHostCommand([NODE, '-e', 'bad\0arg'], { cwd: dir, timeoutMs: 20_000 });

      expect(result.failure?.kind).toBe('spawn');
    });

    it('rejects invalid options and an empty argv up front', () => {
      expect(() => runHostCommand([], { cwd: dir, timeoutMs: 1000 })).toThrow(RangeError);
      expect(() => runHostCommand([NODE], { cwd: dir, timeoutMs: 0 })).toThrow(RangeError);
      expect(() => runHostCommand([NODE], { cwd: dir, timeoutMs: 2 ** 31 })).toThrow(RangeError);
      expect(() => runHostCommand([NODE], { cwd: dir, timeoutMs: 1000, captureBytes: -1 })).toThrow(RangeError);
    });
  });

  describe('output capture', () => {
    it('does not fail a command for verbose output (well past the old 1 MiB limit)', async () => {
      const result = await runHostCommand(
        [NODE, '-e', "process.stdout.write('x'.repeat(3 * 1024 * 1024) + '\\n12 tests pass\\n')"],
        { cwd: dir, timeoutMs: 20_000 },
      );

      expect(hostCommandSucceeded(result)).toBe(true);
      // The head and the tail are kept, so the closing summary line survives.
      expect(result.stdout).toContain('12 tests pass');
      expect(result.stdout).toContain('bytes of output omitted');
      expect(result.stdout.length).toBeLessThan(2 * 1024 * 1024 + 200);
    });

    it('keeps the first and the last captureBytes of a stream and counts the rest', async () => {
      const result = await runHostCommand(
        [NODE, '-e', "process.stdout.write('A'.repeat(100) + 'B'.repeat(1000) + 'C'.repeat(100))"],
        { cwd: dir, timeoutMs: 20_000, captureBytes: 100 },
      );

      expect(result.stdout).toBe(`${'A'.repeat(100)}\n[... 1000 bytes of output omitted ...]\n${'C'.repeat(100)}`);
    });

    it('returns the whole stream when it fits the bound', async () => {
      const result = await runHostCommand([NODE, '-e', "process.stdout.write('é'.repeat(60))"], {
        cwd: dir,
        timeoutMs: 20_000,
        captureBytes: 100,
      });

      // 120 bytes split across head and tail without a broken character.
      expect(result.stdout).toBe('é'.repeat(60));
    });
  });

  describe.skipIf(!POSIX)('process-group kill', () => {
    it('kills the whole tree, grandchildren included, when timeoutMs expires', async () => {
      const pidFile = join(dir, 'pids.json');
      const started = Date.now();
      const pending = runHostCommand([NODE, writeTreeScript(dir), pidFile], { cwd: dir, timeoutMs: 5_000 });
      const pids = await waitForTreePids(pidFile);
      const result = await pending;
      const elapsed = Date.now() - started;
      const alive = await waitUntilDead([pids.child, pids.grandchild]);
      killPids(alive);

      expect(alive).toEqual([]);
      expect(result.failure?.kind).toBe('timeout');
      expect(result.failure?.message).toContain('timed out after 5000 ms');
      expect(elapsed).toBeLessThan(20_000);
      expect(describeHostCommandFailure(['node'], result)).toContain('timed out after 5000 ms');
    });

    it('kills the whole tree when the signal aborts', async () => {
      const pidFile = join(dir, 'pids.json');
      const controller = new AbortController();
      const pending = runHostCommand([NODE, writeTreeScript(dir), pidFile], {
        cwd: dir,
        timeoutMs: 120_000,
        signal: controller.signal,
      });
      const pids = await waitForTreePids(pidFile);
      controller.abort();
      const result = await pending;
      const alive = await waitUntilDead([pids.child, pids.grandchild]);
      killPids(alive);

      expect(alive).toEqual([]);
      expect(result.failure?.kind).toBe('aborted');
      expect(result.failure?.message).toContain('the workflow is stopping');
    });

    it('does not start a command when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const marker = join(dir, 'started');

      const result = await runHostCommand([NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`], {
        cwd: dir,
        timeoutMs: 20_000,
        signal: controller.signal,
      });

      expect(result.failure?.kind).toBe('aborted');
      expect(existsSync(marker)).toBe(false);
    });

    it('kills a background process the command leaves behind when it exits', async () => {
      const pidFile = join(dir, 'bg.pid');
      // The shell starts a background sleeper in its group, records its pid,
      // and exits 0 at once.
      const result: HostCommandResult = await runHostCommand(['sh', '-c', `sleep 60 & echo $! > '${pidFile}'`], {
        cwd: dir,
        timeoutMs: 20_000,
      });
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      const alive = await waitUntilDead([pid]);
      killPids(alive);

      expect(hostCommandSucceeded(result)).toBe(true);
      expect(alive).toEqual([]);
    });
  });
});
