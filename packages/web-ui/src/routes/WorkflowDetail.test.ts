import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type {
  WorkflowSummaryDto,
  WorkflowDetailDto,
  HumanGateRequestDto,
  TransitionRecordDto,
  MessageLogEntry,
  MessageLogResponseDto,
  WorkflowBudgetDto,
  WorkflowEscalationDto,
} from '$lib/types.js';
import { tick } from 'svelte';
import { RpcError } from '$lib/ws-client.js';

// jsdom does not provide ResizeObserver -- stub it globally
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

// ---------------------------------------------------------------------------
// Mock store functions -- vi.hoisted ensures these are available in vi.mock
// ---------------------------------------------------------------------------

const {
  mockGetWorkflowBudget,
  mockGetWorkflowDetail,
  mockResolveWorkflowGate,
  mockGetWorkflowFileTree,
  mockGetWorkflowFileContent,
  mockGetWorkflowArtifacts,
  mockGetWorkflowArtifactFile,
  mockGetWorkflowMessageLog,
  mockGetWorkflowMessageLogEntry,
  mockResolveWorkflowEscalation,
  mockAppState,
} = vi.hoisted(() => ({
  mockGetWorkflowBudget: vi.fn<(id: string) => Promise<WorkflowBudgetDto>>(),
  mockGetWorkflowDetail: vi.fn<(id: string) => Promise<WorkflowDetailDto>>(),
  mockResolveWorkflowGate: vi.fn<(id: string, gateId: string, event: string, prompt?: string) => Promise<void>>(),
  mockGetWorkflowFileTree: vi.fn(),
  mockGetWorkflowFileContent: vi.fn(),
  mockGetWorkflowArtifacts: vi.fn(),
  mockGetWorkflowArtifactFile: vi.fn(),
  mockGetWorkflowMessageLog:
    vi.fn<(id: string, opts?: { before?: string; limit?: number }) => Promise<MessageLogResponseDto>>(),
  mockGetWorkflowMessageLogEntry: vi.fn(),
  mockResolveWorkflowEscalation:
    vi.fn<(id: string, escalationId: string, decision: string, whitelistSelection?: number) => Promise<void>>(),
  mockAppState: {
    workflowReviewErrors: new Map<string, string>(),
    refreshErrors: {} as Record<string, string>,
    pendingGates: new Map<string, HumanGateRequestDto>(),
    pendingWorkflowEscalations: new Map<string, WorkflowEscalationDto>(),
  },
}));

vi.mock('$lib/stores.svelte.js', () => ({
  appState: mockAppState,
  getWorkflowBudget: (id: string) => mockGetWorkflowBudget(id),
  connectionGeneration: { value: 0 },
  getWorkflowDetail: (...args: unknown[]) => mockGetWorkflowDetail(...(args as [string])),
  resolveWorkflowGate: (...args: unknown[]) =>
    mockResolveWorkflowGate(...(args as [string, string, string, string | undefined])),
  // Mirrors the store: the detail's gate replaces every entry for that workflow.
  syncWorkflowGateFromDetail: (workflowId: string, detail: WorkflowDetailDto) => {
    const next = new Map<string, HumanGateRequestDto>();
    for (const [gateId, gate] of mockAppState.pendingGates) {
      if (gate.workflowId !== workflowId) next.set(gateId, gate);
    }
    if (detail.phase === 'waiting_human' && detail.gate) next.set(detail.gate.gateId, detail.gate);
    mockAppState.pendingGates = next;
  },
  resolveWorkflowEscalation: (...args: unknown[]) =>
    mockResolveWorkflowEscalation(...(args as [string, string, string, number | undefined])),
  getWorkflowFileTree: (...args: unknown[]) => mockGetWorkflowFileTree(...args),
  getWorkflowFileContent: (...args: unknown[]) => mockGetWorkflowFileContent(...args),
  getWorkflowArtifacts: (...args: unknown[]) => mockGetWorkflowArtifacts(...args),
  getWorkflowArtifactFile: (...args: unknown[]) => mockGetWorkflowArtifactFile(...args),
  getWorkflowMessageLog: (...args: unknown[]) =>
    mockGetWorkflowMessageLog(...(args as [string, { before?: string; limit?: number } | undefined])),
  getWorkflowMessageLogEntry: (...args: unknown[]) => mockGetWorkflowMessageLogEntry(...args),
  getWorkflowReadme: () => Promise.resolve({ content: '# Readme' }),
}));

vi.mock('$lib/utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils.js')>();
  return {
    ...actual,
    phaseBadgeVariant: (phase: string) => {
      const map: Record<string, string> = {
        running: 'default',
        waiting_human: 'warning',
        completed: 'success',
        failed: 'destructive',
      };
      return map[phase] ?? 'outline';
    },
  };
});

