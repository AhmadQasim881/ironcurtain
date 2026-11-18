import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { InteractionLog, type InteractionEntry } from '../src/session/interaction-log.js';
import { prepareRedactionSecrets } from '../src/trusted-process/audit-redactor.js';
import type { Session, SessionId } from '../src/session/types.js';

const TEST_DIR = resolve('/tmp', `interaction-log-test-${process.pid}`);
const LOG_PATH = resolve(TEST_DIR, 'interactions.jsonl');

const ANTHROPIC_KEY = 'sk-ant-api03-' + 'abcdefghijklmnopqrstuvWXYZ';
const CUSTOM_TOKEN = 'corp-deploy-token-' + '0123456789abcdef';
const ENTRY: InteractionEntry = {
  timestamp: '2026-02-27T12:00:00.000Z',
  sessionId: 'test-123',
  turnNumber: 1,
  role: 'user',
  content: '',
};

function readLogEntries(): InteractionEntry[] {
  const content = readFileSync(LOG_PATH, 'utf-8').trim();
  if (content === '') return [];
  return content.split('\n').map((line) => JSON.parse(line));
}

function createMockSession(sessionId: string, sendMessage: (msg: string) => Promise<string>): Session {
  return {
    getInfo: () => ({
      id: sessionId as SessionId,
      status: 'ready' as const,
      turnCount: 0,
      createdAt: new Date().toISOString(),
    }),
    sendMessage,
    getHistory: () => [],
    getDiagnosticLog: () => [],
    getPendingEscalations: () => [],
    resolveEscalation: async () => {},
    getBudgetStatus: () => ({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      elapsedSeconds: 0,
      estimatedCostUsd: 0,
      tokenTrackingAvailable: false,
      limits: {
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
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
    }),
    close: async () => {},
  };
}

describe('InteractionLog', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('writes valid JSONL entries', async () => {
    const log = new InteractionLog(LOG_PATH);

    const entry: InteractionEntry = {
      timestamp: '2026-02-27T12:00:00.000Z',
      sessionId: 'test-123',
      turnNumber: 1,
      role: 'user',
      content: 'hello world',
    };

    log.log(entry);
    await log.close();

    const entries = readLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it('appends multiple entries', async () => {
    const log = new InteractionLog(LOG_PATH);

    log.log({
      timestamp: '2026-02-27T12:00:00.000Z',
      sessionId: 'test-123',
      turnNumber: 1,
      role: 'user',
      content: 'question',
    });
    log.log({
      timestamp: '2026-02-27T12:00:01.000Z',
      sessionId: 'test-123',
      turnNumber: 1,
      role: 'assistant',
      content: 'answer',
    });

    await log.close();

    const entries = readLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].role).toBe('user');
    expect(entries[1].role).toBe('assistant');
  });

  it('appends to existing file', async () => {
    // First write
    const log1 = new InteractionLog(LOG_PATH);
    log1.log({
      timestamp: '2026-02-27T12:00:00.000Z',
      sessionId: 'test-123',
      turnNumber: 1,
      role: 'user',
      content: 'first',
    });
    await log1.close();

    // Second write appends
    const log2 = new InteractionLog(LOG_PATH);
    log2.log({
      timestamp: '2026-02-27T12:01:00.000Z',
      sessionId: 'test-123',
      turnNumber: 2,
      role: 'user',
      content: 'second',
    });
    await log2.close();

    const entries = readLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].content).toBe('first');
    expect(entries[1].content).toBe('second');
  });

  it('creates the transcript owner-only (0600) and tightens an existing one', async () => {
    const log = new InteractionLog(LOG_PATH);
    await log.close();
    expect(statSync(LOG_PATH).mode & 0o777).toBe(0o600);

    chmodSync(LOG_PATH, 0o644);
    const reopened = new InteractionLog(LOG_PATH);
    await reopened.close();
    expect(statSync(LOG_PATH).mode & 0o777).toBe(0o600);
  });

  it('creates a missing directory owner-only (0700)', async () => {
    const nestedPath = resolve(TEST_DIR, 'sessions', 'abc', 'interactions.jsonl');
    const log = new InteractionLog(nestedPath);
    await log.close();
    expect(statSync(resolve(TEST_DIR, 'sessions', 'abc')).mode & 0o777).toBe(0o700);
  });

  it('masks API keys and card numbers by default', async () => {
    const log = new InteractionLog(LOG_PATH);
    log.log({ ...ENTRY, content: `use ${ANTHROPIC_KEY} and card 4111 1111 1111 1111` });
    await log.close();

    const raw = readFileSync(LOG_PATH, 'utf-8');
    expect(raw).not.toContain(ANTHROPIC_KEY);
    expect(raw).not.toContain('4111 1111 1111 1111');
    expect(readLogEntries()[0].content).toBe('use sk-a...WXYZ and card 4111 ******** 1111');
  });

  it('masks the exact credential values it is given, and writes verbatim with null redaction', async () => {
    const redacted = new InteractionLog(LOG_PATH, { redaction: { secrets: prepareRedactionSecrets([CUSTOM_TOKEN]) } });
    redacted.log({ ...ENTRY, content: `deploy with ${CUSTOM_TOKEN}` });
    await redacted.close();
    const verbatim = new InteractionLog(LOG_PATH, { redaction: null });
    verbatim.log({ ...ENTRY, content: `deploy with ${CUSTOM_TOKEN}` });
    await verbatim.close();

    const entries = readLogEntries();
    expect(entries[0]).toEqual({ ...ENTRY, content: 'deploy with ***REDACTED***' });
    expect(entries[1].content).toBe(`deploy with ${CUSTOM_TOKEN}`);
  });
});

