/**
 * The daemon's side of retention: the automatic prune is off unless
 * `retention.autoPrune` is set, runs shortly after start when it is, and
 * daemon.log rotates by size (`retention.logs`).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDaemonLogPath, getSessionsDir } from '../src/config/paths.js';
import {
  RETENTION_CONFIG_DEFAULTS,
  loadUserConfig,
  type ResolvedRetentionConfig,
  type ResolvedUserConfig,
} from '../src/config/user-config.js';
import { isDaemonRunning } from '../src/daemon/control-socket.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';

vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
vi.mock('../src/config/user-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/user-config.js')>()),
  loadUserConfig: vi.fn(),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function useRetention(retention: ResolvedRetentionConfig): void {
  vi.mocked(loadUserConfig).mockReturnValue({
    statistics: { enabled: false, retentionDays: null },
    retention,
  } as unknown as ResolvedUserConfig);
}

/** An old, idle session directory with nothing holding it. */
function makeOldSession(id: string): string {
  const dir = join(getSessionsDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.log'), 'done\n');
  const when = new Date(Date.now() - 90 * DAY_MS);
  utimesSync(join(dir, 'session.log'), when, when);
  utimesSync(dir, when, when);
  return dir;
}

describe('IronCurtainDaemon retention', () => {
  let home: string;
  let savedHome: string | undefined;
  let running: { daemon: IronCurtainDaemon; done: Promise<void> } | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-daemon-prune-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // start-up banner
  });

  afterEach(async () => {
    if (running) {
      await running.daemon.shutdown();
      await running.done;
      running = undefined;
    }
    vi.restoreAllMocks();
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function startDaemon(): Promise<void> {
    const daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true, autoPruneStartDelayMs: 0 });
    running = { daemon, done: daemon.start() };
    await waitUntil(() => isDaemonRunning());
  }

  it('prunes shortly after start when retention.autoPrune is set, and logs what it removed', async () => {
    useRetention({ ...RETENTION_CONFIG_DEFAULTS, autoPrune: true });
    const dir = makeOldSession('idle-session');
    await startDaemon();
    await waitUntil(() => !existsSync(dir));
    await waitUntil(() => readFileSync(getDaemonLogPath('daemon'), 'utf8').includes('Prune removed 1 session'));
  });

  it('never prunes on its own by default', async () => {
    useRetention(RETENTION_CONFIG_DEFAULTS);
    const dir = makeOldSession('idle-session');
    await startDaemon();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(getDaemonLogPath('daemon'), 'utf8')).not.toContain('Prune');
  });

  it('rotates daemon.log by size', async () => {
    useRetention({ ...RETENTION_CONFIG_DEFAULTS, logs: { maxBytes: 64 * 1024, maxFiles: 2 } });
    const log = getDaemonLogPath('daemon');
    mkdirSync(join(home, 'logs'), { recursive: true });
    writeFileSync(log, 'old line\n'.repeat(10_000));
    await startDaemon();
    expect(readFileSync(`${log}.1`, 'utf8')).toContain('old line');
    expect(readFileSync(log, 'utf8')).not.toContain('old line');
  });
});
