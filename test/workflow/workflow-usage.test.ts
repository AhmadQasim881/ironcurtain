import { describe, expect, it } from 'vitest';
import { createBudgetGate } from '../../src/docker/budget-gate.js';
import {
  WorkflowUsageMeter,
  emptyWorkflowUsage,
  findWorkflowBudgetBreach,
  parseWorkflowUsage,
  workflowUsageFromCheckpoint,
  type WorkflowUsage,
} from '../../src/workflow/workflow-usage.js';
import { MockSession, makeLlmExchange, mockBudgetStatus } from './test-helpers.js';
import type { ConversationTurn } from '../../src/session/types.js';
import type { WorkflowContext } from '../../src/workflow/types.js';

const RUN = 'run-under-test';

/** A usage record with the given counters and the status they imply. */
function usage(overrides: Partial<WorkflowUsage>): WorkflowUsage {
  const parsed = parseWorkflowUsage({ ...emptyWorkflowUsage(), ...overrides });
  if (!parsed) throw new Error('fixture did not parse');
  return parsed;
}

describe('WorkflowUsageMeter: metrics-bus exchanges', () => {
  it('counts exchanges attributed to the run or to one of its bundles, and nothing else', () => {
    const meter = new WorkflowUsageMeter(RUN);
    meter.addBundle('bundle-a');

    meter.observeExchange(makeLlmExchange({ workflowRunId: RUN }));
    meter.observeExchange(makeLlmExchange({ bundleId: 'bundle-a', quality: 'bundle_only' }));
    meter.observeExchange(makeLlmExchange({ workflowRunId: 'other-run' }));
    meter.observeExchange(makeLlmExchange({ bundleId: 'bundle-b', quality: 'bundle_only' }));
    meter.observeExchange(makeLlmExchange({ quality: 'unattributed' }));

    expect(meter.snapshot()).toMatchObject({
      observedExchanges: 2,
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
    });
  });

  it('treats a Docker session id as its own bundle id (a session that owns its bundle)', () => {
    const meter = new WorkflowUsageMeter(RUN);
    const session = new MockSession({
      sessionId: 'per-state-session',
      responses: [],
      budgetStatus: () => mockBudgetStatus({ tokenTrackingAvailable: true }),
    });
    meter.sessionStarted(session, 'docker');
    meter.observeExchange(makeLlmExchange({ bundleId: 'per-state-session', quality: 'bundle_only' }));
    expect(meter.snapshot()).toMatchObject({ observedExchanges: 1, totalTokens: 110, meteredSessions: 1 });

    // A builtin session never has a MITM bundle, so its id is not registered.
    const builtin = new WorkflowUsageMeter(RUN);
    builtin.sessionStarted(new MockSession({ sessionId: 'builtin-session', responses: [] }), 'builtin');
    builtin.observeExchange(makeLlmExchange({ bundleId: 'builtin-session', quality: 'bundle_only' }));
    expect(builtin.snapshot().observedExchanges).toBe(0);
  });

  it('counts an exchange once even if it is published twice', () => {
    const meter = new WorkflowUsageMeter(RUN);
    const exchange = makeLlmExchange({ workflowRunId: RUN, exchangeId: 'same-id' });
    meter.observeExchange(exchange);
    meter.observeExchange(exchange);
    expect(meter.snapshot().observedExchanges).toBe(1);
  });

  it('keeps input, cache and output separately and marks partly measured exchanges as lower bounds', () => {
    const meter = new WorkflowUsageMeter(RUN);
    meter.sessionStarted(
      new MockSession({ responses: [], budgetStatus: () => mockBudgetStatus({ tokenTrackingAvailable: true }) }),
      'docker',
    );
    meter.observeExchange(
      makeLlmExchange({
        workflowRunId: RUN,
        usage: {
          inputTokensReported: 50,
          inputTokensTotal: 1050,
          inputTokensUncached: 50,
          cacheReadInputTokens: 900,
          cacheWriteInputTokens: 100,
          outputTokensTotal: 40,
          canonicalTotalTokens: 1090,
        },
      }),
    );
    expect(meter.snapshot()).toMatchObject({
      inputTokens: 1050,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
      outputTokens: 40,
      totalTokens: 1090,
      lowerBound: false,
      tokenTrackingStatus: 'complete',
    });

    // A stream cut before the final usage report: output never arrived.
    meter.observeExchange(
      makeLlmExchange({
        workflowRunId: RUN,
        usage: {
          inputTokensTotal: 300,
          outputTokensReported: null,
          outputTokensTotal: null,
          providerTotalTokens: null,
          canonicalTotalTokens: null,
          usageCompleteness: 'partial',
        },
      }),
    );
    const partial = meter.snapshot();
    expect(partial).toMatchObject({
      inputTokens: 1350,
      totalTokens: 1390,
      observedExchanges: 2,
      incompleteExchanges: 1,
      lowerBound: true,
      tokenTrackingStatus: 'partial',
    });
  });
});

