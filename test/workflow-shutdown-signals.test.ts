import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installWorkflowShutdownSignals,
  WORKFLOW_FORCE_EXIT_MS,
  WORKFLOW_SIGNAL_SNAPSHOT_BUDGET_MS,
  workflowStopOptionsForSignal,
} from '../src/workflow/shutdown-signals.js';
import { installDaemonShutdownSignals } from '../src/daemon/daemon-command.js';

afterEach(() => {
  vi.useRealTimers();
});

/** The `signal` listener installed since `before` was captured, typed as Node types the signal's listeners. */
function installedHandler(signal: NodeJS.Signals, before: ReadonlySet<unknown>) {
  const handler = process.listeners(signal).find((listener) => !before.has(listener));
  if (!handler) throw new Error(`No ${signal} handler was installed`);
  return handler;
}

describe('workflow shutdown signals', () => {
  it('aborts gracefully, escalates a second signal, and removes exact wrappers', () => {
    const before = new Set(process.listeners('SIGTERM'));
    const controller = new AbortController();
    const forceExit = vi.fn();
    const onFirstSignal = vi.fn();
    const uninstall = installWorkflowShutdownSignals(controller, { forceExit, onFirstSignal });
    const handler = installedHandler('SIGTERM', before);

    handler('SIGTERM');
    expect(controller.signal.aborted).toBe(true);
    expect(onFirstSignal).toHaveBeenCalledWith('SIGTERM');
    expect(forceExit).not.toHaveBeenCalled();

    handler('SIGTERM');
    expect(forceExit).toHaveBeenCalledWith(143);

    uninstall();
    expect(new Set(process.listeners('SIGTERM'))).toEqual(before);
  });

  it('keeps draining through the second SIGHUP of a hangup; a later SIGTERM still forces the exit', () => {
    // A closing terminal delivers SIGHUP twice. The workflow teardown the
    // first one started (shutdownAll) must not be cut short by the second.
    const hupBefore = new Set(process.listeners('SIGHUP'));
    const termBefore = new Set(process.listeners('SIGTERM'));
    const controller = new AbortController();
    const forceExit = vi.fn();
    const uninstall = installWorkflowShutdownSignals(controller, { forceExit });
    try {
      const hangup = installedHandler('SIGHUP', hupBefore);
      hangup('SIGHUP');
      hangup('SIGHUP');
      expect(controller.signal.aborted).toBe(true);
      expect(forceExit).not.toHaveBeenCalled();

      installedHandler('SIGTERM', termBefore)('SIGTERM');
      expect(forceExit).toHaveBeenCalledWith(143);
    } finally {
      uninstall();
    }
    expect(new Set(process.listeners('SIGHUP'))).toEqual(hupBefore);
  });

  it('forces exit when graceful teardown exceeds its deadline', async () => {
    vi.useFakeTimers();
    const before = new Set(process.listeners('SIGHUP'));
    const forceExit = vi.fn();
    const uninstall = installWorkflowShutdownSignals(new AbortController(), {
      forceExit,
      forceExitAfterMs: 25,
    });

    installedHandler('SIGHUP', before)('SIGHUP');
    await vi.advanceTimersByTimeAsync(25);
    expect(forceExit).toHaveBeenCalledWith(129);

    uninstall();
  });
});

describe('workflow stop options after a signal', () => {
  it('records the signal and bounds snapshots well inside the force-exit window', () => {
    expect(workflowStopOptionsForSignal(undefined)).toEqual({});
    expect(workflowStopOptionsForSignal('SIGINT')).toEqual({
      reason: 'Workflow interrupted by SIGINT',
      snapshotBudgetMs: WORKFLOW_SIGNAL_SNAPSHOT_BUDGET_MS,
    });
    expect(WORKFLOW_SIGNAL_SNAPSHOT_BUDGET_MS).toBeLessThan(WORKFLOW_FORCE_EXIT_MS);
  });
});