// Import component after mocks
import WorkflowDetail from './WorkflowDetail.svelte';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<WorkflowSummaryDto> = {}): WorkflowSummaryDto {
  return {
    workflowId: 'wf-1',
    name: 'Code Review Pipeline',
    phase: 'running',
    currentState: 'implement',
    startedAt: '2026-01-15T10:00:00Z',
    taskDescription: 'Review the codebase',
    round: 0,
    maxRounds: 5,
    totalTokens: 0,
    ...overrides,
  };
}

function makeTransition(overrides: Partial<TransitionRecordDto> = {}): TransitionRecordDto {
  return {
    from: 'plan',
    to: 'implement',
    event: 'CONTINUE',
    timestamp: '2026-01-15T10:05:00Z',
    durationMs: 30000,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<WorkflowDetailDto> = {}): WorkflowDetailDto {
  return {
    workflowId: 'wf-1',
    name: 'Code Review Pipeline',
    phase: 'running',
    currentState: 'implement',
    startedAt: '2026-01-15T10:00:00Z',
    taskDescription: 'Review the codebase',
    round: 2,
    maxRounds: 5,
    totalTokens: 15000,
    description: 'Automated code review workflow',
    stateGraph: { states: [], transitions: [] },
    transitionHistory: [],
    context: {
      taskDescription: 'Review the codebase',
      round: 2,
      maxRounds: 5,
      totalTokens: 15000,
      visitCounts: {},
    },
    workspacePath: '/tmp/wf-workspace',
    hasReadme: false,
    ...overrides,
  };
}

function makeGate(overrides: Partial<HumanGateRequestDto> = {}): HumanGateRequestDto {
  return {
    gateId: 'gate-1',
    workflowId: 'wf-1',
    stateName: 'review',
    acceptedEvents: ['APPROVE', 'FORCE_REVISION'],
    presentedArtifacts: [],
    summary: 'Review needed',
    ...overrides,
  };
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'wf-1',
    summary: makeSummary(),
    onback: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowDetail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    // `restoreAllMocks` does not reset the call history of the hoisted
    // `vi.fn()` instances; explicitly clear so per-test assertions on
    // call counts (e.g. message-log fetch counts) start from zero.
    mockGetWorkflowBudget.mockReset();
    mockGetWorkflowBudget.mockRejectedValue(new Error('Limits unavailable'));
    mockGetWorkflowDetail.mockReset();
    mockResolveWorkflowGate.mockReset();
    mockGetWorkflowFileTree.mockReset();
    mockGetWorkflowFileContent.mockReset();
    mockGetWorkflowArtifacts.mockReset();
    mockGetWorkflowArtifactFile.mockReset();
    mockGetWorkflowMessageLogEntry.mockReset();
    mockGetWorkflowMessageLog.mockReset();
    mockAppState.pendingGates = new Map();
    mockAppState.pendingWorkflowEscalations = new Map();
    mockResolveWorkflowEscalation.mockReset();
    mockGetWorkflowDetail.mockResolvedValue(makeDetail());
    // WorkspaceBrowser's FileTree calls fetchFileTree on mount
    mockGetWorkflowFileTree.mockResolvedValue({ entries: [] });
    mockGetWorkflowFileContent.mockResolvedValue({ content: '' });
    // Default to an empty message log; tests that exercise the timeline
    // override per-call.
    mockGetWorkflowMessageLog.mockResolvedValue({ entries: [], hasMore: false });
  });

  /** Render with a gate in the waiting_human phase. */
  function renderWithGate(gateOverrides: Partial<HumanGateRequestDto> = {}) {
    const gate = makeGate(gateOverrides);
    const summary = makeSummary({ phase: 'waiting_human' });
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'waiting_human', gate }));
    render(WorkflowDetail, { props: makeProps({ summary, gate }) });
  }

  // ── Header rendering ──────────────────────────────────────────────

  it('renders the workflow name and phase badge', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Code Review Pipeline')).toBeTruthy();
      expect(screen.getByText('running')).toBeTruthy();
    });
  });

  it('shows the current state in the header', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('implement')).toBeTruthy();
    });
  });

  it('calls onback when the Back button is clicked', async () => {
    const onback = vi.fn();
    render(WorkflowDetail, { props: makeProps({ onback }) });

    await vi.waitFor(() => {
      expect(screen.getByText('Code Review Pipeline')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText(/Back/));
    expect(onback).toHaveBeenCalled();
  });

  // ── Loading and error states ──────────────────────────────────────

  it('shows a spinner while loading detail', () => {
    // Don't resolve the promise yet
    mockGetWorkflowDetail.mockReturnValue(new Promise(() => {}));
    render(WorkflowDetail, { props: makeProps() });

    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  it('shows an error alert when fetching detail fails', async () => {
    mockGetWorkflowDetail.mockRejectedValue(new Error('Workflow not found'));
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Workflow not found')).toBeTruthy();
    });
    expect(screen.queryByTestId('workflow-budget-detail')).toBeNull();
    expect(screen.queryByText('Loading resource limits…')).toBeNull();
  });

  // ── Context metrics cards ─────────────────────────────────────────

  it('displays round, total tokens, workspace path, and description', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
      expect(screen.getByText('15,000')).toBeTruthy();
      expect(screen.getByText('/tmp/wf-workspace')).toBeTruthy();
      expect(screen.getByText('Automated code review workflow')).toBeTruthy();
    });
  });

  it('shows run-wide tokens with their breakdown, marking a partial total as a lower bound', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        usage: {
          inputTokens: 52_000,
          cacheReadTokens: 40_000,
          cacheWriteTokens: 2_000,
          outputTokens: 3_000,
          totalTokens: 55_000,
          estimatedCostUsd: 1.2,
          activeSeconds: 300,
          observedExchanges: 9,
          incompleteExchanges: 1,
          unmeasuredExchanges: 0,
          meteredSessions: 2,
          reportedSessions: 0,
          untrackedSessions: 0,
          lowerBound: true,
          tokenTrackingStatus: 'partial',
        },
      }),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('workflow-total-tokens').textContent).toBe(`≥${(55_000).toLocaleString()}`);
    });
    const breakdown = screen.getByTestId('workflow-token-breakdown').textContent ?? '';
    expect(breakdown).toContain(`${(52_000).toLocaleString()} in (${(42_000).toLocaleString()} cache)`);
    expect(breakdown).toContain(`${(3_000).toLocaleString()} out`);
    expect(breakdown).toContain('partial: 1 of 9 exchanges incomplete');
  });

  it('says run tokens are unavailable instead of 0 when LLM statistics are off', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        totalTokens: 0,
        context: { ...makeDetail().context, totalTokens: 0 },
        usage: {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0.4,
          activeSeconds: 30,
          observedExchanges: 0,
          incompleteExchanges: 0,
          unmeasuredExchanges: 0,
          meteredSessions: 0,
          reportedSessions: 0,
          untrackedSessions: 1,
          lowerBound: false,
          tokenTrackingStatus: 'unavailable',
        },
      }),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('workflow-total-tokens').textContent).toBe('Unavailable');
    });
    expect(screen.getByTestId('workflow-token-breakdown').textContent).toContain('LLM statistics are off');
  });

  it('shows "--" for empty description', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ description: '' }));
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('--')).toBeTruthy();
    });
  });

  // ── Workspace browser toggle ──────────────────────────────────────

  // Helper: find the workspace browser toggle button (not the context card label)
  function findWorkspaceToggle(): HTMLButtonElement {
    const allWorkspace = screen.getAllByText('Workspace');
    // The toggle button is a <button> containing the "Workspace" text
    for (const el of allWorkspace) {
      const btn = el.closest('button');
      if (btn && btn.classList.contains('flex')) return btn;
    }
    throw new Error('Workspace toggle button not found');
  }

  it('starts with workspace browser collapsed', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByText('Select a file to view its contents')).toBeNull();
  });

  it('expands workspace browser when the Workspace header is clicked', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    await fireEvent.click(findWorkspaceToggle());

    await vi.waitFor(() => {
      expect(screen.getByText('Select a file to view its contents')).toBeTruthy();
    });
  });

  it('collapses workspace browser on second click', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    const toggle = findWorkspaceToggle();

    await fireEvent.click(toggle);
    await vi.waitFor(() => {
      expect(screen.getByText('Select a file to view its contents')).toBeTruthy();
    });

    await fireEvent.click(toggle);
    await vi.waitFor(() => {
      expect(screen.queryByText('Select a file to view its contents')).toBeNull();
    });
  });

  // ── Transition history ────────────────────────────────────────────

  it('renders transition history with from/to states and duration', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [
          makeTransition({ from: 'plan', to: 'implement', durationMs: 30000 }),
          makeTransition({ from: 'implement', to: 'test', durationMs: 120000, timestamp: '2026-01-15T10:10:00Z' }),
        ],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Transition History')).toBeTruthy();
    });

    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('test')).toBeTruthy();

    expect(screen.getByText('30s')).toBeTruthy();
    expect(screen.getByText('2m 0s')).toBeTruthy();
  });

  it('shows event badges in transition history', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ event: 'APPROVE' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('APPROVE')).toBeTruthy();
    });
  });

  it('does not show transition history section when there are no transitions', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ transitionHistory: [] }));
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByText('Transition History')).toBeNull();
  });

  // ── Agent message expand/collapse with markdown ───────────────────

  it('shows "show message" toggle when a transition has an agentMessage', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ agentMessage: 'Implementation **complete**.' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('show message')).toBeTruthy();
    });
  });

  it('expands agent message with prose-markdown class when "show message" is clicked', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ agentMessage: 'Implementation **complete**.' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('show message')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('show message'));

    await vi.waitFor(() => {
      expect(screen.getByText('hide message')).toBeTruthy();
    });

    // Find the message container with prose-markdown class
    const messageContainers = document.querySelectorAll('.prose-markdown');
    expect(messageContainers.length).toBeGreaterThan(0);

    // Verify markdown was rendered
    const lastContainer = messageContainers[messageContainers.length - 1];
    expect(lastContainer.querySelector('strong')?.textContent).toBe('complete');
  });

  it('collapses agent message when "hide message" is clicked', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ agentMessage: 'Some message' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('show message')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('show message'));
    await vi.waitFor(() => {
      expect(screen.getByText('hide message')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('hide message'));
    await vi.waitFor(() => {
      expect(screen.getByText('show message')).toBeTruthy();
    });
  });

  it('does not show "show message" toggle when transition has no agentMessage', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ agentMessage: undefined })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Transition History')).toBeTruthy();
    });

    expect(screen.queryByText('show message')).toBeNull();
  });

  // ── Multiple messages expand independently ────────────────────────

  it('expands different transition messages independently', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [
          makeTransition({ from: 'plan', to: 'implement', agentMessage: 'Message one' }),
          makeTransition({
            from: 'implement',
            to: 'test',
            agentMessage: 'Message two',
            timestamp: '2026-01-15T10:10:00Z',
          }),
        ],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      const toggles = screen.getAllByText('show message');
      expect(toggles.length).toBe(2);
    });

    // Expand first message only
    const toggles = screen.getAllByText('show message');
    await fireEvent.click(toggles[0]);

    await vi.waitFor(() => {
      expect(screen.getByText('hide message')).toBeTruthy();
      // Second message should still have "show message"
      expect(screen.getAllByText('show message').length).toBe(1);
    });
  });

  // ── GateReviewPanel integration ───────────────────────────────────

  it('shows GateReviewPanel when gate is provided and phase is waiting_human', async () => {
    renderWithGate();

    await vi.waitFor(() => {
      expect(screen.getByText('Review Required: review')).toBeTruthy();
      expect(screen.getByText('Waiting for Review')).toBeTruthy();
    });
  });

  it('does not show GateReviewPanel when phase is not waiting_human', async () => {
    const gate = makeGate();
    render(WorkflowDetail, { props: makeProps({ gate }) });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByText('Review Required: review')).toBeNull();
  });

  // ── Duration formatting ───────────────────────────────────────────

  it.each([
    { durationMs: 500, expected: '500ms' },
    { durationMs: 45000, expected: '45s' },
    { durationMs: 185000, expected: '3m 5s' },
  ])('formats $durationMs ms duration as "$expected"', async ({ durationMs, expected }) => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ durationMs })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText(expected)).toBeTruthy();
    });
  });

  // ── Phase badge display ───────────────────────────────────────────

  it('displays phase with underscores replaced by spaces', async () => {
    const summary = makeSummary({ phase: 'waiting_human' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText('waiting human')).toBeTruthy();
    });
  });

  // ── Resolve error display ────────────────────────────────────────

  it('shows resolve error alert when gate resolution fails', async () => {
    mockResolveWorkflowGate.mockRejectedValue(new Error('Gate expired'));
    renderWithGate();

    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' }).getAttribute('aria-disabled')).toBe('false');
    });

    await fireEvent.click(screen.getByText('Approve'));

    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to resolve gate.*Gate expired/)).toBeTruthy();
    });
  });

  it('dismisses resolve error when dismiss is clicked', async () => {
    mockResolveWorkflowGate.mockRejectedValue(new Error('Gate expired'));
    renderWithGate();

    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' }).getAttribute('aria-disabled')).toBe('false');
    });

    await fireEvent.click(screen.getByText('Approve'));

    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to resolve gate/)).toBeTruthy();
    });

    // Click dismiss
    await fireEvent.click(screen.getByText('Dismiss'));

    await vi.waitFor(() => {
      expect(screen.queryByText(/Failed to resolve gate/)).toBeNull();
    });
  });

  // ── Context: missing context ───────────────────────────────────

  it('does not render metrics cards when context is null', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({ context: undefined as unknown as WorkflowDetailDto['context'] }),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('State Machine')).toBeTruthy();
    });

    expect(screen.queryByText('Round')).toBeNull();
    expect(screen.queryByText('Total Tokens')).toBeNull();
  });

  // ── Gate seeding into pendingGates ──────────────────────────────

  it('seeds gate into appState.pendingGates when detail has a gate', async () => {
    const gate = makeGate({ gateId: 'gate-seed-1', stateName: 'review' });
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ gate, phase: 'waiting_human' }));

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      // After detail is loaded, the gate should be in appState.pendingGates
      expect(mockAppState.pendingGates.has('gate-seed-1')).toBe(true);
    });

    expect(mockAppState.pendingGates.get('gate-seed-1')?.stateName).toBe('review');
  });

  it('replaces a stale gate for the workflow with the one the detail reports', async () => {
    // A gate dismissed while the client was disconnected (its gate_dismissed
    // event was missed) must not survive beside the live one, or the panel
    // could show the stale summary while the click resolves the live gate.
    mockAppState.pendingGates = new Map([['gate-stale', makeGate({ gateId: 'gate-stale', stateName: 'old_review' })]]);
    const gate = makeGate({ gateId: 'gate-live', stateName: 'review' });
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ gate, phase: 'waiting_human' }));

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(mockAppState.pendingGates.has('gate-live')).toBe(true);
    });
    expect(mockAppState.pendingGates.has('gate-stale')).toBe(false);
  });

  // The store's getWorkflowDetail rebuilds the workflow's entries from each
  // detail (stores-escalation-refresh.test.ts); the view shows what it holds.
  it("shows the store's pending tool-call escalations of this workflow only", async () => {
    const escalation: WorkflowEscalationDto = {
      escalationId: 'esc-live',
      workflowId: 'wf-1',
      stateId: 'implement',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path: '/outside/f.txt' },
      reason: 'Writes outside the workspace require approval.',
      receivedAt: '2026-01-15T10:06:00Z',
    };
    mockAppState.pendingWorkflowEscalations = new Map([
      ['esc-live', escalation],
      ['esc-other', { ...escalation, escalationId: 'esc-other', workflowId: 'wf-2', toolName: 'delete_file' }],
    ]);
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ escalations: [escalation] }));

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getAllByTestId('workflow-escalation')).toHaveLength(1);
    });
    expect(screen.getByTestId('workflow-escalation').textContent).toContain('write_file');
  });

  // ── Multiple transition messages: one expanded, one collapsed ──

  it('keeps unrelated messages collapsed when one is toggled', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [
          makeTransition({ from: 'a', to: 'b', agentMessage: 'First msg' }),
          makeTransition({
            from: 'b',
            to: 'c',
            agentMessage: 'Second msg',
            timestamp: '2026-01-15T10:10:00Z',
          }),
          makeTransition({
            from: 'c',
            to: 'd',
            agentMessage: 'Third msg',
            timestamp: '2026-01-15T10:15:00Z',
          }),
        ],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getAllByText('show message').length).toBe(3);
    });

    // Expand only the second message
    const toggles = screen.getAllByText('show message');
    await fireEvent.click(toggles[1]);

    await vi.waitFor(() => {
      expect(screen.getByText('hide message')).toBeTruthy();
      // The other two should still be collapsed
      expect(screen.getAllByText('show message').length).toBe(2);
    });
  });

  // ── Summary phase badge variants ──────────────────────────────

  it.each(['failed', 'completed'] as const)('renders %s phase with correct display text', async (phase) => {
    const summary = makeSummary({ phase });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText(phase)).toBeTruthy();
    });
  });

  // ── Transition history event badge: no event ───────────────────

  it('does not show event badge when transition has no event', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ event: '' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Transition History')).toBeTruthy();
    });

    // The "CONTINUE" event from the default factory is overridden with empty string
    // An empty string event still renders the badge element, but the content is empty
    // Check that the default "CONTINUE" is NOT present
    expect(screen.queryByText('CONTINUE')).toBeNull();
  });

  // ── Fetches detail using the workflowId prop ───────────────────

  it('fetches workflow detail using the workflowId prop', async () => {
    render(WorkflowDetail, {
      props: makeProps({ workflowId: 'custom-wf-99' }),
    });

    await vi.waitFor(() => {
      expect(mockGetWorkflowDetail).toHaveBeenCalledWith('custom-wf-99');
    });
  });

  // ── No resolve error on successful resolution ─────────────────

  it('does not show resolve error when gate resolution succeeds', async () => {
    mockResolveWorkflowGate.mockResolvedValue(undefined);
    renderWithGate();

    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' }).getAttribute('aria-disabled')).toBe('false');
    });

    await fireEvent.click(screen.getByText('Approve'));

    await vi.waitFor(() => {
      // The decision is bound to the gate the panel displayed.
      expect(mockResolveWorkflowGate).toHaveBeenCalledWith('wf-1', 'gate-1', 'APPROVE', undefined);
    });

    expect(screen.queryByText(/Failed to resolve gate/)).toBeNull();
  });

  // ── A new raise gets a fresh review panel ──────────────────────
  //
  // The displayed gate can switch from one raise to another without the panel
  // unmounting in between: the reconnect rebuild, the re-read after a stale
  // refusal, and a gate_raised that evicts a raise whose dismissal was missed
  // all replace the workflow's gate in one step. Nothing the user saw or
  // started for the earlier raise may carry over to the new one.

  it('does not show artifact content cached for an earlier raise of the same gate', async () => {
    const summary = makeSummary({ phase: 'waiting_human' });
    const visit1 = makeGate({ gateId: 'wf-1-review-1-aaaa', presentedArtifacts: ['plan'] });
    const visit2 = makeGate({ gateId: 'wf-1-review-2-bbbb', presentedArtifacts: ['plan'] });
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'waiting_human', gate: visit1 }));
    // WP-32: the listing carries names and sizes; each file's content is its own fetch.
    mockGetWorkflowArtifacts.mockResolvedValue({ files: [{ path: 'plan.txt', size: 19 }], truncated: false });
    mockGetWorkflowArtifactFile.mockResolvedValue({ content: 'plan from visit one', language: 'text' });

    const artifactsTab = () => screen.getByRole('button', { name: /^Artifacts/ });
    const view = render(WorkflowDetail, { props: makeProps({ summary, gate: visit1 }) });
    await vi.waitFor(() => {
      expect(artifactsTab()).toBeTruthy();
    });
    await fireEvent.click(artifactsTab());
    await vi.waitFor(() => {
      expect(screen.getByText('plan from visit one')).toBeTruthy();
    });

    mockGetWorkflowArtifacts.mockResolvedValue({ files: [{ path: 'plan.txt', size: 19 }], truncated: false });
    mockGetWorkflowArtifactFile.mockResolvedValue({ content: 'plan from visit two', language: 'text' });
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'waiting_human', gate: visit2 }));
    await view.rerender(makeProps({ summary, gate: visit2 }));
    await tick();

    // The earlier raise's artifact is gone and the panel starts over on the summary.
    expect(screen.queryByText('plan from visit one')).toBeNull();
    await fireEvent.click(artifactsTab());
    await vi.waitFor(() => {
      expect(screen.getByText('plan from visit two')).toBeTruthy();
    });
    expect(screen.queryByText('plan from visit one')).toBeNull();
    expect(mockGetWorkflowArtifacts).toHaveBeenCalledTimes(2);
    expect(mockGetWorkflowArtifactFile).toHaveBeenCalledTimes(2);
  });

  it('does not carry an abort confirmation over to a new raise', async () => {
    mockResolveWorkflowGate.mockResolvedValue(undefined);
    const summary = makeSummary({ phase: 'waiting_human' });
    const visit1 = makeGate({ gateId: 'wf-1-review-1-aaaa', acceptedEvents: ['APPROVE', 'ABORT'] });
    const visit2 = makeGate({ gateId: 'wf-1-review-2-bbbb', acceptedEvents: ['APPROVE', 'ABORT'] });
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'waiting_human', gate: visit1 }));

    const view = render(WorkflowDetail, { props: makeProps({ summary, gate: visit1 }) });
    await vi.waitFor(() => {
      expect(screen.getByText('Abort Workflow')).toBeTruthy();
    });
    await fireEvent.click(screen.getByText('Abort Workflow'));
    expect(screen.getByText('Confirm Abort')).toBeTruthy();

    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'waiting_human', gate: visit2 }));
    await view.rerender(makeProps({ summary, gate: visit2 }));
    await tick();

    // The confirmation was given while the first raise was shown; the new
    // raise starts with its own buttons and no pending confirmation.
    expect(screen.queryByText('Confirm Abort')).toBeNull();
    expect(screen.getByText('Abort Workflow')).toBeTruthy();
    expect(mockResolveWorkflowGate).not.toHaveBeenCalled();
  });

  // ── Error callout (failed / interrupted with error) ───────────────

  it('shows error callout when phase is failed and error is set', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'failed', error: 'Agent step crashed unexpectedly' }));
    const summary = makeSummary({ phase: 'failed' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByTestId('workflow-error-callout')).toBeTruthy();
    });
    expect(screen.getByText('Workflow failed')).toBeTruthy();
    expect(screen.getByTestId('workflow-error-text').textContent).toBe('Agent step crashed unexpectedly');
  });

  it('shows error callout when phase is interrupted and error is set', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'interrupted', error: 'Daemon restarted mid-run' }));
    const summary = makeSummary({ phase: 'failed' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByTestId('workflow-error-callout')).toBeTruthy();
    });
    expect(screen.getByText('Workflow interrupted')).toBeTruthy();
    expect(screen.getByTestId('workflow-error-text').textContent).toBe('Daemon restarted mid-run');
  });

  it('does not show error callout for completed workflows', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'completed' }));
    const summary = makeSummary({ phase: 'completed' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByTestId('workflow-error-callout')).toBeNull();
  });

  it('does not show error callout for aborted workflows without error text', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'aborted' }));
    const summary = makeSummary({ phase: 'aborted' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByTestId('workflow-error-callout')).toBeNull();
  });

  it('does not show error callout for interrupted workflows without error text', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'interrupted' }));
    const summary = makeSummary({ phase: 'failed' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByTestId('workflow-error-callout')).toBeNull();
  });

  // ── Latest verdict row ────────────────────────────────────────────

  it('shows latest verdict card when latestVerdict is set', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        latestVerdict: { stateId: 'review', verdict: 'APPROVE', confidence: 0.92 },
      }),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('latest-verdict-card')).toBeTruthy();
    });

    expect(screen.getByTestId('latest-verdict-value').textContent).toBe('APPROVE');
    expect(screen.getByTestId('latest-verdict-confidence').textContent?.trim()).toBe('— 92%');
    expect(screen.getByTestId('latest-verdict-state').textContent?.trim()).toBe('review');
  });

  it('shows latest verdict card without confidence when confidence is omitted', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        latestVerdict: { stateId: 'plan', verdict: 'CONTINUE' },
      }),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('latest-verdict-value').textContent).toBe('CONTINUE');
    });
    expect(screen.queryByTestId('latest-verdict-confidence')).toBeNull();
  });

  it('does not show latest verdict card when latestVerdict is unset', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });
    expect(screen.queryByTestId('latest-verdict-card')).toBeNull();
  });

  // ── Message log section ───────────────────────────────────────────

  function makeMessageEntry(overrides: Partial<MessageLogEntry> = {}): MessageLogEntry {
    return {
      type: 'agent_sent',
      ts: '2026-01-15T10:05:00Z',
      workflowId: 'wf-1',
      state: 'plan',
      role: 'planner',
      message: 'Plan the work',
      ...overrides,
    } as MessageLogEntry;
  }

  it('starts with the message log section collapsed and does not fetch on mount', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Message log')).toBeTruthy();
    });

    // Toggle is collapsed: aria-expanded=false
    const toggle = screen.getByTestId('message-log-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(mockGetWorkflowMessageLog).not.toHaveBeenCalled();
    expect(screen.queryByTestId('message-log-timeline')).toBeNull();
  });

  it('fetches and renders the message log when the section is expanded', async () => {
    mockGetWorkflowMessageLog.mockResolvedValue({
      entries: [makeMessageEntry({ ts: '2026-01-15T11:00:00Z' })],
      hasMore: false,
    });
    render(WorkflowDetail, { props: makeProps({ workflowId: 'wf-42' }) });

    await vi.waitFor(() => {
      expect(screen.getByTestId('message-log-toggle')).toBeTruthy();
    });

    await fireEvent.click(screen.getByTestId('message-log-toggle'));

    await vi.waitFor(() => {
      expect(mockGetWorkflowMessageLog).toHaveBeenCalledWith('wf-42', { limit: 200 });
      expect(screen.getByTestId('message-log-timeline')).toBeTruthy();
    });
  });

  it('appends older entries when "Load older" is clicked', async () => {
    const newest = makeMessageEntry({ ts: '2026-01-15T12:00:00Z', message: 'Newest' });
    const middle = makeMessageEntry({ ts: '2026-01-15T11:00:00Z', message: 'Middle' });
    const older = makeMessageEntry({ ts: '2026-01-15T09:00:00Z', message: 'Older' });

    mockGetWorkflowMessageLog
      .mockResolvedValueOnce({ entries: [newest, middle], hasMore: true })
      .mockResolvedValueOnce({ entries: [older], hasMore: false });

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('message-log-toggle')).toBeTruthy();
    });

    await fireEvent.click(screen.getByTestId('message-log-toggle'));

    await vi.waitFor(() => {
      expect(screen.getAllByTestId('message-log-entry').length).toBe(2);
      expect(screen.getByTestId('message-log-load-older')).toBeTruthy();
    });

    await fireEvent.click(screen.getByTestId('message-log-load-older'));

    await vi.waitFor(() => {
      // Expect the second call to use the oldest entry's ts as the cursor.
      expect(mockGetWorkflowMessageLog).toHaveBeenNthCalledWith(2, 'wf-1', {
        limit: 200,
        before: '2026-01-15T11:00:00Z',
      });
      // Three entries now, in newest-first order.
      expect(screen.getAllByTestId('message-log-entry').length).toBe(3);
    });
  });

  it('does not refetch when the section is collapsed and re-expanded', async () => {
    mockGetWorkflowMessageLog.mockResolvedValue({
      entries: [makeMessageEntry()],
      hasMore: false,
    });
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('message-log-toggle')).toBeTruthy();
    });

    const toggle = screen.getByTestId('message-log-toggle');
    await fireEvent.click(toggle);
    await vi.waitFor(() => {
      expect(screen.getByTestId('message-log-timeline')).toBeTruthy();
    });

    await fireEvent.click(toggle);
    await fireEvent.click(toggle);

    // Still exactly one fetch — the second expand is a no-op since the
    // log was already fetched.
    expect(mockGetWorkflowMessageLog).toHaveBeenCalledTimes(1);
  });

  // ── WORKFLOW_CORRUPTED handling ──────────────────────────────────

  it('shows the dedicated corruption panel when WORKFLOW_CORRUPTED is returned', async () => {
    mockGetWorkflowDetail.mockRejectedValue(
      new RpcError('WORKFLOW_CORRUPTED', 'Failed to parse checkpoint.json: unexpected token at line 12'),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Workflow checkpoint is corrupted')).toBeTruthy();
    });
    expect(screen.getByTestId('corruption-message').textContent).toBe(
      'Failed to parse checkpoint.json: unexpected token at line 12',
    );
    expect(screen.queryByTestId('workflow-budget-detail')).toBeNull();
    expect(screen.queryByText('Loading resource limits…')).toBeNull();
    // The generic destructive banner must NOT also appear.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('falls back to the generic error banner for non-corruption RPC errors', async () => {
    mockGetWorkflowDetail.mockRejectedValue(new RpcError('WORKFLOW_NOT_FOUND', 'Workflow wf-x not found'));
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Workflow wf-x not found')).toBeTruthy();
    });
    // No corruption-specific panel
    expect(screen.queryByText('Workflow checkpoint is corrupted')).toBeNull();
  });
});

