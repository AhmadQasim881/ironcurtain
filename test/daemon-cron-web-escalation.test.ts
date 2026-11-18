/**
 * Cron escalations in the web UI, end to end: a real WebUiServer shares the
 * daemon's SessionManager and a WebSocket client stands in for the browser.
 *
 * - Without Signal, a cron escalation waits for a decision while a browser
 *   is connected: it is pushed live (`escalation.created`) with its full
 *   request, listed by `escalations.list`, and approving it there lets the
 *   job's tool call through (`escalation.resolved` follows).
 * - Its expiry is pushed too (`escalation.expired`), once, also when an
 *   approval from the browser arrives after the proxy timed it out.
 * - With no browser connected (only a CLI client, which sends no Origin) it
 *   is denied at once, as before, and never shown.
 * - With Signal configured, a job that notifies gets its Signal banner and
 *   the escalation can be decided in the web UI as well; one that does not
 *   notify is denied at once even while a browser is connected.
 * - It shows the reviewer context the session attached (the task, the
 *   agent's untrusted justification), but carries no group key: it is never
 *   approved as part of a web UI group approval.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import type { IronCurtainConfig } from '../src/config/types.js';
import { getJobGeneratedDir } from '../src/config/paths.js';
import { saveJob } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition, type RunRecord } from '../src/cron/types.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';
import { createStandaloneSession } from '../src/session/index.js';
import type { SessionManager } from '../src/session/session-manager.js';
import type { EscalationRequest, Session, SessionOptions } from '../src/session/types.js';
import { EscalationExpiredError } from '../src/types/errors.js';
import { WebUiServer } from '../src/web-ui/web-ui-server.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';

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

const createSession = vi.mocked(createStandaloneSession);

const REQUEST: EscalationRequest = {
  escalationId: 'esc-cron-web-1',
  serverName: 'github',
  toolName: 'close_issue',
  arguments: { owner: 'acme', repo: 'widgets', issue_number: 47, comment: 'Closing as fixed in #48' },
  reason: 'Closing issues requires approval',
  context: { repository: 'acme/widgets' },
  whitelistCandidates: [{ description: 'Allow close_issue on acme/widgets' }],
};

interface Frame {
  readonly id?: string;
  readonly ok?: boolean;
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly event?: string;
}

/** A connected WebSocket client that records every frame it receives. */
interface Client {
  readonly frames: Frame[];
  request(method: string, params?: Record<string, unknown>): Promise<Frame>;
  nextEvent(event: string, timeoutMs?: number): Promise<Frame>;
  close(): Promise<void>;
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const ws = new WebSocket(url, { headers });
  const frames: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  ws.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Frame;
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.match(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const waitFor = (match: (frame: Frame) => boolean, timeoutMs: number, what: string): Promise<Frame> => {
    const seen = frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
      waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  };
  let nextId = 0;
  return {
    frames,
    request(method, params) {
      const id = `req-${++nextId}`;
      ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
      return waitFor((frame) => frame.id === id, 5_000, `the reply to ${method}`);
    },
    nextEvent(event, timeoutMs = 5_000) {
      return waitFor((frame) => frame.event === event, timeoutMs, `event ${event}`);
    },
    close() {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        ws.on('close', () => resolve());
        ws.close();
      });
    },
  };
}

function mockHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn(() => ({
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0, failing: 0 },
      failingJobs: [],
      signalConnected: false,
      nextFireTime: null,
    })),
    removeJob: vi.fn(async () => {}),
    enableJob: vi.fn(async () => {}),
    disableJob: vi.fn(async () => {}),
    recompileJob: vi.fn(async () => ({ failedServers: [] })),
    reloadJob: vi.fn(async () => {}),
    refreshLists: vi.fn(),
    startJobRun: vi.fn(),
    runJobNow: vi.fn(),
    listJobs: vi.fn(() => []),
  };
}

