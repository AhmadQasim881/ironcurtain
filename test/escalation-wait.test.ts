/**
 * Unit tests for the escalation wait primitives
 * (`src/trusted-process/escalation-wait.ts`): typed abort reasons, the
 * deadline signal that layers the configured escalation timeout over a
 * cancellation signal, the abortable sleep and handler race, and the
 * withdrawal error an in-process handler rejects with.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ESCALATION_WITHDRAWN_CODE,
  EscalationWithdrawnError,
  callerCancellationSignal,
  describeCallerCancellation,
  escalationAbortReason,
  escalationDeadlineSignal,
  isEscalationWithdrawnError,
  readEscalationAbortReason,
  settleBeforeAbort,
  sleepUnlessAborted,
} from '../src/trusted-process/escalation-wait.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('readEscalationAbortReason', () => {
  it('is undefined while the signal has not aborted', () => {
    expect(readEscalationAbortReason(new AbortController().signal)).toBeUndefined();
  });

  it('returns the typed reason the wait was aborted with', () => {
    const controller = new AbortController();
    controller.abort(escalationAbortReason('timed-out', 'no decision within the 30s escalation timeout'));
    expect(readEscalationAbortReason(controller.signal)).toEqual({
      kind: 'timed-out',
      detail: 'no decision within the 30s escalation timeout',
    });
  });

  it('reads an untyped abort as a cancellation', () => {
    const controller = new AbortController();
    controller.abort();
    expect(readEscalationAbortReason(controller.signal)).toEqual({
      kind: 'cancelled',
      detail: 'escalation wait aborted',
    });
    const odd = new AbortController();
    odd.abort({ kind: 'approved', detail: 'not a wait outcome' });
    expect(readEscalationAbortReason(odd.signal)?.kind).toBe('cancelled');
  });
});

describe('escalationDeadlineSignal', () => {
  it('aborts as timed out exactly at the configured timeout', () => {
    vi.useFakeTimers();
    const deadline = escalationDeadlineSignal(new AbortController().signal, 30_000);
    vi.advanceTimersByTime(29_999);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(readEscalationAbortReason(deadline.signal)).toEqual({
      kind: 'timed-out',
      detail: 'no decision within the 30s escalation timeout',
    });
    deadline.dispose();
  });

  it('aborts at once, with the cancellation reason, when the cancel signal fires', () => {
    vi.useFakeTimers();
    const cancel = new AbortController();
    const deadline = escalationDeadlineSignal(cancel.signal, 30_000);
    cancel.abort(escalationAbortReason('cancelled', 'coordinator shutting down'));
    expect(readEscalationAbortReason(deadline.signal)).toEqual({
      kind: 'cancelled',
      detail: 'coordinator shutting down',
    });
    deadline.dispose();
  });

  it('never fires after dispose', () => {
    vi.useFakeTimers();
    const deadline = escalationDeadlineSignal(new AbortController().signal, 1_000);
    deadline.dispose();
    vi.advanceTimersByTime(5_000);
    expect(deadline.signal.aborted).toBe(false);
  });
});

describe('sleepUnlessAborted', () => {
  it('resolves as soon as the signal aborts instead of after the full delay', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = sleepUnlessAborted(60_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('resolves immediately on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepUnlessAborted(60_000, controller.signal)).resolves.toBeUndefined();
  });
});

describe('settleBeforeAbort', () => {
  it("returns the handler's value when it settles first", async () => {
    const result = await settleBeforeAbort(Promise.resolve('approved'), new AbortController().signal);
    expect(result).toEqual({ settled: true, value: 'approved' });
  });

  it('returns settled:false when the signal wins, and swallows a late rejection', async () => {
    const controller = new AbortController();
    let rejectLate: ((err: Error) => void) | undefined;
    const pending = new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    });
    const race = settleBeforeAbort(pending, controller.signal);
    controller.abort();
    await expect(race).resolves.toEqual({ settled: false });
    // Must not surface as an unhandled rejection.
    rejectLate?.(new Error('late'));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('propagates a rejection that happens before the abort', async () => {
    await expect(
      settleBeforeAbort(Promise.reject(new Error('hook failed')), new AbortController().signal),
    ).rejects.toThrow('hook failed');
  });

  it('does not wait for the handler on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(settleBeforeAbort(new Promise(() => {}), controller.signal)).resolves.toEqual({ settled: false });
  });
});

describe('EscalationWithdrawnError', () => {
  it('is recognized by its code, also across module copies', () => {
    const err = new EscalationWithdrawnError('the agent turn that raised it has ended');
    expect(err.code).toBe(ESCALATION_WITHDRAWN_CODE);
    expect(err.message).toBe('the agent turn that raised it has ended');
    expect(isEscalationWithdrawnError(err)).toBe(true);
    // Another copy of the class (or a plain error carrying the code) matches too.
    expect(isEscalationWithdrawnError(Object.assign(new Error('x'), { code: ESCALATION_WITHDRAWN_CODE }))).toBe(true);
    expect(isEscalationWithdrawnError(new Error('Denied by human'))).toBe(false);
    expect(isEscalationWithdrawnError({ code: ESCALATION_WITHDRAWN_CODE })).toBe(false);
  });
});

describe('callerCancellationSignal', () => {
  it("aborts with a cancelled reason carrying the caller's abort reason", () => {
    const caller = new AbortController();
    const mapped = callerCancellationSignal(caller.signal);
    expect(mapped.signal.aborted).toBe(false);
    caller.abort(new Error('the execute_code script timed out after 300ms before this tool call completed'));
    expect(readEscalationAbortReason(mapped.signal)).toEqual({
      kind: 'cancelled',
      detail: 'the execute_code script timed out after 300ms before this tool call completed',
    });
    mapped.dispose();
  });

  it('is aborted from the start when the caller already cancelled', () => {
    const mapped = callerCancellationSignal(AbortSignal.abort('gone'));
    expect(readEscalationAbortReason(mapped.signal)).toEqual({ kind: 'cancelled', detail: 'gone' });
  });

  it('stops following the caller once disposed', () => {
    const caller = new AbortController();
    const mapped = callerCancellationSignal(caller.signal);
    mapped.dispose();
    caller.abort();
    expect(mapped.signal.aborted).toBe(false);
  });

  it('describes reasons without a message generically', () => {
    expect(describeCallerCancellation(undefined)).toBe('the caller cancelled the tool call');
    expect(describeCallerCancellation(new Error(''))).toBe('the caller cancelled the tool call');
    expect(describeCallerCancellation('closing')).toBe('closing');
  });
});
