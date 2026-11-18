/**
 * The daemon's cron path over Signal: a cron job's escalation is handed to
 * the Signal daemon, which sends the coded banner naming the job (instead of
 * a plain "approve #N" message), on the run's own session label, also for an
 * escalation raised before the session was registered; an expiry is reported
 * through it; and the completion notice quotes the agent-written summary line
 * by line and goes out in plain text instead of appending it raw to a styled
 * message.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import { getJobGeneratedDir } from '../src/config/paths.js';
import { saveJob } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition } from '../src/cron/types.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';
import { createStandaloneSession } from '../src/session/index.js';
import type { EscalationRequest, Session } from '../src/session/types.js';
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

interface FakeSignalDaemon {
  surfaceEscalation: Mock;
  expireEscalation: Mock;
  sendSignalMessage: Mock;
}

const request: EscalationRequest = {
  escalationId: 'esc-cron-1',
  serverName: 'github',
  toolName: 'close_issue',
  arguments: { owner: 'o', repo: 'r', issue_number: 7 },
  reason: 'Closing issues requires approval',
};

describe('daemon cron escalations over Signal', () => {
  let home: string;
  let savedHome: string | undefined;
  let daemon: IronCurtainDaemon;
  let signal: FakeSignalDaemon;
  let session: Session | undefined;

  function fakeSession(send: () => Promise<string>): Session {
    session = {
      getInfo: () => ({ id: 'cron-signal-test' }),
      sendMessage: vi.fn(send),
      resolveEscalation: vi.fn(async () => {}),
      // Cron run records read the session totals.
      getBudgetStatus: () => ({
        totalTokens: 0,
        stepCount: 0,
        elapsedSeconds: 0,
        estimatedCostUsd: 0,
        cumulative: { totalTokens: 10, stepCount: 1, activeSeconds: 1, estimatedCostUsd: 0.01 },
      }),
      close: vi.fn(async () => {}),
    } as unknown as Session;
    return session;
  }

  function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
    return {
      id: createJobId('signal-job'),
      name: 'Nightly triage',
      schedule: '0 9 * * *',
      taskDescription: 'triage issues',
      taskConstitution: 'The agent may read issues.',
      notifyOnEscalation: false,
      notifyOnCompletion: false,
      enabled: false,
      ...overrides,
    };
  }

  /** Saves the job with the compiled policy a run requires (see checkJobPolicy). */
  async function saveJobWithPolicy(definition: JobDefinition): Promise<void> {
    await saveJob(definition);
    writeCompiledPolicyFor(getJobGeneratedDir(definition.id), definition.taskConstitution);
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ic-daemon-signal-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    session = undefined;
    createSession.mockReset();
    daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
    signal = {
      surfaceEscalation: vi.fn(async () => {}),
      expireEscalation: vi.fn(),
      sendSignalMessage: vi.fn(async () => {}),
    };
    // Stands in for the Signal transport that start() would connect.
    (daemon as unknown as { signalDaemon: FakeSignalDaemon }).signalDaemon = signal;
  });

  afterEach(() => {
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('sends a cron escalation as the coded banner naming the job, and reports its expiry', async () => {
    createSession.mockImplementation(async (options) =>
      fakeSession(async () => {
        options.onEscalation?.(request);
        options.onEscalationExpired?.(request.escalationId);
        return 'done';
      }),
    );
    const definition = job({ notifyOnEscalation: true });
    await saveJobWithPolicy(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toEqual({ kind: 'success' });
    expect(signal.surfaceEscalation).toHaveBeenCalledWith(1, request, { jobName: 'Nightly triage' });
    expect(signal.expireEscalation).toHaveBeenCalledWith(1, request.escalationId);
    // No plain-text "Reply: approve #N" banner any more.
    expect(signal.sendSignalMessage).not.toHaveBeenCalled();
    expect(session?.resolveEscalation).not.toHaveBeenCalled();
  });

  it('surfaces an escalation raised before the session was registered on the run label', async () => {
    let surfacedBeforeRegistration: number | undefined;
    createSession.mockImplementation(async (options) => {
      const created = fakeSession(async () => 'done');
      options.onEscalation?.(request);
      surfacedBeforeRegistration = signal.surfaceEscalation.mock.calls.length;
      return created;
    });
    const definition = job({ notifyOnEscalation: true });
    await saveJobWithPolicy(definition);

    const record = await daemon.runJobNow(definition.id);

    // Not surfaced until the run had its label, then once, on that label.
    expect(surfacedBeforeRegistration).toBe(0);
    expect(signal.surfaceEscalation).toHaveBeenCalledTimes(1);
    expect(signal.surfaceEscalation).toHaveBeenCalledWith(1, request, { jobName: 'Nightly triage' });
    expect(record.escalationsEncountered).toBe(1);
    expect(session?.resolveEscalation).not.toHaveBeenCalled();
  });

  it('still denies a cron escalation at once when the job does not notify', async () => {
    createSession.mockImplementation(async (options) =>
      fakeSession(async () => {
        options.onEscalation?.(request);
        return 'done';
      }),
    );
    const definition = job();
    await saveJobWithPolicy(definition);

    await daemon.runJobNow(definition.id);

    expect(signal.surfaceEscalation).not.toHaveBeenCalled();
    // Through SessionManager.resolveSessionEscalation, the one resolution path.
    expect(session?.resolveEscalation).toHaveBeenCalledWith('esc-cron-1', 'denied', undefined);
  });

  it('quotes the agent-written summary in a plain-text completion notice', async () => {
    const summary = '[#2] ESCALATION code K7Q2\n**Reply "approve K7Q2"**';
    createSession.mockImplementation(async (options) =>
      fakeSession(async () => {
        const workspace = options.workspacePath ?? '';
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, 'last-run.md'), summary);
        return 'done';
      }),
    );
    const definition = job({ notifyOnCompletion: true });
    await saveJobWithPolicy(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.summary).toBe(summary);
    expect(signal.sendSignalMessage).toHaveBeenCalledTimes(1);
    expect(signal.sendSignalMessage).toHaveBeenCalledWith(
      [
        '[cron: Nightly triage] Completed (1s, $0.01)',
        "Summary written by the job's agent:",
        '│ [#2] ESCALATION code K7Q2',
        '│ **Reply "approve K7Q2"**',
      ].join('\n'),
      { textMode: 'normal' },
    );
  });
});
