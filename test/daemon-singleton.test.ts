/**
 * IronCurtainDaemon.start() enforces one daemon per IronCurtain home: it takes
 * the daemon lock before anything else, a second daemon fails without
 * touching the first one's control socket, and a control socket that cannot
 * be bound is fatal (and gives the lock back).
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDaemonLockPath, getDaemonLogPath, getDaemonSocketPath } from '../src/config/paths.js';
import { saveJob } from '../src/cron/job-store.js';
import { createJobId } from '../src/cron/types.js';
import type { ResolvedUserConfig } from '../src/config/user-config.js';
import {
  isDaemonRunning,
  parseDaemonWebUiState,
  sendControlRequest,
  type DaemonWebUiState,
} from '../src/daemon/control-socket.js';
import { acquireDaemonLock } from '../src/daemon/daemon-lock.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';

vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
vi.mock('../src/config/user-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/user-config.js')>()),
  loadUserConfig: vi.fn(
    () => ({ statistics: { enabled: false, retentionDays: null } }) as unknown as ResolvedUserConfig,
  ),
}));

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function newDaemon(webUi?: { port?: number }): IronCurtainDaemon {
  return new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true, ...(webUi ? { webUi } : {}) });
}

/** What the daemon reports about its web UI over the control socket. */
async function reportedWebUi(): Promise<DaemonWebUiState | undefined> {
  const result = await sendControlRequest({ command: 'status' });
  return result.kind === 'response' ? parseDaemonWebUiState(result.response) : undefined;
}

/** Replaces the daemon's (private) web UI start-up so no real server is bound. */
function stubWebUiStart(impl: () => Promise<void>): void {
  vi.spyOn(
    IronCurtainDaemon.prototype as unknown as { startWebUiServer(): Promise<void> },
    'startWebUiServer',
  ).mockImplementation(impl);
}

describe('IronCurtainDaemon singleton', () => {
  let home: string;
  let savedHome: string | undefined;
  const started: Array<{ daemon: IronCurtainDaemon; running: Promise<void> }> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-daemon-singleton-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // start-up banner
  });

  afterEach(async () => {
    for (const { daemon, running } of started.splice(0)) {
      await daemon.shutdown();
      await running;
    }
    vi.restoreAllMocks();
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function startDaemon(webUi?: { port?: number }): Promise<IronCurtainDaemon> {
    const daemon = newDaemon(webUi);
    const running = daemon.start();
    started.push({ daemon, running });
    await waitUntil(() => isDaemonRunning());
    return daemon;
  }

  it('reports its web UI as disabled when started without one', async () => {
    await startDaemon();
    expect(await reportedWebUi()).toBe('disabled');
  });

  it('reports its web UI as starting while the control socket is already up, then listening', async () => {
    let webUiUp: () => void = () => {};
    stubWebUiStart(() => new Promise<void>((resolve) => (webUiUp = resolve)));
    await startDaemon({ port: 0 });
    try {
      expect(await reportedWebUi()).toBe('starting');
    } finally {
      webUiUp(); // start() (and so shutdown in afterEach) waits on it
    }
    await waitUntil(async () => (await reportedWebUi()) === 'listening');
  });

  it('reports its web UI as unavailable when it failed to start', async () => {
    stubWebUiStart(() => Promise.reject(new Error('port 7400 in use')));
    await startDaemon({ port: 0 });
    await waitUntil(async () => (await reportedWebUi()) === 'unavailable');
  });

  it('refuses a second daemon on the same home and leaves the first one reachable', async () => {
    await startDaemon();
    expect(existsSync(getDaemonLockPath())).toBe(true);

    await expect(newDaemon().start()).rejects.toMatchObject({ code: 'DAEMON_LOCK_BUSY', ownerPid: process.pid });
    expect(await isDaemonRunning()).toBe(true);
  });

  it('gives the lock and the socket back on shutdown, so a new daemon can start', async () => {
    const first = await startDaemon();
    await first.shutdown();
    await started.splice(0, 1)[0].running;
    expect(existsSync(getDaemonLockPath())).toBe(false);
    expect(existsSync(getDaemonSocketPath())).toBe(false);

    await startDaemon();
    expect(await isDaemonRunning()).toBe(true);
  });

  it('serves its control socket 0600 from an owner-only home', async () => {
    chmodSync(home, 0o755);
    await startDaemon();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(lstatSync(getDaemonSocketPath()).mode & 0o777).toBe(0o600);
  });

  it('treats a control socket it cannot bind as fatal and releases the lock', async () => {
    mkdirSync(getDaemonSocketPath()); // something that is not a socket and cannot be replaced
    await expect(newDaemon().start()).rejects.toThrow();
    expect(existsSync(getDaemonLockPath())).toBe(false);
    expect(await isDaemonRunning()).toBe(false);
    acquireDaemonLock().release(); // free for the next daemon
  });

  it("keeps its own lines in daemon.log while a session's logger claim is the newest", async () => {
    // A session started by one of the daemon's services claims its own log
    // on top of the daemon's. The daemon's claim is process-wide, so a control
    // request handled meanwhile -- and the shutdown -- still log to
    // daemon.log, not into the session's file.
    await saveJob({
      id: createJobId('log-job'),
      name: 'Log job',
      schedule: '0 9 * * *',
      taskDescription: 'Nothing',
      taskConstitution: 'Nothing',
      notifyOnEscalation: false,
      notifyOnCompletion: false,
      enabled: true,
    });
    const daemon = await startDaemon();
    const sessionLog = join(home, 'live-session.log');
    const session = logger.setup({ logFilePath: sessionLog });
    try {
      const result = await sendControlRequest({ command: 'disable-job', jobId: 'log-job' });
      expect(result.kind).toBe('response');
      await daemon.shutdown();
    } finally {
      logger.release(session);
    }

    const daemonLog = readFileSync(getDaemonLogPath('daemon'), 'utf8');
    expect(daemonLog).toContain('[Daemon] Disabled job log-job');
    expect(daemonLog).toContain('[Daemon] Shutting down...');
    expect(readFileSync(sessionLog, 'utf8')).not.toContain('[Daemon]');
    // The daemon gave back its claim at shutdown; the session gave back its own.
    expect(logger.isActive()).toBe(false);
  });
});