describe('WorkflowUsageMeter: sessions, cost and status', () => {
  it('aggregates builtin sessions from their AI SDK usage, live and once settled', () => {
    const meter = new WorkflowUsageMeter(RUN);
    let status = mockBudgetStatus({ inputTokens: 1000, outputTokens: 200, estimatedCostUsd: 0.5 });
    const history: ConversationTurn[] = [
      {
        turnNumber: 1,
        userMessage: 'go',
        assistantResponse: 'ok',
        timestamp: new Date().toISOString(),
        usage: {
          promptTokens: 1000,
          completionTokens: 200,
          totalTokens: 1200,
          cacheReadTokens: 600,
          cacheWriteTokens: 50,
        },
      },
    ];
    const session = new MockSession({ responses: [], budgetStatus: () => status });
    session.getHistory = () => history;

    meter.sessionStarted(session, 'builtin');
    expect(meter.snapshot()).toMatchObject({
      inputTokens: 1000,
      cacheReadTokens: 600,
      cacheWriteTokens: 50,
      outputTokens: 200,
      totalTokens: 1200,
      estimatedCostUsd: 0.5,
      reportedSessions: 1,
      tokenTrackingStatus: 'complete',
    });

    status = mockBudgetStatus({ inputTokens: 1500, outputTokens: 300, estimatedCostUsd: 0.75 });
    meter.sessionEnded(session);
    // Settled values do not change once the session has ended.
    status = mockBudgetStatus({ inputTokens: 99_999, outputTokens: 99_999, estimatedCostUsd: 99 });
    expect(meter.snapshot()).toMatchObject({ totalTokens: 1800, estimatedCostUsd: 0.75 });
  });

  it('takes Docker sessions’ cost from the session but their tokens only from the bus', () => {
    const meter = new WorkflowUsageMeter(RUN);
    const session = new MockSession({
      responses: [],
      budgetStatus: () =>
        mockBudgetStatus({
          tokenTrackingAvailable: true,
          inputTokens: 5000,
          outputTokens: 500,
          estimatedCostUsd: 1.25,
        }),
    });
    meter.sessionStarted(session, 'docker');
    meter.observeExchange(makeLlmExchange({ workflowRunId: RUN }));
    meter.sessionEnded(session);
    // The session's own token totals are the same exchanges seen on the bus;
    // adding them too would count them twice.
    expect(meter.snapshot()).toMatchObject({ totalTokens: 110, estimatedCostUsd: 1.25, meteredSessions: 1 });
  });

  // MET-1 / WP-41: a container session's `estimatedCostUsd` may be its agent
  // CLI's own total_cost_usd, which the agent controls. The run-wide total is
  // what the workflow ceiling decides on, so it counts host-observed cost only.
  it.each([-1, 0, 1e9, Number.POSITIVE_INFINITY])(
    'counts a Docker session’s host-observed cost, never an agent-reported cost of %s',
    (agentReported) => {
      const meter = new WorkflowUsageMeter(RUN);
      const live = new MockSession({
        responses: [],
        budgetStatus: () =>
          mockBudgetStatus({ tokenTrackingAvailable: true, estimatedCostUsd: agentReported, hostObservedCostUsd: 0.4 }),
      });
      const settled = new MockSession({
        responses: [],
        budgetStatus: () =>
          mockBudgetStatus({
            tokenTrackingAvailable: true,
            estimatedCostUsd: agentReported,
            hostObservedCostUsd: 5.25,
          }),
      });
      meter.sessionStarted(settled, 'docker');
      meter.sessionEnded(settled);
      meter.sessionStarted(live, 'docker');

      const snapshot = meter.snapshot();
      expect(snapshot.estimatedCostUsd).toBeCloseTo(5.65, 10);
      // The ceiling trips on the host-observed figure, whatever the agents report.
      expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 5 }, snapshot)).toMatchObject({
        dimension: 'cost',
        message: 'estimated cost $5.65 of $5.00',
      });
      expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 6 }, snapshot)).toBeUndefined();
    },
  );

  it('reports unavailable when no session could be observed, partial when only some could', () => {
    const meter = new WorkflowUsageMeter(RUN);
    expect(meter.snapshot().tokenTrackingStatus).toBe('partial'); // nothing observed yet

    const untracked = new MockSession({ responses: [] }); // tokenTrackingAvailable: false
    meter.sessionStarted(untracked, 'docker');
    meter.sessionEnded(untracked);
    expect(meter.snapshot()).toMatchObject({ untrackedSessions: 1, tokenTrackingStatus: 'unavailable' });

    const tracked = new MockSession({
      responses: [],
      budgetStatus: () => mockBudgetStatus({ tokenTrackingAvailable: true }),
    });
    meter.sessionStarted(tracked, 'docker');
    meter.observeExchange(makeLlmExchange({ workflowRunId: RUN }));
    expect(meter.snapshot()).toMatchObject({
      meteredSessions: 1,
      untrackedSessions: 1,
      tokenTrackingStatus: 'partial',
    });
  });

  it('survives sessions whose budget status cannot be read', () => {
    const meter = new WorkflowUsageMeter(RUN);
    const broken = new MockSession({
      responses: [],
      budgetStatus: () => {
        throw new Error('status unavailable');
      },
    });
    meter.sessionStarted(broken, 'builtin');
    expect(() => meter.snapshot()).not.toThrow();
    meter.sessionEnded(broken);
    expect(meter.snapshot()).toMatchObject({ untrackedSessions: 1, totalTokens: 0, estimatedCostUsd: 0 });
  });

  it('counts active time only while running', () => {
    const meter = new WorkflowUsageMeter(RUN, usage({ activeSeconds: 10 }));
    meter.setRunning(true, 1_000);
    expect(meter.snapshot(4_000).activeSeconds).toBe(13);
    meter.setRunning(false, 6_000);
    // Waiting at a gate does not count.
    expect(meter.snapshot(60_000).activeSeconds).toBe(15);
    meter.setRunning(true, 60_000);
    meter.setRunning(true, 61_000); // idempotent: the clock started at 60s
    expect(meter.snapshot(62_000).activeSeconds).toBe(17);
  });
});

