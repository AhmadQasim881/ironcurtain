import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import MessageLogTimeline from './message-log-timeline.svelte';
import type {
  MessageLogEntry,
  MessageLogEntryDto,
  AgentSentEntry,
  AgentReceivedEntry,
  AgentRetryEntry,
  GateRaisedEntry,
  GateResolvedEntry,
  ErrorEntry,
  StateTransitionEntry,
  QuotaExhaustedEntry,
  ToolCallEscalationEntry,
} from '$lib/types.js';

// ---------------------------------------------------------------------------
// Factories — one per variant so tests stay readable.
// ---------------------------------------------------------------------------

const TS = '2026-04-23T12:00:00.000Z';

function agentSent(overrides: Partial<AgentSentEntry> = {}): AgentSentEntry {
  return {
    type: 'agent_sent',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    role: 'planner',
    message: 'Hello there.',
    ...overrides,
  };
}

function agentReceived(overrides: Partial<AgentReceivedEntry> = {}): AgentReceivedEntry {
  return {
    type: 'agent_received',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    role: 'planner',
    message: 'Done with **task**.',
    verdict: 'pass',
    confidence: 'high',
    ...overrides,
  };
}

function stateTransition(overrides: Partial<StateTransitionEntry> = {}): StateTransitionEntry {
  return {
    type: 'state_transition',
    ts: TS,
    workflowId: 'wf-1',
    state: 'reviewer',
    from: 'planner',
    event: 'PASS',
    ...overrides,
  };
}

function gateRaised(overrides: Partial<GateRaisedEntry> = {}): GateRaisedEntry {
  return {
    type: 'gate_raised',
    ts: TS,
    workflowId: 'wf-1',
    state: 'plan_review',
    acceptedEvents: ['APPROVE', 'ABORT'],
    ...overrides,
  };
}

function gateResolved(overrides: Partial<GateResolvedEntry> = {}): GateResolvedEntry {
  return {
    type: 'gate_resolved',
    ts: TS,
    workflowId: 'wf-1',
    state: 'plan_review',
    event: 'APPROVE',
    prompt: null,
    ...overrides,
  };
}

function errorEntry(overrides: Partial<ErrorEntry> = {}): ErrorEntry {
  return {
    type: 'error',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    error: 'Something blew up.',
    ...overrides,
  };
}

function quotaExhausted(overrides: Partial<QuotaExhaustedEntry> = {}): QuotaExhaustedEntry {
  return {
    type: 'quota_exhausted',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    role: 'planner',
    rawMessage: 'Rate limit hit.',
    ...overrides,
  };
}

function agentRetry(overrides: Partial<AgentRetryEntry> = {}): AgentRetryEntry {
  return {
    type: 'agent_retry',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    role: 'planner',
    reason: 'missing_status_block',
    details: 'Status block was absent.',
    retryMessage: 'Please include the status block.',
    ...overrides,
  };
}

