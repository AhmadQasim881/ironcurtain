/**
 * The reviewer context on an escalation card: the task and the human's last
 * message are shown as the human's own text; the agent's justification is
 * set apart, labelled as written by the agent, and rendered through
 * SafeText like every other agent-influenced string.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import EscalationCard from './escalation-card.svelte';
import WorkflowEscalationPanel from './workflow-escalation-panel.svelte';
import type { EscalationDto, WorkflowEscalationDto } from '$lib/types.js';

function escalation(overrides: Partial<EscalationDto> = {}): EscalationDto {
  return {
    escalationId: 'e1',
    sessionLabel: 3,
    sessionSource: { kind: 'web' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: '/home/u/project/notes.md' },
    reason: 'Write outside the sandbox',
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('escalation reviewer context', () => {
  it('shows the task and the last message as trusted, and the justification apart as untrusted', () => {
    render(EscalationCard, {
      props: {
        escalation: escalation({
          taskSummary: 'Refactor the parser',
          lastTrustedUserMessage: { text: 'also fix the notes file', sentAt: '2026-01-01T00:00:00.000Z' },
          agentJustification: 'The notes need the new API names.',
        }),
        onapprove: vi.fn(),
        ondeny: vi.fn(),
      },
    });

    expect(screen.getByTestId('escalation-task-summary').textContent).toContain('Refactor the parser');
    expect(screen.getByTestId('escalation-user-message').textContent).toContain('also fix the notes file');
    const trusted = screen.getByTestId('escalation-trusted-context');
    expect(trusted.textContent).toContain('Your last message');
    expect(trusted.textContent).not.toContain('new API names');

    const justification = screen.getByTestId('escalation-agent-justification');
    expect(justification.textContent).toContain('untrusted, written by the agent');
    expect(justification.textContent).toContain('The notes need the new API names.');
  });

  it('renders invisible and direction-changing characters in the justification as escapes', () => {
    render(EscalationCard, {
      props: {
        escalation: escalation({ agentJustification: 'Looks \u202eharmless\u202c to me\u200b' }),
        onapprove: vi.fn(),
        ondeny: vi.fn(),
      },
    });
    const justification = screen.getByTestId('escalation-agent-justification');
    expect(justification.textContent).toContain('\\u202e');
    expect(justification.textContent).not.toContain('\u202e');
    expect(justification.querySelectorAll('[data-invisible-char]').length).toBe(3);
    // The card-level warning counts the justification as agent text.
    expect(screen.getByTestId('invisible-char-warning')).toBeTruthy();
  });

  it('shows the task once when it is the last message too, and nothing without context', () => {
    const { unmount } = render(EscalationCard, {
      props: {
        escalation: escalation({ taskSummary: 'push it', lastTrustedUserMessage: { text: 'push it' } }),
        onapprove: vi.fn(),
        ondeny: vi.fn(),
      },
    });
    // A one-shot or cron session's only message is its task: shown once, as the task.
    expect(screen.getByTestId('escalation-task-summary').textContent).toContain('push it');
    expect(screen.queryByTestId('escalation-user-message')).toBeNull();
    unmount();

    render(EscalationCard, { props: { escalation: escalation(), onapprove: vi.fn(), ondeny: vi.fn() } });
    expect(screen.queryByTestId('escalation-trusted-context')).toBeNull();
    expect(screen.queryByTestId('escalation-agent-justification')).toBeNull();
  });

  it('the workflow escalation panel shows the workflow task and the justification', () => {
    const workflowEscalation: WorkflowEscalationDto = {
      escalationId: 'w1',
      workflowId: 'wf',
      stateId: 'implement',
      serverName: 'git',
      toolName: 'git_push',
      arguments: {},
      reason: 'Push requires approval',
      taskSummary: 'Ship the release notes',
      agentJustification: 'The review state passed.',
      receivedAt: '2026-01-01T00:00:00.000Z',
    };
    render(WorkflowEscalationPanel, { props: { escalations: [workflowEscalation], onresolve: vi.fn() } });
    expect(screen.getByTestId('escalation-task-summary').textContent).toContain('Ship the release notes');
    expect(screen.getByTestId('escalation-agent-justification').textContent).toContain('The review state passed.');
  });
});
