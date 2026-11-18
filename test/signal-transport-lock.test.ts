/**
 * One Signal transport per IronCurtain home. `ironcurtain bot`, and
 * `ironcurtain daemon` unless `--no-signal`, attach to the same signal-cli
 * container and receive stream: two of them would both handle each incoming
 * message (two agent sessions for one task) or split the messages, and both
 * would manage the same container. The second one is refused and told which
 * process runs the transport: a second bot exits 1 before it touches the
 * container, and a daemon starts without Signal (cron-only).
 *
 * The Signal bot daemon, its container manager, the sandbox check and the
 * session-mode preflight are fakes; the IronCurtain home, the logger and the
 * locks are real.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signal = vi.hoisted(() => ({
  config: {
    botNumber: '+15550000001',
    recipientNumber: '+15550000002',
    recipientIdentityKey: 'test-identity-key',
    container: {
      image: 'signal-cli-rest-api:test',
      port: 18080,
      dataDir: '/nonexistent/signal-data',
      containerName: 'ironcurtain-signal',
    },
    maxConcurrentSessions: 3,
  },
  /** Every fake transport constructed, in order. */
  transports: [] as Array<{ connected: boolean; shutdown(): Promise<void> }>,
  /** The container start of the (fake) container manager. */
  ensureRunning: vi.fn(async () => 'http://127.0.0.1:18080'),
  /** Thrown by the session-mode preflight when set. */
  preflightError: undefined as Error | undefined,
}));

vi.mock('../src/signal/signal-bot-daemon.js', () => ({
  SignalBotDaemon: class {
    connected = false;
    private exitRun: (() => void) | undefined;
    private readonly containerManager: { ensureRunning(): Promise<string> };

    constructor(options: { containerManager: { ensureRunning(): Promise<string> } }) {
      this.containerManager = options.containerManager;
      signal.transports.push(this);
    }

    async connect(): Promise<void> {
      await this.containerManager.ensureRunning();
      this.connected = true;
    }

    run(): Promise<void> {
      return new Promise((resolve) => {
        this.exitRun = resolve;
      });
    }

    async start(): Promise<void> {
      await this.connect();
      await this.run();
    }

    shutdown(): Promise<void> {
      this.connected = false;
      this.exitRun?.();
      return Promise.resolve();
    }

    sendSignalMessage(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock('../src/signal/signal-container.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/signal/signal-container.js')>()),
  createSignalContainerManager: () => ({
    ensureRunning: signal.ensureRunning,
    waitForHealthy: async () => {},
    teardown: async () => {},
    exists: async () => true,
    isRunning: async () => true,
  }),
}));
vi.mock('../src/docker/docker-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/docker-manager.js')>()),
  createDockerManager: () => ({}),
}));
vi.mock('../src/signal/signal-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/signal/signal-config.js')>()),
  resolveSignalConfig: () => signal.config,
}));
vi.mock('../src/config/user-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/user-config.js')>()),
  loadUserConfig: () => ({ statistics: { enabled: false, retentionDays: null } }),
}));
vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: () => ({}),
}));
vi.mock('../src/session/preflight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/session/preflight.js')>()),
  resolveSessionMode: () => {
    if (signal.preflightError) return Promise.reject(signal.preflightError);
    return Promise.resolve({ mode: { kind: 'builtin' }, reason: 'test' });
  },
}));
vi.mock('../src/utils/preflight-checks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/preflight-checks.js')>()),
  ensureSandboxViable: async () => {},
}));
vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));

