/**
 * Tests for container-turn wall-clock enforcement (audit finding DINF-8):
 *
 *   - `exec-deadline.ts`: the runtime managers classify a deadline hit from
 *     the killed child or the elapsed time, never from the exec client's exit
 *     code (the Docker CLI exits 0 when Node SIGTERMs it).
 *   - `turn-timeout.ts`: each turn runs under an in-container `timeout`, and a
 *     marker sweep kills the turn's survivors after a timeout.
 *
 * No Docker is involved. The process-level cases run the real wrapper and the
 * real sweep script on this host through a `docker exec` shim that executes
 * the command locally (Linux only: the sweep reads `/proc`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rejectedExecResult, resolvedExecResult } from '../../src/docker/exec-deadline.js';
import { createDockerManager } from '../../src/docker/docker-manager.js';
import {
  MAX_HOST_TIMEOUT_MS,
  STOP_SWEEP_MAX_ATTEMPTS,
  STOP_SWEEP_RETRY_MS,
  TIMEOUT_BINARY,
  TURN_KILL_SWEEP_SCRIPT,
  TURN_KILL_SWEEP_TIMEOUT_MS,
  TURN_MARKER_ENV,
  TURN_TIMEOUT_HOST_SLACK_MS,
  TURN_TIMEOUT_KILL_AFTER_SECONDS,
  buildBoundedTurn,
  buildTurnKillCommand,
  killTimedOutTurn,
  killTurnProcesses,
  runBoundedContainerCommand,
  turnTimedOut,
} from '../../src/docker/turn-timeout.js';
import type { ContainerRuntime, DockerExecResult } from '../../src/docker/types.js';
import {
  LOCAL_TURN_PROCESS_TESTS_SUPPORTED,
  isProcessAlive as isAlive,
  localDockerExec,
  markedProcessIds,
  waitUntilProcessGone as waitUntilGone,
} from '../helpers/local-container-exec.js';

const TURN_ID = '0f3c9a52-7d1e-4c55-9a51-2f8d6e4b1c3a';

describe('exec deadline classification', () => {
  it('reports a killed client that exited 0 as a timeout, never as success', () => {
    expect(resolvedExecResult({ stdout: 'started\n', stderr: '', killed: true }, 2_000, 2_007)).toEqual({
      exitCode: 124,
      stdout: 'started\n',
      stderr: '',
      timedOut: true,
    });
  });

  it('falls back to elapsed time when the exec implementation cannot report killed', () => {
    expect(resolvedExecResult({ stdout: '', stderr: '' }, 1_000, 1_000)).toMatchObject({
      exitCode: 124,
      timedOut: true,
    });
    expect(resolvedExecResult({ stdout: 'ok', stderr: '' }, 1_000, 999)).toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    expect(resolvedExecResult({ stdout: 'ok', stderr: '' }, 0, 10_000_000)).toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
  });

  it('treats a killed rejection as a timeout whatever exit code the client chose', () => {
    expect(
      rejectedExecResult({ code: 143, killed: true, signal: undefined, stdout: 'x', stderr: 'y' }, 5_000, 5_010),
    ).toEqual({ exitCode: 124, stdout: 'x', stderr: 'y', timedOut: true });
    expect(
      rejectedExecResult({ code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' }, 5_000, 10),
    ).toEqual({ exitCode: 124, stdout: '', stderr: '', timedOut: true });
  });

  it('never reports an exec Node did not signal as a timeout, however long the wall clock says it took', () => {
    // `killed: false` is authoritative: a host suspend or clock step during a
    // completed turn must not discard its output as a wall-clock exhaustion.
    expect(resolvedExecResult({ stdout: 'done', stderr: '', killed: false }, 1_000, 3_600_000)).toEqual({
      exitCode: 0,
      stdout: 'done',
      stderr: '',
    });
    expect(
      rejectedExecResult({ code: 2, killed: false, signal: undefined, stdout: '', stderr: 'boom' }, 1_000, 3_600_000),
    ).toEqual({ exitCode: 2, stdout: '', stderr: 'boom' });
  });

  it('keeps ordinary failures as their own exit code', () => {
    expect(rejectedExecResult({ code: 2, stdout: 'out', stderr: 'err' }, 5_000, 10)).toEqual({
      exitCode: 2,
      stdout: 'out',
      stderr: 'err',
    });
    expect(rejectedExecResult({ code: 'ENOENT', stdout: '', stderr: '' }, 5_000, 10)).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
  });
});

describe('buildBoundedTurn', () => {
  it('wraps the turn in an absolute-path coreutils timeout with a kill grace', () => {
    const bounded = buildBoundedTurn(['claude', '-p', 'hello world'], TURN_ID, 30);

    expect(bounded.command).toEqual([
      TIMEOUT_BINARY,
      `--kill-after=${TURN_TIMEOUT_KILL_AFTER_SECONDS}`,
      '30',
      'claude',
      '-p',
      'hello world',
    ]);
    expect(TIMEOUT_BINARY).toBe('/usr/bin/timeout');
    expect(bounded.hostTimeoutMs).toBe(30_000 + TURN_TIMEOUT_KILL_AFTER_SECONDS * 1000 + TURN_TIMEOUT_HOST_SLACK_MS);
    expect(bounded.maxSeconds).toBe(30);
    expect(bounded.environment).toEqual({ [TURN_MARKER_ENV]: TURN_ID });
    expect(bounded.marker).toBe(`${TURN_MARKER_ENV}=${TURN_ID}`);
  });

  it('leaves the command alone and arms no host deadline when the limit is disabled', () => {
    const bounded = buildBoundedTurn(['claude', '-p', 'x'], TURN_ID, null);
    expect(bounded).toMatchObject({
      command: ['claude', '-p', 'x'],
      hostTimeoutMs: 0,
      maxSeconds: null,
      environment: {},
    });
  });

  it('keeps fractional limits and caps the host deadline at the largest Node timer', () => {
    expect(buildBoundedTurn(['a'], TURN_ID, 0.5)).toMatchObject({
      command: [TIMEOUT_BINARY, `--kill-after=${TURN_TIMEOUT_KILL_AFTER_SECONDS}`, '0.5', 'a'],
      hostTimeoutMs: 500 + TURN_TIMEOUT_KILL_AFTER_SECONDS * 1000 + TURN_TIMEOUT_HOST_SLACK_MS,
    });
    // 30 days would overflow setTimeout and fire after 1 ms.
    expect(buildBoundedTurn(['a'], TURN_ID, 30 * 86_400).hostTimeoutMs).toBe(MAX_HOST_TIMEOUT_MS);
  });

  it('rejects limits and turn ids it cannot represent safely', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildBoundedTurn(['a'], TURN_ID, bad)).toThrow(/positive number of seconds/);
    }
    expect(() => buildBoundedTurn(['a'], 'not-a-uuid', 30)).toThrow(/host-minted UUID/);
    expect(() => buildBoundedTurn(['a'], `${TURN_ID}\nX=1`, 30)).toThrow(/host-minted UUID/);
  });
});

describe('turnTimedOut', () => {
  const bounded = buildBoundedTurn(['a'], TURN_ID, 10);
  const result = (exitCode: number, timedOut?: boolean): DockerExecResult => ({
    exitCode,
    stdout: '',
    stderr: '',
    ...(timedOut === undefined ? {} : { timedOut }),
  });

  it('recognizes the host backstop, the wrapper SIGTERM and the kill-after SIGKILL', () => {
    expect(turnTimedOut(result(124, true), bounded, 50)).toBe(true);
    expect(turnTimedOut(result(124), bounded, 10_020)).toBe(true);
    expect(turnTimedOut(result(137), bounded, 20_100)).toBe(true);
  });

  it('leaves exit 124 and 137 before the deadline to the adapter', () => {
    expect(turnTimedOut(result(124), bounded, 2_000)).toBe(false);
    expect(turnTimedOut(result(137), bounded, 2_000)).toBe(false);
  });

  it('never reports an ordinary exit or an unbounded turn as a timeout', () => {
    expect(turnTimedOut(result(0), bounded, 60_000)).toBe(false);
    expect(turnTimedOut(result(1), bounded, 60_000)).toBe(false);
    const unbounded = buildBoundedTurn(['a'], TURN_ID, null);
    expect(turnTimedOut(result(124), unbounded, 60_000)).toBe(false);
  });
});

describe('killTimedOutTurn', () => {
  it('passes the marker as an argument to a constant script and runs as the agent user', async () => {
    const bounded = buildBoundedTurn(['a'], TURN_ID, 10);
    const exec = vi.fn<ContainerRuntime['exec']>(async () => ({ exitCode: 0, stdout: '2\n', stderr: '' }));

    await killTimedOutTurn({ exec }, 'container-1', bounded);

    expect(exec).toHaveBeenCalledOnce();
    const [containerId, command, timeoutMs, execUser, workdir, environment] = exec.mock.calls[0];
    expect(containerId).toBe('container-1');
    expect(command).toEqual(['/bin/sh', '-c', TURN_KILL_SWEEP_SCRIPT, 'ironcurtain-turn-kill', bounded.marker]);
    expect(buildTurnKillCommand(bounded.marker)).toEqual(command);
    expect(TURN_KILL_SWEEP_SCRIPT).not.toContain(TURN_ID);
    expect(timeoutMs).toBe(TURN_KILL_SWEEP_TIMEOUT_MS);
    // Default exec user (the agent): never a root or privileged exec.
    expect(execUser).toBeUndefined();
    expect(workdir).toBeUndefined();
    // The sweep itself must not carry the marker it hunts for.
    expect(environment).toBeUndefined();
  });

  it('never throws when the sweep fails or cannot run', async () => {
    const bounded = buildBoundedTurn(['a'], TURN_ID, 10);
    await expect(
      killTimedOutTurn(
        { exec: async () => ({ exitCode: 124, stdout: '', stderr: 'wedged', timedOut: true }) },
        'c',
        bounded,
      ),
    ).resolves.toBeUndefined();
    await expect(
      killTimedOutTurn(
        {
          exec: async () => {
            throw new Error('daemon gone');
          },
        },
        'c',
        bounded,
      ),
    ).resolves.toBeUndefined();
  });

  it('runs the sweep as the given exec user when the turn ran as one', async () => {
    const bounded = buildBoundedTurn(['a'], TURN_ID, 10);
    const exec = vi.fn<ContainerRuntime['exec']>(async () => ({ exitCode: 0, stdout: '0', stderr: '' }));

    await killTurnProcesses({ exec }, 'container-1', bounded, 'stopped', '1000');

    expect(exec).toHaveBeenCalledWith(
      'container-1',
      buildTurnKillCommand(bounded.marker),
      TURN_KILL_SWEEP_TIMEOUT_MS,
      '1000',
    );
  });
});

describe('runBoundedContainerCommand', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const isSweep = (command: readonly string[]): boolean => command[3] === 'ironcurtain-turn-kill';

  it('execs the command under the wall clock with a fresh marker and leaves an ordinary exit alone', async () => {
    const exec = vi.fn<ContainerRuntime['exec']>(async () => ({ exitCode: 3, stdout: 'out', stderr: 'err' }));

    const options = { maxSeconds: 30, execUser: '1000', workdir: '/workspace' };
    const first = await runBoundedContainerCommand({ exec }, 'container-1', ['make', 'test'], options);
    const second = await runBoundedContainerCommand({ exec }, 'container-1', ['make', 'test'], options);

    expect(first).toMatchObject({ ending: 'exited', result: { exitCode: 3, stdout: 'out', stderr: 'err' } });
    expect(second.ending).toBe('exited');
    expect(exec).toHaveBeenCalledTimes(2);
    const [containerId, command, timeoutMs, execUser, workdir, environment] = exec.mock.calls[0];
    expect(containerId).toBe('container-1');
    expect(command).toEqual([TIMEOUT_BINARY, `--kill-after=${TURN_TIMEOUT_KILL_AFTER_SECONDS}`, '30', 'make', 'test']);
    expect(timeoutMs).toBe(30_000 + TURN_TIMEOUT_KILL_AFTER_SECONDS * 1000 + TURN_TIMEOUT_HOST_SLACK_MS);
    expect(execUser).toBe('1000');
    expect(workdir).toBe('/workspace');
    expect(environment?.[TURN_MARKER_ENV]).toMatch(UUID);
    expect(exec.mock.calls[1][5]?.[TURN_MARKER_ENV]).not.toBe(environment?.[TURN_MARKER_ENV]);
  });

  it('sweeps a timed-out command by its marker as the command user before returning', async () => {
    const exec = vi.fn<ContainerRuntime['exec']>(async (_id, command) =>
      isSweep(command)
        ? { exitCode: 0, stdout: '3', stderr: '' }
        : { exitCode: 124, stdout: 'partial', stderr: '', timedOut: true },
    );

    const outcome = await runBoundedContainerCommand({ exec }, 'container-1', ['pytest'], {
      maxSeconds: 5,
      execUser: '1000',
    });

    expect(outcome).toMatchObject({ ending: 'timed-out', result: { stdout: 'partial' } });
    expect(exec).toHaveBeenCalledTimes(2);
    const marker = `${TURN_MARKER_ENV}=${exec.mock.calls[0][5]?.[TURN_MARKER_ENV] ?? ''}`;
    expect(exec.mock.calls[1]).toEqual([
      'container-1',
      buildTurnKillCommand(marker),
      TURN_KILL_SWEEP_TIMEOUT_MS,
      '1000',
    ]);
  });

  it('sweeps the command at once when the signal aborts while it runs', async () => {
    const controller = new AbortController();
    let sweptWhileRunning = false;
    let finishCommand: (result: DockerExecResult) => void = () => {};
    const exec = vi.fn<ContainerRuntime['exec']>((_id, command) => {
      if (isSweep(command)) {
        sweptWhileRunning = true;
        // The sweep kills the command's processes: its exec ends.
        finishCommand({ exitCode: 137, stdout: '', stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '1', stderr: '' });
      }
      return new Promise<DockerExecResult>((resolve) => {
        finishCommand = resolve;
      });
    });

    const pending = runBoundedContainerCommand({ exec }, 'container-1', ['node', 'hang.js'], {
      maxSeconds: 600,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const outcome = await pending;

    expect(sweptWhileRunning).toBe(true);
    expect(outcome.ending).toBe('stopped');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][3]).toBeUndefined();
  });

  describe('a stop that lands before the command process exists', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * A command exec whose process "starts" only after `startAfterSweeps`
     * sweeps have run: earlier sweeps find nothing, a later one kills it and
     * so ends the exec.
     */
    function lateStartingCommand(startAfterSweeps: number) {
      let sweeps = 0;
      let finishCommand: (result: DockerExecResult) => void = () => {};
      const exec = vi.fn<ContainerRuntime['exec']>((_id, command) => {
        if (!isSweep(command)) {
          return new Promise<DockerExecResult>((resolve) => {
            finishCommand = resolve;
          });
        }
        sweeps += 1;
        if (sweeps <= startAfterSweeps) return Promise.resolve({ exitCode: 0, stdout: '0', stderr: '' });
        finishCommand({ exitCode: 137, stdout: '', stderr: '' });
        return Promise.resolve({ exitCode: 0, stdout: '1', stderr: '' });
      });
      return { exec, sweeps: () => sweeps, finish: (result: DockerExecResult) => finishCommand(result) };
    }

    it('sweeps again while the stopped command is still running, until a sweep reaches it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const controller = new AbortController();
      const command = lateStartingCommand(1);

      const pending = runBoundedContainerCommand({ exec: command.exec }, 'container-1', ['pytest'], {
        maxSeconds: 600,
        execUser: '1000',
        signal: controller.signal,
      });
      // Aborted at once: the first sweep runs before the process exists.
      controller.abort();
      await vi.advanceTimersByTimeAsync(STOP_SWEEP_RETRY_MS * 3);
      // Checked before awaiting: with one sweep only, the exec would never end.
      expect(command.sweeps()).toBe(2);
      const outcome = await pending;

      expect(outcome.ending).toBe('stopped');
      const marker = `${TURN_MARKER_ENV}=${command.exec.mock.calls[0][5]?.[TURN_MARKER_ENV] ?? ''}`;
      for (const call of command.exec.mock.calls.slice(1)) {
        expect(call).toEqual(['container-1', buildTurnKillCommand(marker), TURN_KILL_SWEEP_TIMEOUT_MS, '1000']);
      }
    });

    it('stops sweeping after a bounded number of attempts', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const controller = new AbortController();
      const command = lateStartingCommand(Number.POSITIVE_INFINITY);

      const pending = runBoundedContainerCommand({ exec: command.exec }, 'container-1', ['pytest'], {
        maxSeconds: 600,
        signal: controller.signal,
      });
      controller.abort();
      await vi.advanceTimersByTimeAsync(STOP_SWEEP_RETRY_MS * (STOP_SWEEP_MAX_ATTEMPTS + 3));
      expect(command.sweeps()).toBe(STOP_SWEEP_MAX_ATTEMPTS);

      // The in-container deadline ends it eventually; nothing sweeps again.
      command.finish({ exitCode: 124, stdout: '', stderr: '' });
      const outcome = await pending;
      expect(outcome.ending).toBe('stopped');
      expect(command.sweeps()).toBe(STOP_SWEEP_MAX_ATTEMPTS);
    });
  });

  it('starts nothing for an already-aborted signal', async () => {
    const exec = vi.fn<ContainerRuntime['exec']>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      runBoundedContainerCommand({ exec }, 'container-1', ['true'], { maxSeconds: 5, signal: controller.signal }),
    ).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe.skipIf(!LOCAL_TURN_PROCESS_TESTS_SUPPORTED)('wall clock with real processes (no Docker)', () => {
  const spawned: ChildProcess[] = [];

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      if (child.pid !== undefined && isAlive(child.pid)) child.kill('SIGKILL');
    }
  });

  it('reports a deadline hit as timedOut when the exec client exits 0 on SIGTERM (DINF-8)', async () => {
    const manager = createDockerManager(localDockerExec);
    const started = Date.now();

    // Like the Docker CLI: the client traps SIGTERM and exits 0.
    const result = await manager.exec(
      'container-1',
      ['/bin/sh', '-c', 'trap "exit 0" TERM; echo started; while :; do sleep 0.05; done'],
      300,
    );

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ exitCode: 124, stdout: 'started\n', timedOut: true });
  });

  it('kills the whole turn inside the container at the deadline and the sweep reaches escaped children', async () => {
    const manager = createDockerManager(localDockerExec);
    const turnId = randomUUID();
    const bounded = buildBoundedTurn(
      [
        '/bin/sh',
        '-c',
        // One child stays in the turn's process group; one leaves it with
        // setsid and holds no pipe, as a detached tool subprocess would.
        'sleep 30 & echo "$!"; setsid sleep 30 >/dev/null 2>&1 </dev/null & echo "$!"; wait',
      ],
      turnId,
      1,
    );

    const started = Date.now();
    const result = await manager.exec('container-1', bounded.command, bounded.hostTimeoutMs, undefined, undefined, {
      ...bounded.environment,
    });
    const elapsedMs = Date.now() - started;
    const [inGroup, escaped] = result.stdout.trim().split('\n').map(Number);

    expect(result.exitCode).toBe(124);
    expect(turnTimedOut(result, bounded, elapsedMs)).toBe(true);
    expect(elapsedMs).toBeLessThan(bounded.hostTimeoutMs);
    // coreutils timeout signalled the group: the in-group child is gone.
    expect(await waitUntilGone(inGroup)).toBe(true);
    // The escaped child survived the group kill until the marker sweep.
    expect(isAlive(escaped)).toBe(true);

    await killTimedOutTurn(manager, 'container-1', bounded);

    expect(await waitUntilGone(escaped)).toBe(true);
  });

  it('keeps sweeping a detached process tree that forks while a pass runs until none is left', async () => {
    const manager = createDockerManager(localDockerExec);
    const bounded = buildBoundedTurn(['true'], randomUUID(), 5);
    // A runaway left the turn's process group and keeps forking marked
    // children. One `/proc` pass expands its PID list once, so children forked
    // during the pass survive it; later passes catch them.
    const loop = spawn('/bin/sh', ['-c', 'while :; do sleep 30 & sleep 0.02; done'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...bounded.environment },
    });
    spawned.push(loop);
    loop.unref();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(markedProcessIds(bounded.marker).length).toBeGreaterThan(1);

      await killTimedOutTurn(manager, 'container-1', bounded);

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(markedProcessIds(bounded.marker)).toEqual([]);
    } finally {
      for (const pid of markedProcessIds(bounded.marker)) process.kill(pid, 'SIGKILL');
    }
  });

  it('kills only processes whose environment carries the exact marker', async () => {
    const manager = createDockerManager(localDockerExec);
    const turnId = randomUUID();
    const bounded = buildBoundedTurn(['true'], turnId, 5);
    const start = (env: Record<string, string>): number => {
      const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore', env: { ...process.env, ...env } });
      spawned.push(child);
      child.unref();
      if (child.pid === undefined) throw new Error('spawn failed');
      return child.pid;
    };
    const marked = start({ [TURN_MARKER_ENV]: turnId });
    const otherTurn = start({ [TURN_MARKER_ENV]: randomUUID() });
    const substring = start({ DECOY: `x${bounded.marker}x` });
    const prefix = start({ [TURN_MARKER_ENV]: `${turnId}0` });

    await killTimedOutTurn(manager, 'container-1', bounded);

    expect(await waitUntilGone(marked)).toBe(true);
    expect(isAlive(otherTurn)).toBe(true);
    expect(isAlive(substring)).toBe(true);
    expect(isAlive(prefix)).toBe(true);
  });

  // One child stays in the command's process group; one leaves it with setsid
  // and holds no pipe, as a detached test-runner worker would.
  const TREE_SCRIPT =
    'sleep 60 & echo "$!" >> "$1"; setsid sleep 60 >/dev/null 2>&1 </dev/null & echo "$!" >> "$1"; wait';

  it('ends a timed-out deterministic command and its escaped child inside the "container"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bounded-command-'));
    try {
      const pidFile = join(dir, 'pids');
      const started = Date.now();
      const outcome = await runBoundedContainerCommand(
        createDockerManager(localDockerExec),
        'container-1',
        ['/bin/sh', '-c', TREE_SCRIPT, 'sh', pidFile],
        { maxSeconds: 1 },
      );

      expect(outcome.ending).toBe('timed-out');
      expect(Date.now() - started).toBeLessThan(15_000);
      const [inGroup, escaped] = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
      expect(await waitUntilGone(inGroup)).toBe(true);
      expect(await waitUntilGone(escaped)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ends a running deterministic command and its escaped child when the stop signal fires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bounded-command-'));
    try {
      const pidFile = join(dir, 'pids');
      const controller = new AbortController();
      const pending = runBoundedContainerCommand(
        createDockerManager(localDockerExec),
        'container-1',
        ['/bin/sh', '-c', TREE_SCRIPT, 'sh', pidFile],
        { maxSeconds: 120, signal: controller.signal },
      );
      const deadline = Date.now() + 10_000;
      const readPids = (): number[] =>
        existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
      while (readPids().length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const [inGroup, escaped] = readPids();
      const stoppedAt = Date.now();
      controller.abort();
      const outcome = await pending;

      expect(outcome.ending).toBe('stopped');
      expect(Date.now() - stoppedAt).toBeLessThan(10_000);
      expect(await waitUntilGone(inGroup)).toBe(true);
      expect(await waitUntilGone(escaped)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
