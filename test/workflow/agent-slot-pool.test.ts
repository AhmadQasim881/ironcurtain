import { describe, it, expect, vi } from 'vitest';
import {
  AGENT_SLOT_REQUEST_TOO_LARGE,
  AgentSlotPool,
  AgentSlotRequestError,
  type AgentSlotLease,
} from '../../src/workflow/agent-slot-pool.js';

/** Resolves after pending promise callbacks have run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Tracks whether a promise has resolved yet. */
function track<T>(promise: Promise<T>): { readonly done: () => boolean; readonly value: Promise<T> } {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { done: () => done, value: promise };
}

describe('AgentSlotPool', () => {
  it('grants requests at once while slots are free', async () => {
    const pool = new AgentSlotPool(3);
    const a = await pool.acquire();
    const b = await pool.acquire(2);
    expect(pool.inUse).toBe(3);
    expect(a.slots).toBe(1);
    expect(b.slots).toBe(2);
    a.release();
    b.release();
    expect(pool.inUse).toBe(0);
  });

  it('a fifth acquire waits when the capacity is 4, and runs once a slot is free', async () => {
    const pool = new AgentSlotPool(4);
    const leases = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]);
    const onWait = vi.fn();
    const fifth = track(pool.acquire(1, { onWait }));
    await settle();
    expect(fifth.done()).toBe(false);
    expect(pool.waiting).toBe(1);
    expect(onWait).toHaveBeenCalledWith({ inUse: 4, capacity: 4, waiting: 1 });

    leases[2].release();
    const lease = await fifth.value;
    expect(lease.slots).toBe(1);
    expect(pool.inUse).toBe(4);
    expect(pool.waiting).toBe(0);
  });

  it('keeps a request queued, and the pool whole, when its onWait report throws', async () => {
    const pool = new AgentSlotPool(1);
    const held = await pool.acquire();
    const waiting = track(
      pool.acquire(1, {
        onWait: () => {
          throw new Error('tab closed');
        },
      }),
    );
    await settle();
    // The report failed, but the request still waits for its slot.
    expect(waiting.done()).toBe(false);
    expect(pool.waiting).toBe(1);

    held.release();
    const lease = await waiting.value;
    expect(pool.inUse).toBe(1);
    lease.release();
    // Nothing leaked: the whole pool is free again.
    expect(pool.inUse).toBe(0);
    (await pool.acquire()).release();
  });

  it('does not call onWait for a request granted at once', async () => {
    const pool = new AgentSlotPool(1);
    const onWait = vi.fn();
    (await pool.acquire(1, { onWait })).release();
    expect(onWait).not.toHaveBeenCalled();
  });

  it('serves waiters in order and lets no later request overtake a larger one at the head', async () => {
    const pool = new AgentSlotPool(3);
    const held = await pool.acquire(2);
    const order: string[] = [];
    const big = pool.acquire(3).then((lease) => {
      order.push('big');
      return lease;
    });
    // One slot is free, but the earlier 3-slot request is still waiting.
    const small = pool.acquire(1).then((lease) => {
      order.push('small');
      return lease;
    });
    await settle();
    expect(order).toEqual([]);

    held.release();
    const bigLease = await big;
    await settle();
    expect(order).toEqual(['big']);
    bigLease.release();
    (await small).release();
    expect(order).toEqual(['big', 'small']);
    expect(pool.inUse).toBe(0);
  });

  it('removes a waiting request whose signal aborts and serves the ones behind it', async () => {
    const pool = new AgentSlotPool(2);
    const held = await pool.acquire(1);
    const controller = new AbortController();
    const blocked = pool.acquire(2, { signal: controller.signal });
    const behind = track(pool.acquire(1));
    await settle();
    expect(pool.waiting).toBe(2);

    const reason = new Error('workflow aborted');
    controller.abort(reason);
    await expect(blocked).rejects.toBe(reason);
    // The aborted head no longer blocks the 1-slot request behind it.
    const lease: AgentSlotLease = await behind.value;
    expect(pool.waiting).toBe(0);
    expect(pool.inUse).toBe(2);
    lease.release();
    held.release();
    expect(pool.inUse).toBe(0);
  });

  it('rejects at once when the signal has already aborted', async () => {
    const pool = new AgentSlotPool(1);
    await expect(pool.acquire(1, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    expect(pool.inUse).toBe(0);
    expect(pool.waiting).toBe(0);
  });

  it('refuses at once a request larger than the whole pool', async () => {
    const pool = new AgentSlotPool(2);
    const refusal = await pool.acquire(3).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(AgentSlotRequestError);
    expect(refusal).toMatchObject({ code: AGENT_SLOT_REQUEST_TOO_LARGE, requested: 3, capacity: 2 });
    expect(String(refusal)).toContain('maxConcurrentAgentSessions');
    expect(pool.waiting).toBe(0);
  });

  it('releases a lease only once', async () => {
    const pool = new AgentSlotPool(2);
    const a = await pool.acquire();
    const b = await pool.acquire();
    a.release();
    a.release();
    expect(pool.inUse).toBe(1);
    b.release();
    expect(pool.inUse).toBe(0);
  });

  it('rejects invalid capacities and request sizes', async () => {
    expect(() => new AgentSlotPool(0)).toThrow();
    expect(() => new AgentSlotPool(1.5)).toThrow();
    const pool = new AgentSlotPool(2);
    await expect(pool.acquire(0)).rejects.toThrow();
    await expect(pool.acquire(1.5)).rejects.toThrow();
  });
});