describe('BaseTransport.sendAndLog', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('logs user and assistant entries around sendMessage', async () => {
    // Mock getSessionInteractionLogPath to use our test dir
    vi.mock('../src/config/paths.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../src/config/paths.js')>();
      return {
        ...original,
        getSessionInteractionLogPath: () => LOG_PATH,
      };
    });

    // Re-import to pick up the mock
    const { BaseTransport: MockedBaseTransport } = await import('../src/session/base-transport.js');

    class TestTransportMocked extends MockedBaseTransport {
      public runFn: ((session: Session) => Promise<void>) | null = null;

      protected async runSession(session: Session): Promise<void> {
        if (this.runFn) await this.runFn(session);
      }
      close(): void {}
      public async testSendAndLog(session: Session, msg: string): Promise<string> {
        return this.sendAndLog(session, msg);
      }
    }

    const transport = new TestTransportMocked();
    const session = createMockSession('sess-456', async (msg) => `echo: ${msg}`);

    transport.runFn = async (s) => {
      await transport.testSendAndLog(s, 'hello');
      await transport.testSendAndLog(s, 'world');
    };

    await transport.run(session);

    const entries = readLogEntries();
    expect(entries).toHaveLength(4);

    // Turn 1
    expect(entries[0].role).toBe('user');
    expect(entries[0].content).toBe('hello');
    expect(entries[0].turnNumber).toBe(1);
    expect(entries[0].sessionId).toBe('sess-456');

    expect(entries[1].role).toBe('assistant');
    expect(entries[1].content).toBe('echo: hello');
    expect(entries[1].turnNumber).toBe(1);

    // Turn 2
    expect(entries[2].role).toBe('user');
    expect(entries[2].content).toBe('world');
    expect(entries[2].turnNumber).toBe(2);

    expect(entries[3].role).toBe('assistant');
    expect(entries[3].content).toBe('echo: world');
    expect(entries[3].turnNumber).toBe(2);
  });

  it('logs only user entry when sendMessage throws', async () => {
    vi.mock('../src/config/paths.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../src/config/paths.js')>();
      return {
        ...original,
        getSessionInteractionLogPath: () => LOG_PATH,
      };
    });

    const { BaseTransport: MockedBaseTransport } = await import('../src/session/base-transport.js');

    class TestTransportMocked extends MockedBaseTransport {
      public runFn: ((session: Session) => Promise<void>) | null = null;

      protected async runSession(session: Session): Promise<void> {
        if (this.runFn) await this.runFn(session);
      }
      close(): void {}
      public async testSendAndLog(session: Session, msg: string): Promise<string> {
        return this.sendAndLog(session, msg);
      }
    }

    const transport = new TestTransportMocked();
    const session = createMockSession('sess-err', async () => {
      throw new Error('LLM failed');
    });

    let caughtError: Error | null = null;
    transport.runFn = async (s) => {
      try {
        await transport.testSendAndLog(s, 'will fail');
      } catch (e) {
        caughtError = e as Error;
      }
    };

    await transport.run(session);

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe('LLM failed');

    const entries = readLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('user');
    expect(entries[0].content).toBe('will fail');
  });

  /** Runs one sendAndLog turn of `session` through a BaseTransport and returns the transcript. */
  async function runOneTurn(session: Session, message: string): Promise<InteractionEntry[]> {
    const { BaseTransport: MockedBaseTransport } = await import('../src/session/base-transport.js');
    class OneTurnTransport extends MockedBaseTransport {
      protected async runSession(s: Session): Promise<void> {
        await this.sendAndLog(s, message);
      }
      close(): void {}
    }
    await new OneTurnTransport().run(session);
    return readLogEntries();
  }

  it("masks the session's known credentials in both sides of the transcript", async () => {
    const session = {
      ...createMockSession('sess-redact', async () => `the token is ${CUSTOM_TOKEN}`),
      getLogRedaction: () => ({ secrets: prepareRedactionSecrets([CUSTOM_TOKEN]) }),
    } as Session;

    const entries = await runOneTurn(session, `deploy with ${CUSTOM_TOKEN} and ${ANTHROPIC_KEY}`);

    expect(readFileSync(LOG_PATH, 'utf-8')).not.toContain(CUSTOM_TOKEN);
    expect(entries.map((e) => e.content)).toEqual([
      'deploy with ***REDACTED*** and sk-a...WXYZ',
      'the token is ***REDACTED***',
    ]);
  });

  it('keeps the transcript verbatim when the session has audit redaction turned off', async () => {
    const session = {
      ...createMockSession('sess-verbatim', async () => 'ok'),
      getLogRedaction: () => null,
    } as Session;

    const entries = await runOneTurn(session, `key ${ANTHROPIC_KEY}`);

    expect(entries[0].content).toBe(`key ${ANTHROPIC_KEY}`);
  });

  it('applies the audit redactor patterns for a session that does not say', async () => {
    const entries = await runOneTurn(
      createMockSession('sess-default', async () => 'ok'),
      `key ${ANTHROPIC_KEY}`,
    );
    expect(entries[0].content).toBe('key sk-a...WXYZ');
  });
});