import { sendControlRequest, type DaemonStatusDto } from '../src/daemon/control-socket.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';
import { PreflightError } from '../src/session/preflight.js';
import { runBot } from '../src/signal/bot-command.js';

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** `promise`, or 'still running' when it has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms = 3_000): Promise<T | 'still running'> {
  return Promise.race([
    promise,
    new Promise<'still running'>((resolve) => setTimeout(resolve, ms, 'still running').unref()),
  ]);
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

describe('one Signal transport per IronCurtain home', () => {
  let home: string;
  let savedHome: string | undefined;
  let stderr: string[];
  let listenersBefore: Record<(typeof SIGNALS)[number], Set<unknown>>;
  /** Bots and daemons started by the test, stopped in afterEach. */
  const running: Array<Promise<unknown>> = [];
  const daemons: IronCurtainDaemon[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-signal-lock-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    signal.transports.length = 0;
    signal.ensureRunning.mockReset();
    signal.preflightError = undefined;
    listenersBefore = {
      SIGINT: new Set(process.listeners('SIGINT')),
      SIGTERM: new Set(process.listeners('SIGTERM')),
      SIGHUP: new Set(process.listeners('SIGHUP')),
    };
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitCalled(code);
    });
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.shutdown();
    // A bot's start() returns once its transport has shut down.
    for (const transport of signal.transports) await transport.shutdown();
    await Promise.allSettled(running.splice(0));
    vi.restoreAllMocks();
    for (const signalName of SIGNALS) {
      for (const listener of process.listeners(signalName)) {
        if (!listenersBefore[signalName].has(listener)) process.off(signalName, listener);
      }
    }
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** Starts `ironcurtain bot` and waits until its transport is connected. */
  async function startBot(): Promise<void> {
    const index = signal.transports.length;
    const run = runBot();
    running.push(run.catch(() => {}));
    await vi.waitFor(() => expect(signal.transports[index]?.connected).toBe(true));
  }

  /** Starts a daemon with the Signal transport enabled and waits until its start-up is complete. */
  async function startDaemon(): Promise<IronCurtainDaemon> {
    const daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' } });
    daemons.push(daemon);
    running.push(daemon.start().catch(() => {}));
    await vi.waitFor(() => expect(stderr.join('')).toContain('IronCurtain daemon started.'), { timeout: 10_000 });
    return daemon;
  }

  async function daemonStatus(): Promise<DaemonStatusDto> {
    const result = await sendControlRequest({ command: 'status' });
    if (result.kind !== 'response' || !result.response.ok) throw new Error('no status from the daemon');
    return result.response.data as DaemonStatusDto;
  }

  it('refuses a second ironcurtain bot before it touches the container, naming the one running', async () => {
    await startBot();

    await expect(within(runBot())).rejects.toMatchObject({ code: 1 });

    expect(signal.ensureRunning).toHaveBeenCalledTimes(1);
    expect(signal.transports).toHaveLength(1);
    expect(stderr.join('')).toContain(`Process ${process.pid} holds the IronCurtain Signal lock`);
  });

  it('refuses ironcurtain bot beside a daemon that runs the Signal transport', async () => {
    await startDaemon();
    expect(signal.transports[0]?.connected).toBe(true);

    await expect(within(runBot())).rejects.toMatchObject({ code: 1 });

    expect(signal.ensureRunning).toHaveBeenCalledTimes(1);
    expect(stderr.join('')).toContain(`Process ${process.pid} holds the IronCurtain Signal lock`);
  });

  it('starts a daemon beside a running bot without Signal (cron-only), saying who runs it', async () => {
    await startBot();

    await startDaemon();

    expect(signal.ensureRunning).toHaveBeenCalledTimes(1);
    expect(signal.transports).toHaveLength(1);
    const written = stderr.join('');
    expect(written).toContain(`Signal transport not started: Process ${process.pid} holds the IronCurtain Signal lock`);
    expect(written).not.toContain('Signal transport: connected');
    expect((await daemonStatus()).signalConnected).toBe(false);
  });

  it('frees the transport when a bot or a daemon stops, so the next one can start', async () => {
    await startBot();
    await signal.transports[0].shutdown();
    await Promise.allSettled(running);

    const daemon = await startDaemon();
    expect(signal.transports[1]?.connected).toBe(true);
    expect(stderr.join('')).toContain('Signal transport: connected');
    await daemon.shutdown();

    await startBot();
    expect(signal.ensureRunning).toHaveBeenCalledTimes(3);
  });

  it('frees the transport when the daemon fails to start Signal', async () => {
    signal.ensureRunning.mockRejectedValueOnce(new Error('signal-cli container did not start'));
    await startDaemon();
    expect(stderr.join('')).not.toContain('Signal transport: connected');

    await startBot();
    expect(signal.ensureRunning).toHaveBeenCalledTimes(2);
  });

  it('prints a preflight error of ironcurtain bot as its message and exits 1, freeing the transport', async () => {
    signal.preflightError = new PreflightError('--agent claude-code requires container mode, but Docker is down.');

    await expect(within(runBot({ agent: 'claude-code' }))).rejects.toMatchObject({ code: 1 });

    const written = stderr.join('');
    expect(written).toContain('--agent claude-code requires container mode, but Docker is down.');
    expect(written).toContain('Run `ironcurtain doctor` for a full diagnostic.');
    expect(written).not.toMatch(/^\s+at /m);
    expect(signal.ensureRunning).not.toHaveBeenCalled();
    // The bot gave back its log claim and the Signal transport before exiting.
    expect(logger.isActive()).toBe(false);
    signal.preflightError = undefined;
    await startBot();
  });
});