describe('persisted workflow usage', () => {
  function legacyContext(totalTokens: number): WorkflowContext {
    return { totalTokens } as WorkflowContext;
  }

  it('continues from the checkpoint record and recomputes the status from its counters', () => {
    const restored = workflowUsageFromCheckpoint({
      usage: {
        ...usage({ totalTokens: 500, inputTokens: 400, outputTokens: 100, reportedSessions: 1 }),
        tokenTrackingStatus: 'unavailable',
      },
      context: legacyContext(0),
      transitionHistory: [],
    });
    expect(restored).toMatchObject({ totalTokens: 500, tokenTrackingStatus: 'complete' });

    const meter = new WorkflowUsageMeter(RUN, restored);
    meter.observeExchange(makeLlmExchange({ workflowRunId: RUN }));
    expect(meter.snapshot()).toMatchObject({ totalTokens: 610, observedExchanges: 1 });
  });

  it('restores a pre-usage checkpoint from its output-only total as a lower bound', () => {
    const restored = workflowUsageFromCheckpoint({
      context: legacyContext(1234),
      transitionHistory: [],
    });
    expect(restored).toMatchObject({
      outputTokens: 1234,
      totalTokens: 1234,
      lowerBound: true,
      tokenTrackingStatus: 'partial',
    });
    const untouched = workflowUsageFromCheckpoint({ context: legacyContext(0), transitionHistory: [] });
    expect(untouched.lowerBound).toBe(false);
  });

  it('coerces damaged records instead of trusting them', () => {
    const parsed = parseWorkflowUsage({
      totalTokens: 'lots',
      inputTokens: -5,
      outputTokens: Number.NaN,
      estimatedCostUsd: 2,
      lowerBound: 'yes',
      tokenTrackingStatus: 'complete',
    });
    expect(parsed).toMatchObject({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 2,
      lowerBound: false,
      // Nothing was observed: the stored "complete" is not believed.
      tokenTrackingStatus: 'partial',
    });
    expect(parseWorkflowUsage(null)).toBeUndefined();
    expect(parseWorkflowUsage([1, 2])).toBeUndefined();
  });
});

