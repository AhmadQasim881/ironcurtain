import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import WorkflowEscalationPanel from './workflow-escalation-panel.svelte';
import { ESCALATION_ARM_DELAY_MS } from './escalation-modal.svelte';
import type { WorkflowEscalationDto } from '$lib/types.js';

function makeEscalation(overrides: Partial<WorkflowEscalationDto> = {}): WorkflowEscalationDto {
  return {
    escalationId: 'esc-1',
    workflowId: 'wf-1',
    stateId: 'implement',
    persona: 'coder',
    serverName: 'filesystem',
    toolName: 'write_file',
    arguments: { path: '/outside/f.txt' },
    reason: 'Writes outside the workspace require approval.',
    whitelistCandidates: [{ description: 'Allow writes within /outside' }],
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await tick();
}

const approveButtons = (): HTMLElement[] => screen.getAllByTestId('workflow-escalation-approve');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkflowEscalationPanel', () => {
  it('keeps an unavailable complete review deny-only even after arming', async () => {
    const onresolve = vi.fn();
    const escalation = makeEscalation({ reviewUnavailable: true, arguments: {}, whitelistCandidates: [] });
    render(WorkflowEscalationPanel, { props: { escalations: [escalation], onresolve } });
    await elapse(ESCALATION_ARM_DELAY_MS);
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await fireEvent.click(approve);
    expect(onresolve).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onresolve).toHaveBeenCalledWith(escalation, 'denied');
  });

  it('shows the blocked call: tool, state, persona, reason and arguments', () => {
    render(WorkflowEscalationPanel, { props: { escalations: [makeEscalation()], onresolve: vi.fn() } });

    expect(screen.getByText('Tool call awaiting approval')).toBeTruthy();
    const panel = screen.getByTestId('workflow-escalation');
    expect(panel.textContent).toContain('filesystem');
    expect(panel.textContent).toContain('write_file');
    expect(panel.textContent).toContain('implement');
    expect(panel.textContent).toContain('coder');
    expect(screen.getByText('Writes outside the workspace require approval.')).toBeTruthy();
    expect(panel.textContent).toContain('/outside/f.txt');
  });

  it('approves without a whitelist by default, and with the selected candidate', async () => {
    const onresolve = vi.fn();
    const escalation = makeEscalation();
    render(WorkflowEscalationPanel, { props: { escalations: [escalation], onresolve } });
    await elapse(ESCALATION_ARM_DELAY_MS);

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onresolve).toHaveBeenLastCalledWith(escalation, 'approved', undefined);

    await fireEvent.click(screen.getByRole('button', { name: 'Allow writes within /outside' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onresolve).toHaveBeenLastCalledWith(escalation, 'approved', 0);
  });

  it('denies, and disables the buttons while that escalation resolves', async () => {
    const onresolve = vi.fn();
    const escalation = makeEscalation();
    const { rerender } = render(WorkflowEscalationPanel, { props: { escalations: [escalation], onresolve } });
    await elapse(ESCALATION_ARM_DELAY_MS);

    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onresolve).toHaveBeenCalledWith(escalation, 'denied');

    await rerender({ escalations: [escalation], onresolve, busyId: 'esc-1' });
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the call text inert (no markup injection from the agent)', () => {
    render(WorkflowEscalationPanel, {
      props: {
        escalations: [makeEscalation({ reason: '<img src=x onerror=alert(1)>', arguments: { path: '<b>x</b>' } })],
        onresolve: vi.fn(),
      },
    });
    const panel = screen.getByTestId('workflow-escalation');
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.querySelector('b')).toBeNull();
    expect(panel.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('WorkflowEscalationPanel: arming (same rule as the Escalations page)', () => {
  it('ignores Approve, Deny and whitelist clicks on a card that has just appeared', async () => {
    const onresolve = vi.fn();
    render(WorkflowEscalationPanel, { props: { escalations: [makeEscalation()], onresolve } });
    await tick();

    const candidate = screen.getByTestId('workflow-whitelist-candidate');
    for (const control of [approveButtons()[0], screen.getByTestId('workflow-escalation-deny'), candidate]) {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      await fireEvent.click(control);
    }
    await elapse(ESCALATION_ARM_DELAY_MS - 1);
    await fireEvent.click(approveButtons()[0]);
    expect(onresolve).not.toHaveBeenCalled();
    expect(candidate.getAttribute('aria-pressed')).toBe('false');

    await elapse(1);
    expect(approveButtons()[0].hasAttribute('aria-disabled')).toBe(false);
    await fireEvent.click(approveButtons()[0]);
    expect(onresolve).toHaveBeenCalledTimes(1);
  });

  it('does not let the second click of a double click decide the card that moved up', async () => {
    const onresolve = vi.fn();
    const first = makeEscalation({ escalationId: 'esc-1' });
    const second = makeEscalation({ escalationId: 'esc-2', arguments: { path: '/outside/other.txt' } });
    const { rerender } = render(WorkflowEscalationPanel, { props: { escalations: [first, second], onresolve } });
    await elapse(ESCALATION_ARM_DELAY_MS);

    await fireEvent.click(approveButtons()[0]);
    expect(onresolve).toHaveBeenLastCalledWith(first, 'approved', undefined);

    // The approved call leaves the list; the next one moves into its place.
    await rerender({ escalations: [second], onresolve });
    await fireEvent.click(approveButtons()[0]);
    expect(onresolve).toHaveBeenCalledTimes(1);

    await elapse(ESCALATION_ARM_DELAY_MS);
    await fireEvent.click(approveButtons()[0]);
    expect(onresolve).toHaveBeenLastCalledWith(second, 'approved', undefined);
  });
});

describe('WorkflowEscalationPanel: agent-influenced text', () => {
  it('shows invisible and direction-changing characters as escapes, and warns', () => {
    render(WorkflowEscalationPanel, {
      props: {
        escalations: [
          makeEscalation({
            toolName: 'write\u2066_file',
            reason: 'Looks \u202eharmless',
            arguments: { path: '/outside/\u202ehs.pukcab\u202c', note: 'a\u200bb' },
            whitelistCandidates: [{ description: 'Allow \u061c everything' }],
          }),
        ],
        onresolve: vi.fn(),
      },
    });

    const text = screen.getByTestId('workflow-escalation').textContent ?? '';
    for (const escape of ['\\u2066', '\\u202e', '\\u202c', '\\u200b', '\\u061c']) {
      expect(text).toContain(escape);
    }
    for (const raw of ['\u2066', '\u202e', '\u202c', '\u200b', '\u061c']) {
      expect(text).not.toContain(raw);
    }
    const args = screen.getByTestId('workflow-escalation-arguments');
    expect(args.classList.contains('bidi-safe')).toBe(true);
    expect(args.querySelectorAll('[data-invisible-char]').length).toBeGreaterThan(0);
    expect(screen.getByTestId('invisible-char-warning')).toBeTruthy();
  });

  it('shows no warning for an ordinary escalation', () => {
    render(WorkflowEscalationPanel, { props: { escalations: [makeEscalation()], onresolve: vi.fn() } });
    expect(screen.queryByTestId('invisible-char-warning')).toBeNull();
    expect(screen.queryByTestId('human-only-note')).toBeNull();
  });
});

describe('WorkflowEscalationPanel: human-only escalations', () => {
  it('says the call is approved once, offers no whitelist and sends no selection', async () => {
    const onresolve = vi.fn();
    // The pipeline offers no candidate for a human-only call; even if one
    // arrived, the panel must not offer it.
    const escalation = makeEscalation({
      serverName: 'proxy',
      toolName: 'add_proxy_domain',
      arguments: { domain: 'example.com' },
      humanOnly: true,
    });
    render(WorkflowEscalationPanel, { props: { escalations: [escalation], onresolve } });
    await elapse(ESCALATION_ARM_DELAY_MS);

    expect(screen.getByTestId('human-only-note').textContent).toContain('approved once');
    expect(screen.queryByTestId('workflow-whitelist-candidate')).toBeNull();

    await fireEvent.click(approveButtons()[0]);
    expect(onresolve).toHaveBeenCalledWith(escalation, 'approved', undefined);
  });
});