function toolCallEscalation(overrides: Partial<ToolCallEscalationEntry> = {}): ToolCallEscalationEntry {
  return {
    type: 'tool_call_escalation',
    ts: TS,
    workflowId: 'wf-1',
    state: 'implement',
    escalationId: 'esc-1',
    serverName: 'filesystem',
    toolName: 'write_file',
    reason: 'Writes outside the workspace require approval.',
    outcome: 'raised',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageLogTimeline', () => {
  // ── Per-variant rendering ───────────────────────────────────────────

  it('renders agent_sent with its variant marker and preview', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentSent({ message: 'A short note.' })], hasMore: false },
    });

    const entries = screen.getAllByTestId('message-log-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].getAttribute('data-entry-type')).toBe('agent_sent');
    expect(screen.getByText('Agent sent')).toBeTruthy();
    expect(screen.getByTestId('agent-preview').textContent).toContain('A short note.');
  });

  it('renders agent_received with verdict line and success badge', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentReceived({ verdict: 'pass', confidence: 'high' })], hasMore: false },
    });

    expect(screen.getByText('Agent received')).toBeTruthy();
    expect(screen.getByText('pass')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
  });

  it('renders state_transition with from → to / event', () => {
    render(MessageLogTimeline, {
      props: {
        entries: [stateTransition({ from: 'planner', state: 'reviewer', event: 'PASS' })],
        hasMore: false,
      },
    });

    const entry = screen.getByTestId('message-log-entry');
    expect(entry.getAttribute('data-entry-type')).toBe('state_transition');
    expect(entry.textContent).toContain('planner');
    expect(entry.textContent).toContain('reviewer');
    expect(entry.textContent).toContain('PASS');
    // The "State" label badge is shown.
    expect(screen.getByText('State')).toBeTruthy();
  });

  it('renders gate_raised with muted variant and accepted events', () => {
    render(MessageLogTimeline, {
      props: { entries: [gateRaised({ acceptedEvents: ['APPROVE', 'REPLAN'] })], hasMore: false },
    });

    expect(screen.getByText('Gate raised')).toBeTruthy();
    expect(screen.getByText('APPROVE, REPLAN')).toBeTruthy();
  });

  it('renders gate_resolved with the resolving event', () => {
    render(MessageLogTimeline, {
      props: { entries: [gateResolved({ event: 'APPROVE' })], hasMore: false },
    });

    expect(screen.getByText('Gate resolved')).toBeTruthy();
    expect(screen.getByText('APPROVE')).toBeTruthy();
    // Legacy entries carry no channel; nothing is rendered for it.
    expect(screen.queryByTestId('gate-resolved-by')).toBeNull();
  });

  it('renders the declared channel on gate_resolved when present', () => {
    render(MessageLogTimeline, {
      props: { entries: [gateResolved({ event: 'APPROVE', resolvedBy: 'cli' })], hasMore: false },
    });

    expect(screen.getByTestId('gate-resolved-by').textContent).toBe('cli');
  });

  it('renders error with destructive marker and full text', () => {
    render(MessageLogTimeline, {
      props: { entries: [errorEntry({ error: 'Boom.' })], hasMore: false },
    });

    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText('Boom.')).toBeTruthy();
  });

  it('renders quota_exhausted with destructive marker and raw message', () => {
    render(MessageLogTimeline, {
      props: {
        entries: [quotaExhausted({ rawMessage: 'You hit your limit.' })],
        hasMore: false,
      },
    });

    expect(screen.getByText('Quota exhausted')).toBeTruthy();
    expect(screen.getByText('You hit your limit.')).toBeTruthy();
  });

  it('renders agent_retry with warning marker and reason', () => {
    render(MessageLogTimeline, {
      props: {
        entries: [agentRetry({ reason: 'invalid_verdict', details: 'Verdict was off.' })],
        hasMore: false,
      },
    });

    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.getByText('invalid_verdict')).toBeTruthy();
    expect(screen.getByText('Verdict was off.')).toBeTruthy();
  });

  it('renders tool_call_escalation with the tool, outcome and reason', () => {
    render(MessageLogTimeline, {
      props: { entries: [toolCallEscalation({ outcome: 'expired' })], hasMore: false },
    });

    const entry = screen.getByTestId('message-log-entry');
    expect(entry.getAttribute('data-entry-type')).toBe('tool_call_escalation');
    expect(screen.getByText('Escalation')).toBeTruthy();
    expect(screen.getByText('filesystem/write_file')).toBeTruthy();
    expect(screen.getByText('expired')).toBeTruthy();
    expect(screen.getByText('Writes outside the workspace require approval.')).toBeTruthy();
  });

  it('renders an entry type it does not know with a neutral badge instead of failing', () => {
    // The daemon's log is append-only and can carry types newer than this UI
    // build (fan-out joins, transient failures, ...): one must not take the
    // whole timeline down.
    const unknown = { type: 'fanout_join', ts: TS, workflowId: 'wf-1', state: 'join' } as unknown as MessageLogEntry;
    render(MessageLogTimeline, {
      props: { entries: [unknown, gateRaised({ ts: '2026-04-23T12:00:01.000Z' })], hasMore: false },
    });

    const items = screen.getAllByTestId('message-log-entry');
    expect(items).toHaveLength(2);
    expect(screen.getByText('fanout_join')).toBeTruthy();
    expect(screen.getByText('Gate raised')).toBeTruthy();
  });

  it('renders all eight variants together without errors', () => {
    const entries: MessageLogEntry[] = [
      agentSent({ ts: '2026-04-23T12:00:00.000Z' }),
      agentReceived({ ts: '2026-04-23T12:00:01.000Z' }),
      stateTransition({ ts: '2026-04-23T12:00:02.000Z' }),
      gateRaised({ ts: '2026-04-23T12:00:03.000Z' }),
      gateResolved({ ts: '2026-04-23T12:00:04.000Z' }),
      errorEntry({ ts: '2026-04-23T12:00:05.000Z' }),
      stateTransition({ ts: '2026-04-23T12:00:06.000Z', state: 'errored' }),
      quotaExhausted({ ts: '2026-04-23T12:00:07.000Z' }),
      agentRetry({ ts: '2026-04-23T12:00:08.000Z' }),
    ];

    render(MessageLogTimeline, { props: { entries, hasMore: false } });

    const items = screen.getAllByTestId('message-log-entry');
    expect(items).toHaveLength(entries.length);
    const types = items.map((el) => el.getAttribute('data-entry-type'));
    expect(new Set(types)).toEqual(
      new Set([
        'agent_sent',
        'agent_received',
        'state_transition',
        'gate_raised',
        'gate_resolved',
        'error',
        'quota_exhausted',
        'agent_retry',
      ]),
    );
  });

  // ── Load-older button ────────────────────────────────────────────────

  it('shows the "Load older" button when hasMore is true', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentSent()], hasMore: true, onLoadOlder: vi.fn() },
    });

    expect(screen.getByTestId('message-log-load-older')).toBeTruthy();
  });

  it('hides the "Load older" button when hasMore is false', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentSent()], hasMore: false, onLoadOlder: vi.fn() },
    });

    expect(screen.queryByTestId('message-log-load-older')).toBeNull();
  });

  it('calls onLoadOlder when "Load older" is clicked', async () => {
    const onLoadOlder = vi.fn();
    render(MessageLogTimeline, {
      props: { entries: [agentSent()], hasMore: true, onLoadOlder },
    });

    await fireEvent.click(screen.getByTestId('message-log-load-older'));

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  // ── Loading indicator ────────────────────────────────────────────────

  it('shows the loading indicator when loading is true', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentSent()], hasMore: true, loading: true },
    });

    expect(screen.getByTestId('message-log-loading')).toBeTruthy();
    // While loading, the load-older button is hidden to prevent double-click.
    expect(screen.queryByTestId('message-log-load-older')).toBeNull();
  });

  // ── Empty state ──────────────────────────────────────────────────────

  it('renders an empty-state placeholder when entries is empty', () => {
    render(MessageLogTimeline, { props: { entries: [], hasMore: false } });

    expect(screen.getByTestId('message-log-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('message-log-entry')).toHaveLength(0);
  });

  it('does not render the empty-state placeholder while loading the first page', () => {
    render(MessageLogTimeline, { props: { entries: [], hasMore: false, loading: true } });

    expect(screen.queryByTestId('message-log-empty')).toBeNull();
    expect(screen.getByTestId('message-log-loading')).toBeTruthy();
  });

  // ── Click-to-expand on agent messages ───────────────────────────────

  it('expands an agent_sent entry to full markdown on click', async () => {
    const longMessage = 'Line one\n\n## Heading\n\nMore **markdown** content.';
    render(MessageLogTimeline, {
      props: { entries: [agentSent({ message: longMessage })], hasMore: false },
    });

    // Initially collapsed: preview is shown, full content is not.
    expect(screen.getByTestId('agent-preview')).toBeTruthy();
    expect(screen.queryByTestId('agent-full')).toBeNull();

    await fireEvent.click(screen.getByTestId('agent-toggle'));

    // After click: full markdown rendered, preview gone.
    const full = screen.getByTestId('agent-full');
    expect(full).toBeTruthy();
    expect(full.querySelector('h2')?.textContent).toBe('Heading');
    expect(full.querySelector('strong')?.textContent).toBe('markdown');
    expect(screen.queryByTestId('agent-preview')).toBeNull();
  });

  it('collapses an expanded agent message back to a preview on a second click', async () => {
    render(MessageLogTimeline, {
      props: { entries: [agentReceived({ message: 'Some **markdown** result.' })], hasMore: false },
    });

    const toggle = screen.getByTestId('agent-toggle');
    await fireEvent.click(toggle);
    expect(screen.getByTestId('agent-full')).toBeTruthy();

    await fireEvent.click(toggle);
    expect(screen.queryByTestId('agent-full')).toBeNull();
    expect(screen.getByTestId('agent-preview')).toBeTruthy();
  });

  // ── Truncated entries: full text on expand (WP-32) ───────────────────
  //
  // `workflows.messageLog` pages cut long string fields and mark the entry
  // `truncated` with a `ref`. The timeline fetches the complete entry through
  // `fetchFullEntry` only when a reviewer expands it.

  it('fetches the complete entry when a truncated agent message is expanded', async () => {
    const cut: MessageLogEntryDto = {
      ...agentSent({ message: 'The beginning of a very long' }),
      truncated: true,
      ref: '120:9000',
    };
    const fetchFullEntry = vi
      .fn()
      .mockResolvedValue({ entry: agentSent({ message: 'The beginning of a very long **complete** message.' }) });

    render(MessageLogTimeline, { props: { entries: [cut], hasMore: false, fetchFullEntry } });

    expect(fetchFullEntry).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByTestId('agent-toggle'));

    expect(fetchFullEntry).toHaveBeenCalledWith('120:9000');
    const full = await screen.findByTestId('agent-full');
    await vi.waitFor(() => {
      expect(full.querySelector('strong')?.textContent).toBe('complete');
    });
    expect(screen.queryByTestId('agent-truncated')).toBeNull();
  });

  it('keeps the cut text and explains when the complete entry cannot be fetched', async () => {
    const cut: MessageLogEntryDto = {
      ...agentSent({ message: 'Partial text' }),
      truncated: true,
      ref: '0:5',
    };
    const fetchFullEntry = vi.fn().mockRejectedValue(new Error('Connection closed'));

    render(MessageLogTimeline, { props: { entries: [cut], hasMore: false, fetchFullEntry } });
    await fireEvent.click(screen.getByTestId('agent-toggle'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('agent-truncated').textContent).toContain('Connection closed');
    });
    expect(screen.getByTestId('agent-full').textContent).toContain('Partial text');
  });

  it('marks a truncated agent message as partial when no fetcher is available', async () => {
    const cut: MessageLogEntryDto = { ...agentSent({ message: 'Partial text' }), truncated: true, ref: '0:5' };

    render(MessageLogTimeline, { props: { entries: [cut], hasMore: false } });
    await fireEvent.click(screen.getByTestId('agent-toggle'));

    expect(screen.getByTestId('agent-truncated').textContent).toContain('truncated');
  });

  it('offers "Show full text" for a truncated non-agent entry and loads it on click', async () => {
    const cut: MessageLogEntryDto = { ...errorEntry({ error: 'Stack trace begins' }), truncated: true, ref: '42:7' };
    const fetchFullEntry = vi
      .fn()
      .mockResolvedValue({ entry: errorEntry({ error: 'Stack trace begins here and goes on' }) });

    render(MessageLogTimeline, { props: { entries: [cut], hasMore: false, fetchFullEntry } });

    expect(screen.getByTestId('entry-truncated')).toBeTruthy();
    await fireEvent.click(screen.getByTestId('load-full-entry'));

    expect(fetchFullEntry).toHaveBeenCalledWith('42:7');
    await vi.waitFor(() => {
      expect(screen.getByText('Stack trace begins here and goes on')).toBeTruthy();
    });
    expect(screen.queryByTestId('entry-truncated')).toBeNull();
  });

  it('never calls fetchFullEntry for an entry that was not truncated', async () => {
    const fetchFullEntry = vi.fn();
    render(MessageLogTimeline, {
      props: { entries: [agentSent({ message: 'Short and complete.' })], hasMore: false, fetchFullEntry },
    });

    await fireEvent.click(screen.getByTestId('agent-toggle'));

    expect(fetchFullEntry).not.toHaveBeenCalled();
    expect(screen.queryByTestId('agent-truncated')).toBeNull();
  });

  // ── B3: expanded-state survives pagination append ───────────────────
  //
  // Before the fix the expansion key included the array index; appending
  // older entries via "Load older" shifted every prior index by N and
  // collapsed the user's selections. Keying by `entry.ts` only keeps each
  // selection bound to its message regardless of where it lands in the list.

  // ── Composite key disambiguates same-`ts` entries of different `type` ──
  //
  // The orchestrator can write pairs like `state_transition` + `gate_raised`
  // at the same millisecond. Keying the each-block on `entry.ts` alone
  // caused Svelte 5 to throw `each_key_duplicate` (fatal), silently failing
  // the timeline render. The composite `ts:type` key keeps both entries
  // distinct.

  it('renders two entries sharing the same ts but different type without throwing', () => {
    const sharedTs = '2026-04-23T12:00:00.000Z';
    const entries: MessageLogEntry[] = [
      stateTransition({ ts: sharedTs, from: 'planner', state: 'plan_review', event: 'NEEDS_REVIEW' }),
      gateRaised({ ts: sharedTs, state: 'plan_review', acceptedEvents: ['APPROVE', 'ABORT'] }),
    ];

    expect(() => render(MessageLogTimeline, { props: { entries, hasMore: false } })).not.toThrow();

    const items = screen.getAllByTestId('message-log-entry');
    expect(items).toHaveLength(2);
    const types = items.map((el) => el.getAttribute('data-entry-type'));
    expect(types).toContain('state_transition');
    expect(types).toContain('gate_raised');
  });

  it('preserves expanded state when older entries are appended (pagination)', async () => {
    const newMsg = agentSent({
      ts: '2026-04-23T12:00:10.000Z',
      message: 'Newer message body',
    });
    const { rerender } = render(MessageLogTimeline, {
      props: { entries: [newMsg], hasMore: true, onLoadOlder: vi.fn() },
    });

    // Expand the only entry currently in view.
    await fireEvent.click(screen.getByTestId('agent-toggle'));
    expect(screen.getByTestId('agent-full')).toBeTruthy();
    expect(screen.queryByTestId('agent-preview')).toBeNull();

    // Simulate "Load older" appending a second, older entry. After the
    // append, the originally-clicked entry still expands (its key survived
    // even though its index moved within the list).
    const olderMsg = agentSent({
      ts: '2026-04-23T11:00:00.000Z',
      message: 'Older message body',
    });
    await rerender({ entries: [newMsg, olderMsg], hasMore: false });

    const fulls = screen.getAllByTestId('agent-full');
    const previews = screen.queryAllByTestId('agent-preview');
    expect(fulls).toHaveLength(1);
    expect(previews).toHaveLength(1);
    expect(fulls[0].textContent).toContain('Newer message body');
    expect(previews[0].textContent).toContain('Older message body');
  });
});
