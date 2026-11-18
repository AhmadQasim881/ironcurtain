/**
 * `ironcurtain start` runs the first-start wizard while it has not completed
 * in this home (config.json's `setupCompleted` marker), not merely while
 * config.json is missing: after `doctor`, `mux` or the daemon ran first, the
 * first interactive start still shows it. It never runs without a terminal,
 * nor in a `start --pty` child of mux or the web UI.
 *
 * The wizard, the session factory, the mode preflight and the transport are
 * mocked; the IronCurtain home and its config.json are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REAL_TMP } from './fixtures/test-policy.js';
import type { IronCurtainConfig } from '../src/config/types.js';

const state = vi.hoisted(() => ({
  wizardRuns: 0,
  sessions: 0,
  wizardArgs: [] as unknown[],
  /** What the wizard returns ('completed' or 'declined'). */
  wizardOutcome: 'completed',
}));

vi.mock('../src/config/first-start.js', () => ({
  runFirstStart: (options?: unknown) => {
    state.wizardRuns++;
    state.wizardArgs.push(options);
    return Promise.resolve(state.wizardOutcome);
  },
}));

vi.mock('ora', () => ({
  default: () => ({
    start() {
      return this;
    },
    fail() {},
    succeed() {},
  }),
}));

vi.mock('../src/session/index.js', () => ({
  createStandaloneSession: () => {
    state.sessions++;
    return Promise.reject(new Error('stop after the wizard decision'));
  },
}));

vi.mock('../src/session/preflight.js', () => ({
  resolveSessionMode: () => Promise.resolve({ mode: { kind: 'builtin' }, reason: 'test' }),
  formatModeLine: () => 'Mode: builtin (test)',
}));

vi.mock('../src/session/cli-transport.js', () => ({
  CliTransport: class {
    createEscalationHandler(): () => void {
      return () => {};
    }
    createEscalationExpiredHandler(): () => void {
      return () => {};
    }
    createDiagnosticHandler(): () => void {
      return () => {};
    }
  },
}));

vi.mock('../src/config/tool-annotations-overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/tool-annotations-overlay.js')>()),
  warnOnAnnotationOverlay: () => {},
}));

vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: () => testConfig(),
  loadGeneratedPolicy: () => ({
    compiledPolicy: { rules: [] },
    toolAnnotations: { servers: {} },
    toolAnnotationsOverlay: undefined,
  }),
  checkConstitutionFreshness: () => {},
  checkAnnotationFreshness: () => {},
}));

import { main } from '../src/index.js';

const TEST_HOME = `${REAL_TMP}/ironcurtain-start-first-run-test-${process.pid}`;

function testConfig(): IronCurtainConfig {
  return {
    agentModelId: 'anthropic:claude-sonnet-4-6',
    protectedPaths: [],
    mcpServers: {},
    generatedDir: resolve(TEST_HOME, 'generated'),
    constitutionPath: resolve(TEST_HOME, 'constitution.md'),
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      memory: { enabled: false, autoSave: false },
    },
  } as unknown as IronCurtainConfig;
}

function writeUserConfig(content: Record<string, unknown>): void {
  writeFileSync(resolve(TEST_HOME, 'config.json'), JSON.stringify(content));
}

/** Runs `ironcurtain start <args>` until it stops (at session creation, or the PTY mode check). */
async function start(args: string[]): Promise<void> {
  await expect(main(args)).rejects.toThrow('process.exit(1)');
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

describe('ironcurtain start: first-start wizard', () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  let signalListeners: Record<(typeof SIGNALS)[number], number>;

  function setInteractive(isTTY: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true, writable: true });
  }

  beforeEach(() => {
    process.env['IRONCURTAIN_HOME'] = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
    state.wizardRuns = 0;
    state.sessions = 0;
    state.wizardArgs = [];
    state.wizardOutcome = 'completed';
    setInteractive(true);
    signalListeners = { SIGINT: 0, SIGTERM: 0, SIGHUP: 0 };
    for (const signal of SIGNALS) signalListeners[signal] = process.listenerCount(signal);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // start's interrupt handlers stay installed when the mocked exit throws.
    for (const signal of SIGNALS) {
      for (const listener of process.listeners(signal).slice(signalListeners[signal])) {
        process.removeListener(signal, listener);
      }
    }
    if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    delete process.env['IRONCURTAIN_HOME'];
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('runs on a fresh home before the session', async () => {
    await start(['do the task']);

    expect(state.wizardRuns).toBe(1);
    expect(state.sessions).toBe(1);
  });

  it('runs in start mode, so declining it skips setup but not the task', async () => {
    state.wizardOutcome = 'declined';

    await start(['do the task']);

    expect(state.wizardArgs).toEqual([{ mode: 'start' }]);
    expect(state.sessions).toBe(1);
  });

  it('still runs after another command created config.json (doctor, mux or the daemon ran first)', async () => {
    writeUserConfig({ setupCompleted: false, agentModelId: 'anthropic:claude-sonnet-4-6' });

    await start(['do the task']);

    expect(state.wizardRuns).toBe(1);
  });

  it('does not run once the wizard has completed', async () => {
    writeUserConfig({ setupCompleted: true });

    await start(['do the task']);

    expect(state.wizardRuns).toBe(0);
    expect(state.sessions).toBe(1);
  });

  it('does not run for a config.json from before the marker', async () => {
    writeUserConfig({ agentModelId: 'anthropic:claude-sonnet-4-6' });

    await start(['do the task']);

    expect(state.wizardRuns).toBe(0);
  });

  it('does not run without a terminal', async () => {
    setInteractive(false);

    await start(['do the task']);

    expect(state.wizardRuns).toBe(0);
    expect(state.sessions).toBe(1);
  });

  it('does not run in a `start --pty` child (mux and the web UI tabs)', async () => {
    // The test preflight resolves builtin mode, so the PTY child stops at its mode check.
    await start(['--pty', '--agent', 'claude-code']);

    expect(state.wizardRuns).toBe(0);
  });
});