describe('findWorkflowBudgetBreach', () => {
  const complete = usage({ reportedSessions: 1 });

  it('stays quiet without limits or below every limit', () => {
    expect(findWorkflowBudgetBreach(undefined, usage({ totalTokens: 1e9 }))).toBeUndefined();
    expect(
      findWorkflowBudgetBreach(
        { maxTotalTokens: 1000, maxEstimatedCostUsd: 1, maxWallClockSeconds: 60 },
        { ...complete, totalTokens: 999, estimatedCostUsd: 0.99, activeSeconds: 59 },
      ),
    ).toBeUndefined();
    expect(
      findWorkflowBudgetBreach(
        { maxTotalTokens: null, maxEstimatedCostUsd: null, maxWallClockSeconds: null },
        { ...complete, totalTokens: 1e9 },
      ),
    ).toBeUndefined();
  });

  it('reports each dimension once its limit is reached', () => {
    expect(
      findWorkflowBudgetBreach({ maxTotalTokens: 1000 }, usage({ reportedSessions: 1, totalTokens: 1000 })),
    ).toMatchObject({
      dimension: 'tokens',
      limitField: 'maxTotalTokens',
      used: 1000,
      limit: 1000,
      message: '1,000 of 1,000 tokens used',
    });
    expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 2 }, { ...complete, estimatedCostUsd: 2.5 })).toMatchObject({
      dimension: 'cost',
      message: 'estimated cost $2.50 of $2.00',
    });
    expect(findWorkflowBudgetBreach({ maxWallClockSeconds: 30 }, { ...complete, activeSeconds: 31 })).toMatchObject({
      dimension: 'wallClock',
      limitField: 'maxWallClockSeconds',
    });
  });

  it('marks a lower-bound token total and fails closed when some session was not observable', () => {
    expect(
      findWorkflowBudgetBreach(
        { maxTotalTokens: 10 },
        usage({ totalTokens: 20, lowerBound: true, reportedSessions: 1 }),
      )?.message,
    ).toBe('at least 20 of 10 tokens used');

    // A session that nothing counted (no token tracking, no budget gate)
    // fails both ceilings closed: the cost ceiling no longer passes it.
    const uncounted = usage({ untrackedSessions: 1, uncountedSessions: 1 });
    const breach = findWorkflowBudgetBreach({ maxTotalTokens: 1_000_000 }, uncounted);
    expect(breach).toMatchObject({ dimension: 'tokens', limitField: 'maxTotalTokens' });
    expect(breach?.message).toContain('cannot be enforced');
    const costBreach = findWorkflowBudgetBreach({ maxEstimatedCostUsd: 5 }, uncounted);
    expect(costBreach).toMatchObject({ dimension: 'cost', limitField: 'maxEstimatedCostUsd', limit: 5 });
    expect(costBreach?.message).toBe(
      'the $5.00 cost ceiling cannot be enforced: 1 agent session(s) of this run had neither token tracking ' +
        'nor a budget gate counting their usage; remove the cost ceiling or use a running-time ceiling for this run',
    );
    expect(findWorkflowBudgetBreach({ maxWallClockSeconds: 60 }, uncounted)).toBeUndefined();
    // A session the metrics missed but its bundle's budget gate counted is
    // held to the gate's figures (already in the totals) instead.
    expect(
      findWorkflowBudgetBreach({ maxTotalTokens: 1_000_000, maxEstimatedCostUsd: 5 }, usage({ untrackedSessions: 1 })),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Budget-gate charges (FU-16 / 07-03)
// ---------------------------------------------------------------------------

describe('WorkflowUsageMeter: what the bundles’ budget gates charged', () => {
  /** A Docker session whose budget status reports `gate` as its bundle gate's charges. */
  function gatedSession(
    sessionId: string,
    gate: () => { readonly bundleId: string; readonly totalTokens: number; readonly costUsd: number },
    opts: { readonly tokenTrackingAvailable?: boolean; readonly hostObservedCostUsd?: number } = {},
  ): MockSession {
    return new MockSession({
      sessionId,
      responses: [],
      budgetStatus: () => ({
        ...mockBudgetStatus({
          tokenTrackingAvailable: opts.tokenTrackingAvailable ?? true,
          hostObservedCostUsd: opts.hostObservedCostUsd ?? 0,
        }),
        budgetGate: gate(),
      }),
    });
  }

  it('breaches maxEstimatedCostUsd 4 on the $5 a session’s own gate charged, though it observed no cost', () => {
    const meter = new WorkflowUsageMeter(RUN);
    let charges = { bundleId: 'per-state-session', totalTokens: 40_000, costUsd: 2 };
    const session = gatedSession('per-state-session', () => charges);
    meter.sessionStarted(session, 'docker');
    // Live, while the session runs.
    expect(meter.snapshot()).toMatchObject({ estimatedCostUsd: 2, gateOnlyCostUsd: 2, totalTokens: 40_000 });

    charges = { ...charges, totalTokens: 100_000, costUsd: 5 };
    meter.sessionEnded(session);
    // Settled when it ends: its own bundle goes away with it.
    charges = { ...charges, costUsd: 99 };
    const snapshot = meter.snapshot();
    expect(snapshot).toMatchObject({
      estimatedCostUsd: 5,
      gateOnlyCostUsd: 5,
      totalTokens: 100_000,
      gateOnlyTokens: 100_000,
      inputTokens: 0,
      outputTokens: 0,
      uncountedSessions: 0,
      tokenTrackingStatus: 'partial',
    });
    expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 4 }, snapshot)).toMatchObject({
      dimension: 'cost',
      used: 5,
      message: 'estimated cost $5.00 of $4.00',
    });
    expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 6 }, snapshot)).toBeUndefined();
  });

  it('takes a last reading of a closed session’s own gate, which settled the exchanges still in flight', () => {
    const meter = new WorkflowUsageMeter(RUN);
    let charges = { bundleId: 'per-state-session', totalTokens: 10_000, costUsd: 1 };
    const session = gatedSession('per-state-session', () => charges);
    meter.sessionStarted(session, 'docker');
    meter.sessionEnded(session);
    expect(meter.snapshot()).toMatchObject({ estimatedCostUsd: 1, totalTokens: 10_000 });

    // Closing the session stopped its container's MITM, which settled the
    // requests a process the agent left running still had open.
    charges = { ...charges, totalTokens: 60_000, costUsd: 5 };
    meter.sessionClosed(session);
    const snapshot = meter.snapshot();
    expect(snapshot).toMatchObject({ estimatedCostUsd: 5, gateOnlyCostUsd: 5, totalTokens: 60_000 });
    expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 4 }, snapshot)).toMatchObject({ dimension: 'cost' });

    // A reading never lowers the count, and a bundle the meter does not know is not counted.
    charges = { ...charges, totalTokens: 0, costUsd: 0 };
    meter.sessionClosed(session);
    const stranger = gatedSession('stranger', () => ({ bundleId: 'unknown-bundle', totalTokens: 1, costUsd: 100 }));
    meter.sessionClosed(stranger);
    expect(meter.snapshot()).toMatchObject({ estimatedCostUsd: 5, totalTokens: 60_000 });
  });

  it('counts a bundle_only exchange’s cost through the gate that charged it', () => {
    const meter = new WorkflowUsageMeter(RUN);
    const gate = createBudgetGate({ mode: 'turn', limits: { maxTotalTokens: null, maxEstimatedCostUsd: null } });
    meter.addBundle('shared-bundle');
    meter.trackBundleGate('shared-bundle', gate);
    // A process that dropped the metrics lease: the exchange is tied only to the bundle.
    const exchange = makeLlmExchange({
      bundleId: 'shared-bundle',
      quality: 'bundle_only',
      usage: {
        inputTokensReported: 100_000,
        inputTokensTotal: 100_000,
        inputTokensUncached: 100_000,
        outputTokensReported: 1_000,
        outputTokensTotal: 1_000,
        providerTotalTokens: 101_000,
        canonicalTotalTokens: 101_000,
      },
    });
    const turn = gate.beginTurn();
    const admission = gate.admit({
      protocol: 'anthropic-messages',
      model: 'claude-sonnet-4-5',
      outputCapTokens: 1_000,
    });
    if (!admission.admitted) throw new Error(`unexpected refusal: ${admission.refusal.message}`);
    admission.ticket.markUpstreamStatus(200);
    admission.ticket.settle(exchange);
    turn.end();
    meter.observeExchange(exchange);

    const snapshot = meter.snapshot();
    // The bus and the gate both counted its tokens: they count once.
    expect(snapshot).toMatchObject({ observedExchanges: 1, totalTokens: 101_000, gateOnlyTokens: 0 });
    // No session's host-observed cost includes it; the gate's list-price charge does.
    const listed = (100_000 * 3 + 1_000 * 15) / 1_000_000;
    expect(snapshot.estimatedCostUsd).toBeCloseTo(listed, 12);
    expect(snapshot.gateOnlyCostUsd).toBeCloseTo(listed, 12);
    expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 0.3 }, snapshot)).toMatchObject({ dimension: 'cost' });
  });

  it('fails both ceilings closed for a session with neither token tracking nor a budget gate (statistics off)', () => {
    const meter = new WorkflowUsageMeter(RUN);
    const session = new MockSession({ responses: [] }); // tokenTrackingAvailable: false, no gate
    meter.sessionStarted(session, 'docker');
    meter.sessionEnded(session);
    const snapshot = meter.snapshot();
    expect(snapshot).toMatchObject({ untrackedSessions: 1, uncountedSessions: 1, estimatedCostUsd: 0 });
    expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 5 }, snapshot)).toMatchObject({
      dimension: 'cost',
      message: expect.stringContaining('cannot be enforced') as string,
    });
    expect(findWorkflowBudgetBreach({ maxTotalTokens: 1_000_000 }, snapshot)?.message).toContain('cannot be enforced');
    // An unreadable status counts as uncounted too.
    const broken = new MockSession({
      responses: [],
      budgetStatus: () => {
        throw new Error('status unavailable');
      },
    });
    const other = new WorkflowUsageMeter(RUN);
    other.sessionStarted(broken, 'builtin');
    expect(other.snapshot().uncountedSessions).toBe(1);
  });

  it('holds a session without token tracking to its bundle gate’s charges (statistics off)', () => {
    const meter = new WorkflowUsageMeter(RUN);
    const session = gatedSession('stats-off', () => ({ bundleId: 'stats-off', totalTokens: 300_000, costUsd: 1.2 }), {
      tokenTrackingAvailable: false,
    });
    meter.sessionStarted(session, 'docker');
    meter.sessionEnded(session);
    const snapshot = meter.snapshot();
    expect(snapshot).toMatchObject({
      untrackedSessions: 1,
      uncountedSessions: 0,
      totalTokens: 300_000,
      gateOnlyTokens: 300_000,
      tokenTrackingStatus: 'partial',
    });
    expect(snapshot.estimatedCostUsd).toBeCloseTo(1.2, 12);
    // Both ceilings are enforced on the gate's figures rather than failing closed.
    expect(findWorkflowBudgetBreach({ maxTotalTokens: 1_000_000, maxEstimatedCostUsd: 5 }, snapshot)).toBeUndefined();
    expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 1 }, snapshot)).toMatchObject({ dimension: 'cost' });
    expect(findWorkflowBudgetBreach({ maxTotalTokens: 250_000 }, snapshot)).toMatchObject({
      dimension: 'tokens',
      message: 'at least 300,000 of 250,000 tokens used',
    });

    // A session borrowing a bundle whose gate the meter reads is counted by
    // that gate, even when its own status does not report it.
    const shared = new WorkflowUsageMeter(RUN);
    shared.addBundle('shared-bundle');
    shared.trackBundleGate('shared-bundle', { snapshot: () => ({ totalTokens: 1_000, costUsd: 0.25 }) });
    shared.sessionStarted(new MockSession({ responses: [] }), 'docker', 'shared-bundle');
    expect(shared.snapshot()).toMatchObject({ untrackedSessions: 1, uncountedSessions: 0, gateOnlyCostUsd: 0.25 });
  });

  it('counts each bundle at the larger of its observed and gate-charged usage, never their sum', () => {
    const meter = new WorkflowUsageMeter(RUN);
    let charges = { totalTokens: 0, costUsd: 0 };
    meter.addBundle('shared-bundle');
    meter.trackBundleGate('shared-bundle', { snapshot: () => charges });
    const borrowed = new MockSession({
      sessionId: 'lane-session',
      responses: [],
      budgetStatus: () => mockBudgetStatus({ tokenTrackingAvailable: true, hostObservedCostUsd: 0.5 }),
    });
    meter.sessionStarted(borrowed, 'docker', 'shared-bundle');
    meter.observeExchange(makeLlmExchange({ workflowRunId: RUN, bundleId: 'shared-bundle' }));
    // The gate has not settled the exchange yet: the observed view is the larger.
    expect(meter.snapshot()).toMatchObject({
      totalTokens: 110,
      gateOnlyTokens: 0,
      estimatedCostUsd: 0.5,
      gateOnlyCostUsd: 0,
    });

    // The gate charged that exchange and one the bus never saw (an estimate).
    charges = { totalTokens: 110 + 32_000, costUsd: 0.98 };
    expect(meter.snapshot()).toMatchObject({ totalTokens: 32_110, gateOnlyTokens: 32_000 });
    expect(meter.snapshot().estimatedCostUsd).toBeCloseTo(0.98, 12);
    expect(meter.snapshot().gateOnlyCostUsd).toBeCloseTo(0.48, 12);
    // Settling the session changes nothing; the gate is still read after it ended.
    meter.sessionEnded(borrowed);
    charges = { totalTokens: 50_000, costUsd: 1.5 };
    expect(meter.snapshot()).toMatchObject({ totalTokens: 50_000, gateOnlyTokens: 49_890 });
    expect(meter.snapshot().estimatedCostUsd).toBeCloseTo(1.5, 12);

    // Another bundle is compared on its own: its sessions' larger cost does
    // not absorb this bundle's gate charges.
    const other = gatedSession(
      'per-state-session',
      () => ({ bundleId: 'per-state-session', totalTokens: 0, costUsd: 1 }),
      {
        hostObservedCostUsd: 3,
      },
    );
    meter.sessionStarted(other, 'docker');
    meter.sessionEnded(other);
    expect(meter.snapshot().estimatedCostUsd).toBeCloseTo(1.5 + 3, 12);
  });

  it('persists the gate-only figures and uncounted sessions; an older record’s untracked sessions stay uncounted', () => {
    const recorded = usage({
      totalTokens: 5_000,
      gateOnlyTokens: 4_000,
      estimatedCostUsd: 2,
      gateOnlyCostUsd: 1.5,
      untrackedSessions: 2,
      uncountedSessions: 0,
    });
    const restored = workflowUsageFromCheckpoint({
      usage: recorded,
      context: {} as WorkflowContext,
      transitionHistory: [],
    });
    expect(restored).toMatchObject({ gateOnlyTokens: 4_000, gateOnlyCostUsd: 1.5, uncountedSessions: 0 });
    const meter = new WorkflowUsageMeter(RUN, restored);
    expect(meter.snapshot()).toMatchObject({ totalTokens: 5_000, estimatedCostUsd: 2, gateOnlyTokens: 4_000 });

    // Written before budget-gate charges were counted: nothing counted those
    // untracked sessions' spend, so both ceilings stay closed after a resume.
    const older: Record<string, unknown> = { ...usage({ untrackedSessions: 2, totalTokens: 10 }) };
    delete older.uncountedSessions;
    const parsedOlder = parseWorkflowUsage(older);
    expect(parsedOlder).toMatchObject({ untrackedSessions: 2, uncountedSessions: 2 });
    expect(parseWorkflowUsage({ ...older, uncountedSessions: 'none' })?.uncountedSessions).toBe(2);
    if (!parsedOlder) throw new Error('older record did not parse');
    expect(findWorkflowBudgetBreach({ maxEstimatedCostUsd: 100 }, parsedOlder)?.message).toContain(
      'cannot be enforced',
    );
  });
});
