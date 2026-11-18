/**
 * A cron job in Docker mode whose agent overspends: the bundle's MITM budget
 * gate refuses its completion after the cap, the session stops the turn, and
 * the daemon records the run as budget_exhausted (WP-42).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { IronCurtainConfig } from '../../src/config/types.js';
import { getJobGeneratedDir } from '../../src/config/paths.js';
import { loadRecentRuns, saveJob } from '../../src/cron/job-store.js';
import { createJobId, type JobDefinition } from '../../src/cron/types.js';
import { IronCurtainDaemon } from '../../src/daemon/ironcurtain-daemon.js';
import { BUDGET_REFUSAL_HEADER } from '../../src/docker/budget-gate.js';
import { DockerAgentSession } from '../../src/docker/docker-agent-session.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';
import * as logger from '../../src/logger.js';
import { createStandaloneSession } from '../../src/session/index.js';
import type { AgentConversationId, SessionId } from '../../src/session/types.js';
import {
  budgetSessionConfig,
  gatedBatchInfra,
  overspendingAgentExec,
  startBudgetHarness,
  type BudgetHarness,
} from '../helpers/budget-gate-harness.js';
import { writeCompiledPolicyFor } from '../fixtures/scoped-policy.js';

vi.mock('../../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
vi.mock('../../src/cron/compile-task-policy.js', () => ({ compileTaskPolicy: vi.fn(async () => {}) }));
vi.mock('../../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/index.js')>()),
  loadConfig: vi.fn(
    () =>
      ({
        protectedPaths: [],
        userConfig: { resourceBudget: {}, memory: { enabled: false, autoSave: false } },
      }) as unknown as IronCurtainConfig,
  ),
}));

const createSession = vi.mocked(createStandaloneSession);

describe('cron runs on a gated Docker bundle', () => {
  let home: string;
  let savedHome: string | undefined;
  let harness: BudgetHarness | undefined;
  let warn: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    savedHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-cron-gate-'));
    process.env.IRONCURTAIN_HOME = home;
    createSession.mockReset();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    warn.mockRestore();
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('records budget_exhausted when the gate refuses the agent a completion after the cap', async () => {
    const gatedHarness = await startBudgetHarness({
      gate: { mode: 'turn', limits: { maxTotalTokens: 200, maxEstimatedCostUsd: null } },
    });
    harness = gatedHarness;
    const agent = overspendingAgentExec(gatedHarness);
    createSession.mockImplementation(async () => {
      const session = new DockerAgentSession({
        config: budgetSessionConfig(),
        sessionId: 'cron-gate-session' as SessionId,
        agentConversationId: 'cron-gate-conversation' as AgentConversationId,
        infra: gatedBatchInfra(join(home, 'bundle'), gatedHarness.gate, agent.exec),
        ownsInfra: false,
      });
      await session.initialize();
      return session;
    });

    const job: JobDefinition = {
      id: createJobId('gated-job'),
      name: 'Gated job',
      schedule: '0 9 * * *',
      taskDescription: 'do things',
      taskConstitution: 'The agent may read the workspace.',
      notifyOnEscalation: false,
      notifyOnCompletion: false,
      enabled: false,
    };
    await saveJob(job);
    // A job without a current compiled policy is refused before its session starts.
    writeCompiledPolicyFor(getJobGeneratedDir(job.id), job.taskConstitution);
    const daemon = new IronCurtainDaemon({ mode: { kind: 'docker', agent: 'claude-code' as AgentId }, noSignal: true });

    const record = await daemon.runJobNow(job.id);

    expect(record.outcome).toEqual({ kind: 'budget_exhausted', dimension: 'tokens' });
    expect(loadRecentRuns(job.id, 1)[0]?.outcome).toEqual({ kind: 'budget_exhausted', dimension: 'tokens' });
    // The agent's first completion was forwarded; the one after the cap got
    // the marker response and never reached the provider.
    expect(agent.responses.map((response) => response.statusCode)).toEqual([200, 400]);
    expect(agent.responses[1]?.headers[BUDGET_REFUSAL_HEADER]).toBe('budget-exhausted');
    expect(gatedHarness.upstreamRequests).toHaveLength(1);
    expect(agent.sweeps).toHaveLength(1);
  });
});
