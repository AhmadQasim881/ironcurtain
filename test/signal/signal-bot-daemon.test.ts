import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  SignalBotDaemon,
  parseSignalEnvelope,
  parseHashPrefix,
  isAuthorizedSender,
  normalizePhoneNumber,
  type SignalBotDaemonOptions,
} from '../../src/signal/signal-bot-daemon.js';
import type { ResolvedSignalConfig } from '../../src/signal/signal-config.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { EscalationRequest, SessionId } from '../../src/session/types.js';
import type { Transport } from '../../src/session/transport.js';
import type { JobId } from '../../src/cron/types.js';
import { EscalationExpiredError } from '../../src/types/errors.js';
import { ESCALATION_CODE_ALPHABET } from '../../src/signal/escalation-reply.js';
import { SignalImageError } from '../../src/signal/signal-image.js';
import { createSignalBridgeClient } from '../../src/signal/signal-bridge-client.js';
import { escalationDispatch } from '../../src/web-ui/dispatch/escalation-dispatch.js';
import type { DispatchContext } from '../../src/web-ui/dispatch/types.js';
import type { EscalationDto } from '../../src/web-ui/web-ui-types.js';
import * as logger from '../../src/logger.js';
import {
  MockSignalApi,
  createMockSignalContainerManager,
  createTestSignalConfig,
  getSignalTestTlsIdentity,
  waitFor,
  waitForMessage,
  waitForMessages,
} from '../helpers/mock-signal-api.js';

// --- Test helpers ---

/** Short delay for async operations in integration tests. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Waits until the given mock function has been called at least `count` times. */
function waitForCalls(fn: ReturnType<typeof vi.fn>, count: number, timeoutMs = 15_000): Promise<void> {
  return waitFor(() => fn.mock.calls.length >= count, timeoutMs);
}

// Track mock sessions and their onEscalation callbacks for per-session assertions
interface MockSessionRecord {
  session: ReturnType<typeof createMockSession>;
  onEscalation?: (request: EscalationRequest) => void;
}
const createdMockSessions: MockSessionRecord[] = [];

function createMockSession() {
  const sessionId = `test-session-${createdMockSessions.length}`;
  const createdAt = new Date().toISOString();

  return {
    getInfo: () => ({
      id: sessionId as SessionId,
      status: 'ready' as const,
      turnCount: 0,
      createdAt,
    }),
    sendMessage: vi.fn().mockResolvedValue('Agent response text'),
    getHistory: () => [],
    getDiagnosticLog: () => [],
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalations: () => [],
    getBudgetStatus: () => ({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
      stepCount: 1,
      elapsedSeconds: 5,
      estimatedCostUsd: 0.01,
      tokenTrackingAvailable: true,
      limits: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      lastTurn: null,
      cumulative: {
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalTokens: 150,
        stepCount: 1,
        activeSeconds: 5,
        estimatedCostUsd: 0.01,
      },
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// Mock createSession to avoid real session creation.
// Each call returns a distinct mock session tracked in createdMockSessions.
// Also captures the onEscalation callback so tests can simulate escalations
// through the real callback chain.
vi.mock('../../src/session/index.js', () => {
  const impl = (options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
    const session = createMockSession();
    createdMockSessions.push({ session, onEscalation: options?.onEscalation });
    return Promise.resolve(session);
  };
  return {
    createSession: vi.fn().mockImplementation(impl),
    createStandaloneSession: vi.fn().mockImplementation(impl),
  };
});

vi.mock('../../src/config/index.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    auditLogPath: '/tmp/audit.jsonl',
    allowedDirectory: '/tmp/sandbox',
    mcpServers: {},
    protectedPaths: [],
    generatedDir: '/tmp/generated',
    constitutionPath: '/tmp/constitution.md',
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-key',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 160_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      memory: { enabled: false, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined },
      webSearch: { provider: null, brave: null, tavily: null, serpapi: null },
      serverCredentials: {},
      signal: null,
    },
  }),
}));

vi.mock('../../src/logger.js', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setup: vi.fn(),
  teardown: vi.fn(),
  isActive: vi.fn().mockReturnValue(false),
}));

// --- Unit tests for pure functions ---

describe('parseSignalEnvelope', () => {
  it('extracts message from json-rpc envelope', () => {
    const raw = JSON.stringify({
      envelope: {
        sourceNumber: '+15551234567',
        dataMessage: { message: 'hello', timestamp: 12345 },
      },
    });
    const env = parseSignalEnvelope(raw);
    expect(env?.dataMessage?.message).toBe('hello');
    expect(env?.sourceNumber).toBe('+15551234567');
  });

  it('handles flat envelope (no json-rpc wrapping)', () => {
    const raw = JSON.stringify({
      sourceNumber: '+15551234567',
      dataMessage: { message: 'hello' },
    });
    const env = parseSignalEnvelope(raw);
    expect(env?.dataMessage?.message).toBe('hello');
  });

  it('returns null for non-JSON', () => {
    expect(parseSignalEnvelope('not json')).toBeNull();
  });

  it('returns envelope for typing indicators (no dataMessage)', () => {
    const raw = JSON.stringify({
      envelope: { typingMessage: { action: 'STARTED' } },
    });
    const env = parseSignalEnvelope(raw);
    expect(env?.dataMessage).toBeUndefined();
  });
});

describe('normalizePhoneNumber', () => {
  it('strips spaces', () => {
    expect(normalizePhoneNumber('+1 555 123 4567')).toBe('+15551234567');
  });

  it('returns already-normalized numbers unchanged', () => {
    expect(normalizePhoneNumber('+15551234567')).toBe('+15551234567');
  });
});

