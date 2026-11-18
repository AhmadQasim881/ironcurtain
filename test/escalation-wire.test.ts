import { describe, expect, it } from 'vitest';
import {
  assertEscalationReviewable,
  escalationForWire,
  fitsEscalationReview,
  MAX_ESCALATION_REVIEW_BYTES,
} from '../src/web-ui/escalation-wire.js';
import type { EscalationDto, WorkflowEscalationDto } from '../src/web-ui/web-ui-types.js';

function record(): EscalationDto {
  return {
    escalationId: 'example-review',
    sessionLabel: 1,
    sessionSource: { kind: 'web' },
    serverName: 'filesystem',
    toolName: 'write_file',
    arguments: { path: '/workspace/example.txt', content: 'Example.' },
    reason: 'Review this example.',
    receivedAt: '2026-11-16T00:00:00.000Z',
    whitelistCandidates: [{ description: 'Example candidate' }],
    groupKey: 'example-group',
  };
}

describe('complete browser review projection', () => {
  it('preserves a small complete record unchanged', () => {
    const original = record();
    expect(escalationForWire(original, 2048)).toBe(original);
    expect(fitsEscalationReview(original, 2048)).toBe(true);
  });

  it('projects a record over a small budget to an explicit deny-only summary without changing the original', () => {
    const original = record();
    original.arguments.content = 'Example prose. '.repeat(160);
    const shown = escalationForWire(original, 2048);
    expect(shown).toMatchObject({
      escalationId: original.escalationId,
      reviewUnavailable: true,
      arguments: {},
      humanOnly: true,
    });
    expect(shown.groupKey).toBeUndefined();
    expect(shown.whitelistCandidates).toBeUndefined();
    expect(() => assertEscalationReviewable(shown)).toThrow('can only be denied');
    expect(Buffer.byteLength(JSON.stringify(shown))).toBeLessThan(2048);
    expect(original.arguments.content).toBe('Example prose. '.repeat(160));
  });

  it('uses the same projection for workflow details and nested event records', () => {
    const original: WorkflowEscalationDto = {
      escalationId: 'example-workflow-review',
      workflowId: 'wf-example',
      stateId: 'review',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { content: 'Example. '.repeat(300) },
      reason: 'Review this example.',
      receivedAt: '2026-11-16T00:00:00.000Z',
    };
    const shown = escalationForWire(original, 2048);
    expect(shown).toMatchObject({ workflowId: 'wf-example', stateId: 'review', reviewUnavailable: true });
    expect(Buffer.byteLength(JSON.stringify({ workflowId: 'wf-example', escalation: shown }))).toBeLessThan(2048);
  });

  it('rejects an oversized original for approval while its complete view remains intact', () => {
    const original = record();
    original.arguments.content = 'x'.repeat(MAX_ESCALATION_REVIEW_BYTES + 1);
    expect(() => assertEscalationReviewable(original)).toThrow('can only be denied');
    expect(() => assertEscalationReviewable(record())).not.toThrow();
  });

  it('stops at bounded depth and refuses cycles and missing records', () => {
    const nested: Record<string, unknown> = {};
    nested.self = nested;
    expect(fitsEscalationReview(nested, 2048)).toBe(false);
    expect(fitsEscalationReview(undefined, 2048)).toBe(false);
    let depth: Record<string, unknown> = {};
    for (let i = 0; i < 18; i++) depth = { example: depth };
    expect(fitsEscalationReview(depth, 2048)).toBe(false);
  });
});
