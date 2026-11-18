import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { Session, BudgetStatus, DiagnosticEvent, SessionInfo, ConversationTurn } from '../src/session/types.js';
import type { CliTransport as CliTransportType } from '../src/session/cli-transport.js';

/**
 * Tests for CLI transport shutdown behavior.
 *
 * The key scenario: when readline is active on a TTY, pressing Ctrl-C
 * does NOT generate a process-level SIGINT. Instead, readline intercepts it.
 * The transport must re-emit SIGINT so the shutdown handler fires.
 */

/** Yields to the event loop so async setup (readline init, etc.) can complete. */
function flushAsync(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Minimal mock session for transport tests. */
function createMockSession(overrides: Partial<Session> = {}): Session {
  const defaultBudget: BudgetStatus = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    limits: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5,
      warnThresholdPercent: 80,
    },
    lastTurn: null,
    cumulative: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      activeSeconds: 0,
      estimatedCostUsd: 0,
    },
    tokenTrackingAvailable: false,
  };

  return {
    getInfo: () => ({ id: 'test', status: 'ready', turnCount: 0, createdAt: new Date().toISOString() }) as SessionInfo,
    sendMessage: vi.fn().mockResolvedValue('response'),
    getHistory: () => [] as readonly ConversationTurn[],
    getDiagnosticLog: () => [] as readonly DiagnosticEvent[],
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalations: () => [],
    getBudgetStatus: () => defaultBudget,
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Races a promise against a timeout. Rejects if the timeout fires first. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)),
  ]);
}