describe('workflow budget refresh', () => {
  const snapshot: WorkflowBudgetDto = {
    limits: {
      maxTotalTokens: 1000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5,
      warnThresholdPercent: 80,
    },
    sources: {
      maxTotalTokens: 'default',
      maxSteps: 'default',
      maxSessionSeconds: 'default',
      maxEstimatedCostUsd: 'default',
      warnThresholdPercent: 'default',
    },
    recorded: true,
  };
  it('uses detail budget without a duplicate initial read and polls only running runs', async () => {
    vi.useFakeTimers();
    try {
      mockGetWorkflowDetail.mockResolvedValue(makeDetail({ budget: snapshot }));
      mockGetWorkflowBudget.mockReset();
      mockGetWorkflowBudget.mockResolvedValue(snapshot);
      const view = render(WorkflowDetail, { props: makeProps() });
      await tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByTestId('budget-maxEstimatedCostUsd').textContent).toContain('$5.00');
      expect(mockGetWorkflowBudget).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockGetWorkflowBudget).toHaveBeenCalledTimes(1);
      await view.rerender(makeProps({ summary: makeSummary({ phase: 'completed' }) }));
      await tick();
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockGetWorkflowBudget).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('discards obsolete poll responses after a state refresh seeds a newer snapshot', async () => {
    vi.useFakeTimers();
    try {
      mockGetWorkflowDetail.mockResolvedValue(makeDetail({ budget: snapshot }));
      mockGetWorkflowBudget.mockReset();
      let resolveOld!: (value: WorkflowBudgetDto) => void;
      mockGetWorkflowBudget.mockReturnValue(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      );
      const view = render(WorkflowDetail, { props: makeProps() });
      await tick();
      await vi.advanceTimersByTimeAsync(5000);
      const newer = { ...snapshot, limits: { ...snapshot.limits, maxEstimatedCostUsd: 30 } };
      mockGetWorkflowDetail.mockResolvedValue(makeDetail({ budget: newer }));
      await view.rerender(makeProps({ summary: makeSummary({ currentState: 'review' }) }));
      await tick();
      await vi.advanceTimersByTimeAsync(0);
      resolveOld(snapshot);
      await tick();
      expect(screen.getByTestId('budget-maxEstimatedCostUsd').textContent).toContain('$30.00');
      expect(mockGetWorkflowBudget).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls a running workflow and cleans up polling when detail is unmounted', async () => {
    vi.useFakeTimers();
    try {
      mockGetWorkflowDetail.mockResolvedValue(makeDetail());
      mockGetWorkflowBudget.mockReset();
      mockGetWorkflowBudget.mockResolvedValue({
        limits: {
          maxTotalTokens: 1000,
          maxSteps: 200,
          maxSessionSeconds: 1800,
          maxEstimatedCostUsd: 5,
          warnThresholdPercent: 80,
        },
        sources: {
          maxTotalTokens: 'default',
          maxSteps: 'default',
          maxSessionSeconds: 'default',
          maxEstimatedCostUsd: 'default',
          warnThresholdPercent: 'default',
        },
        recorded: true,
      });
      const view = render(WorkflowDetail, { props: makeProps() });
      await tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockGetWorkflowBudget).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockGetWorkflowBudget).toHaveBeenCalledTimes(2);
      view.unmount();
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockGetWorkflowBudget).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