describe('isAuthorizedSender', () => {
  it('accepts matching sourceNumber', () => {
    const env = { sourceNumber: '+15551234567' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(true);
  });

  it('rejects non-matching sourceNumber', () => {
    const env = { sourceNumber: '+15559999999' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(false);
  });

  it('accepts matching source (fallback)', () => {
    const env = { source: '+15551234567' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(true);
  });

  it('rejects envelope with no sender', () => {
    const env = {};
    expect(isAuthorizedSender(env, '+15551234567')).toBe(false);
  });

  it('handles number normalization (spaces)', () => {
    const env = { sourceNumber: '+1 555 123 4567' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(true);
  });
});

describe('parseHashPrefix', () => {
  it('parses #N prefix with space', () => {
    const result = parseHashPrefix('#2 list the directory');
    expect(result.targetLabel).toBe(2);
    expect(result.messageText).toBe('list the directory');
  });

  it('returns null targetLabel when no prefix', () => {
    const result = parseHashPrefix('regular message');
    expect(result.targetLabel).toBeNull();
    expect(result.messageText).toBe('regular message');
  });

  it('parses multi-digit labels', () => {
    const result = parseHashPrefix('#12 do something');
    expect(result.targetLabel).toBe(12);
    expect(result.messageText).toBe('do something');
  });

  it('does not match # in the middle of text', () => {
    const result = parseHashPrefix('issue #2 is broken');
    expect(result.targetLabel).toBeNull();
    expect(result.messageText).toBe('issue #2 is broken');
  });

  it('requires a space after the label', () => {
    const result = parseHashPrefix('#2');
    expect(result.targetLabel).toBeNull();
    expect(result.messageText).toBe('#2');
  });

  it('preserves multiline message text', () => {
    const result = parseHashPrefix('#1 line one\nline two');
    expect(result.targetLabel).toBe(1);
    expect(result.messageText).toBe('line one\nline two');
  });
});

// --- Integration tests with mock signal-cli API ---

describe('SignalBotDaemon', () => {
  let mockApi: MockSignalApi;
  let port: number;

  // Bind an ephemeral port to avoid conflicts; read it back after start().
  beforeEach(async () => {
    mockApi = new MockSignalApi();
    await mockApi.start();
    port = mockApi.port;
    // Set default identity for the configured recipient
    mockApi.setIdentities([{ number: '+15559876543', fingerprint: 'test-identity-key-abc123' }]);
  });

  afterEach(async () => {
    await mockApi.stop();
    createdMockSessions.length = 0;

    // Restore default createSession mock in case a test overrode it
    const { createStandaloneSession: createSession } = await import('../../src/session/index.js');
    vi.mocked(createSession).mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
      const session = createMockSession();
      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });
  });

  function createDaemon(
    configOverrides?: Partial<ResolvedSignalConfig>,
    options?: Partial<SignalBotDaemonOptions>,
  ): SignalBotDaemon {
    return new SignalBotDaemon({
      config: createTestSignalConfig(port, configOverrides),
      containerManager: createMockSignalContainerManager(port),
      mode: { kind: 'builtin' },
      // Fast banner retries keep the delivery-failure tests quick.
      escalationRetryDelaysMs: [5, 5, 5],
      ...options,
    });
  }

  /**
   * Starts a daemon, waits for it to be ready, runs the test body,
   * then shuts down and awaits the start promise. Handles lifecycle
   * so tests can focus on assertions.
   */
  async function withDaemon(
    body: (daemon: SignalBotDaemon) => Promise<void>,
    configOverrides?: Partial<ResolvedSignalConfig>,
    options?: Partial<SignalBotDaemonOptions>,
  ): Promise<void> {
    const daemon = createDaemon(configOverrides, options);
    const startPromise = daemon.start();
    // Wait for the "online" message to be sent (daemon is ready)
    await waitForMessages(mockApi, 1);
    try {
      await body(daemon);
    } finally {
      await daemon.shutdown();
      await startPromise;
    }
  }

  it('sends online message on start', async () => {
    await withDaemon(async () => {
      expect(mockApi.sentMessages.length).toBeGreaterThanOrEqual(1);
      expect(mockApi.sentMessages[0].message).toContain('online');
    });
  });

  it('routes authorized messages to session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      expect(mockApi.messageTexts.some((m) => m.includes('Started a new session'))).toBe(true);
    });
  });

  it('sends fallback message when agent returns empty response', async () => {
    // Override createSession so sendMessage returns an empty string
    const { createStandaloneSession: createSession } = await import('../../src/session/index.js');
    vi.mocked(createSession).mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
      const session = createMockSession();
      vi.mocked(session.sendMessage).mockResolvedValue('');
      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('no text response'), 10_000);

      expect(mockApi.messageTexts.some((m) => m.includes('no text response'))).toBe(true);
      // Ensure no empty message was sent
      expect(mockApi.sentMessages.every((m) => m.message.trim().length > 0)).toBe(true);
    });
  });

  it('ignores messages from unauthorized senders', async () => {
    await withDaemon(async () => {
      const countBefore = mockApi.sentMessages.length;
      mockApi.simulateIncomingMessage('+19999999999', 'I am a stranger');
      await wait(50);

      expect(mockApi.sentMessages.length).toBe(countBefore);
    });
  });

  it('handles /help control command', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/help');
      await waitForMessage(mockApi, (m) => m.includes('Commands:'));

      const messages = mockApi.messageTexts;
      expect(messages.some((m) => m.includes('Commands:'))).toBe(true);
      expect(messages.some((m) => m.includes('/new'))).toBe(true);
      expect(messages.some((m) => m.includes('/sessions'))).toBe(true);
      expect(messages.some((m) => m.includes('/switch'))).toBe(true);
      expect(messages.some((m) => m.includes('approve <code>') && m.includes('details <code>'))).toBe(true);
      const help = messages.find((m) => m.includes('Commands:'));
      expect(help).toContain('/pending - list pending escalations');
      expect(help).toContain('/show <code>');
      expect(help).toContain('approve+ <code> - approve it and whitelist the pattern its banner shows');
    });
  });

  it('handles /budget command with no active session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/budget');
      await waitForMessage(mockApi, (m) => m.includes('No active session'));

      expect(mockApi.messageTexts.some((m) => m.includes('No active session'))).toBe(true);
    });
  });

  it('sends styled messages via POST /v2/send', async () => {
    await withDaemon(async () => {
      const firstSent = mockApi.sentMessages[0];
      expect(firstSent.text_mode).toBe('styled');
      expect(firstSent.recipients).toEqual(['+15559876543']);
    });
  });

  it('sends goodbye message on shutdown', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await waitForMessages(mockApi, 1);

    await daemon.shutdown();
    await startPromise;

    expect(mockApi.messageTexts.some((m) => m.includes('shutting down'))).toBe(true);
  });

  it(
    'keeps running when its connection drops: it reconnects, and only shutdown() ends run()',
    { timeout: 30_000 },
    async () => {
      // IronCurtainDaemon treats a started transport as gone only when run()
      // rejects, so cron escalations keep the Signal path while the connection
      // is down (DAEMON.md, Escalation Handling; test/operator-docs.test.ts).
      const daemon = createDaemon();
      let ended = false;
      const running = daemon.start().then(() => {
        ended = true;
      });
      try {
        await waitForMessages(mockApi, 1);
        // signal-cli restarts: the bot reconnects and drains what it missed.
        mockApi.queueForDrain(mockApi.envelope('+15559876543', '/help'));
        mockApi.disconnectClients();
        await waitForMessage(mockApi, (m) => m.includes('Commands:'), 20_000);
        expect(ended).toBe(false);
      } finally {
        await daemon.shutdown();
        await running;
      }
      expect(ended).toBe(true);
    },
  );

  it('says on stderr why Signal did not start when the bridge image cannot be used', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const daemon = new SignalBotDaemon({
        config: createTestSignalConfig(port),
        containerManager: {
          ...createMockSignalContainerManager(port),
          ensureRunning: () =>
            Promise.reject(
              new SignalImageError('SIGNAL_IMAGE_NOT_PINNED', 'Run "ironcurtain setup-signal --update-image"\u202e'),
            ),
        },
        mode: { kind: 'builtin' },
      });

      await expect(daemon.connect()).rejects.toThrow('setup-signal --update-image');
      expect(stderr).toHaveBeenCalledWith(
        'Signal transport not started: Run "ironcurtain setup-signal --update-image"\\u202e\n',
      );
      expect(mockApi.sentMessages).toHaveLength(0);
    } finally {
      stderr.mockRestore();
    }
  });

  it('rejects an unauthenticated receive upgrade and closes the client', async () => {
    const client = createSignalBridgeClient(`https://127.0.0.1:${port}`, 'c'.repeat(64), {
      ca: getSignalTestTlsIdentity().certPem,
    });
    const close = vi.spyOn(client, 'close');
    const daemon = createDaemon(undefined, {
      containerManager: {
        ...createMockSignalContainerManager(port),
        ensureRunning: async () => client,
      },
    });
    await expect(daemon.connect()).rejects.toThrow('WebSocket connection failed');
    expect(close).toHaveBeenCalledOnce();
    expect(mockApi.sentMessages).toHaveLength(0);
  });

  it('does not reopen the run wait after shutdown during startup', async () => {
    const daemon = createDaemon();
    await daemon.shutdown();
    await expect(daemon.run()).resolves.toBeUndefined();
  });

  // --- Identity verification ---

  it('rejects envelope with untrustedIdentity flag', async () => {
    await withDaemon(async () => {
      const countBefore = mockApi.sentMessages.length;
      mockApi.simulateUntrustedIdentity('+15559876543', 'should be rejected');
      await wait(50);

      const messagesAfter = mockApi.sentMessages.slice(countBefore);
      expect(messagesAfter.every((m) => !m.message.includes('session'))).toBe(true);
    });
  });

  it('rejects when fingerprint does not match stored key', async () => {
    mockApi.setIdentities([{ number: '+15559876543', fingerprint: 'different-key-xyz' }]);

    await withDaemon(async () => {
      const countBefore = mockApi.sentMessages.length;
      mockApi.simulateIncomingMessage('+15559876543', 'should be rejected');
      await wait(50);

      const messagesAfter = mockApi.sentMessages.slice(countBefore);
      expect(messagesAfter.every((m) => !m.message.includes('Started a new session'))).toBe(true);
    });
  });

  it('fails closed when identity API is unavailable', async () => {
    mockApi.setIdentityEndpointDown(true);

    await withDaemon(async () => {
      const countBefore = mockApi.sentMessages.length;
      mockApi.simulateIncomingMessage('+15559876543', 'should be rejected');
      await wait(50);

      const messagesAfter = mockApi.sentMessages.slice(countBefore);
      expect(messagesAfter.every((m) => !m.message.includes('Started a new session'))).toBe(true);
    });
  });

  it('retries identity check on next message after API failure (no TTL caching of failures)', async () => {
    mockApi.setIdentityEndpointDown(true);

    await withDaemon(async () => {
      // First message: rejected (API down)
      mockApi.simulateIncomingMessage('+15559876543', 'first attempt');
      await wait(50);

      // Restore API and send second message
      mockApi.setIdentityEndpointDown(false);
      mockApi.setIdentities([{ number: '+15559876543', fingerprint: 'test-identity-key-abc123' }]);

      mockApi.simulateIncomingMessage('+15559876543', 'second attempt');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      expect(mockApi.messageTexts.some((m) => m.includes('Started a new session'))).toBe(true);
    });
  });

  /** Number of logger.error calls so far whose message contains `text`. */
  function errorsLogged(text: string): number {
    return vi.mocked(logger.error).mock.calls.filter(([message]) => message.includes(text)).length;
  }

  it('rejects messages while signal-cli lists no identity for the recipient, without locking or caching', async () => {
    mockApi.setIdentities([{ number: '+15550000000', fingerprint: 'someone-else' }]);
    const before = errorsLogged('lists no identity key');

    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'first attempt');
      await waitFor(() => errorsLogged('lists no identity key') > before);
      expect(mockApi.messageTexts.some((m) => m.includes('Started a new session'))).toBe(false);

      // Not locked and nothing cached: once signal-cli lists the record, messages pass.
      mockApi.setIdentities([{ number: '+15559876543', fingerprint: 'test-identity-key-abc123' }]);
      mockApi.simulateIncomingMessage('+15559876543', 'second attempt');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
    });
  });

  it('verifies the newest identity record listed for the number', async () => {
    mockApi.setIdentities([
      { number: '+15559876543', fingerprint: 'old-key-of-the-recipient', added: '1700000000000' },
      { number: '+15559876543', fingerprint: 'test-identity-key-abc123', added: '1700000005000' },
    ]);

    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
    });
  });

  it('locks when the newest record for the number carries another key, even after a matching one', async () => {
    mockApi.setIdentities([
      { number: '+15559876543', fingerprint: 'test-identity-key-abc123', added: '1700000000000' },
      { number: '+15559876543', fingerprint: 'changed-key', added: '1700000005000' },
    ]);
    const before = errorsLogged('LOCKED');

    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'should be rejected');
      await waitFor(() => errorsLogged('LOCKED') > before);
      expect(mockApi.messageTexts.some((m) => m.includes('Started a new session'))).toBe(false);
    });
  });

  it('verifies the record of the stored account UUID, whatever else is listed for the number', async () => {
    // Another identity for the same number is listed first and is newer: neither the
    // first nor the newest record for the number is the one setup recorded.
    mockApi.setIdentities([
      { number: '+15559876543', uuid: 'another-identity', fingerprint: 'other-key', added: '1700000005000' },
      {
        number: '+15559876543',
        uuid: 'aci-recipient',
        fingerprint: 'test-identity-key-abc123',
        added: '1700000000000',
      },
    ]);

    await withDaemon(
      async () => {
        mockApi.simulateIncomingMessage('+15559876543', 'Hello agent', undefined, undefined, {
          sourceUuid: 'aci-recipient',
        });
        await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      },
      { recipientUuid: 'aci-recipient' },
    );
  });

  it('locks when a message from the number comes from another account than the recorded one', async () => {
    mockApi.setIdentities([{ number: '+15559876543', uuid: 'aci-recipient', fingerprint: 'test-identity-key-abc123' }]);
    const before = errorsLogged('not the recorded aci-recipient');

    await withDaemon(
      async () => {
        // The number now belongs to another Signal account (SIM swap): the recorded
        // account's record still carries the stored key, but the sender is someone else.
        mockApi.simulateIncomingMessage('+15559876543', 'Hello agent', undefined, undefined, {
          sourceUuid: 'attacker-aci',
        });
        await waitFor(() => errorsLogged('not the recorded aci-recipient') > before);
        // Locked: the recorded account is refused too until re-trust.
        mockApi.simulateIncomingMessage('+15559876543', 'Hello again', undefined, undefined, {
          sourceUuid: 'aci-recipient',
        });
        await wait(50);
        expect(mockApi.messageTexts.some((m) => m.includes('Started a new session'))).toBe(false);
      },
      { recipientUuid: 'aci-recipient' },
    );
  });

  it('accepts messages from the recorded account and rejects, without locking, one that names no account', async () => {
    mockApi.setIdentities([{ number: '+15559876543', uuid: 'aci-recipient', fingerprint: 'test-identity-key-abc123' }]);
    const before = errorsLogged('names no sender account');

    await withDaemon(
      async () => {
        mockApi.simulateIncomingMessage('+15559876543', 'Hello agent', undefined, undefined, {
          sourceUuid: 'ACI-RECIPIENT',
        });
        await waitForMessage(mockApi, (m) => m.includes('Agent response text'));

        // The record check verifies the recorded account, not the sender: a message
        // that names no sender account cannot be tied to it, so it is refused.
        mockApi.simulateIncomingMessage('+15559876543', 'unnamed sender');
        await waitFor(() => errorsLogged('names no sender account') > before);
        expect(createdMockSessions[0].session.sendMessage).toHaveBeenCalledTimes(1);

        // Not locked: the recorded account is still accepted.
        mockApi.simulateIncomingMessage('+15559876543', 'follow up', undefined, undefined, {
          sourceUuid: 'aci-recipient',
        });
        await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Agent response text')).length >= 2);
        expect(createdMockSessions[0].session.sendMessage).toHaveBeenCalledTimes(2);
      },
      { recipientUuid: 'aci-recipient' },
    );
  });

  it('rejects an approval that names no sender account when the account is recorded', async () => {
    mockApi.setIdentities([{ number: USER, uuid: 'aci-recipient', fingerprint: 'test-identity-key-abc123' }]);
    const before = errorsLogged('names no sender account');

    await withDaemon(
      async (daemon) => {
        mockApi.simulateIncomingMessage(USER, 'Hello agent', undefined, undefined, { sourceUuid: 'aci-recipient' });
        await waitForMessage(mockApi, (m) => m.includes('Agent response text'));
        const code = await surface(daemon, 1, 'esc-unnamed');

        mockApi.simulateIncomingMessage(USER, `approve ${code}`);
        await waitFor(() => errorsLogged('names no sender account') > before);
        expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

        mockApi.simulateIncomingMessage(USER, `approve ${code}`, undefined, undefined, { sourceUuid: 'aci-recipient' });
        await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
      },
      { recipientUuid: 'aci-recipient' },
    );
  });

  describe('unlocking from config.json on disk', () => {
    const savedHome = process.env.IRONCURTAIN_HOME;
    let home: string;

    beforeEach(() => {
      home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-signal-unlock-'));
      process.env.IRONCURTAIN_HOME = home;
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    });

    /** Writes what `setup-signal --re-trust` would record. */
    function writeTrust(recipientIdentityKey: string, recipientUuid: string): void {
      writeFileSync(
        resolve(home, 'config.json'),
        JSON.stringify({
          signal: {
            botNumber: '+15551234567',
            recipientNumber: USER,
            recipientIdentityKey,
            recipientUuid,
            container: { port },
          },
        }),
        { mode: 0o600 },
      );
    }

    it('unlocks when a re-trust records another account UUID for the same key', async () => {
      mockApi.setIdentities([{ number: USER, uuid: 'aci-2', fingerprint: 'test-identity-key-abc123' }]);
      const locked = errorsLogged('LOCKED');

      await withDaemon(
        async () => {
          mockApi.simulateIncomingMessage(USER, 'first', undefined, undefined, { sourceUuid: 'aci-2' });
          await waitFor(() => errorsLogged('LOCKED') > locked);

          writeTrust('test-identity-key-abc123', 'aci-2');
          mockApi.simulateIncomingMessage(USER, 'Hello agent', undefined, undefined, { sourceUuid: 'aci-2' });
          await waitForMessage(mockApi, (m) => m.includes('Agent response text'));
        },
        { recipientUuid: 'aci-1' },
      );
    });

    it('checks the reloaded identity against signal-cli instead of a success cached before the lock', async () => {
      mockApi.setIdentities([{ number: USER, uuid: 'aci-1', fingerprint: 'test-identity-key-abc123' }]);
      const locked = errorsLogged('LOCKED');

      await withDaemon(
        async () => {
          // A verified message caches the identity check for 5 minutes.
          mockApi.simulateIncomingMessage(USER, 'Hello agent', undefined, undefined, { sourceUuid: 'aci-1' });
          await waitForMessage(mockApi, (m) => m.includes('Agent response text'));

          mockApi.simulateIncomingMessage(USER, 'from elsewhere', undefined, undefined, { sourceUuid: 'aci-2' });
          await waitFor(() => errorsLogged('LOCKED') > locked);
          const requests = mockApi.identityRequests;

          // config.json now names aci-2 with a key other than the one signal-cli lists for it.
          mockApi.setIdentities([
            { number: null, uuid: 'aci-1', fingerprint: 'test-identity-key-abc123' },
            { number: USER, uuid: 'aci-2', fingerprint: 'key-of-aci-2' },
          ]);
          writeTrust('not-the-key-of-aci-2', 'aci-2');
          mockApi.simulateIncomingMessage(USER, 'after unlock', undefined, undefined, { sourceUuid: 'aci-2' });
          await waitFor(() => errorsLogged('LOCKED') > locked + 1);

          expect(mockApi.identityRequests).toBe(requests + 1);
          expect(createdMockSessions[0].session.sendMessage).toHaveBeenCalledTimes(1);
        },
        { recipientUuid: 'aci-1' },
      );
    });
  });

  // --- Escalation handling ---

  const USER = '+15559876543';

  function escalationRequest(escalationId: string, overrides: Partial<EscalationRequest> = {}): EscalationRequest {
    return {
      escalationId,
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path: `/tmp/${escalationId}.txt`, content: 'hello' },
      reason: 'Write outside the sandbox',
      ...overrides,
    };
  }

  /** The reply code in the latest banner header sent for session `label`. */
  function bannerCode(label: number): string {
    const header = mockApi.messageTexts.filter((m) => m.includes(`ESCALATION [#${label}`)).at(-1);
    const code = header?.match(/\] code ([A-Z0-9]{4})\n/)?.[1];
    if (code === undefined) throw new Error(`no escalation banner for #${label}`);
    return code;
  }

  /** Surfaces an escalation on session `label`, waits until its banner is delivered, returns its code. */
  async function surface(
    daemon: SignalBotDaemon,
    label: number,
    escalationId: string,
    overrides: Partial<EscalationRequest> = {},
  ): Promise<string> {
    await daemon.surfaceEscalation(label, escalationRequest(escalationId, overrides));
    return bannerCode(label);
  }

  /** A well-formed code that differs from `code`. */
  function otherCode(code: string): string {
    return code === 'WXYZ' ? 'ZYXW' : 'WXYZ';
  }

  /** Starts Signal sessions #1..#count and waits for #1's reply to its first message. */
  async function startSessions(count: number): Promise<void> {
    mockApi.simulateIncomingMessage(USER, 'Hello agent');
    await waitForMessage(mockApi, (m) => m.includes('Agent response text'));
    for (let started = 1; started < count; started += 1) {
      mockApi.simulateIncomingMessage(USER, '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length > started);
    }
  }

  function stubTransport(): Transport {
    return { run: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
  }

  /** Awaits the banner deliveries started through a spied `surfaceEscalation`. */
  async function deliveries(spy: { mock: { results: Array<{ value: unknown }> } }): Promise<void> {
    await Promise.all(spy.mock.results.map((result) => result.value));
  }

  it('approves only with the code shown in the banner', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-123');
      expect(code).toMatch(new RegExp(`^[${ESCALATION_CODE_ALPHABET}]{4}$`));

      mockApi.simulateIncomingMessage(USER, `approve ${code.toLowerCase()}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-123', 'approved', undefined);

      // A repeated approval is refused rather than applied to anything else.
      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} (#1) was already approved`));
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledTimes(1);
    });
  });

  it('denies the only pending escalation on a bare deny', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-456');

      mockApi.simulateIncomingMessage(USER, '/deny');
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} denied`));
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-456', 'denied', undefined);
    });
  });

  it('refuses a bare approve and approve #N and never forwards them to the agent', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      await surface(daemon, 1, 'esc-bare');
      const session = createdMockSessions[0].session;

      mockApi.simulateIncomingMessage(USER, 'approve');
      mockApi.simulateIncomingMessage(USER, 'approve #1');
      await waitFor(
        () => mockApi.messageTexts.filter((m) => m.includes("Approvals need the escalation's code")).length >= 2,
      );

      expect(session.resolveEscalation).not.toHaveBeenCalled();
      expect(session.sendMessage).toHaveBeenCalledTimes(1); // only "Hello agent"
    });
  });

  it('consumes approve and deny when nothing is pending instead of forwarding them', async () => {
    await withDaemon(async () => {
      await startSessions(1);
      const session = createdMockSessions[0].session;

      mockApi.simulateIncomingMessage(USER, 'approve');
      mockApi.simulateIncomingMessage(USER, 'deny');
      mockApi.simulateIncomingMessage(USER, 'approve K7Q2');
      await waitFor(() => mockApi.messageTexts.filter((m) => m === 'No escalation is pending.').length >= 2);
      await waitForMessage(mockApi, (m) => m.includes('No pending escalation has code K7Q2'));

      expect(session.sendMessage).toHaveBeenCalledTimes(1); // only "Hello agent"
    });
  });

  it('refuses an approval with a wrong code', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const wrong = otherCode(await surface(daemon, 1, 'esc-wrong'));

      mockApi.simulateIncomingMessage(USER, `approve ${wrong}`);
      await waitForMessage(mockApi, (m) => m.includes(`No pending escalation has code ${wrong}`));

      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
    });
  });

  it('refuses a late approve after the session re-escalated', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const first = await surface(daemon, 1, 'esc-first');
      // The first escalation times out and the agent escalates again at once.
      daemon.expireEscalation(1, 'esc-first');
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${first} expired (timed out)`));
      const second = await surface(daemon, 1, 'esc-second');
      expect(second).not.toBe(first);

      // The user's approval of the first banner is processed only now.
      mockApi.simulateIncomingMessage(USER, `approve ${first}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${first} (#1) was already expired`));

      expect(mockApi.messageTexts.some((m) => m.includes('Session #1 has a newer escalation'))).toBe(true);
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
    });
  });

  it('refuses a reply sent before the escalation was raised (escalation changed)', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-changed');
      const minuteAgo = Date.now() - 60_000;

      // A bare deny written for an earlier escalation, delivered late.
      mockApi.simulateIncomingMessage(USER, 'deny', minuteAgo);
      // The Signal server's receive time counts, not the phone's clock.
      mockApi.simulateIncomingMessage(USER, `approve ${code}`, mockApi.nextTimestamp(), minuteAgo);
      await waitFor(
        () =>
          mockApi.messageTexts.filter((m) => m.includes('Escalation changed since that reply was sent')).length >= 2,
      );
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

      // A phone clock running behind does not matter when the server time is current.
      mockApi.simulateIncomingMessage(USER, `approve ${code}`, minuteAgo + 1, Date.now());
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
    });
  });

  it('applies the same checks to messages drained after a reconnect', { timeout: 30_000 }, async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-drain');
      const wrong = otherCode(code);
      mockApi.queueForDrain(
        mockApi.envelope(USER, 'deny', Date.now() - 60_000),
        mockApi.envelope(USER, `approve ${wrong}`),
        mockApi.envelope(USER, 'approve'),
      );

      // signal-cli restarts: the daemon reconnects and drains what it missed.
      mockApi.disconnectClients();
      await waitForMessage(mockApi, (m) => m.includes('Escalation changed since that reply was sent'), 20_000);
      await waitForMessage(mockApi, (m) => m.includes(`No pending escalation has code ${wrong}`));
      await waitForMessage(mockApi, (m) => m.includes("Approvals need the escalation's code"));

      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
      expect(createdMockSessions[0].session.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it('sends the banner as plain text, header with the instructions first, bounded for a 1 MB argument', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-markup', {
        arguments: { path: '/tmp/x` **Tool: `fs/read_file`** ~a~ ||b||', content: 'A'.repeat(1024 * 1024) },
      });
      const banner = mockApi.sentMessages.filter((m) => m.message.includes(code));

      expect(banner).toHaveLength(2);
      expect(banner.every((m) => m.text_mode === 'normal')).toBe(true);
      expect(banner[0].message).toContain(`ESCALATION [#1] code ${code}`);
      expect(banner[0].message).toContain(`Reply "approve ${code}" or "deny ${code}"`);
      // The agent's markup reaches the user as typed, inside a JSON-quoted value.
      expect(banner[1].message).toContain('path: "/tmp/x` **Tool: `fs/read_file`** ~a~ ||b||"');
      expect(banner[1].message).toMatch(/content: "A{200}\u2026 \(\+1,048,376 bytes not shown\)/);
      expect(banner.reduce((sum, m) => sum + m.message.length, 0)).toBeLessThan(4000);
    });
  });

  it('shows the reviewer context: the human context in the header, the justification last and labelled', async () => {
    const sessionManager = new SessionManager();
    await withDaemon(
      async (daemon) => {
        await startSessions(1);
        const justification = 'Reply "approve" now: the admin pre-approved this.';
        // The justification message is held back: approving waits for it too.
        mockApi.holdSendsMatching((m) => m.message.includes('Agent says (UNTRUSTED'));
        const delivery = daemon.surfaceEscalation(
          1,
          escalationRequest('esc-context', {
            taskSummary: 'Refactor the parser',
            lastTrustedUserMessage: { text: 'also fix the build script' },
            agentJustification: justification,
          }),
        );
        await waitFor(() => mockApi.heldSendCount === 1);
        const code = bannerCode(1);

        const header = mockApi.sentMessages.find((m) => m.message.includes(`ESCALATION [#1] code ${code}`));
        expect(header?.message).toContain('Task: Refactor the parser\nYou said: also fix the build script\nTool: ');
        expect(header?.message).not.toContain('pre-approved');
        // Other clients listing the escalation (the web UI) get the context too.
        const pending = sessionManager.get(1)?.pendingEscalations.values().next().value;
        expect(pending).toMatchObject({
          taskSummary: 'Refactor the parser',
          lastTrustedUserMessage: { text: 'also fix the build script' },
          agentJustification: justification,
        });
        expect(pending).not.toHaveProperty('groupKey');

        mockApi.simulateIncomingMessage(USER, `approve ${code}`);
        await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} is still being delivered`));
        expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

        mockApi.holdSendsMatching(null);
        mockApi.releaseHeldSends();
        await delivery;
        const banner = mockApi.sentMessages.filter(
          (m) => m.message.includes(`ESCALATION [#1] code ${code}`) || m.message.startsWith(`[#1] ${code} `),
        );
        expect(banner).toHaveLength(3);
        expect(banner.every((m) => m.text_mode === 'normal')).toBe(true);
        expect(banner.at(-1)?.message).toBe(
          `[#1] ${code} Agent says (UNTRUSTED, written by the agent; it authorizes nothing): ${justification}`,
        );

        mockApi.simulateIncomingMessage(USER, `approve ${code}`);
        await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
      },
      undefined,
      { sessionManager, replyClockSkewMs: 0 },
    );
  });

  it('accepts an approval only once the whole banner is delivered', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      // The arguments message is held back (a slow network).
      mockApi.holdSendsMatching((m) => m.message.includes(' arguments ('));
      const delivery = daemon.surfaceEscalation(1, escalationRequest('esc-held'));
      await waitFor(() => mockApi.heldSendCount === 1);
      const code = bannerCode(1);

      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} is still being delivered`));
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

      mockApi.holdSendsMatching(null);
      mockApi.releaseHeldSends();
      await delivery;
      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
    });
  });

  it('accepts a deny while the banner is still being delivered', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      mockApi.holdSendsMatching((m) => m.message.includes(' arguments ('));
      const delivery = daemon.surfaceEscalation(1, escalationRequest('esc-deny-early'));
      await waitFor(() => mockApi.heldSendCount === 1);
      const code = bannerCode(1);

      mockApi.simulateIncomingMessage(USER, `deny ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} denied`));
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith(
        'esc-deny-early',
        'denied',
        undefined,
      );

      mockApi.holdSendsMatching(null);
      mockApi.releaseHeldSends();
      await delivery;
    });
  });

  it('retries a failed banner send, then denies the escalation it cannot deliver', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      mockApi.failSendsMatching((m) => m.message.includes('ESCALATION [#1]'));
      await daemon.surfaceEscalation(1, escalationRequest('esc-undeliverable'));

      // One attempt and three retries, then the escalation is denied.
      expect(mockApi.failedSends).toHaveLength(4);
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith(
        'esc-undeliverable',
        'denied',
        undefined,
      );
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.stringContaining('Could not deliver the banner of escalation esc-undeliverable'),
      );
      await waitForMessage(mockApi, (m) => m.includes('was denied automatically'));
    });
  });

  it('retries a transient banner send failure', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      let failures = 1;
      mockApi.failSendsMatching((m) => m.message.includes('ESCALATION [#1]') && failures-- > 0);
      const code = await surface(daemon, 1, 'esc-transient');
      expect(mockApi.failedSends).toHaveLength(1);

      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
    });
  });

  it('refuses an approval sent before the arguments were delivered, even when processed afterwards', async () => {
    await withDaemon(
      async (daemon) => {
        await startSessions(1);
        mockApi.holdSendsMatching((m) => m.message.includes(' arguments ('));
        const delivery = daemon.surfaceEscalation(1, escalationRequest('esc-unread'));
        await waitFor(() => mockApi.heldSendCount === 1);
        const code = bannerCode(1);

        // The user answers from the header alone; the reply reaches the daemon
        // only after the arguments were delivered (a reconnect drain, say).
        const writtenAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 20));
        mockApi.holdSendsMatching(null);
        mockApi.releaseHeldSends();
        await delivery;
        mockApi.simulateIncomingMessage(USER, `approve ${code}`, mockApi.nextTimestamp(), writtenAt);
        await waitForMessage(mockApi, (m) =>
          m.includes(`That approval was sent before the arguments of escalation ${code} were delivered`),
        );
        expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

        // Sent after reading them, it counts.
        mockApi.simulateIncomingMessage(USER, `approve ${code}`, mockApi.nextTimestamp(), Date.now());
        await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
      },
      undefined,
      // No skew allowance, so the test need not wait for it to pass.
      { replyClockSkewMs: 0 },
    );
  });

  it('stops delivering, and denies nothing, once the escalation is settled elsewhere', async () => {
    const sessionManager = new SessionManager();
    await withDaemon(
      async (daemon) => {
        await startSessions(1);
        let settled = false;
        mockApi.failSendsMatching((m) => {
          if (!m.message.includes('ESCALATION [#1]')) return false;
          // While the header fails, the user approves in the web UI.
          if (!settled) {
            settled = true;
            void sessionManager.resolveSessionEscalation('esc-settled', 'approved');
          }
          return true;
        });
        await daemon.surfaceEscalation(1, escalationRequest('esc-settled'));

        expect(mockApi.failedSends).toHaveLength(1);
        expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledTimes(1);
        expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith(
          'esc-settled',
          'approved',
          undefined,
        );
        expect(mockApi.messageTexts.some((m) => m.includes('denied automatically'))).toBe(false);
      },
      undefined,
      { sessionManager },
    );
  });

  it('reports an undeliverable escalation that expired meanwhile as expired', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      mockApi.failSendsMatching((m) => m.message.includes(' arguments ('));
      vi.mocked(createdMockSessions[0].session.resolveEscalation).mockRejectedValueOnce(
        new EscalationExpiredError('esc-undeliverable-late'),
      );
      await daemon.surfaceEscalation(1, escalationRequest('esc-undeliverable-late'));
      const code = bannerCode(1);

      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} expired (timed out)`));
      expect(mockApi.messageTexts.some((m) => m.includes('denied automatically'))).toBe(false);
    });
  });

  it('reports a late approval of an expired escalation as expired, not approved', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-stale');
      vi.mocked(createdMockSessions[0].session.resolveEscalation).mockRejectedValueOnce(
        new EscalationExpiredError('esc-stale'),
      );

      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} had already expired`));

      expect(mockApi.messageTexts.some((m) => m.includes(`Escalation ${code} approved`))).toBe(false);
    });
  });

  it('only allows denying an escalation whose values do not fit in full', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-long-path', { arguments: { path: `/tmp/${'a/'.repeat(5000)}x` } });
      expect(mockApi.messageTexts.some((m) => m.includes('cannot be approved over Signal'))).toBe(true);

      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} cannot be approved over Signal`));
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

      mockApi.simulateIncomingMessage(USER, `deny ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} denied`));
    });
  });

  it('details <code> sends more of the arguments as plain text', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-details', {
        arguments: { path: '/tmp/d.txt', content: `${'B'.repeat(1000)}END` },
      });
      expect(mockApi.messageTexts.some((m) => m.includes('END'))).toBe(false);

      mockApi.simulateIncomingMessage(USER, `details ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Details for ${code}`));
      const details = mockApi.sentMessages.filter((m) => m.message.includes(`Details for ${code}`));
      expect(details.every((m) => m.text_mode === 'normal')).toBe(true);
      expect(details[0].message).toContain('BBBBBEND"');
      expect(createdMockSessions[0].session.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it('handles concurrent replies to the same escalation once', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-789');

      // Two rapid replies: the second is refused while the first resolves, or after it.
      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      mockApi.simulateIncomingMessage(USER, `deny ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
      await waitForMessage(
        mockApi,
        (m) => m.includes('being resolved') || m.includes(`Escalation ${code} (#1) was already approved`),
      );
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledTimes(1);
    });
  });

  it('acts only on escalations whose banner went out over Signal', async () => {
    const sessionManager = new SessionManager();
    await withDaemon(
      async () => {
        await startSessions(1);
        // A web session's escalation is decided in the web UI, not from Signal.
        const webSession = createMockSession();
        const webLabel = sessionManager.register(webSession, stubTransport(), { kind: 'web' });
        sessionManager.recordEscalation(webLabel, escalationRequest('esc-web'));

        mockApi.simulateIncomingMessage(USER, 'deny');
        await waitForMessage(mockApi, (m) => m === 'No escalation is pending.');
        expect(webSession.resolveEscalation).not.toHaveBeenCalled();
      },
      undefined,
      { sessionManager },
    );
  });

  it('names the cron job in its banner and approves its escalation by code', async () => {
    const sessionManager = new SessionManager();
    await withDaemon(
      async (daemon) => {
        const cronSession = createMockSession();
        const label = sessionManager.register(cronSession, stubTransport(), {
          kind: 'cron',
          jobId: 'nightly' as JobId,
          jobName: 'Nightly triage',
        });
        await daemon.surfaceEscalation(label, escalationRequest('esc-cron'), { jobName: 'Nightly triage' });
        const code = bannerCode(label);
        expect(
          mockApi.messageTexts.some((m) => m.includes(`ESCALATION [#${label} cron: Nightly triage] code ${code}`)),
        ).toBe(true);

        mockApi.simulateIncomingMessage(USER, `approve #${label} ${code}`);
        await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
        expect(cronSession.resolveEscalation).toHaveBeenCalledWith('esc-cron', 'approved', undefined);
      },
      undefined,
      { sessionManager },
    );
  });

  it('checks the identity afresh for an approval instead of trusting the cached check', async () => {
    const before = errorsLogged('LOCKED');
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-fresh');
      const requests = mockApi.identityRequests;

      // The key changes without signal-cli flagging the envelope, within the 5-minute window.
      mockApi.setIdentities([{ number: USER, fingerprint: 'replaced-key' }]);
      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitFor(() => errorsLogged('LOCKED') > before);

      expect(mockApi.identityRequests).toBe(requests + 1);
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
      expect(mockApi.messageTexts.some((m) => m.includes(`Escalation ${code} approved`))).toBe(false);
    });
  });

  it('rejects an approval when signal-cli no longer lists the identity, then accepts it once listed again', async () => {
    const before = errorsLogged('lists no identity key');
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-noid');

      mockApi.setIdentities([]);
      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitFor(() => errorsLogged('lists no identity key') > before);
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

      mockApi.setIdentities([{ number: USER, fingerprint: 'test-identity-key-abc123' }]);
      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));
    });
  });

  it('/pending lists the escalations pending over Signal with their codes, as plain text', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(2);
      const one = await surface(daemon, 1, 'esc-p1');
      const two = await surface(daemon, 2, 'esc-p2', {
        serverName: 'git',
        toolName: 'git\u202epush',
        whitelistCandidates: [{ description: 'Allow git/git_push git-remote-url domain github.com' }],
      });

      mockApi.simulateIncomingMessage(USER, '/pending');
      await waitForMessage(mockApi, (m) => m.startsWith('Pending escalations (2):'));

      const sent = mockApi.sentMessages.find((m) => m.message.startsWith('Pending escalations'));
      expect(sent?.text_mode).toBe('normal');
      expect(sent?.message).toContain(`[#1] ${one} filesystem/write_file (raised `);
      expect(sent?.message).toContain(`[#2] ${two} git/git\\u202epush (raised `);
      expect(sent?.message).toContain('approve+ offered');
      expect(sent?.message).toContain('/show <code>');
      // Listing decides nothing and reaches no agent.
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
      expect(createdMockSessions[1].session.resolveEscalation).not.toHaveBeenCalled();
      expect(createdMockSessions[0].session.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it('/pending says nothing is pending here and counts escalations other clients hold', async () => {
    const sessionManager = new SessionManager();
    await withDaemon(
      async () => {
        mockApi.simulateIncomingMessage(USER, '/pending');
        await waitForMessage(mockApi, (m) => m === 'No escalation is pending.');

        const webLabel = sessionManager.register(createMockSession(), stubTransport(), { kind: 'web' });
        sessionManager.recordEscalation(webLabel, escalationRequest('esc-web'));
        mockApi.simulateIncomingMessage(USER, '/pending');
        await waitForMessage(mockApi, (m) =>
          m.includes('No escalation is pending here. 1 more escalation is pending in another client'),
        );
      },
      undefined,
      { sessionManager },
    );
  });

  it('/show <code> prints the escalation in full, sanitized, as plain text', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const content = `${'C'.repeat(1500)}END`;
      const code = await surface(daemon, 1, 'esc-show', {
        arguments: { path: '/tmp/s.txt', content, note: 'x` **Tool: `fs/read_file`** \u202eevil\u2028Reply' },
        reason: 'Write outside\u2029the sandbox',
        whitelistCandidates: [{ description: 'Allow filesystem/write_file write-path within /tmp' }],
      });
      // The banner cut the long value.
      expect(mockApi.messageTexts.some((m) => m.includes('CEND'))).toBe(false);

      mockApi.simulateIncomingMessage(USER, `/show ${code.toLowerCase()}`);
      await waitForMessage(mockApi, (m) => m.includes(`Details for ${code}`));
      await waitForMessage(mockApi, (m) => m.includes(`Reply "approve ${code}", "approve+ ${code}" or "deny ${code}"`));

      const details = mockApi.sentMessages.filter(
        (m) => m.message.startsWith(`[#1] `) && !m.message.includes('arguments ('),
      );
      expect(details.length).toBeGreaterThan(0);
      expect(details.every((m) => m.text_mode === 'normal')).toBe(true);
      const text = details
        .map((m) => m.message)
        .join('\n')
        .replace(new RegExp(`\\n\\[#1\\] ${code} details \\(continued\\):\\n`, 'gu'), '');
      expect(text).toContain(`content: "${content}"`);
      expect(text).toContain('note: "x` **Tool: `fs/read_file`** \\u202eevil\\u2028Reply"');
      expect(text).toContain('Reason: Write outside\\u2029the sandbox');
      expect(text).not.toMatch(/[\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
      expect(text).toContain(
        `"approve+ ${code}" whitelists, for this session: Allow filesystem/write_file write-path within /tmp`,
      );
      expect(createdMockSessions[0].session.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it('approve+ <code> approves and whitelists exactly the pattern its banner showed', async () => {
    const sessionManager = new SessionManager();
    await withDaemon(
      async (daemon) => {
        await startSessions(1);
        const shown = 'Allow filesystem/write_file write-path within /tmp/project';
        const candidates = [{ description: shown }, { description: 'Allow filesystem/write_file anywhere' }];
        const code = await surface(daemon, 1, 'esc-wl', { whitelistCandidates: candidates });

        // The pending escalation keeps the full request, candidates included.
        expect(sessionManager.get(1)?.pendingEscalations.get('esc-wl')?.whitelistCandidates).toEqual(candidates);
        const header = mockApi.messageTexts.find((m) => m.includes(`ESCALATION [#1] code ${code}`));
        expect(header).toContain(`Reply "approve ${code}" or "deny ${code}"`);
        expect(header).toContain(`or "approve+ ${code}" to approve and whitelist, for this session:\n${shown}\n`);
        expect(mockApi.messageTexts.some((m) => m.includes('anywhere'))).toBe(false);

        mockApi.simulateIncomingMessage(USER, `approve+ ${code.toLowerCase()}`);
        await waitForMessage(mockApi, (m) =>
          m.includes(`Escalation ${code} approved. Whitelisted for this session: ${shown}`),
        );

        // Index 0 is the candidate whose description the banner showed.
        expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-wl', 'approved', {
          whitelistSelection: 0,
        });
        const confirmation = mockApi.sentMessages.find((m) => m.message.includes('Whitelisted for this session'));
        expect(confirmation?.text_mode).toBe('normal');
        expect(createdMockSessions[0].session.sendMessage).toHaveBeenCalledTimes(1);
      },
      undefined,
      { sessionManager },
    );
  });

  it('approve+ whitelists the exact candidate; other clients list the candidates but never group it', async () => {
    const sessionManager = new SessionManager();
    await withDaemon(
      async (daemon) => {
        await startSessions(1);
        // The proxy's two candidates: the exact pattern first, the directory-wide one second.
        const exact = 'Allow filesystem/write_file write-path /tmp/project/a.txt';
        const exactKey = '["filesystem","write_file",[["write-path","/tmp/project/a.txt"]]]';
        const candidates = [
          { description: exact, scope: 'exact' as const, patternKey: exactKey },
          {
            description: 'Allow filesystem/write_file write-path within /tmp/project (recursive)',
            scope: 'directory' as const,
            patternKey: '["filesystem","write_file",[["write-path-dir","/tmp/project"]]]',
          },
        ];
        const code = await surface(daemon, 1, 'esc-exact', { whitelistCandidates: candidates });

        // The banner offers the exact pattern only; widening is never offered over Signal.
        const header = mockApi.messageTexts.find((m) => m.includes(`ESCALATION [#1] code ${code}`));
        expect(header).toContain(`or "approve+ ${code}" to approve and whitelist, for this session:\n${exact}\n`);
        expect(mockApi.messageTexts.some((m) => m.includes('(recursive)'))).toBe(false);

        // The web UI lists the candidates, but no group key: beside a web escalation with
        // the same exact pattern, a group approval covers the web one alone.
        const webSession = createMockSession();
        const webLabel = sessionManager.register(webSession, stubTransport(), { kind: 'web' });
        sessionManager.setPendingEscalation(webLabel, {
          escalationId: 'esc-web',
          sessionLabel: webLabel,
          toolName: 'write_file',
          serverName: 'filesystem',
          arguments: { path: '/tmp/project/a.txt' },
          reason: 'Write outside the sandbox',
          whitelistCandidates: [candidates[0]],
          groupKey: exactKey,
          receivedAt: new Date().toISOString(),
        });
        const ctx = { sessionManager } as unknown as DispatchContext;
        const listed = (await escalationDispatch(ctx, 'escalations.list', {})) as EscalationDto[];
        const overSignal = listed.find((esc) => esc.escalationId === 'esc-exact');
        expect(overSignal?.whitelistCandidates).toEqual(candidates);
        expect(overSignal).not.toHaveProperty('groupKey');
        await expect(
          escalationDispatch(ctx, 'escalations.approveGroup', {
            groupKey: exactKey,
            escalationIds: ['esc-web', 'esc-exact'],
          }),
        ).rejects.toMatchObject({ code: 'ESCALATION_GROUP_CHANGED' });
        expect(webSession.resolveEscalation).not.toHaveBeenCalled();
        expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

        mockApi.simulateIncomingMessage(USER, `approve+ ${code}`);
        await waitForMessage(mockApi, (m) =>
          m.includes(`Escalation ${code} approved. Whitelisted for this session: ${exact}`),
        );
        expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-exact', 'approved', {
          whitelistSelection: 0,
        });
      },
      undefined,
      { sessionManager },
    );
  });

  it('refuses approve+ when the banner offered no whitelist pattern', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(2);
      const plain = await surface(daemon, 1, 'esc-nowl');
      const humanOnly = await surface(daemon, 2, 'esc-human', {
        humanOnly: true,
        whitelistCandidates: [{ description: 'Allow proxy/add_proxy_domain domain example.com' }],
      });
      expect(mockApi.messageTexts.some((m) => m.includes(`"approve+ ${plain}"`))).toBe(false);
      expect(mockApi.messageTexts.some((m) => m.includes(`"approve+ ${humanOnly}"`))).toBe(false);

      mockApi.simulateIncomingMessage(USER, `approve+ ${plain}`);
      mockApi.simulateIncomingMessage(USER, `/approve+ #2 ${humanOnly}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${plain} offers no whitelist pattern`));
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${humanOnly} offers no whitelist pattern`));
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
      expect(createdMockSessions[1].session.resolveEscalation).not.toHaveBeenCalled();

      // A plain approval of the same escalation still works, without whitelisting.
      mockApi.simulateIncomingMessage(USER, `approve ${plain}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${plain} approved.`));
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-nowl', 'approved', undefined);
    });
  });

  it('consumes approve+ without a code, or malformed, instead of forwarding it to the agent', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);
      const code = await surface(daemon, 1, 'esc-plus', {
        whitelistCandidates: [{ description: 'Allow filesystem/write_file write-path within /tmp' }],
      });

      mockApi.simulateIncomingMessage(USER, 'approve+');
      mockApi.simulateIncomingMessage(USER, 'approve+ the plan please');
      mockApi.simulateIncomingMessage(USER, '/approve+');
      // Typos of "approve+ <code>": consumed (and not applied), never chat.
      mockApi.simulateIncomingMessage(USER, `approve+${code}`);
      mockApi.simulateIncomingMessage(USER, `approve++ ${code}`);
      mockApi.simulateIncomingMessage(USER, `/approve+${code}`);
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('reply "approve+ <code>"')).length >= 6);

      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
      expect(createdMockSessions[0].session.sendMessage).toHaveBeenCalledTimes(1); // only "Hello agent"
      expect(mockApi.messageTexts.some((m) => m.startsWith('Unknown command'))).toBe(false);
    });
  });

  // --- Session lifecycle ---

  it('handles /quit command by ending session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '/quit');
      await waitForMessage(mockApi, (m) => m.includes('Session ended'));

      expect(mockApi.messageTexts.some((m) => m.includes('Session ended'))).toBe(true);
    });
  });

  // --- Multi-session tests ---

  it('creates two concurrent sessions via /new', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      const startedCount = mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length;
      expect(startedCount).toBe(2);
    });
  });

  it('/sessions lists all active sessions', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      mockApi.simulateIncomingMessage('+15559876543', '/sessions');
      await waitForMessage(mockApi, (m) => m.includes('Active sessions'));

      const sessionList = mockApi.messageTexts.find((m) => m.includes('Active sessions'));
      expect(sessionList).toBeDefined();
      expect(sessionList).toContain('#1');
      expect(sessionList).toContain('#2');
      expect(sessionList).toContain('> #2');
    });
  });

  it('/switch changes which session receives messages', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      mockApi.simulateIncomingMessage('+15559876543', '/switch 1');
      await waitForMessage(mockApi, (m) => m.includes('Switched to session #1'));

      expect(mockApi.messageTexts.some((m) => m.includes('Switched to session #1'))).toBe(true);
    });
  });

  it('/quit ends current and auto-switches', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      mockApi.simulateIncomingMessage('+15559876543', '/quit');
      await waitForMessage(mockApi, (m) => m.includes('Switched to #1'));

      expect(mockApi.messageTexts.some((m) => m.includes('Switched to #1'))).toBe(true);
    });
  });

  it('/quit N ends a specific session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      mockApi.simulateIncomingMessage('+15559876543', '/quit 1');
      await waitForMessage(mockApi, (m) => m.includes('Session #1 ended'));

      expect(mockApi.messageTexts.some((m) => m.includes('Session #1 ended'))).toBe(true);
    });
  });

  it('a bare deny reaches the only pending escalation, whichever session has it', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(2);

      const code = await surface(daemon, 1, 'esc-auto');
      mockApi.simulateIncomingMessage(USER, 'deny');
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} denied`));

      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-auto', 'denied', undefined);
    });
  });

  it('two escalations of one session are both pending and decided or expired each on its own', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(1);

      // Parallel tool calls of session #1 escalate at once.
      const first = await surface(daemon, 1, 'esc-par-a');
      const second = await surface(daemon, 1, 'esc-par-b', { toolName: 'delete_file' });
      expect(second).not.toBe(first);

      mockApi.simulateIncomingMessage(USER, 'deny');
      await waitForMessage(mockApi, (m) => m.includes('Several escalations are pending (#1).'));
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

      mockApi.simulateIncomingMessage(USER, `approve ${first}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${first} approved`));
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-par-a', 'approved', undefined);

      // The second one is still pending, and expires on its own.
      daemon.expireEscalation(1, 'esc-par-b');
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${second} expired (timed out)`));
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledTimes(1);
    });
  });

  it('asks for the code when several escalations are pending', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(2);

      await surface(daemon, 1, 'esc-a');
      await surface(daemon, 2, 'esc-b');
      mockApi.simulateIncomingMessage(USER, 'deny');
      await waitForMessage(mockApi, (m) => m.includes('Several escalations are pending (#1, #2)'));
      mockApi.simulateIncomingMessage(USER, 'approve');
      await waitForMessage(mockApi, (m) => m.includes("Approvals need the escalation's code"));

      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
      expect(createdMockSessions[1].session.resolveEscalation).not.toHaveBeenCalled();
    });
  });

  it('deny #N and approve #N <code> target one session; a code from another session is refused', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(2);

      const one = await surface(daemon, 1, 'esc-x');
      const two = await surface(daemon, 2, 'esc-y');
      mockApi.simulateIncomingMessage(USER, `approve #2 ${one}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${one} is not on session #2`));

      mockApi.simulateIncomingMessage(USER, `approve #1 ${one}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${one} approved`));
      mockApi.simulateIncomingMessage(USER, 'deny #2');
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${two} denied`));

      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-x', 'approved', undefined);
      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-y', 'denied', undefined);
    });
  });

  it('max session limit enforced', async () => {
    await withDaemon(
      async () => {
        mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
        await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
        mockApi.simulateIncomingMessage('+15559876543', '/new');
        await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

        mockApi.simulateIncomingMessage('+15559876543', '/new');
        await waitForMessage(mockApi, (m) => m.includes('Session limit reached'));

        expect(mockApi.messageTexts.some((m) => m.includes('Session limit reached'))).toBe(true);
      },
      { maxConcurrentSessions: 2 },
    );
  });

  it('/sessions shows no active sessions when none exist', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/sessions');
      await waitForMessage(mockApi, (m) => m.includes('No active sessions'));

      expect(mockApi.messageTexts.some((m) => m.includes('No active sessions'))).toBe(true);
    });
  });

  it('/switch to non-existent session shows error', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/switch 5');
      await waitForMessage(mockApi, (m) => m.includes('No session #5'));

      expect(mockApi.messageTexts.some((m) => m.includes('No session #5'))).toBe(true);
    });
  });

  it('/budget N shows budget for specific session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '/budget 1');
      await waitForMessage(mockApi, (m) => m.includes('budget'));

      expect(mockApi.messageTexts.some((m) => m.includes('budget'))).toBe(true);
    });
  });

  // --- Multi-escalation flow tests ---

  it('approving one escalation leaves the other pending until its own code arrives', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(2);

      const one = await surface(daemon, 1, 'esc-a');
      const two = await surface(daemon, 2, 'esc-b');
      mockApi.simulateIncomingMessage(USER, `approve ${one}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${one} approved`));

      // Only #2 is left, but a bare approve still does not reach it.
      mockApi.simulateIncomingMessage(USER, 'approve');
      await waitForMessage(mockApi, (m) => m.includes("Approvals need the escalation's code"));
      expect(createdMockSessions[1].session.resolveEscalation).not.toHaveBeenCalled();

      mockApi.simulateIncomingMessage(USER, `approve ${two}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${two} approved`));
      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-b', 'approved', undefined);
    });
  });

  it('deny with explicit label targets the correct session', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(2);

      await surface(daemon, 1, 'esc-d1');
      const two = await surface(daemon, 2, 'esc-d2');
      mockApi.simulateIncomingMessage(USER, 'deny #2');
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${two} denied`));

      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-d2', 'denied', undefined);
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
    });
  });

  it('full flow: disambiguate, approve one by code, then deny the other bare', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(2);

      const one = await surface(daemon, 1, 'esc-flow-1');
      await surface(daemon, 2, 'esc-flow-2');

      // Step 1: a bare deny with two pending asks for the code
      mockApi.simulateIncomingMessage(USER, 'deny');
      await waitForMessage(mockApi, (m) => m.includes('Several escalations are pending'));

      // Step 2: approve #1 by its code
      mockApi.simulateIncomingMessage(USER, `approve ${one}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${one} approved`));
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith(
        'esc-flow-1',
        'approved',
        undefined,
      );

      // Step 3: only #2 is left, so a bare deny reaches it
      mockApi.simulateIncomingMessage(USER, 'deny');
      await waitForMessage(mockApi, (m) => m.includes('denied'));
      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-flow-2', 'denied', undefined);
    });
  });

  it('deny #N where N has no pending escalation shows error', async () => {
    await withDaemon(async (daemon) => {
      await startSessions(2);

      await surface(daemon, 1, 'esc-only-1');
      mockApi.simulateIncomingMessage(USER, 'deny #2');
      await waitForMessage(mockApi, (m) => m.includes('Session #2 has no pending escalation'));

      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
    });
  });

  // --- Escalation callback chain tests ---
  // These exercise the real onEscalation callback wiring instead of
  // calling daemon.surfaceEscalation() directly, catching bugs
  // where the transport's sessionLabel is wrong.

  it('escalation via callback chain labels banner with correct session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      expect(createdMockSessions[1].onEscalation).toBeDefined();
      createdMockSessions[1].onEscalation!({
        escalationId: 'esc-callback-2',
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://example.com' },
        reason: 'test escalation',
      });
      await waitForMessage(mockApi, (m) => m.includes('ESCALATION'));

      const banner = mockApi.messageTexts.find((m) => m.includes('ESCALATION'));
      expect(banner).toBeDefined();
      expect(banner).toContain('[#2]');
      expect(banner).not.toContain('[#1]');
    });
  });

  it('escalation via callback from session #1 labels banner with #1', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      expect(createdMockSessions[0].onEscalation).toBeDefined();
      createdMockSessions[0].onEscalation!({
        escalationId: 'esc-callback-1',
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: '/etc/passwd' },
        reason: 'protected path',
      });
      await waitForMessage(mockApi, (m) => m.includes('ESCALATION'));

      const banner = mockApi.messageTexts.find((m) => m.includes('ESCALATION'));
      expect(banner).toBeDefined();
      expect(banner).toContain('[#1]');
    });
  });

  it('approve routes to correct session when escalation was set via callback', async () => {
    await withDaemon(async (daemon) => {
      const surfaced = vi.spyOn(daemon, 'surfaceEscalation');
      await startSessions(2);

      createdMockSessions[1].onEscalation!({
        escalationId: 'esc-cb-resolve',
        serverName: 'git',
        toolName: 'git_clone',
        arguments: {},
        reason: 'test',
      });
      await deliveries(surfaced);
      const code = bannerCode(2);

      mockApi.simulateIncomingMessage(USER, `approve ${code}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code} approved`));

      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith(
        'esc-cb-resolve',
        'approved',
        undefined,
      );
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
    });
  });

  it('concurrent callback escalations on both sessions are told apart by their codes', async () => {
    await withDaemon(async (daemon) => {
      const surfaced = vi.spyOn(daemon, 'surfaceEscalation');
      await startSessions(2);

      createdMockSessions[0].onEscalation!({
        escalationId: 'esc-both-1',
        serverName: 'git',
        toolName: 'git_push',
        arguments: {},
        reason: 'push requires approval',
      });
      createdMockSessions[1].onEscalation!({
        escalationId: 'esc-both-2',
        serverName: 'filesystem',
        toolName: 'delete_file',
        arguments: {},
        reason: 'delete requires approval',
      });
      await deliveries(surfaced);

      const banners = mockApi.messageTexts.filter((m) => m.includes('ESCALATION'));
      expect(banners.length).toBe(2);
      expect(banners.some((b) => b.includes('[#1]'))).toBe(true);
      expect(banners.some((b) => b.includes('[#2]'))).toBe(true);

      // Bare approve is refused: it does not say which escalation it means
      mockApi.simulateIncomingMessage(USER, 'approve');
      await waitForMessage(mockApi, (m) => m.includes("Approvals need the escalation's code"));

      // Approve #2 by its code, then deny #1 (the only one left) bare
      const two = bannerCode(2);
      mockApi.simulateIncomingMessage(USER, `approve ${two}`);
      await waitForMessage(mockApi, (m) => m.includes(`Escalation ${two} approved`));
      mockApi.simulateIncomingMessage(USER, 'deny');
      await waitForMessage(mockApi, (m) => m.includes('denied'));

      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith(
        'esc-both-2',
        'approved',
        undefined,
      );
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-both-1', 'denied', undefined);
    });
  });

  it('reproduces production scenario: session #1 escalation resolved, /new, message to #2 escalates with correct label', async () => {
    // This test reproduces the exact production bug:
    // 1. Session #1 created, processes message, escalates
    // 2. User approves session #1's escalation
    // 3. Session #1 responds
    // 4. /new creates session #2
    // 5. Message sent to session #2, session #2 escalates
    // 6. Banner should say [#2], not [#1]

    // Make session #1's sendMessage trigger an escalation via callback, then resolve
    const { createStandaloneSession: createSession } = await import('../../src/session/index.js');
    const mockCreateSession = vi.mocked(createSession);

    let callCount = 0;
    mockCreateSession.mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
      callCount++;
      const session = createMockSession();

      if (callCount === 1) {
        // Session #1: sendMessage triggers escalation, then resolves after approval
        session.sendMessage = vi.fn().mockImplementation(async () => {
          // Simulate the session escalating during message processing
          options?.onEscalation?.({
            escalationId: 'esc-s1-clone',
            serverName: 'git',
            toolName: 'git_clone',
            arguments: { url: 'https://github.com/provos/ironcurtain.web' },
            reason: 'Remote git operations require approval',
          });
          // Yield to let escalation be processed before returning
          await wait(10);
          return 'Repository cloned successfully.';
        });
      } else if (callCount === 2) {
        // Session #2: sendMessage triggers escalation, then resolves
        session.sendMessage = vi.fn().mockImplementation(async () => {
          options?.onEscalation?.({
            escalationId: 'esc-s2-clone',
            serverName: 'git',
            toolName: 'git_clone',
            arguments: { url: 'https://github.com/provos/provos.github.io' },
            reason: 'Remote git operations require approval',
          });
          await wait(10);
          return 'Clone operation was blocked.';
        });
      }

      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    const daemon = createDaemon();
    const surfaced = vi.spyOn(daemon, 'surfaceEscalation');
    const startPromise = daemon.start();
    await waitForMessages(mockApi, 1);

    // Step 1: Send message to create session #1 and trigger its escalation
    mockApi.simulateIncomingMessage('+15559876543', 'clone ironcurtain.web');
    await waitForMessage(mockApi, (m) => m.includes('arguments (') && m.includes('ironcurtain.web'));

    // Session #1 should be processing and have escalated
    let messages = mockApi.messageTexts;
    const banner1 = messages.find((m) => m.includes('arguments (') && m.includes('ironcurtain.web'));
    expect(banner1).toBeDefined();
    expect(banner1).toContain('[#1]');
    expect(messages.some((m) => m.includes('ESCALATION [#1]'))).toBe(true);

    // Step 2: Approve session #1's escalation with the code from its banner
    await deliveries(surfaced);
    const code1 = bannerCode(1);
    mockApi.simulateIncomingMessage('+15559876543', `approve ${code1}`);
    await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code1} approved`));
    await waitForMessage(mockApi, (m) => m.includes('Repository cloned successfully'));

    // Session #1 should have responded
    messages = mockApi.messageTexts;
    expect(messages.some((m) => m.includes('Repository cloned successfully'))).toBe(true);

    // Step 3: /new creates session #2
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

    // Step 4: Send message to session #2 (current), which triggers escalation
    mockApi.simulateIncomingMessage('+15559876543', 'clone provos.github.io');
    await waitForMessage(mockApi, (m) => m.includes('arguments (') && m.includes('provos/provos.github.io'));

    // Step 5: The escalation banner for session #2 should say [#2], NOT [#1]
    messages = mockApi.messageTexts;
    const banner2 = messages.find((m) => m.includes('arguments (') && m.includes('provos/provos.github.io'));
    expect(banner2).toBeDefined();
    expect(banner2).toContain('[#2]');
    expect(banner2).not.toContain('[#1]');
    expect(messages.some((m) => m.includes('ESCALATION [#2]'))).toBe(true);

    // Step 6: Deny and verify it resolves on session #2
    await deliveries(surfaced);
    mockApi.simulateIncomingMessage('+15559876543', 'deny');
    await waitForMessage(mockApi, (m) => m.includes('Clone operation was blocked'));
    // The "Escalation denied." confirmation is emitted on a separate async chain
    // (resolveSessionEscalation().then() in signal-bot-daemon.ts) and can lag the
    // session's "blocked" response, so await it explicitly before asserting on it —
    // otherwise `denyMsg` is intermittently undefined (macOS-runner-timing flake).
    await waitForMessage(mockApi, (m) => m.includes('denied'));

    messages = mockApi.messageTexts;
    // The deny confirmation should reference session #2
    const denyMsg = messages.find((m) => m.includes('denied'));
    expect(denyMsg).toContain('[#2]');

    // The session #2 response should also be prefixed with [#2]
    expect(messages.some((m) => m.includes('[#2]') && m.includes('Clone operation was blocked'))).toBe(true);

    // Session #1's resolveEscalation should NOT have been called for the second escalation
    expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalledWith('esc-s2-clone', 'denied');

    await daemon.shutdown();
    await startPromise;
  });

  it('race: message sent immediately after /new is routed to the new session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'hello', 1000);
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      expect(createdMockSessions).toHaveLength(1);
      const session1 = createdMockSessions[0].session;
      // Wait for the "hello" message to be fully forwarded to the session
      // before clearing — the WebSocket handler is fire-and-forget so
      // sendMessage("hello") may still be in-flight after the "Started a
      // new session" notification is sent.
      await waitForCalls(vi.mocked(session1.sendMessage), 1);
      vi.mocked(session1.sendMessage).mockClear();

      // Send /new immediately followed by a message (same tick)
      mockApi.simulateIncomingMessage('+15559876543', '/new', 2000);
      mockApi.simulateIncomingMessage('+15559876543', 'work on provos.github.io', 2001);
      await waitFor(() => createdMockSessions.length >= 2);
      await waitForCalls(vi.mocked(createdMockSessions[1].session.sendMessage), 1);

      expect(createdMockSessions).toHaveLength(2);
      const session2 = createdMockSessions[1].session;

      // The message must go to session #2, not session #1
      expect(vi.mocked(session1.sendMessage)).not.toHaveBeenCalled();
      expect(vi.mocked(session2.sendMessage)).toHaveBeenCalledWith('work on provos.github.io');
    });
  });

  it('race: escalation after /new gets correct session label', async () => {
    // End-to-end test for the reported bug: escalation banner should
    // show [#2] when the message was routed to session #2 after /new.

    const { createStandaloneSession: createSession } = await import('../../src/session/index.js');
    const mockCreateSession = vi.mocked(createSession);

    let callCount = 0;
    mockCreateSession.mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
      callCount++;
      const session = createMockSession();

      if (callCount === 2) {
        // Session #2: sendMessage triggers escalation for provos.github.io
        session.sendMessage = vi.fn().mockImplementation(async () => {
          options?.onEscalation?.({
            escalationId: 'esc-race-s2',
            serverName: 'git',
            toolName: 'git_clone',
            arguments: { url: 'https://github.com/provos/provos.github.io' },
            reason: 'approval required',
          });
          await wait(10);
          return 'Clone blocked.';
        });
      }

      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    const daemon = createDaemon();
    const surfaced = vi.spyOn(daemon, 'surfaceEscalation');
    const startPromise = daemon.start();
    await waitForMessages(mockApi, 1);

    // Explicit, distinct (and current: replies older than an escalation are
    // refused) timestamps for messages sent in the same tick.
    const t0 = Date.now();

    // Create session #1
    mockApi.simulateIncomingMessage('+15559876543', 'hello', t0);
    await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
    expect(createdMockSessions).toHaveLength(1);

    // Send /new + message in rapid succession
    mockApi.simulateIncomingMessage('+15559876543', '/new', t0 + 1);
    mockApi.simulateIncomingMessage('+15559876543', 'clone provos.github.io', t0 + 2);
    await waitForMessage(mockApi, (m) => m.includes('arguments (') && m.includes('provos/provos.github.io'));

    // The escalation banner must say [#2], not [#1]
    const messages = mockApi.messageTexts;
    const banner = messages.find((m) => m.includes('arguments (') && m.includes('provos/provos.github.io'));
    expect(banner).toBeDefined();
    expect(banner).toContain('[#2]');
    expect(messages.some((m) => m.includes('ESCALATION [#2]'))).toBe(true);
    expect(messages.some((m) => m.includes('ESCALATION [#1]'))).toBe(false);

    // Deny and verify correct routing
    await deliveries(surfaced);
    mockApi.simulateIncomingMessage('+15559876543', 'deny', t0 + 3);
    await waitForMessage(mockApi, (m) => m.includes('denied') && m.includes('[#2]'));

    const allMessages = mockApi.messageTexts;
    // Deny confirmation should reference #2
    expect(allMessages.some((m) => m.includes('denied') && m.includes('[#2]'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('concurrent: session #1 in-flight when /new and #2 message arrive', async () => {
    // This reproduces the exact concurrent production scenario:
    // - Session #1 is STILL PROCESSING (forwardMessage hasn't returned)
    // - User sends /new → creates session #2
    // - User sends message → goes to session #2
    // - Session #2 escalates → banner should say [#2]

    const { createStandaloneSession: createSession } = await import('../../src/session/index.js');
    const mockCreateSession = vi.mocked(createSession);

    // Controls for session #1's long-running message
    let resolveSession1Message: ((value: string) => void) | null = null;

    let callCount = 0;
    mockCreateSession.mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
      callCount++;
      const session = createMockSession();

      if (callCount === 1) {
        // Session #1: sendMessage blocks until we explicitly resolve it
        session.sendMessage = vi.fn().mockImplementation(() => {
          return new Promise<string>((resolve) => {
            // Fire escalation immediately
            options?.onEscalation?.({
              escalationId: 'esc-concurrent-s1',
              serverName: 'git',
              toolName: 'git_clone',
              arguments: { url: 'https://github.com/provos/ironcurtain.web' },
              reason: 'approval required',
            });
            // But DON'T resolve the message yet — session #1 stays in-flight
            resolveSession1Message = resolve;
          });
        });
      } else if (callCount === 2) {
        // Session #2: sendMessage triggers escalation, resolves after yield
        session.sendMessage = vi.fn().mockImplementation(async () => {
          options?.onEscalation?.({
            escalationId: 'esc-concurrent-s2',
            serverName: 'git',
            toolName: 'git_clone',
            arguments: { url: 'https://github.com/provos/provos.github.io' },
            reason: 'approval required',
          });
          await wait(10);
          return 'Clone blocked.';
        });
      }

      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    const daemon = createDaemon();
    const surfaced = vi.spyOn(daemon, 'surfaceEscalation');
    const startPromise = daemon.start();
    await waitForMessages(mockApi, 1);

    // Step 1: Message creates session #1 and starts processing (blocks)
    mockApi.simulateIncomingMessage('+15559876543', 'clone ironcurtain.web');
    await waitForMessage(mockApi, (m) => m.includes('arguments (') && m.includes('ironcurtain.web'));

    // Session #1 has escalated but its forwardMessage is still blocked
    let messages = mockApi.messageTexts;
    const banner1 = messages.find((m) => m.includes('arguments (') && m.includes('ironcurtain.web'));
    expect(banner1).toContain('[#1]');

    // Step 2: Approve session #1's escalation with its code
    await deliveries(surfaced);
    const code1 = bannerCode(1);
    mockApi.simulateIncomingMessage('+15559876543', `approve ${code1}`);
    await waitForMessage(mockApi, (m) => m.includes(`Escalation ${code1} approved`));

    // Now resolve session #1's message so it finishes
    expect(resolveSession1Message).not.toBeNull();
    resolveSession1Message!('Repository cloned.');
    await waitForMessage(mockApi, (m) => m.includes('Repository cloned'));

    // Step 3: /new while nothing is in-flight anymore
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

    // Step 4: Message to session #2 triggers escalation
    mockApi.simulateIncomingMessage('+15559876543', 'clone provos.github.io');
    await waitForMessage(mockApi, (m) => m.includes('arguments (') && m.includes('provos/provos.github.io'));

    // THE KEY ASSERTION: session #2's escalation banner must say [#2]
    messages = mockApi.messageTexts;
    const banner2 = messages.find((m) => m.includes('arguments (') && m.includes('provos/provos.github.io'));
    expect(banner2).toBeDefined();
    expect(banner2).toContain('[#2]');
    expect(banner2).not.toContain('[#1]');
    expect(messages.filter((m) => m.includes('ESCALATION [#2]'))).toHaveLength(1);

    // Deny and verify correct routing
    await deliveries(surfaced);
    mockApi.simulateIncomingMessage('+15559876543', 'deny');
    await waitForMessage(mockApi, (m) => m.includes('Clone blocked'));
    // The "denied" confirmation is emitted on a separate async chain
    // (resolveSessionEscalation().then()) from the session's "Clone blocked"
    // response, so wait for it explicitly before asserting on it.
    await waitForMessage(mockApi, (m) => m.includes('denied') && m.includes('[#2]'));

    messages = mockApi.messageTexts;
    // Deny confirmation should reference #2
    expect(messages.some((m) => m.includes('denied') && m.includes('[#2]'))).toBe(true);
    // Response from session #2 should be prefixed [#2]
    expect(messages.some((m) => m.includes('[#2]') && m.includes('Clone blocked'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  // --- #N prefix routing tests ---

  it('#N prefix routes message to specified session without switching', async () => {
    await withDaemon(async () => {
      // Create session #1 (auto-created)
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      // Create session #2
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      // Current session is #2. Route to #1 via prefix.
      // sendMessage on session #1 was already called once for "Hello agent"
      const callsBefore = vi.mocked(createdMockSessions[0].session.sendMessage).mock.calls.length;
      mockApi.simulateIncomingMessage('+15559876543', '#1 list the directory');
      await waitForCalls(vi.mocked(createdMockSessions[0].session.sendMessage), callsBefore + 1);

      // Message should have been sent to session #1
      expect(vi.mocked(createdMockSessions[0].session.sendMessage)).toHaveBeenCalledWith('list the directory');
      // Session #2 should NOT have received this message
      expect(vi.mocked(createdMockSessions[1].session.sendMessage)).not.toHaveBeenCalledWith('list the directory');

      // currentLabel should still be #2: send a plain message and verify it goes to #2
      vi.mocked(createdMockSessions[1].session.sendMessage).mockClear();
      mockApi.simulateIncomingMessage('+15559876543', 'follow up');
      await waitForCalls(vi.mocked(createdMockSessions[1].session.sendMessage), 1);

      expect(vi.mocked(createdMockSessions[1].session.sendMessage)).toHaveBeenCalledWith('follow up');
    });
  });

  it('#N prefix to non-existent session shows error', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '#5 do something');
      await waitForMessage(mockApi, (m) => m.includes('No session #5'));

      expect(mockApi.messageTexts.some((m) => m.includes('No session #5'))).toBe(true);
    });
  });

  it('#N prefix strips only the prefix from the forwarded message', { timeout: 15_000 }, async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      // Wait for the agent response (not just "Started a new session") so that
      // forwardToSession for "Hello agent" has completed and messageInFlight is false.
      await waitForMessage(mockApi, (m) => m.includes('Agent response text'), 10_000);

      const callsBefore = vi.mocked(createdMockSessions[0].session.sendMessage).mock.calls.length;
      mockApi.simulateIncomingMessage('+15559876543', '#1 check #2 issue');
      await waitForCalls(vi.mocked(createdMockSessions[0].session.sendMessage), callsBefore + 1, 10_000);

      expect(vi.mocked(createdMockSessions[0].session.sendMessage)).toHaveBeenCalledWith('check #2 issue');
    });
  });

  // --- /help with current session ---

  it('/help shows current session label', async () => {
    await withDaemon(async () => {
      // Create a session first
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '/help');
      await waitForMessage(mockApi, (m) => m.includes('Commands:'));

      const helpMsg = mockApi.messageTexts.find((m) => m.includes('Commands:'));
      expect(helpMsg).toBeDefined();
      expect(helpMsg).toContain('Current session: #1');
    });
  });

  it('/help shows no active session when none exists', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/help');
      await waitForMessage(mockApi, (m) => m.includes('Commands:'));

      const helpMsg = mockApi.messageTexts.find((m) => m.includes('Commands:'));
      expect(helpMsg).toBeDefined();
      expect(helpMsg).toContain('No active session.');
    });
  });

  it('/help includes #N prefix routing documentation', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/help');
      await waitForMessage(mockApi, (m) => m.includes('Commands:'));

      const helpMsg = mockApi.messageTexts.find((m) => m.includes('Commands:'));
      expect(helpMsg).toContain('#N <message>');
    });
  });
});
