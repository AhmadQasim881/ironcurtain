/**
 * `ironcurtain daemon <subcommand>` against a daemon control socket: a
 * reachable daemon does the work (however long it takes), a daemon that took
 * a request and then failed is reported and never duplicated by a local run,
 * and local fallbacks happen only with the daemon lock held. Starting a daemon
 * while another holds the lock exits non-zero. Only starting a daemon and a
 * local run-job check the V8 sandbox and resolve the session mode (and print
 * preflight's host-model warnings); the other subcommands need neither, so
 * they work where isolated-vm cannot load or Docker is down.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import { getDaemonLockPath, getDaemonSocketPath } from '../src/config/paths.js';
import type { RunRecord } from '../src/cron/types.js';
import {
  ControlSocketServer,
  type ControlRequestHandler,
  type DaemonStatus,
  type JobRunStart,
} from '../src/daemon/control-socket.js';
import { runDaemonCommand } from '../src/daemon/daemon-command.js';
import { acquireDaemonLock, type DaemonLock } from '../src/daemon/daemon-lock.js';
import * as logger from '../src/logger.js';
import { resolveSessionMode } from '../src/session/preflight.js';
import { ensureSandboxViable } from '../src/utils/preflight-checks.js';

const local = vi.hoisted(() => ({
  runJobCommand: vi.fn(async () => {}),
  runRecompileJob: vi.fn(async () => {}),
  runRemoveJob: vi.fn(async () => {}),
  confirmJobRemoval: vi.fn(async () => true),
  runEnableJob: vi.fn(async () => {}),
  runDisableJob: vi.fn(async () => {}),
  runListJobs: vi.fn(),
  runShowLogs: vi.fn(),
  formatDaemonJobList: vi.fn(),
}));

vi.mock('../src/cron/job-commands.js', () => local);
vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
vi.mock('../src/session/preflight.js', () => ({
  resolveSessionMode: vi.fn(async () => ({ mode: { kind: 'builtin' } })),
  formatModeLine: vi.fn(() => 'Mode: builtin (test)'),
}));
vi.mock('../src/utils/preflight-checks.js', () => ({ ensureSandboxViable: vi.fn(async () => {}) }));
vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: vi.fn(() => ({}) as IronCurtainConfig),
}));

class ProcessExit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const SUCCESS_RECORD: RunRecord = {
  startedAt: '2026-03-05T09:00:00.000Z',
  completedAt: '2026-03-05T09:00:03.000Z',
  outcome: { kind: 'success' },
  budget: { totalTokens: 10, stepCount: 1, elapsedSeconds: 3, estimatedCostUsd: 0.01 },
  summary: null,
  escalationsEncountered: 0,
  escalationsApproved: 0,
  discardedChanges: null,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHandler(overrides: Partial<ControlRequestHandler> = {}): ControlRequestHandler {
  return {
    getStatus: (): DaemonStatus => ({
      uptimeSeconds: 1,
      jobs: { total: 1, enabled: 1, running: 0, failing: 0 },
      failingJobs: [],
      signalConnected: false,
      nextFireTime: null,
    }),
    removeJob: vi.fn(async () => {}),
    enableJob: vi.fn(async () => {}),
    disableJob: vi.fn(async () => {}),
    recompileJob: vi.fn(async () => ({ failedServers: [] })),
    refreshLists: vi.fn(),
    reloadJob: vi.fn(async () => {}),
    startJobRun: vi.fn((): JobRunStart => ({ completion: Promise.resolve(SUCCESS_RECORD) })),
    runJobNow: vi.fn(async () => SUCCESS_RECORD),
    listJobs: vi.fn(() => []),
    ...overrides,
  };
}

describe('daemon CLI against the control socket', () => {
  let home: string;
  let savedHome: string | undefined;
  let savedExitCode: typeof process.exitCode;
  let errors: string[];
  let stderr: string[];
  let signalListeners: { SIGINT: number; SIGTERM: number };
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-daemon-cli-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    savedExitCode = process.exitCode;
    errors = [];
    stderr = [];
    signalListeners = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    for (const fn of Object.values(local)) fn.mockClear();
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExit(code);
    }) as typeof process.exit);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    logger.teardown();
    // runDaemonCommand([]) registers shutdown handlers; drop the ones it added.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const listeners = process.listeners(signal);
      for (const listener of listeners.slice(signalListeners[signal])) process.removeListener(signal, listener);
    }
    process.exitCode = savedExitCode;
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function startDaemonSocket(handler: ControlRequestHandler): Promise<ControlSocketServer> {
    const server = new ControlSocketServer(handler);
    await server.start();
    cleanups.push(() => server.stop());
    return server;
  }

  /** A "daemon" that takes each request and drops the connection. */
  async function startDroppingSocket(): Promise<void> {
    const server: Server = createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(getDaemonSocketPath(), resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }

  /** A "daemon" that answers every request line with `reply` (say, the shape an older daemon sends). */
  async function startReplyingSocket(reply: string): Promise<void> {
    const server: Server = createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.end(`${reply}\n`));
    });
    await new Promise<void>((resolve) => server.listen(getDaemonSocketPath(), resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }

  function holdDaemonLock(): DaemonLock {
    const lock = acquireDaemonLock();
    cleanups.push(() => lock.release());
    return lock;
  }

  it('waits for a daemon run slower than the connect timeout and never runs the job locally', async () => {
    const startJobRun = vi.fn((): JobRunStart => ({ completion: delay(2_500).then(() => SUCCESS_RECORD) }));
    await startDaemonSocket(makeHandler({ startJobRun }));

    await runDaemonCommand(['run-job', 'nightly']);

    expect(startJobRun).toHaveBeenCalledTimes(1);
    expect(startJobRun).toHaveBeenCalledWith('nightly');
    expect(local.runJobCommand).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('Job "nightly" completed via daemon.');
    expect(errors.join('\n')).toContain('Outcome: success');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('exits non-zero when the daemon run did not succeed', async () => {
    const failed: RunRecord = { ...SUCCESS_RECORD, outcome: { kind: 'error', message: 'boom' } };
    await startDaemonSocket(makeHandler({ startJobRun: () => ({ completion: Promise.resolve(failed) }) }));
    await runDaemonCommand(['run-job', 'nightly']);
    expect(process.exitCode).toBe(1);
    expect(local.runJobCommand).not.toHaveBeenCalled();
  });

  it('shows completed-run safety notices received from the daemon', async () => {
    const record: RunRecord = {
      ...SUCCESS_RECORD,
      notices: ['Example host-file warning\u0007.\nInspect /workspace/example.'],
    };
    await startDaemonSocket(makeHandler({ startJobRun: () => ({ completion: Promise.resolve(record) }) }));

    await runDaemonCommand(['run-job', 'nightly']);

    expect(errors.join('\n')).toContain('Example host-file warning\\u0007.');
    expect(errors.join('\n')).toContain('Inspect /workspace/example.');
  });

  it('waits for a recompile slower than the connect timeout instead of compiling locally too', async () => {
    const recompileJob = vi.fn(async () => {
      await delay(2_500);
      return { failedServers: [] };
    });
    await startDaemonSocket(makeHandler({ recompileJob }));

    await runDaemonCommand(['recompile-job', 'nightly']);

    expect(recompileJob).toHaveBeenCalledWith('nightly');
    expect(local.runRecompileJob).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('policy recompiled (daemon notified)');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('names the servers a daemon recompile left out and exits 2, without compiling locally', async () => {
    await startDaemonSocket(makeHandler({ recompileJob: vi.fn(async () => ({ failedServers: ['git', 'fetch'] })) }));

    await runDaemonCommand(['recompile-job', 'nightly']);

    const output = errors.join('\n');
    expect(output).toContain('policy recompiled (daemon notified)');
    expect(output).toContain('2 server(s) failed to compile and have no rules');
    expect(output).toContain(': git, fetch. The daemon log has the reasons.');
    expect(process.exitCode).toBe(2);
    expect(local.runRecompileJob).not.toHaveBeenCalled();
  });

  it('reports a recompile by an older daemon, whose reply names no servers, as done (exit 0)', async () => {
    await startReplyingSocket(JSON.stringify({ ok: true }));

    await runDaemonCommand(['recompile-job', 'nightly']);

    expect(errors.join('\n')).toContain('policy recompiled (daemon notified)');
    expect(errors.join('\n')).not.toContain('failed to compile');
    expect(process.exitCode ?? 0).toBe(0);
    expect(local.runRecompileJob).not.toHaveBeenCalled();
  });

  it('reports a daemon that drops the run-job connection and does not run the job locally', async () => {
    await startDroppingSocket();
    await expect(runDaemonCommand(['run-job', 'nightly'])).rejects.toMatchObject({ code: 1 });
    expect(local.runJobCommand).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('was not run locally');
  });

  it('reports losing the daemon mid-run and does not run the job locally', async () => {
    const server = await startDaemonSocket(
      makeHandler({ startJobRun: () => ({ completion: new Promise<RunRecord>(() => {}) }) }),
    );

    const command = runDaemonCommand(['run-job', 'nightly']);
    const outcome = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    // The daemon goes away after it accepted the run (the CLI is polling).
    while (!errors.some((line) => line.includes('is running in the daemon'))) await delay(10);
    await server.stop();

    expect(await outcome).toMatchObject({ code: 1 });
    expect(local.runJobCommand).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('lost track of job "nightly"');
  });

  it('reports a daemon that drops the connection before accepting the run, without running it locally', async () => {
    let stop: () => Promise<void> = async () => {};
    const server = await startDaemonSocket(
      makeHandler({
        startJobRun: () => {
          // Stop the daemon before its reply goes out.
          void stop();
          return { completion: new Promise<RunRecord>(() => {}) };
        },
      }),
    );
    stop = () => server.stop();

    await expect(runDaemonCommand(['run-job', 'nightly'])).rejects.toMatchObject({ code: 1 });
    expect(local.runJobCommand).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('was not run locally');
  });

  it('reports a daemon-side error without running the job locally', async () => {
    await startDaemonSocket(
      makeHandler({
        startJobRun: () => {
          throw new Error('Job not found: nightly');
        },
      }),
    );
    await expect(runDaemonCommand(['run-job', 'nightly'])).rejects.toMatchObject({ code: 1 });
    expect(local.runJobCommand).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('Error from daemon: Job not found: nightly');
  });

  it('runs the job locally, holding the daemon lock, when no daemon is reachable', async () => {
    let lockHeldDuringRun = false;
    local.runJobCommand.mockImplementationOnce(async () => {
      lockHeldDuringRun = existsSync(getDaemonLockPath());
    });

    await runDaemonCommand(['run-job', 'nightly']);

    expect(local.runJobCommand).toHaveBeenCalledWith('nightly', { kind: 'builtin' });
    expect(lockHeldDuringRun).toBe(true);
    expect(existsSync(getDaemonLockPath())).toBe(false);
  });

  it('runs a local run-job in the mode resolved for --agent, resolving it only once', async () => {
    const goose = { kind: 'docker', agent: 'goose' } as const;
    vi.mocked(resolveSessionMode).mockClear();
    vi.mocked(resolveSessionMode).mockResolvedValueOnce({ mode: goose } as Awaited<
      ReturnType<typeof resolveSessionMode>
    >);

    await runDaemonCommand(['run-job', 'nightly', '--agent', 'goose']);

    expect(resolveSessionMode).toHaveBeenCalledTimes(1);
    expect(resolveSessionMode).toHaveBeenCalledWith(expect.objectContaining({ requestedAgent: 'goose' }));
    expect(local.runJobCommand).toHaveBeenCalledWith('nightly', goose);
  });

  it('refuses to run locally while a daemon that does not answer holds the lock', async () => {
    holdDaemonLock();
    await expect(runDaemonCommand(['run-job', 'nightly'])).rejects.toMatchObject({ code: 1 });
    expect(local.runJobCommand).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('holds the IronCurtain daemon lock');

    await expect(runDaemonCommand(['remove-job', 'nightly', '--force'])).rejects.toMatchObject({ code: 1 });
    expect(local.runRemoveJob).not.toHaveBeenCalled();
  });

  it('reports a status request the daemon took but did not answer as an error', async () => {
    await startDroppingSocket();
    await expect(runDaemonCommand(['status'])).rejects.toMatchObject({ code: 1 });
    expect(errors.join('\n')).not.toContain('Daemon is not running.');
  });

  it('exits non-zero when another daemon already holds the lock', async () => {
    holdDaemonLock();
    await expect(runDaemonCommand(['--no-signal'])).rejects.toMatchObject({ code: 1 });
    expect(stderr.join('')).toContain('holds the IronCurtain daemon lock');
    expect(existsSync(getDaemonSocketPath())).toBe(false);
  });

  it("prints preflight's host-model warnings when it starts a daemon or runs a job itself, not for other subcommands", async () => {
    const preflight = vi.mocked(resolveSessionMode);
    preflight.mockImplementation(async () => ({
      mode: { kind: 'builtin' },
      reason: 'test',
      warnings: ['Auto-approve is off for this session: its model has no credentials'],
    }));
    const warningLines = (): string[] =>
      stderr
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('Warning:'));
    try {
      // A local run-job prints them, once: its headless session shows them
      // nowhere else, and runJobCommand gets only the mode resolved here.
      await runDaemonCommand(['run-job', 'nightly']);
      expect(local.runJobCommand).toHaveBeenCalledWith('nightly', { kind: 'builtin' });
      expect(warningLines()).toEqual(['Warning: Auto-approve is off for this session: its model has no credentials']);

      // A run the daemon takes is the daemon's (it said them at its start),
      // and status runs no session here.
      stderr.length = 0;
      await startDaemonSocket(makeHandler());
      await runDaemonCommand(['run-job', 'nightly']);
      expect(errors.join('\n')).toContain('Job "nightly" completed via daemon.');
      await runDaemonCommand(['status']);
      expect(errors.join('\n')).toContain('Daemon is running.');
      expect(local.runJobCommand).toHaveBeenCalledTimes(1);
      expect(stderr.join('')).not.toContain('Warning:');
    } finally {
      preflight.mockImplementation(async () => ({ mode: { kind: 'builtin' }, reason: 'test' }));
    }
  });

  it("prints preflight's host-model warnings once when it starts a daemon", async () => {
    vi.mocked(resolveSessionMode).mockResolvedValueOnce({
      mode: { kind: 'builtin' },
      reason: 'test',
      warnings: ['Auto-approve is off for this session: its model has no credentials'],
    });

    // Printed before this start fails on the held lock.
    holdDaemonLock();
    await expect(runDaemonCommand(['--no-signal'])).rejects.toMatchObject({ code: 1 });
    const warnings = stderr
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('Warning:'));
    expect(warnings).toEqual(['Warning: Auto-approve is off for this session: its model has no credentials']);
  });

  it('points out a first-start setup that never ran when it starts a daemon, and only then', async () => {
    // A fresh home (loadConfig is mocked and creates nothing): setup pending.
    // Not for the other subcommands.
    await runDaemonCommand(['list-jobs']);
    expect(stderr.join('')).not.toContain('first-start setup');

    // Printed before this start fails on the held lock.
    holdDaemonLock();
    await expect(runDaemonCommand(['--no-signal'])).rejects.toMatchObject({ code: 1 });
    const notice = stderr
      .join('')
      .split('\n')
      .find((line) => line.includes('first-start setup has not been run'));
    expect(notice).toContain(home);
    expect(notice).toContain('Run `ironcurtain setup` in a terminal');

    // Nor once the wizard has completed.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ setupCompleted: true }));
    stderr.length = 0;
    await expect(runDaemonCommand(['--no-signal'])).rejects.toMatchObject({ code: 1 });
    expect(stderr.join('')).not.toContain('first-start setup');
  });

  it('checks the sandbox and resolves the session mode for none of the job, status and logs commands', async () => {
    const preflight = vi.mocked(resolveSessionMode);
    const sandbox = vi.mocked(ensureSandboxViable);
    preflight.mockClear();
    sandbox.mockClear();
    // As when Docker is down or credentials are missing: not needed here.
    preflight.mockRejectedValue(Object.assign(new Error('Docker is not available.'), { name: 'PreflightError' }));
    try {
      await runDaemonCommand(['list-jobs']);
      await runDaemonCommand(['status']);
      await runDaemonCommand(['logs', 'nightly']);
      await runDaemonCommand(['disable-job', 'nightly']);
      await runDaemonCommand(['enable-job', 'nightly']);
      await runDaemonCommand(['recompile-job', 'nightly']);
      await runDaemonCommand(['remove-job', 'nightly', '--force']);
      // A run the daemon takes runs there: nothing to check in this process.
      await startDaemonSocket(makeHandler());
      await runDaemonCommand(['run-job', 'nightly', '--agent', 'goose']);
    } finally {
      preflight.mockImplementation(async () => ({ mode: { kind: 'builtin' }, reason: 'test' }));
    }
    expect(local.runListJobs).toHaveBeenCalledTimes(1);
    expect(local.runShowLogs).toHaveBeenCalledWith('nightly', 5);
    expect(local.runRemoveJob).toHaveBeenCalledWith('nightly', true);
    expect(errors.join('\n')).toContain('Daemon is not running.');
    expect(errors.join('\n')).toContain('Job "nightly" completed via daemon.');
    expect(local.runJobCommand).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(sandbox).not.toHaveBeenCalled();
    expect(stderr.join('')).not.toContain('Mode:');
  });

  it('checks the sandbox before resolving the mode when it starts a daemon or runs a job itself', async () => {
    const order: string[] = [];
    vi.mocked(ensureSandboxViable).mockImplementation(async () => {
      order.push('sandbox');
    });
    vi.mocked(resolveSessionMode).mockImplementation(async () => {
      order.push('mode');
      return { mode: { kind: 'builtin' }, reason: 'test' };
    });
    try {
      await runDaemonCommand(['run-job', 'nightly']);
      expect(order).toEqual(['sandbox', 'mode']);
      expect(local.runJobCommand).toHaveBeenCalledWith('nightly', { kind: 'builtin' });

      // The start then fails on the held lock, after both checks.
      order.length = 0;
      holdDaemonLock();
      await expect(runDaemonCommand(['--no-signal'])).rejects.toMatchObject({ code: 1 });
      expect(order).toEqual(['sandbox', 'mode']);
    } finally {
      vi.mocked(ensureSandboxViable).mockImplementation(async () => {});
      vi.mocked(resolveSessionMode).mockImplementation(async () => ({ mode: { kind: 'builtin' }, reason: 'test' }));
    }
  });

  it('stops a daemon start at a failed sandbox check, before the mode or any daemon file', async () => {
    // ensureSandboxViable prints the fatal error and exits 1.
    vi.mocked(ensureSandboxViable).mockImplementationOnce(async () => {
      throw new ProcessExit(1);
    });
    vi.mocked(resolveSessionMode).mockClear();
    await expect(runDaemonCommand(['--no-signal'])).rejects.toMatchObject({ code: 1 });
    expect(resolveSessionMode).not.toHaveBeenCalled();
    expect(existsSync(getDaemonLockPath())).toBe(false);
    expect(existsSync(getDaemonSocketPath())).toBe(false);
  });

  it('ends a daemon start whose session mode cannot be resolved with the preflight message, exit 1', async () => {
    vi.mocked(resolveSessionMode).mockRejectedValueOnce(
      Object.assign(new Error('Docker is not available.\n\nRun `ironcurtain doctor` for a full diagnostic.'), {
        name: 'PreflightError',
      }),
    );
    await expect(runDaemonCommand(['--no-signal'])).rejects.toMatchObject({ code: 1 });
    expect(stderr.join('')).toContain('Docker is not available.');
    expect(existsSync(getDaemonLockPath())).toBe(false);
  });
});