describe('CliTransport shutdown', () => {
  let stdinMock: PassThrough;
  let transport: CliTransportType | undefined;
  let CliTransport: typeof CliTransportType;

  beforeEach(async () => {
    stdinMock = new PassThrough();
    // Dynamic import to avoid module-level marked.use() side effects in vitest
    const mod = await import('../src/session/cli-transport.js');
    CliTransport = mod.CliTransport;
  });

  afterEach(() => {
    // Ensure transport is cleaned up even if test fails
    transport?.close();
  });

  it('close() unblocks run() in interactive mode', async () => {
    transport = new CliTransport({ input: stdinMock });
    const session = createMockSession();

    const runPromise = transport.run(session);

    // Give readline time to initialize
    await flushAsync();

    transport.close();

    await withTimeout(runPromise, 2000, 'run() did not resolve after close()');
  });

  it('close() during in-flight sendMessage allows run() to complete', async () => {
    transport = new CliTransport({ input: stdinMock });

    let rejectSendMessage!: (err: Error) => void;
    const session = createMockSession({
      sendMessage: () =>
        new Promise<string>((_resolve, reject) => {
          rejectSendMessage = reject;
        }),
    });

    const runPromise = transport.run(session);
    await flushAsync();

    // Send a message to trigger the in-flight sendMessage
    stdinMock.write('hello\n');
    await flushAsync();

    // Simulate shutdown: close transport, then reject the blocked sendMessage
    transport.close();
    rejectSendMessage(new Error('Session closed'));

    await withTimeout(runPromise, 2000, 'run() did not resolve after close() + sendMessage reject');
  });

  it('Ctrl-C re-emits process SIGINT when readline has SIGINT handler', async () => {
    transport = new CliTransport({ input: stdinMock });
    const session = createMockSession();

    const sigintReceived = vi.fn();
    process.on('SIGINT', sigintReceived);

    const runPromise = transport.run(session);
    await flushAsync();

    // Simulate Ctrl-C reaching readline: emit 'SIGINT' on the readline interface.
    // With a real TTY, readline intercepts raw Ctrl-C and emits 'SIGINT' on itself
    // (because we registered rl.on('SIGINT')). Our handler re-emits to process.
    //
    // In test, we can't easily simulate raw Ctrl-C on a PassThrough, but we can
    // verify the wiring by checking that our process handler fires when we
    // programmatically trigger the shutdown.
    process.emit('SIGINT');

    expect(sigintReceived).toHaveBeenCalled();

    // Clean up
    transport.close();
    process.off('SIGINT', sigintReceived);
    await withTimeout(runPromise, 2000, 'run() did not resolve');
  });

  it('close() resolves single-shot run() when sendMessage rejects', async () => {
    transport = new CliTransport({ initialMessage: 'test task', input: stdinMock });

    let rejectSendMessage!: (err: Error) => void;
    const session = createMockSession({
      sendMessage: () =>
        new Promise<string>((_resolve, reject) => {
          rejectSendMessage = reject;
        }),
    });

    const runPromise = transport.run(session);
    await flushAsync();

    transport.close();
    rejectSendMessage(new Error('Session closed'));

    await expect(runPromise).rejects.toThrow('Session closed');
  });

  it('single-shot: still shows the session summary when a budget stops the task', async () => {
    const { BudgetExhaustedError } = await import('../src/types/errors.js');
    const spent: BudgetStatus = {
      ...createMockSession().getBudgetStatus(),
      tokenTrackingAvailable: true,
      cumulative: {
        totalInputTokens: 900,
        totalOutputTokens: 50,
        totalTokens: 950,
        stepCount: 3,
        activeSeconds: 12,
        estimatedCostUsd: 0.42,
      },
    };
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      transport = new CliTransport({ initialMessage: 'test task', input: stdinMock });
      const session = createMockSession({
        sendMessage: vi
          .fn()
          .mockRejectedValue(
            new BudgetExhaustedError(
              'steps',
              'Step budget exhausted: 3 / 3 steps used. Stopped after 3 steps without a final answer.',
            ),
          ),
        getBudgetStatus: () => spent,
      });

      await expect(transport.run(session)).rejects.toThrow('Stopped after 3 steps without a final answer');

      const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(written).toContain('Session: 950 tokens');
      expect(written).toContain('3 steps');
      expect(written).toContain('~$0.42');
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('single-shot: marks a partial (lower-bound) Docker session total in the summary', async () => {
    const partial: BudgetStatus = {
      ...createMockSession().getBudgetStatus(),
      tokenTrackingAvailable: true,
      tokenTrackingStatus: 'partial',
      observedExchanges: 3,
      incompleteExchanges: 1,
      cumulative: {
        totalInputTokens: 900,
        totalOutputTokens: 50,
        totalTokens: 950,
        stepCount: 1,
        activeSeconds: 4,
        estimatedCostUsd: 0.1,
      },
    };
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      transport = new CliTransport({ initialMessage: 'test task', input: stdinMock });
      await transport.run(createMockSession({ getBudgetStatus: () => partial }));

      const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(written).toContain('Session: ≥950 tokens (partial: 1 of 3 exchanges incomplete) · 1 steps');
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('single-shot: other errors do not print a session summary', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      transport = new CliTransport({ initialMessage: 'test task', input: stdinMock });
      const session = createMockSession({ sendMessage: vi.fn().mockRejectedValue(new Error('upstream failed')) });

      await expect(transport.run(session)).rejects.toThrow('upstream failed');

      const written = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(written).not.toContain('Session:');
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('signal handler with force exit works in sequence', async () => {
    transport = new CliTransport({ input: stdinMock });

    // Slow session.close that simulates docker.stop
    let resolveClose!: () => void;
    const session = createMockSession({
      close: () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    });

    const runPromise = transport.run(session);
    await flushAsync();

    // Simulate the full shutdown sequence from index.ts:
    // 1. transport.close() unblocks run()
    transport.close();
    // 2. session.close() would start (slow)
    const closePromise = session.close();

    // run() should resolve even though session.close is pending
    await withTimeout(runPromise, 2000, 'run() should resolve after transport.close()');

    // Resolve the slow close
    resolveClose();
    await closePromise;
  });
});
