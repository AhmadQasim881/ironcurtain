/**
 * FU-10: the notices of a cron run's session are kept in its run record.
 * Nobody watches an unattended run, so a stale compiled policy, an MCP
 * server that did not start, and setuid/setgid or root-owned files the agent
 * left in its host mounts (after a turn, or what its teardown found left
 * behind) would otherwise reach only the session log.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import { runJobCommand } from '../src/cron/job-commands.js';
import { loadLatestRun, saveJob } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition, type JobId } from '../src/cron/types.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import { getPersonaDir } from '../src/persona/resolve.js';
import { createPersonaName } from '../src/persona/types.js';
import { createStandaloneSession } from '../src/session/index.js';
import type { HostPrivilegedFilesDiagnostic } from '../src/session/startup-notices.js';
import type { DiagnosticEvent, Session, SessionOptions } from '../src/session/types.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';

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

const ESC = String.fromCharCode(0x1b);

const HOST_FILES: HostPrivilegedFilesDiagnostic = {
  kind: 'host_privileged_files',
  when: 'after agent turn',
  stripped: 0,
  unstripped: 1,
  rootOwned: 0,
  unlisted: 0,
  paths: ['/home/user/jobs/triage/bin/shell'],
  incomplete: false,
  hint: 'Inspect the files IronCurtain could not neutralize and remove them as root (for example with sudo rm).',
};

describe('cron run notices', () => {
  let root: string;
  let savedEnv: { home: string | undefined; ironcurtainHome: string | undefined };
  let daemon: IronCurtainDaemon;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-cron-notices-')));
    savedEnv = { home: process.env.HOME, ironcurtainHome: process.env.IRONCURTAIN_HOME };
    process.env.HOME = join(root, 'home');
    mkdirSync(process.env.HOME, { recursive: true });
    process.env.IRONCURTAIN_HOME = join(root, 'ironcurtain-home');
    createSession.mockReset();
    daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
  });

  afterEach(async () => {
    await daemon.shutdown();
    if (savedEnv.home === undefined) delete process.env.HOME;
    else process.env.HOME = savedEnv.home;
    if (savedEnv.ironcurtainHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedEnv.ironcurtainHome;
    rmSync(root, { recursive: true, force: true });
  });

  /** A session that reports `atStart` while it is created, `afterTurn` after its turn and `atClose` when it closes. */
  function sessionReporting(events: {
    atStart?: DiagnosticEvent[];
    afterTurn?: DiagnosticEvent[];
    atClose?: DiagnosticEvent[];
  }): void {
    createSession.mockImplementation(async (options: Omit<SessionOptions, 'agentConversationId'>) => {
      const report = (list: DiagnosticEvent[] | undefined): void => {
        for (const event of list ?? []) options.onDiagnostic?.(event);
      };
      report(events.atStart);
      return {
        getInfo: () => ({ id: 'cron-notices-session' }),
        getHistory: () => [],
        sendMessage: vi.fn(async () => {
          report(events.afterTurn);
          return 'done';
        }),
        getBudgetStatus: () => ({
          totalTokens: 0,
          stepCount: 0,
          elapsedSeconds: 0,
          estimatedCostUsd: 0,
          cumulative: { totalTokens: 0, stepCount: 0, activeSeconds: 0, estimatedCostUsd: 0 },
        }),
        close: vi.fn(async () => {
          report(events.atClose);
        }),
        resolveEscalation: vi.fn(async () => {}),
      } as unknown as Session;
    });
  }

  async function runJob(): Promise<Awaited<ReturnType<IronCurtainDaemon['runJobNow']>>> {
    return daemon.runJobNow(await saveTriageJob());
  }

  async function saveTriageJob(): Promise<JobId> {
    const dir = getPersonaDir(createPersonaName('triager'));
    mkdirSync(resolve(dir, 'workspace'), { recursive: true });
    writeFileSync(
      resolve(dir, 'persona.json'),
      JSON.stringify({ name: 'triager', description: 'Triages', createdAt: '2026-11-01T00:00:00.000Z' }),
    );
    writePersonaPolicy(dir);
    const job: JobDefinition = {
      id: createJobId('triage-notices'),
      name: 'Triage',
      schedule: '0 9 * * *',
      taskDescription: 'Triage the issues',
      taskConstitution: 'The agent may read the workspace.',
      persona: 'triager',
      notifyOnEscalation: false,
      notifyOnCompletion: false,
      enabled: false,
    };
    await saveJob(job);
    return job.id;
  }

  it('records a stale-policy notice and the host-mount findings of the turn and the teardown', async () => {
    sessionReporting({
      atStart: [{ kind: 'policy_stale', message: 'Warning: the compiled policy at /p may be stale:\n  - reason' }],
      afterTurn: [{ kind: 'tool_call', toolName: 'filesystem.read_file', preview: 'allowed' }, HOST_FILES],
      atClose: [{ ...HOST_FILES, when: 'session end' }],
    });

    const record = await runJob();

    expect(record.outcome).toEqual({ kind: 'success' });
    expect(record.notices).toEqual([
      '[policy] Warning: the compiled policy at /p may be stale:\n  - reason',
      expect.stringMatching(/^\[host-files\] Warning \(after agent turn\): IronCurtain found setuid/u),
      expect.stringMatching(/^\[host-files\] Warning \(session end\)/u),
    ]);
    expect(record.notices?.[1]).toContain('\n  /home/user/jobs/triage/bin/shell\n');
    // The saved run record keeps them.
    expect(loadLatestRun(createJobId('triage-notices'))?.notices).toEqual(record.notices);
  });

  it('keeps no notices field for a run whose session reported none', async () => {
    sessionReporting({ afterTurn: [{ kind: 'step_finish', stepIndex: 1 }] });

    const record = await runJob();

    expect(record.outcome).toEqual({ kind: 'success' });
    expect(record).not.toHaveProperty('notices');
  });

  it('prints the notices of a job run in the foreground (run-job), where they used to reach stderr', async () => {
    // Before FU-10, buildSessionConfig wrote a stale-policy warning to stderr
    // for every cron session. The run's collector now takes it, and without
    // a daemon log (no daemon is running) run-job is where the user sees it.
    sessionReporting({
      atStart: [{ kind: 'policy_stale', message: 'Warning: the compiled policy at /p may be stale:\n  - reason' }],
      atClose: [{ ...HOST_FILES, when: 'session end', paths: [`/home/user/jobs/triage/bin/sh${ESC}[2J`] }],
    });
    const jobId = await saveTriageJob();
    const lines: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const exitCodes: unknown[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code);
    }) as unknown as typeof process.exit);
    try {
      await runJobCommand(jobId, { kind: 'builtin' });
    } finally {
      consoleError.mockRestore();
      exit.mockRestore();
    }

    expect(exitCodes).toEqual([0]);
    const output = lines.join('\n');
    expect(output).toContain(
      '  Notices:\n    [policy] Warning: the compiled policy at /p may be stale:\n      - reason\n    [host-files] Warning (session end)',
    );
    expect(output).toContain('      /home/user/jobs/triage/bin/sh\\u001b[2J');
    expect(output).not.toContain(ESC);
  });
});
