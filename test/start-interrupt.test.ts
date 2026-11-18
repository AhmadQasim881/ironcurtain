/**
 * `ironcurtain start` interrupt handling (DINF-13) and exit status. Before
 * DINF-13, SIGINT had no handler until a batch session existed (and none at
 * all in --pty mode), so a Ctrl-C during image preparation or container
 * startup killed the process without teardown. The entry point now handles
 * interrupts before the image is prepared: an interrupt during the build
 * exits without creating any container, and an interrupted session setup
 * exits after its teardown.
 *
 * A session's run sets the exit status: 0 when it completes, 1 when the task
 * fails or a budget stops it, 128 plus the signal number when an interrupt
 * ends it (after the one session close, whoever started it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ensureDockerImage: vi.fn(),
  runPtySession: vi.fn(),
  createStandaloneSession: vi.fn(),
  compileTaskScopePolicy: vi.fn(),
  transportRun: vi.fn<(session: unknown) => Promise<void>>(async () => {}),
}));

vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadConfig: () => ({
    userConfig: { modelProviders: { default: 'native' } },
    protectedPaths: [],
    mcpServers: {},
    generatedDir: '/nonexistent',
    constitutionPath: '/nonexistent',
  }),
  loadGeneratedPolicy: () => ({ compiledPolicy: {}, toolAnnotations: {}, toolAnnotationsOverlay: undefined }),
  checkConstitutionFreshness: () => {},
  checkAnnotationFreshness: () => {},
  getPackageGeneratedDir: () => '/nonexistent',
}));
vi.mock('../src/config/tool-annotations-overlay.js', () => ({ warnOnAnnotationOverlay: () => {} }));
vi.mock('../src/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUserConfigPath: () => '/',
}));
vi.mock('../src/session/preflight.js', () => ({
  resolveSessionMode: async () => ({ mode: { kind: 'docker', agent: 'claude-code' } }),
  formatModeLine: () => 'mode',
}));
vi.mock('../src/docker-workload/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  formatDockerWorkloadStatus: () => undefined,
}));
vi.mock('../src/memory/auto-save.js', () => ({ shouldAutoSaveMemory: () => false }));
vi.mock('../src/docker/docker-infrastructure.js', () => ({ ensureDockerImage: state.ensureDockerImage }));
vi.mock('../src/docker/pty-session.js', () => ({ runPtySession: state.runPtySession }));
vi.mock('../src/session/index.js', () => ({ createStandaloneSession: state.createStandaloneSession }));
vi.mock('../src/cron/compile-task-policy.js', () => ({
  compileTaskScopePolicy: state.compileTaskScopePolicy,
  formatTaskScopeSummary: () => [],
}));
vi.mock('../src/session/cli-transport.js', () => ({
  CliTransport: class {
    createEscalationHandler = () => () => {};
    createEscalationExpiredHandler = () => () => {};
    createDiagnosticHandler = () => () => {};
    close(): void {}
    run = (session: unknown): Promise<void> => state.transportRun(session);
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

import { main } from '../src/index.js';
import { BudgetExhaustedError, SessionClosedError } from '../src/types/errors.js';

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** The SIGINT listener main() installed. */
function startListener(before: ReadonlySet<unknown>): () => void {
  const listener = process.listeners('SIGINT').find((candidate) => !before.has(candidate));
  if (!listener) throw new Error('main installed no SIGINT handler');
  return listener as () => void;
}

