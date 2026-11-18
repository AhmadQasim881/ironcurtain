/**
 * The terminal prompt for a workflow tool-call escalation
 * (`promptEscalationInteractive` in src/workflow/cli-support.ts).
 *
 * A human-only escalation (`EvaluationResult.humanOnly`, e.g. opening a
 * passthrough domain) is decided by a human one call at a time and never
 * whitelisted: the prompt says so and offers no whitelist choice, and a
 * number typed anyway is refused instead of turning into a selection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { createInterface } from 'node:readline/promises';
import { promptEscalationInteractive } from '../../src/workflow/cli-support.js';
import type { WorkflowToolCallEscalation } from '../../src/workflow/types.js';

type Readline = ReturnType<typeof createInterface>;

/** A readline stand-in that answers each question with the next scripted answer. */
function scriptedReadline(answers: string[]): { readonly rl: Readline; readonly questions: string[] } {
  const questions: string[] = [];
  const rl = {
    question: (query: string): Promise<string> => {
      questions.push(query);
      const answer = answers.shift();
      return answer === undefined ? Promise.reject(new Error('no scripted answer left')) : Promise.resolve(answer);
    },
  } as unknown as Readline;
  return { rl, questions };
}

function escalation(overrides: Partial<WorkflowToolCallEscalation> = {}): WorkflowToolCallEscalation {
  return {
    escalationId: 'esc-1',
    workflowId: 'wf-1',
    stateId: 'work',
    persona: 'global',
    serverName: 'filesystem',
    toolName: 'write_file',
    arguments: { path: '/outside/f.txt' },
    reason: 'Writes outside the workspace require approval.',
    whitelistCandidates: [{ description: 'Allow writes within /outside' }],
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('promptEscalationInteractive', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers the whitelist candidates of an ordinary escalation', async () => {
    const { rl, questions } = scriptedReadline(['1']);

    const decision = await promptEscalationInteractive(escalation(), rl);

    expect(decision).toEqual({ decision: 'approved', whitelistSelection: 0 });
    expect(questions[0]).toContain('1-1 to approve and whitelist');
    expect(output.join('')).toContain('Allow writes within /outside');
  });

  it('marks a human-only escalation and never offers or accepts a whitelist choice', async () => {
    const { rl, questions } = scriptedReadline(['1', 'y']);

    const decision = await promptEscalationInteractive(
      escalation({
        serverName: 'proxy',
        toolName: 'add_proxy_domain',
        arguments: { domain: 'example.com' },
        humanOnly: true,
      }),
      rl,
    );

    expect(decision).toEqual({ decision: 'approved' });
    const text = output.join('');
    expect(text).toContain('Human decision required: approved once, never whitelisted.');
    expect(text).not.toContain('Allow writes within /outside');
    expect(text).toContain('Invalid choice.');
    for (const question of questions) expect(question).not.toContain('whitelist');
  });
});
