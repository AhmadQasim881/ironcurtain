/**
 * IronCurtainDaemon (src/daemon/ironcurtain-daemon.ts): start/stop and
 * escalation routing across its transports, with fakes at the edges only.
 *
 * Real: the daemon, its control socket, its SessionManager and cron
 * execution, the SignalBotDaemon, and the web UI server (on an ephemeral
 * loopback port). Fake: the signal-cli REST API (a loopback HTTP and
 * WebSocket server, see test/helpers/mock-signal-api.ts), the agent sessions,
 * the workflow manager and the statistics store. Nothing leaves 127.0.0.1
 * and no container is started.
 *
 * A cron job's escalation is the case that crosses transports. The daemon
 * hands it to the Signal bot, which marks it pending on the shared
 * SessionManager and posts a banner carrying the escalation's reply code; a
 * Signal reply quoting that code (`approve <code>`, `deny <code>`), a
 * `deny #N` naming the session, or the web UI's `escalations.resolve` must
 * reach that cron session and no other, and an approval without the code
 * (`approve`, `approve #N`) decides nothing. Without a channel that can
 * answer it, the escalation is denied at once.
 *
 * Every job is saved with a compiled policy for its constitution: the daemon
 * refuses to run a job without one (src/cron/job-policy.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const fakes = vi.hoisted(() => {
  /** Stands in for the workflow system the web UI server is given. */
  class FakeWorkflowManager {
    startBackgroundTasks(): void {}
    findToolCallEscalation(): undefined {
      return undefined;
    }
    async shutdown(): Promise<void> {}
  }
  return { FakeWorkflowManager };
});

vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
vi.mock('../src/cron/compile-task-policy.js', () => ({ compileTaskPolicy: vi.fn(async () => {}) }));
vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: vi.fn(
    () =>
      ({
        protectedPaths: [],
        userConfig: { resourceBudget: {}, memory: { enabled: false, autoSave: false } },
      }) as unknown as IronCurtainConfig,
  ),
}));
vi.mock('../src/signal/signal-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/signal/signal-config.js')>()),
  resolveSignalConfig: vi.fn(),
}));
vi.mock('../src/signal/signal-container.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/signal/signal-container.js')>()),
  createSignalContainerManager: vi.fn(),
}));
vi.mock('../src/docker/docker-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/docker/docker-manager.js')>()),
  createDockerManager: vi.fn(() => ({})),
}));
vi.mock('../src/llm-metrics/runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/llm-metrics/runtime.js')>()),
  acquireLlmMetricsRuntime: vi.fn(),
}));
vi.mock('../src/workflow/workflow-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/workflow/workflow-manager.js')>()),
  WorkflowManager: fakes.FakeWorkflowManager,
}));

import type { IronCurtainConfig } from '../src/config/types.js';
import { getDaemonSocketPath, getJobGeneratedDir, getWebUiStatePath } from '../src/config/paths.js';
import { saveJob } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition, type RunRecord } from '../src/cron/types.js';
import { sendControlRequest } from '../src/daemon/control-socket.js';
import { IronCurtainDaemon, type IronCurtainDaemonOptions } from '../src/daemon/ironcurtain-daemon.js';
import { acquireLlmMetricsRuntime, type LlmMetricsRuntimeLease } from '../src/llm-metrics/runtime.js';
import * as logger from '../src/logger.js';
import { createStandaloneSession } from '../src/session/index.js';
import type { BudgetStatus, EscalationRequest, Session, SessionInfo, SessionOptions } from '../src/session/types.js';
import { SignalBotDaemon } from '../src/signal/signal-bot-daemon.js';
import { createSignalContainerManager } from '../src/signal/signal-container.js';
import { resolveSignalConfig } from '../src/signal/signal-config.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';
import {
  MockSignalApi,
  SIGNAL_TEST_IDENTITY_KEY,
  SIGNAL_TEST_RECIPIENT,
  createMockSignalContainerManager,
  createTestSignalConfig,
  waitFor,
  waitForMessage,
} from './helpers/mock-signal-api.js';

const createSession = vi.mocked(createStandaloneSession);

type StandaloneOptions = Omit<SessionOptions, 'agentConversationId'>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function job(id: string, name: string, overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    id: createJobId(id),
    name,
    schedule: '0 3 * * *',
    taskDescription: 'Check the deployment',
    taskConstitution: 'The agent may read the workspace.',
    notifyOnEscalation: true,
    notifyOnCompletion: false,
    enabled: false,
    ...overrides,
  };
}

