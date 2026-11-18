/**
 * `workflow <cmd> --ensure-daemon` must never start a second daemon: when the
 * web UI endpoint is not reachable but a daemon answers (or merely takes the
 * connection) on its control socket, the command spawns nothing. It waits for
 * a web UI the daemon reports as still starting, and otherwise reports
 * DAEMON_WITHOUT_WEB_UI instead of spawning `ironcurtain daemon --web-ui`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDaemonSocketPath, getWebUiStatePath } from '../../src/config/paths.js';
import {
  ControlSocketServer,
  type ControlRequestHandler,
  type DaemonStatus,
  type DaemonWebUiState,
} from '../../src/daemon/control-socket.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { WebUiServer } from '../../src/web-ui/web-ui-server.js';
import { runDaemonGateCommand } from '../../src/workflow/daemon-gate-commands.js';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: childProcess.spawn,
}));

/** `webUi: null` models a daemon that predates the field (its status has no `webUi`). */
function makeHandler(webUi: DaemonWebUiState | null): ControlRequestHandler {
  return {
    getStatus: vi.fn((): DaemonStatus => ({
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0, failing: 0 },
      failingJobs: [],
      signalConnected: false,
      nextFireTime: null,
      ...(webUi === null ? {} : { webUi }),
    })),
    removeJob: vi.fn(async () => {}),
    enableJob: vi.fn(async () => {}),
    disableJob: vi.fn(async () => {}),
    recompileJob: vi.fn(async () => ({ failedServers: [] })),
    refreshLists: vi.fn(),
    reloadJob: vi.fn(async () => {}),
    startJobRun: vi.fn(),
    runJobNow: vi.fn(),
    listJobs: vi.fn(() => []),
  };
}

describe('--ensure-daemon with a daemon that has no reachable web UI', () => {
  let home: string;
  let savedHome: string | undefined;
  let stdout: string[];
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ic-ensure-daemon-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home; // no web-ui.json here
    stdout = [];
    childProcess.spawn.mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  function lastJson(): Record<string, unknown> {
    const line = stdout.join('').trim().split('\n').pop() ?? '';
    return JSON.parse(line) as Record<string, unknown>;
  }

  async function startControlSocket(handler: ControlRequestHandler): Promise<void> {
    const server = new ControlSocketServer(handler);
    await server.start();
    cleanups.push(() => server.stop());
  }

  it('reports DAEMON_WITHOUT_WEB_UI and spawns nothing when a daemon answers on its control socket', async () => {
    await startControlSocket(makeHandler('disabled'));

    const startedAt = Date.now();
    const exitCode = await runDaemonGateCommand('status', ['wf-1', '--json', '--ensure-daemon']);

    expect(exitCode).toBe(1);
    expect(lastJson()).toMatchObject({
      ok: false,
      error: 'DAEMON_WITHOUT_WEB_UI',
      hint: expect.stringContaining('started without --web-ui'),
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(Date.now() - startedAt).toBeLessThan(5_000); // at once, not after the start-up wait
  });

  it('reports DAEMON_WITHOUT_WEB_UI at once for a daemon whose web UI failed to start, or that does not say', async () => {
    await startControlSocket(makeHandler('unavailable'));
    expect(await runDaemonGateCommand('status', ['wf-1', '--json', '--ensure-daemon'])).toBe(1);
    expect(lastJson()).toMatchObject({
      error: 'DAEMON_WITHOUT_WEB_UI',
      hint: expect.stringContaining('failed to start'),
    });
    await cleanups.splice(0)[0]();

    const legacy = makeHandler(null);
    await startControlSocket(legacy);
    expect(await runDaemonGateCommand('status', ['wf-1', '--json', '--ensure-daemon'])).toBe(1);
    expect(legacy.getStatus).toHaveBeenCalled();
    expect(lastJson()).toMatchObject({
      error: 'DAEMON_WITHOUT_WEB_UI',
      hint: expect.stringContaining('was it started without --web-ui?'),
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('waits for the web UI of a daemon that is still starting instead of failing or spawning another', async () => {
    // The daemon binds its control socket before it starts Signal and the web
    // UI, so a concurrent --ensure-daemon (or one racing a daemon start) finds
    // the socket answering while web-ui.json does not exist yet.
    const handler = makeHandler('starting');
    await startControlSocket(handler);
    const webUi = new WebUiServer({
      port: 0,
      host: '127.0.0.1',
      handler,
      sessionManager: new SessionManager(),
      mode: { kind: 'builtin' },
      maxConcurrentWebSessions: 1,
    });
    cleanups.push(() => webUi.stop());
    setTimeout(() => {
      void webUi.start().then(() => {
        writeFileSync(
          getWebUiStatePath(),
          JSON.stringify({ port: webUi.getPort(), host: '127.0.0.1', token: webUi.getAuthToken() }) + '\n',
          { mode: 0o600 },
        );
      });
    }, 400);

    await runDaemonGateCommand('status', ['wf-1', '--json', '--ensure-daemon']);

    // The web UI's own RPC answered (this bare server has no workflow manager),
    // so the command connected rather than failing to find a daemon.
    expect(lastJson()).toMatchObject({ ok: false, message: 'Workflow system not available' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('does not spawn a second daemon when the control socket takes the connection but does not answer', async () => {
    const server: Server = createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(getDaemonSocketPath(), resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const exitCode = await runDaemonGateCommand('await', ['wf-1', '--json', '--ensure-daemon']);

    expect(exitCode).toBe(1);
    expect(lastJson()).toMatchObject({
      ok: false,
      error: 'DAEMON_WITHOUT_WEB_UI',
      hint: expect.stringContaining('did not answer'),
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('still reports DAEMON_NOT_RUNNING without --ensure-daemon', async () => {
    const exitCode = await runDaemonGateCommand('status', ['wf-1', '--json']);
    expect(exitCode).toBe(1);
    expect(lastJson()).toMatchObject({ ok: false, error: 'DAEMON_NOT_RUNNING' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