describe('ironcurtain start interrupts', () => {
  let before: Set<unknown>;

  beforeEach(() => {
    before = new Set<unknown>(process.listeners('SIGINT'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitCalled(code);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    state.ensureDockerImage.mockReset();
    state.runPtySession.mockReset();
    state.createStandaloneSession.mockReset();
    state.compileTaskScopePolicy.mockReset();
    state.transportRun.mockReset();
    // main() exits through the mocked process.exit; drop what it left installed.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before.has(listener)) process.off(signal, listener);
      }
    }
  });

  for (const pty of [true, false]) {
    it(`creates no container when Ctrl-C arrives during the image build (${pty ? 'pty' : 'batch'})`, async () => {
      // The build finishes (or fails) after the interrupt; neither may proceed.
      state.ensureDockerImage.mockImplementation(async () => {
        startListener(before)();
        return { image: 'ironcurtain-claude-code:latest' };
      });

      const run = main(pty ? ['--pty'] : ['task']);

      await expect(run).rejects.toMatchObject({ code: 130 });
      expect(state.runPtySession).not.toHaveBeenCalled();
      expect(state.createStandaloneSession).not.toHaveBeenCalled();
    });
  }

  it('exits after a failed build that the interrupt caused', async () => {
    state.ensureDockerImage.mockImplementation(async () => {
      startListener(before)();
      throw new Error('docker build: context canceled');
    });

    await expect(main(['--pty'])).rejects.toMatchObject({ code: 130 });
    expect(state.runPtySession).not.toHaveBeenCalled();
  });

  it('exits with the signal status when PTY setup was interrupted', async () => {
    state.ensureDockerImage.mockResolvedValue({ image: 'ironcurtain-claude-code:latest' });
    state.runPtySession.mockImplementation(async () => {
      // runPtySession owns interrupts once it runs: main handed them over.
      expect(process.listeners('SIGINT').filter((listener) => !before.has(listener))).toEqual([]);
      throw Object.assign(new Error('PTY session interrupted by SIGTERM'), {
        code: 'PTY_INTERRUPTED',
        signal: 'SIGTERM',
      });
    });

    await expect(main(['--pty'])).rejects.toMatchObject({ code: 143 });
  });

  it('cancels a --task-scoped compile on Ctrl-C and starts nothing', async () => {
    state.compileTaskScopePolicy.mockImplementation(async (_task: string, options: { signal?: AbortSignal }) => {
      expect(options.signal?.aborted).toBe(false);
      startListener(before)();
      expect(options.signal?.aborted).toBe(true);
      // The pipeline's LLM calls observe the signal; the compile rejects.
      throw new Error('This operation was aborted');
    });

    await expect(main(['--task-scoped', 'Summarize the notes'])).rejects.toMatchObject({ code: 130 });
    expect(state.ensureDockerImage).not.toHaveBeenCalled();
    expect(state.createStandaloneSession).not.toHaveBeenCalled();
    const written = vi
      .mocked(process.stderr.write)
      .mock.calls.map((call) => String(call[0]))
      .join('');
    expect(written).toContain('Interrupted before the session started');
    expect(written).not.toContain('Could not prepare the task scope');
  });

  it('starts nothing when Ctrl-C arrives as a --task-scoped compile completes', async () => {
    state.compileTaskScopePolicy.mockImplementation(async () => {
      startListener(before)();
      return { policyDir: '/nonexistent/task-policies/scope', policy: { rules: [] }, cached: true };
    });

    await expect(main(['--pty', '--task-scoped', 'Summarize the notes'])).rejects.toMatchObject({ code: 130 });
    expect(state.ensureDockerImage).not.toHaveBeenCalled();
    expect(state.runPtySession).not.toHaveBeenCalled();
  });

  it('passes the interrupt signal to batch session setup and exits after its teardown', async () => {
    state.ensureDockerImage.mockResolvedValue({ image: 'ironcurtain-claude-code:latest' });
    state.createStandaloneSession.mockImplementation(async (options: { abortSignal?: AbortSignal }) => {
      expect(options.abortSignal?.aborted).toBe(false);
      startListener(before)();
      expect(options.abortSignal?.aborted).toBe(true);
      // The factory tears down what it created and rejects.
      throw new Error('Docker session failed: aborted');
    });

    await expect(main(['task'])).rejects.toMatchObject({ code: 130 });
  });
});

describe('ironcurtain start exit status', () => {
  let before: Set<unknown>;
  /** The codes main() passed to process.exit, in order. */
  let exitCodes: Array<number | string | null | undefined>;

  beforeEach(() => {
    before = new Set<unknown>(process.listeners('SIGINT'));
    exitCodes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      exitCodes.push(code);
      throw new ExitCalled(code);
    });
    state.ensureDockerImage.mockResolvedValue({ image: 'ironcurtain-claude-code:latest' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    state.ensureDockerImage.mockReset();
    state.createStandaloneSession.mockReset();
    state.transportRun.mockReset();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before.has(listener)) process.off(signal, listener);
      }
    }
  });

  /**
   * The created session. Like the real ones, its first close() tears down
   * (until `finishClose` with `holdClose`) and a later call returns at once.
   */
  function fakeSession(options: { holdClose?: boolean } = {}) {
    let finishClose: () => void = () => {};
    let closing = false;
    const close = vi.fn((): Promise<void> => {
      if (closing) return Promise.resolve();
      closing = true;
      return new Promise<void>((resolve) => {
        finishClose = resolve;
        if (!options.holdClose) resolve();
      });
    });
    const session = { getInfo: () => ({ id: 'session-under-test' }), close };
    state.createStandaloneSession.mockResolvedValue(session);
    return { close, finishClose: () => finishClose() };
  }

  it('exits 0 when the task completes', async () => {
    const { close } = fakeSession();

    await expect(main(['Summarize the notes'])).rejects.toMatchObject({ code: 0 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when a budget stops the task', async () => {
    // CliTransport has printed the error and the session summary; the exit
    // status must still say that the task did not complete.
    const { close } = fakeSession();
    state.transportRun.mockRejectedValue(new BudgetExhaustedError('steps', 'Step limit reached (200 steps)'));

    await expect(main(['Summarize the notes'])).rejects.toMatchObject({ code: 1 });
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([1]);
  });

  it('exits 1 when the task fails', async () => {
    const { close } = fakeSession();
    state.transportRun.mockRejectedValue(new Error('provider returned 529 overloaded'));

    await expect(main(['Summarize the notes'])).rejects.toMatchObject({ code: 1 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits with the signal status once the session an interrupt closed has finished closing', async () => {
    // Ctrl-C mid-task: the interrupt closes the session, which ends the turn
    // (SessionClosedError). Neither the interrupt nor the end of the run may
    // exit before that one close has finished, and both report 130.
    vi.mocked(process.exit).mockImplementation((code) => {
      exitCodes.push(code);
      return undefined as never;
    });
    const { close, finishClose } = fakeSession({ holdClose: true });
    state.transportRun.mockImplementation(async () => {
      startListener(before)();
      throw new SessionClosedError();
    });

    const run = main(['Summarize the notes']);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    // Give the rejected run every chance to reach its exit.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exitCodes).toEqual([]);

    finishClose();
    await run;
    expect(exitCodes.length).toBeGreaterThan(0);
    expect(new Set(exitCodes)).toEqual(new Set([130]));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