describe('daemon shutdown signals', () => {
  it('shuts down once, exits 0 when done, and forces the exit on a second signal', async () => {
    const before = new Set(process.listeners('SIGTERM'));
    let finishShutdown: () => void = () => {};
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    const exit = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const uninstall = installDaemonShutdownSignals({ shutdown }, { exit });
    try {
      const handler = installedHandler('SIGTERM', before);

      handler('SIGTERM');
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();

      // A second signal while the drain runs forces the exit at once, and
      // never starts a second shutdown.
      handler('SIGTERM');
      expect(exit).toHaveBeenCalledWith(143);
      expect(shutdown).toHaveBeenCalledTimes(1);

      finishShutdown();
      await vi.waitFor(() => expect(exit).toHaveBeenLastCalledWith(0));
    } finally {
      uninstall();
      stderr.mockRestore();
    }
    expect(new Set(process.listeners('SIGTERM'))).toEqual(before);
  });

  it('forces the exit when the graceful shutdown overruns its deadline', async () => {
    vi.useFakeTimers();
    const before = new Set(process.listeners('SIGINT'));
    const exit = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const uninstall = installDaemonShutdownSignals(
      { shutdown: () => new Promise<void>(() => {}) },
      { exit, forceExitAfterMs: 40 },
    );
    try {
      installedHandler('SIGINT', before)('SIGINT');
      await vi.advanceTimersByTimeAsync(40);
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      uninstall();
      stderr.mockRestore();
    }
  });

  it('exits 1 when the shutdown itself fails', async () => {
    const before = new Set(process.listeners('SIGINT'));
    const exit = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const uninstall = installDaemonShutdownSignals(
      { shutdown: () => Promise.reject(new Error('teardown broke')) },
      { exit },
    );
    try {
      installedHandler('SIGINT', before)('SIGINT');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally {
      uninstall();
      stderr.mockRestore();
    }
  });

  it('drains on SIGHUP in a terminal, and the hangup never forces the exit', async () => {
    // Closing the daemon's terminal delivers SIGHUP (twice). Without a
    // listener Node's default action would kill the daemon with no drain.
    const hupBefore = new Set(process.listeners('SIGHUP'));
    let finishShutdown: () => void = () => {};
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    );
    const exit = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const uninstall = installDaemonShutdownSignals({ shutdown }, { exit, output: [{ isTTY: true }, {}] });
    try {
      const hangup = installedHandler('SIGHUP', hupBefore);
      hangup('SIGHUP');
      hangup('SIGHUP');
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      // A repeated SIGHUP does not force the exit, so the notice names SIGTERM.
      const notice = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(notice).toContain('Caught SIGHUP; shutting down the daemon (send SIGTERM to force exit)');

      finishShutdown();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
      stderr.mockRestore();
    }
    expect(new Set(process.listeners('SIGHUP'))).toEqual(hupBefore);
  });

  it('ignores SIGHUP outside a terminal (nohup, a service manager, the --ensure-daemon child)', () => {
    // Node resets the ignored SIGHUP that nohup sets back to the default
    // action (terminate) at startup, so only a listener keeps the daemon up.
    const hupBefore = new Set(process.listeners('SIGHUP'));
    const intBefore = process.listenerCount('SIGINT');
    const termBefore = process.listenerCount('SIGTERM');
    const stdoutErrorListeners = process.stdout.listenerCount('error');
    const stderrErrorListeners = process.stderr.listenerCount('error');
    const shutdown = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const uninstall = installDaemonShutdownSignals({ shutdown }, { exit, output: [{ isTTY: false }, {}] });
    try {
      const hangup = installedHandler('SIGHUP', hupBefore);
      hangup('SIGHUP');
      hangup('SIGHUP');
      expect(shutdown).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      // The hangup may have taken the reader of a piped stdout or stderr
      // with it: their write errors are ignored from then on (guarded once).
      expect(process.stdout.listenerCount('error')).toBe(stdoutErrorListeners + 1);
      expect(process.stderr.listenerCount('error')).toBe(stderrErrorListeners + 1);
      // SIGINT and SIGTERM still stop it gracefully.
      expect(process.listenerCount('SIGINT')).toBe(intBefore + 1);
      expect(process.listenerCount('SIGTERM')).toBe(termBefore + 1);
    } finally {
      uninstall();
    }
    expect(new Set(process.listeners('SIGHUP'))).toEqual(hupBefore);
    expect(process.listenerCount('SIGINT')).toBe(intBefore);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore);
    expect(process.stdout.listenerCount('error')).toBe(stdoutErrorListeners);
    expect(process.stderr.listenerCount('error')).toBe(stderrErrorListeners);
  });

  it(
    'keeps a daemon process outside a terminal running through a hangup, and SIGTERM still drains it',
    { timeout: 30_000 },
    async () => {
      // The real thing: a child process with piped output (as under nohup or
      // the --ensure-daemon spawn) installs the daemon's handlers. Without
      // the SIGHUP listener the kernel's default action ends it at once. The
      // hangup also takes the reader of its stderr (a `| tee` in the closed
      // terminal), and a later write there (SIGUSR2 here) must not crash it.
      const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'daemon', 'daemon-command.ts')).href;
      const program = `
        import { installDaemonShutdownSignals } from ${JSON.stringify(moduleUrl)};
        installDaemonShutdownSignals({
          shutdown: async () => {
            process.stdout.write('drained\\n');
          },
        });
        process.on('SIGUSR2', () => {
          process.stderr.write('a write after the hangup\\n');
          process.stdout.write('wrote\\n');
        });
        setInterval(() => {}, 60_000);
        process.stdout.write('ready\\n');
      `;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderrText = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderrText += chunk;
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const stillRunning = async (): Promise<unknown> =>
        Promise.race([exited, new Promise<'alive'>((resolve) => setTimeout(resolve, 500, 'alive'))]);
      try {
        await vi.waitFor(() => expect(stdout).toContain('ready'), { timeout: 20_000, interval: 20 });

        child.kill('SIGHUP');
        expect(await stillRunning(), stderrText).toBe('alive');

        child.stderr.destroy();
        // Let the pipe's read end close before the child writes to it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        child.kill('SIGUSR2');
        await vi.waitFor(() => expect(stdout).toContain('wrote'), { timeout: 10_000, interval: 20 });
        expect(await stillRunning()).toBe('alive');

        child.kill('SIGTERM');
        expect(await exited).toEqual({ code: 0, signal: null });
        expect(stdout).toContain('drained');
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
  );
});
