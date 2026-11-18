/**
 * Cron auto-save follows the session's memory gate: a job that runs as a persona
 * is asked to save its session summary only when that persona (and the job) keep
 * memory on. A persona that opted out runs with no memory server, so the
 * auto-save prompt would cost a turn and ask for a tool that does not exist (the
 * agent might improvise, e.g. a MEMORY.md in the workspace).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import { saveJob } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition } from '../src/cron/types.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import { getPersonaDir } from '../src/persona/resolve.js';
import { createPersonaName } from '../src/persona/types.js';
import { createStandaloneSession } from '../src/session/index.js';
import type { Session } from '../src/session/types.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';

vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
vi.mock('../src/cron/compile-task-policy.js', () => ({ compileTaskPolicy: vi.fn(async () => {}) }));
vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: vi.fn(
    () =>
      ({
        protectedPaths: [],
        // Memory and auto-save are on globally: only the persona opts out.
        userConfig: { resourceBudget: {}, memory: { enabled: true, autoSave: true } },
      }) as unknown as IronCurtainConfig,
  ),
}));

const createSession = vi.mocked(createStandaloneSession);

describe('cron auto-save and the persona memory opt-out', () => {
  let root: string;
  let savedEnv: { home: string | undefined; ironcurtainHome: string | undefined };
  let daemon: IronCurtainDaemon;
  let sent: string[];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-cron-autosave-')));
    savedEnv = { home: process.env.HOME, ironcurtainHome: process.env.IRONCURTAIN_HOME };
    process.env.HOME = join(root, 'home');
    mkdirSync(process.env.HOME, { recursive: true });
    process.env.IRONCURTAIN_HOME = join(root, 'ironcurtain-home');

    sent = [];
    createSession.mockReset();
    createSession.mockImplementation(
      async () =>
        ({
          getInfo: () => ({ id: `cron-autosave-${sent.length}` }),
          getHistory: () => [
            {
              turnNumber: 1,
              userMessage: 'Triage the issues',
              assistantResponse: 'Labeled 3 issues',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
              timestamp: new Date().toISOString(),
            },
          ],
          sendMessage: vi.fn(async (message: string) => {
            sent.push(message);
            return 'done';
          }),
          getBudgetStatus: () => ({
            totalTokens: 0,
            stepCount: 0,
            elapsedSeconds: 0,
            estimatedCostUsd: 0,
            cumulative: { totalTokens: 0, stepCount: 0, activeSeconds: 0, estimatedCostUsd: 0 },
          }),
          close: vi.fn(async () => {}),
          resolveEscalation: vi.fn(async () => {}),
        }) as unknown as Session,
    );
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

  function createPersona(name: string, memoryEnabled: boolean): void {
    const dir = getPersonaDir(createPersonaName(name));
    mkdirSync(resolve(dir, 'workspace'), { recursive: true });
    writeFileSync(
      resolve(dir, 'persona.json'),
      JSON.stringify({
        name,
        description: `Persona ${name}`,
        createdAt: '2026-11-01T00:00:00.000Z',
        ...(memoryEnabled ? {} : { memory: { enabled: false } }),
      }),
    );
    writePersonaPolicy(dir);
  }

  async function runJobAs(persona: string): Promise<void> {
    const job: JobDefinition = {
      id: createJobId(`job-as-${persona}`),
      name: 'Triage',
      schedule: '0 9 * * *',
      taskDescription: 'Triage the issues',
      taskConstitution: 'The agent may read the workspace.',
      persona,
      notifyOnEscalation: false,
      notifyOnCompletion: false,
      enabled: false,
    };
    await saveJob(job);
    const record = await daemon.runJobNow(job.id);
    expect(record.outcome).toEqual({ kind: 'success' });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ persona, jobId: job.id }));
  }

  it('does not ask a job to save memory when its persona opted out of memory', async () => {
    createPersona('no-memory', false);

    await runJobAs('no-memory');

    expect(sent).toEqual(['Triage the issues']);
  });

  it('asks a job whose persona keeps memory to save its summary with memory.ingest', async () => {
    createPersona('with-memory', true);

    await runJobAs('with-memory');

    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('memory.ingest');
  });
});