/** Saves a job with the policy compiled from its constitution, which every run requires. */
async function saveJobWithPolicy(definition: JobDefinition): Promise<void> {
  await saveJob(definition);
  writeCompiledPolicyFor(getJobGeneratedDir(definition.id), definition.taskConstitution);
}

function escalation(escalationId: string): EscalationRequest {
  return {
    escalationId,
    serverName: 'filesystem',
    toolName: 'write_file',
    arguments: { path: '/etc/hosts' },
    reason: 'Writes outside the workspace',
  };
}

function budgetStatus(): BudgetStatus {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
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
      stepCount: 1,
      activeSeconds: 1,
      estimatedCostUsd: 0,
    },
    tokenTrackingAvailable: false,
  };
}

interface CronSession {
  readonly session: Session;
  readonly resolveEscalation: ReturnType<typeof vi.fn<Session['resolveEscalation']>>;
}

/**
 * A cron session whose task turn raises `request` and then waits until the
 * escalation is resolved, the way a real turn waits on its proxy. Like a
 * real session it reports the resolution through `onEscalationResolved`.
 */
function escalatingSession(jobId: string, request: EscalationRequest, options: StandaloneOptions): CronSession {
  let finishTurn: (() => void) | undefined;
  const resolveEscalation = vi.fn<Session['resolveEscalation']>(async (escalationId, decision) => {
    options.onEscalationResolved?.(escalationId, decision);
    finishTurn?.();
  });
  const session: Session = {
    getInfo: () => ({
      id: `cron-${jobId}` as SessionInfo['id'],
      status: 'ready',
      turnCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    sendMessage: vi.fn<Session['sendMessage']>(
      () =>
        new Promise<string>((resolve) => {
          finishTurn = () => resolve('Task finished.');
          options.onEscalation?.(request);
        }),
    ),
    getHistory: () => [],
    getDiagnosticLog: () => [],
    resolveEscalation,
    getPendingEscalations: () => [],
    getBudgetStatus: () => budgetStatus(),
    close: vi.fn(async () => {}),
  };
  return { session, resolveEscalation };
}

interface WebUiState {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

interface WebUiClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IronCurtainDaemon', () => {
  let home: string;
  let savedHome: string | undefined;
  let api: MockSignalApi;
  let stderr: MockInstance<typeof process.stderr.write>;
  let lease: LlmMetricsRuntimeLease & { release: ReturnType<typeof vi.fn<() => Promise<void>>> };
  /** Sessions created for cron runs, by job id. */
  let cronSessions: Map<string, CronSession>;
  /** What each job's session escalates, by job id. */
  let escalations: Map<string, EscalationRequest>;
  let running: { daemon: IronCurtainDaemon; started: Promise<void> } | undefined;
  const sockets: WebSocket[] = [];
  /** Calls through: only records which escalations reached the Signal bot, and their banner deliveries. */
  let surfaced: MockInstance<SignalBotDaemon['surfaceEscalation']>;

  beforeEach(async () => {
    savedHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-daemon-'));
    process.env.IRONCURTAIN_HOME = home;

    api = new MockSignalApi();
    await api.start();
    api.setIdentities([{ number: SIGNAL_TEST_RECIPIENT, fingerprint: SIGNAL_TEST_IDENTITY_KEY }]);
    vi.mocked(resolveSignalConfig).mockReturnValue(createTestSignalConfig(api.port));
    vi.mocked(createSignalContainerManager).mockReturnValue(createMockSignalContainerManager(api.port));

    lease = {
      repository: {} as LlmMetricsRuntimeLease['repository'],
      reader: {} as LlmMetricsRuntimeLease['reader'],
      release: vi.fn(async () => {}),
    };
    vi.mocked(acquireLlmMetricsRuntime).mockResolvedValue(lease);

    cronSessions = new Map();
    escalations = new Map();
    createSession.mockReset();
    createSession.mockImplementation(async (options) => {
      const jobId = options.jobId ?? '';
      const request = escalations.get(jobId);
      if (!request) throw new Error(`no escalation planned for job "${jobId}"`);
      const cron = escalatingSession(jobId, request, options);
      cronSessions.set(jobId, cron);
      return cron.session;
    });

    surfaced = vi.spyOn(SignalBotDaemon.prototype, 'surfaceEscalation');

    // The daemon reports progress on stderr; keep it out of the test output.
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    if (running) {
      await running.daemon.shutdown();
      await running.started;
      running = undefined;
    }
    await api.stop();
    surfaced.mockRestore();
    stderr.mockRestore();
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const stderrText = (): string =>
    stderr.mock.calls.map(([chunk]) => (typeof chunk === 'string' ? chunk : '')).join('');

  /** Starts the daemon and waits until start() has brought every transport up. */
  async function startDaemon(options: Partial<IronCurtainDaemonOptions> = {}): Promise<IronCurtainDaemon> {
    const daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, ...options });
    const started = daemon.start();
    running = { daemon, started };
    await Promise.race([
      waitFor(() => stderrText().includes('IronCurtain daemon started.')),
      started.then(() => {
        throw new Error('start() returned before the daemon was shut down');
      }),
    ]);
    return daemon;
  }

  /** Shuts the daemon down and waits for start() to return. */
  async function stopDaemon(): Promise<void> {
    if (!running) throw new Error('daemon not running');
    const { daemon, started } = running;
    running = undefined;
    await daemon.shutdown();
    await started;
  }

  /**
   * A message from the configured Signal user to the bot, sent now: the bot
   * refuses a reply dated before the escalation it would decide.
   */
  function signalReply(text: string): void {
    api.simulateIncomingMessage(SIGNAL_TEST_RECIPIENT, text);
  }

  /**
   * Waits until the daemon has handed the escalation of `jobName` to the
   * Signal bot and the bot has delivered its whole banner (an approval sent
   * before that is refused), then returns the session label and the reply
   * code the banner header names.
   */
  async function escalationBanner(jobName: string): Promise<{ label: number; code: string; banner: string }> {
    const callIndex = (): number => surfaced.mock.calls.findIndex(([, , origin]) => origin?.jobName === jobName);
    await waitFor(() => callIndex() !== -1);
    await surfaced.mock.results[callIndex()].value;
    const banner = api.messageTexts.find((m) => m.includes(` cron: ${jobName}] code `)) ?? '';
    const match = /^ESCALATION \[#(\d+) cron: .*\] code ([A-Z0-9]{4})$/m.exec(banner);
    if (!match) throw new Error(`no escalation banner for "${jobName}": ${banner}`);
    return { label: Number(match[1]), code: match[2], banner };
  }

  function cronSession(jobId: string): CronSession {
    const cron = cronSessions.get(jobId);
    if (!cron) throw new Error(`no session was created for job "${jobId}"`);
    return cron;
  }

  function connectWebUi(state: WebUiState): Promise<WebUiClient> {
    const socket = new WebSocket(`ws://${state.host}:${state.port}/ws?token=${encodeURIComponent(state.token)}`);
    sockets.push(socket);
    const waiting = new Map<string, { resolve: (payload: unknown) => void; reject: (error: Error) => void }>();
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as {
        id?: string;
        ok?: boolean;
        payload?: unknown;
        error?: { code: string; message: string };
      };
      if (frame.id === undefined) return; // a broadcast event
      const waiter = waiting.get(frame.id);
      if (!waiter) return;
      waiting.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.payload);
      else waiter.reject(Object.assign(new Error(frame.error?.message), { code: frame.error?.code }));
    });
    let nextId = 0;
    const client: WebUiClient = {
      request(method, params = {}) {
        nextId += 1;
        const id = `req-${nextId}`;
        return new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
    };
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(client));
      socket.once('error', reject);
    });
  }

  function readWebUiState(): WebUiState {
    return JSON.parse(readFileSync(getWebUiStatePath(), 'utf8')) as WebUiState;
  }

  it('start() brings up the control socket, the schedule, Signal and the web UI; shutdown() takes them down', async () => {
    await saveJobWithPolicy(job('nightly-report', 'Nightly report', { enabled: true }));
    await saveJobWithPolicy(job('paused-job', 'Paused job'));

    const daemon = await startDaemon({ webUi: { port: 0 } });

    // The CLI reaches the daemon through the control socket.
    const status = await sendControlRequest({ command: 'status' });
    expect(status).toMatchObject({
      kind: 'response',
      response: {
        ok: true,
        data: { jobs: { total: 2, enabled: 1, running: 0, failing: 0 }, signalConnected: true, webUi: 'listening' },
      },
    });
    const statusData = status.kind === 'response' && status.response.ok ? status.response.data : undefined;
    expect((statusData as { nextFireTime?: unknown } | undefined)?.nextFireTime).toEqual(expect.any(String));

    // Signal is connected and greeted the user.
    await waitForMessage(api, (m) => m.includes('IronCurtain bot is online'));

    // The web UI answers on the port and token the daemon published for CLI clients.
    const webUi = readWebUiState();
    expect(webUi.host).toBe('127.0.0.1');
    const ui = await connectWebUi(webUi);
    expect(await ui.request('status')).toMatchObject({
      webUiListening: true,
      signalConnected: true,
      jobs: { total: 2, enabled: 1 },
      sessionMode: 'builtin',
    });

    await stopDaemon();

    expect(await sendControlRequest({ command: 'status' })).toMatchObject({ kind: 'unreachable' });
    expect(existsSync(getDaemonSocketPath())).toBe(false);
    expect(existsSync(getWebUiStatePath())).toBe(false);
    await expect(connectWebUi(webUi)).rejects.toThrow();
    await waitForMessage(api, (m) => m.includes('IronCurtain bot is shutting down'));
    expect(daemon.getStatus().nextFireTime).toBeNull();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('announces a cron escalation on Signal and resolves it on that session when the user approves with its code', async () => {
    const definition = job('deploy-check', 'Deploy check', { notifyOnCompletion: true });
    await saveJobWithPolicy(definition);
    escalations.set(definition.id, escalation('esc-deploy'));
    const daemon = await startDaemon();

    const run = daemon.runJobNow(definition.id);
    const { label, code, banner } = await escalationBanner('Deploy check');
    expect(banner).toContain('Tool: filesystem/write_file');
    expect(banner).toContain('Reason: Writes outside the workspace');
    expect(banner).toContain(`Reply "approve ${code}" or "deny ${code}"`);
    // The arguments being approved follow in their own message.
    expect(api.messageTexts).toContain(`[#${label}] ${code} arguments (1):\npath: "/etc/hosts"`);
    expect(cronSession(definition.id).resolveEscalation).not.toHaveBeenCalled();

    signalReply(`approve ${code}`);
    const record: RunRecord = await run;

    expect(cronSession(definition.id).resolveEscalation.mock.calls).toEqual([['esc-deploy', 'approved', undefined]]);
    expect(record).toMatchObject({ outcome: { kind: 'success' }, escalationsEncountered: 1, escalationsApproved: 1 });
    await waitForMessage(api, (m) => m.includes(`Escalation ${code} approved.`));
    await waitForMessage(api, (m) => m.startsWith('[cron: Deploy check] Completed'));
  });

  it('routes a coded approval and a deny #N to the right one of several pending cron escalations', async () => {
    const alpha = job('alpha-job', 'Alpha job');
    const beta = job('beta-job', 'Beta job');
    await saveJobWithPolicy(alpha);
    await saveJobWithPolicy(beta);
    escalations.set(alpha.id, escalation('esc-alpha'));
    escalations.set(beta.id, escalation('esc-beta'));
    const daemon = await startDaemon();

    const alphaRun = daemon.runJobNow(alpha.id);
    const betaRun = daemon.runJobNow(beta.id);
    const alphaBanner = await escalationBanner('Alpha job');
    const betaBanner = await escalationBanner('Beta job');
    expect(alphaBanner.label).not.toBe(betaBanner.label);
    expect(alphaBanner.code).not.toBe(betaBanner.code);

    // Ambiguous or misdirected replies decide nothing. An approval must
    // quote the code: a bare one, or one naming only the session, is refused.
    signalReply('approve');
    signalReply(`approve #${betaBanner.label}`);
    await waitFor(() => api.messageTexts.filter((m) => m.includes("Approvals need the escalation's code")).length >= 2);
    signalReply('deny');
    await waitForMessage(api, (m) => m.includes('Several escalations are pending'));
    signalReply(`approve #${betaBanner.label} ${alphaBanner.code}`);
    await waitForMessage(api, (m) =>
      m.includes(`Escalation ${alphaBanner.code} is not on session #${betaBanner.label}`),
    );
    const unknownLabel = Math.max(alphaBanner.label, betaBanner.label) + 10;
    signalReply(`deny #${unknownLabel}`);
    await waitForMessage(api, (m) => m.includes(`Session #${unknownLabel} has no pending escalation.`));
    expect(cronSession(alpha.id).resolveEscalation).not.toHaveBeenCalled();
    expect(cronSession(beta.id).resolveEscalation).not.toHaveBeenCalled();

    signalReply(`approve ${betaBanner.code}`);
    const betaRecord = await betaRun;
    expect(cronSession(beta.id).resolveEscalation.mock.calls).toEqual([['esc-beta', 'approved', undefined]]);
    expect(cronSession(alpha.id).resolveEscalation).not.toHaveBeenCalled();
    expect(betaRecord).toMatchObject({ escalationsEncountered: 1, escalationsApproved: 1 });

    signalReply(`deny #${alphaBanner.label}`);
    const alphaRecord = await alphaRun;
    expect(cronSession(alpha.id).resolveEscalation.mock.calls).toEqual([['esc-alpha', 'denied', undefined]]);
    expect(alphaRecord).toMatchObject({ escalationsEncountered: 1, escalationsApproved: 0 });
  });

  it('lets the web UI list a pending cron escalation and decide it by id', async () => {
    const definition = job('nightly-report', 'Nightly report');
    await saveJobWithPolicy(definition);
    escalations.set(definition.id, escalation('esc-nightly'));
    const daemon = await startDaemon({ webUi: { port: 0 } });
    const ui = await connectWebUi(readWebUiState());

    const run = daemon.runJobNow(definition.id);
    const { label, code } = await escalationBanner('Nightly report');

    expect(await ui.request('escalations.list')).toEqual([
      expect.objectContaining({
        escalationId: 'esc-nightly',
        sessionLabel: label,
        sessionSource: { kind: 'cron', jobId: 'nightly-report', jobName: 'Nightly report' },
      }),
    ]);
    const sessions = (await ui.request('sessions.list')) as Array<{ label: number; hasPendingEscalation: boolean }>;
    expect(sessions.find((s) => s.label === label)?.hasPendingEscalation).toBe(true);

    await ui.request('escalations.resolve', { escalationId: 'esc-nightly', decision: 'denied' });
    const record = await run;

    expect(cronSession(definition.id).resolveEscalation.mock.calls).toEqual([['esc-nightly', 'denied', undefined]]);
    expect(record).toMatchObject({ outcome: { kind: 'success' }, escalationsEncountered: 1, escalationsApproved: 0 });
    // Decided once: a second answer, in the web UI or over Signal, finds nothing to decide.
    await expect(
      ui.request('escalations.resolve', { escalationId: 'esc-nightly', decision: 'approved' }),
    ).rejects.toMatchObject({ code: 'ESCALATION_NOT_FOUND' });
    signalReply(`approve ${code}`);
    await waitForMessage(api, (m) => m.includes(`No pending escalation has code ${code}`));
    expect(cronSession(definition.id).resolveEscalation).toHaveBeenCalledTimes(1);
    expect(await ui.request('escalations.list')).toEqual([]);
  });

  it('denies a cron escalation at once when Signal is not running', async () => {
    const definition = job('offline-job', 'Offline job');
    await saveJobWithPolicy(definition);
    escalations.set(definition.id, escalation('esc-offline'));
    const daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });

    const record = await daemon.runJobNow(definition.id);

    expect(cronSession(definition.id).resolveEscalation.mock.calls).toEqual([['esc-offline', 'denied', undefined]]);
    expect(record).toMatchObject({ outcome: { kind: 'success' }, escalationsEncountered: 1, escalationsApproved: 0 });
    expect(api.sentMessages).toEqual([]);
  });

  it('denies a cron escalation at once when the job does not ask for escalation messages', async () => {
    const definition = job('quiet-job', 'Quiet job', { notifyOnEscalation: false });
    await saveJobWithPolicy(definition);
    escalations.set(definition.id, escalation('esc-quiet'));
    const daemon = await startDaemon();

    const record = await daemon.runJobNow(definition.id);

    expect(cronSession(definition.id).resolveEscalation.mock.calls).toEqual([['esc-quiet', 'denied', undefined]]);
    expect(record).toMatchObject({ escalationsEncountered: 1, escalationsApproved: 0 });
    expect(surfaced).not.toHaveBeenCalled();
    expect(api.messageTexts.filter((m) => m.includes('ESCALATION ['))).toEqual([]);
  });
});