describe('cron escalations in the web UI', () => {
  let home: string;
  let savedHome: string | undefined;
  let daemon: IronCurtainDaemon;
  let server: WebUiServer;
  let baseUrl: string;
  const clients: Client[] = [];
  let session: (Session & { resolveEscalation: ReturnType<typeof vi.fn> }) | undefined;
  let sessionOptions: SessionOptions | undefined;

  function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
    return {
      id: createJobId('web-approval-job'),
      name: 'Nightly triage',
      schedule: '0 9 * * *',
      taskDescription: 'triage issues',
      taskConstitution: 'The agent may read issues.',
      notifyOnEscalation: true,
      notifyOnCompletion: false,
      enabled: false,
      ...overrides,
    };
  }

  async function saveJobWithPolicy(definition: JobDefinition): Promise<void> {
    await saveJob(definition);
    writeCompiledPolicyFor(getJobGeneratedDir(definition.id), definition.taskConstitution);
  }

  /**
   * The agent's session: its task makes one tool call that escalates
   * (`request`) and waits for the decision (the proxy's wait); `expire` makes
   * the proxy time it out instead.
   */
  function agentThatEscalates(request: EscalationRequest = REQUEST): { expire(): void } {
    const decided = deferred<string>();
    createSession.mockImplementation(async (options) => {
      sessionOptions = options;
      session = {
        getInfo: () => ({ id: 'cron-web-session' }),
        sendMessage: vi.fn(async () => {
          options.onEscalation?.(request);
          return `tool call ${await decided.promise}`;
        }),
        // As the escalation watcher does for a response the proxy accepted.
        resolveEscalation: vi.fn(async (id: string, decision: 'approved' | 'denied') => {
          options.onEscalationResolved?.(id, decision);
          decided.resolve(decision);
        }),
        getBudgetStatus: () => ({
          cumulative: { totalTokens: 10, stepCount: 1, activeSeconds: 1, estimatedCostUsd: 0.01 },
        }),
        close: vi.fn(async () => {}),
      } as unknown as Session & { resolveEscalation: ReturnType<typeof vi.fn> };
      return session;
    });
    return {
      expire() {
        sessionOptions?.onEscalationExpired?.(request.escalationId);
        decided.resolve('expired');
      },
    };
  }

  async function browser(): Promise<Client> {
    const port = new URL(baseUrl).port;
    const client = await connect(`ws://127.0.0.1:${port}/ws?token=${new URL(baseUrl).searchParams.get('token')}`, {
      Origin: `http://127.0.0.1:${port}`,
    });
    clients.push(client);
    return client;
  }

  async function cliClient(): Promise<Client> {
    const port = new URL(baseUrl).port;
    const client = await connect(`ws://127.0.0.1:${port}/ws?token=${new URL(baseUrl).searchParams.get('token')}`, {});
    clients.push(client);
    return client;
  }

  function attachSignal(): { surfaceEscalation: ReturnType<typeof vi.fn> } {
    const sessionManager = (daemon as unknown as { sessionManager: SessionManager }).sessionManager;
    const signal = {
      // As SignalBotDaemon does before it sends the coded banner.
      surfaceEscalation: vi.fn(async (label: number, request: EscalationRequest) => {
        sessionManager.recordEscalation(label, request);
      }),
      expireEscalation: vi.fn((label: number, escalationId: string) =>
        sessionManager.expireEscalation(label, escalationId),
      ),
      sendSignalMessage: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    (daemon as unknown as { signalDaemon: unknown }).signalDaemon = signal;
    return signal;
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ic-cron-web-escalation-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    createSession.mockReset();
    session = undefined;
    sessionOptions = undefined;
    daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
    server = new WebUiServer({
      port: 0,
      host: '127.0.0.1',
      handler: mockHandler(),
      sessionManager: (daemon as unknown as { sessionManager: SessionManager }).sessionManager,
      mode: { kind: 'builtin' },
      maxConcurrentWebSessions: 1,
    });
    baseUrl = await server.start();
    // As startWebUiServer() wires it.
    (daemon as unknown as { webUiServer: WebUiServer }).webUiServer = server;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    await server.stop();
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('shows a cron escalation with its full arguments and lets the browser approve it', async () => {
    const client = await browser();
    agentThatEscalates();
    const definition = job();
    await saveJobWithPolicy(definition);

    const run = daemon.runJobNow(definition.id);
    const created = await client.nextEvent('escalation.created');
    expect(created.payload).toMatchObject({
      escalationId: REQUEST.escalationId,
      sessionLabel: 1,
      sessionSource: { kind: 'cron', jobId: 'web-approval-job', jobName: 'Nightly triage' },
      serverName: 'github',
      toolName: 'close_issue',
      arguments: REQUEST.arguments,
      reason: REQUEST.reason,
      context: REQUEST.context,
      whitelistCandidates: REQUEST.whitelistCandidates,
    });

    // A browser that connects later (or reloads) lists it, in full, too.
    const listed = await (await browser()).request('escalations.list');
    expect(listed.payload).toEqual([
      expect.objectContaining({ escalationId: REQUEST.escalationId, arguments: REQUEST.arguments }),
    ]);

    const reply = await client.request('escalations.resolve', {
      escalationId: REQUEST.escalationId,
      decision: 'approved',
    });
    expect(reply).toMatchObject({ ok: true });
    expect(await client.nextEvent('escalation.resolved')).toMatchObject({
      payload: { escalationId: REQUEST.escalationId, decision: 'approved' },
    });

    const record: RunRecord = await run;
    expect(record.outcome).toEqual({ kind: 'success' });
    expect(record.escalationsEncountered).toBe(1);
    expect(record.escalationsApproved).toBe(1);
    expect(session?.resolveEscalation).toHaveBeenCalledWith(REQUEST.escalationId, 'approved', undefined);
    expect((await client.request('escalations.list')).payload).toEqual([]);
  });

  it('shows the reviewer context of a cron escalation but never groups it', async () => {
    const client = await browser();
    // The proxy's exact candidate carries the key a web session's escalation would be grouped by.
    const patternKey = '["github","close_issue",[["github-repo","acme/widgets"]]]';
    const request: EscalationRequest = {
      ...REQUEST,
      whitelistCandidates: [{ description: 'Allow close_issue on acme/widgets', scope: 'exact', patternKey }],
      taskSummary: 'triage issues',
      agentJustification: 'Issue 47 was fixed by #48.',
    };
    agentThatEscalates(request);
    const definition = job();
    await saveJobWithPolicy(definition);

    const run = daemon.runJobNow(definition.id);
    const created = await client.nextEvent('escalation.created');
    expect(created.payload).toMatchObject({
      escalationId: REQUEST.escalationId,
      whitelistCandidates: request.whitelistCandidates,
      taskSummary: 'triage issues',
      agentJustification: 'Issue 47 was fixed by #48.',
    });
    expect(created.payload).not.toHaveProperty('groupKey');
    const listed = await client.request('escalations.list');
    expect(listed.payload).toEqual([expect.objectContaining({ taskSummary: 'triage issues' })]);
    expect((listed.payload as Array<Record<string, unknown>>)[0]).not.toHaveProperty('groupKey');

    // Not a member of any group: a group approval naming it is refused and decides nothing.
    const group = await client.request('escalations.approveGroup', {
      groupKey: patternKey,
      escalationIds: [REQUEST.escalationId],
    });
    expect(group).toMatchObject({ ok: false, error: { code: 'ESCALATION_GROUP_CHANGED' } });
    expect(session?.resolveEscalation).not.toHaveBeenCalled();

    await client.request('escalations.resolve', { escalationId: REQUEST.escalationId, decision: 'denied' });
    expect((await run).escalationsApproved).toBe(0);
  });

  it('pushes the expiry of a cron escalation nobody decided', async () => {
    const client = await browser();
    const agent = agentThatEscalates();
    const definition = job();
    await saveJobWithPolicy(definition);

    const run = daemon.runJobNow(definition.id);
    await client.nextEvent('escalation.created');
    agent.expire();

    expect(await client.nextEvent('escalation.expired')).toMatchObject({
      payload: { escalationId: REQUEST.escalationId, sessionLabel: 1 },
    });
    await run;
    expect(session?.resolveEscalation).not.toHaveBeenCalled();
    expect((await client.request('escalations.list')).payload).toEqual([]);
  });

  it('reports a late approval as ESCALATION_EXPIRED and pushes the expiry once', async () => {
    const client = await browser();
    const agent = agentThatEscalates();
    const definition = job();
    await saveJobWithPolicy(definition);

    const run = daemon.runJobNow(definition.id);
    await client.nextEvent('escalation.created');
    // The proxy timed the request out just before the response was written.
    session?.resolveEscalation.mockRejectedValueOnce(new EscalationExpiredError(REQUEST.escalationId));

    const reply = await client.request('escalations.resolve', {
      escalationId: REQUEST.escalationId,
      decision: 'approved',
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'ESCALATION_EXPIRED' } });
    agent.expire();
    const record = await run;
    expect(record.escalationsApproved).toBe(0);

    // A round trip after the run settled: every event about the escalation has arrived.
    expect((await client.request('escalations.list')).payload).toEqual([]);
    const expired = client.frames.filter((frame) => frame.event === 'escalation.expired');
    expect(expired).toEqual([
      expect.objectContaining({ payload: { escalationId: REQUEST.escalationId, sessionLabel: 1 } }),
    ]);
  });

  it('denies at once, unannounced, when no browser is connected (a CLI client is not one)', async () => {
    const client = await cliClient();
    agentThatEscalates();
    const definition = job();
    await saveJobWithPolicy(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(session?.resolveEscalation).toHaveBeenCalledWith(REQUEST.escalationId, 'denied', undefined);
    expect(record.escalationsApproved).toBe(0);
    expect(client.frames.some((frame) => frame.event === 'escalation.created')).toBe(false);
  });

  it('with Signal, sends the banner and still lets the browser decide a job that notifies', async () => {
    const signal = attachSignal();
    const client = await browser();
    agentThatEscalates();
    const definition = job();
    await saveJobWithPolicy(definition);

    const run = daemon.runJobNow(definition.id);
    await client.nextEvent('escalation.created');
    expect(signal.surfaceEscalation).toHaveBeenCalledWith(1, REQUEST, { jobName: 'Nightly triage' });

    await client.request('escalations.resolve', { escalationId: REQUEST.escalationId, decision: 'denied' });
    await client.nextEvent('escalation.resolved');
    const record = await run;
    expect(session?.resolveEscalation).toHaveBeenCalledWith(REQUEST.escalationId, 'denied', undefined);
    expect(record.escalationsApproved).toBe(0);
  });

  it('with Signal, denies the escalation of a job that does not notify even while a browser is connected', async () => {
    const signal = attachSignal();
    const client = await browser();
    agentThatEscalates();
    const definition = job({ notifyOnEscalation: false });
    await saveJobWithPolicy(definition);

    await daemon.runJobNow(definition.id);

    expect(signal.surfaceEscalation).not.toHaveBeenCalled();
    expect(session?.resolveEscalation).toHaveBeenCalledWith(REQUEST.escalationId, 'denied', undefined);
    expect(client.frames.some((frame) => frame.event === 'escalation.created')).toBe(false);
  });

  it('refuses to approve an escalation that does not name its tool or arguments', async () => {
    const client = await browser();
    const sessionManager = (daemon as unknown as { sessionManager: SessionManager }).sessionManager;
    const blank = {
      getInfo: () => ({ id: 'blank' }),
      resolveEscalation: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as Session;
    const label = sessionManager.register(blank, { run: vi.fn(async () => {}), close: vi.fn() }, { kind: 'signal' });
    sessionManager.setPendingEscalation(label, {
      escalationId: 'esc-blank',
      sessionLabel: label,
      serverName: '',
      toolName: '',
      arguments: {},
      reason: '',
      receivedAt: new Date().toISOString(),
    });

    const approve = await client.request('escalations.resolve', { escalationId: 'esc-blank', decision: 'approved' });
    expect(approve).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(blank.resolveEscalation).not.toHaveBeenCalled();

    const deny = await client.request('escalations.resolve', { escalationId: 'esc-blank', decision: 'denied' });
    expect(deny).toMatchObject({ ok: true });
    expect(blank.resolveEscalation).toHaveBeenCalledWith('esc-blank', 'denied', undefined);
  });
});
