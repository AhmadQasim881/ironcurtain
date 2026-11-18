/**
 * The interactive CLI gate prompt is withdrawn once its raise stops
 * waiting: the run was stopped (a gate idle release, an abort) or the gate
 * was decided elsewhere. The operator is never left answering a gate that
 * is gone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { createInterface } from 'node:readline/promises';
import { promptGateInteractive, runEventLoop } from '../../src/workflow/cli-support.js';
import type { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import type { HumanGateRequest, WorkflowId, WorkflowStatus } from '../../src/workflow/types.js';

const gate: HumanGateRequest = {
  gateId: 'wf-1-review-1-abc',
  workflowId: 'wf-1',
  stateName: 'review',
  acceptedEvents: ['APPROVE', 'ABORT'],
  presentedArtifacts: new Map(),
  summary: 'Waiting for human review at review',
};

/** A readline whose question only settles when its signal aborts (an operator who never answers). */
function silentReadline(): { rl: ReturnType<typeof createInterface>; question: ReturnType<typeof vi.fn> } {
  const question = vi.fn(
    (_query: string, options?: { signal?: AbortSignal }) =>
      new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')), {
          once: true,
        });
      }),
  );
  return { rl: { question } as unknown as ReturnType<typeof createInterface>, question };
}

let writes: string[];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  writes = [];
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
});

describe('interactive gate prompt withdrawal', () => {
  it('returns no decision when its signal aborts', async () => {
    const { rl } = silentReadline();
    const controller = new AbortController();
    const pending = promptGateInteractive(gate, rl, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it('leaves the event loop without deciding once the run stopped at the gate', async () => {
    const { rl, question } = silentReadline();
    let status: WorkflowStatus = { phase: 'waiting_human', gate };
    const orchestrator = {
      getStatus: vi.fn(() => status),
      resolveGate: vi.fn(),
      listToolCallEscalations: vi.fn(() => []),
    } as unknown as WorkflowOrchestrator;

    const loop = runEventLoop(orchestrator, 'wf-1' as WorkflowId, rl);
    await vi.waitFor(() => expect(question).toHaveBeenCalled(), { timeout: 2000, interval: 5 });
    // The gate idle timeout released the run while the prompt was open.
    status = { phase: 'aborted', reason: 'Gate "review" waited 240 minutes without a decision' };
    await loop;

    expect(orchestrator.resolveGate).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('is no longer waiting for this decision');
  });
});
