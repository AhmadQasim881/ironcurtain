import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTRY_METADATA_LIMITS,
  RegistryMetadataBudget,
  RegistryMetadataBudgetError,
  resolveRegistryMetadataLimits,
  type RegistryMetadataPermit,
} from '../../src/docker/registry-metadata-budget.js';

const MIB = 1024 * 1024;

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

/** Tracks whether a promise has settled, without awaiting it. */
function track<T>(promise: Promise<T>): { readonly done: () => boolean; readonly promise: Promise<T> } {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { done: () => done, promise };
}

async function budgetError(promise: Promise<unknown>): Promise<RegistryMetadataBudgetError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RegistryMetadataBudgetError) return error;
    throw error;
  }
  throw new Error('expected a RegistryMetadataBudgetError');
}

describe('RegistryMetadataBudget', () => {
  it('has production bounds above the largest real packument', () => {
    expect(DEFAULT_REGISTRY_METADATA_LIMITS.maxResponseBytes).toBeGreaterThanOrEqual(128 * MIB);
    expect(DEFAULT_REGISTRY_METADATA_LIMITS.maxBufferedBytes).toBeGreaterThanOrEqual(
      DEFAULT_REGISTRY_METADATA_LIMITS.maxResponseBytes,
    );
  });

  it('rejects limits that are not positive integers, or a response ceiling above the buffer', () => {
    expect(() => resolveRegistryMetadataLimits({ maxConcurrentOperations: 0 })).toThrow('positive integer');
    expect(() => resolveRegistryMetadataLimits({ operationTimeoutMs: 1.5 })).toThrow('positive integer');
    expect(() => resolveRegistryMetadataLimits({ maxResponseBytes: 2 * MIB, maxBufferedBytes: MIB })).toThrow(
      'maxResponseBytes',
    );
  });

  it('queues operations beyond its concurrency in FIFO order instead of refusing them', async () => {
    const budget = new RegistryMetadataBudget({ maxConcurrentOperations: 2 });
    const signal = new AbortController().signal;
    const first = await budget.acquire(signal);
    const second = await budget.acquire(signal);
    const order: string[] = [];
    const third = budget.acquire(signal).then((permit) => {
      order.push('third');
      return permit;
    });
    const fourth = budget.acquire(signal).then((permit) => {
      order.push('fourth');
      return permit;
    });
    await settle();
    expect(budget.snapshot).toMatchObject({ activeOperations: 2, queuedOperations: 2 });

    second.release();
    second.release(); // idempotent
    await settle();
    expect(order).toEqual(['third']);
    first.release();
    await settle();
    expect(order).toEqual(['third', 'fourth']);
    (await third).release();
    (await fourth).release();
    expect(budget.snapshot).toMatchObject({ activeOperations: 0, queuedOperations: 0, peakActiveOperations: 2 });
  });

  it('refuses an operation when its queue is full', async () => {
    const budget = new RegistryMetadataBudget({ maxConcurrentOperations: 1, maxQueuedOperations: 1 });
    const signal = new AbortController().signal;
    const held = await budget.acquire(signal);
    const queued = budget.acquire(signal);
    expect((await budgetError(budget.acquire(signal))).code).toBe('queue-full');
    held.release();
    (await queued).release();
  });

  it('removes an aborted waiter from the queue', async () => {
    const budget = new RegistryMetadataBudget({ maxConcurrentOperations: 1 });
    const held = await budget.acquire(new AbortController().signal);
    const controller = new AbortController();
    const waiting = budget.acquire(controller.signal);
    controller.abort();
    expect((await budgetError(waiting)).code).toBe('aborted');
    expect(budget.snapshot.queuedOperations).toBe(0);
    expect((await budgetError(budget.acquire(controller.signal))).code).toBe('aborted');
    held.release();
    expect(budget.snapshot.activeOperations).toBe(0);
  });

  it('grants buffer reservations in FIFO order and never past its byte bound', async () => {
    const budget = new RegistryMetadataBudget({ maxBufferedBytes: 100, maxResponseBytes: 100 });
    const signal = new AbortController().signal;
    const permits: RegistryMetadataPermit[] = [];
    for (let index = 0; index < 4; index += 1) permits.push(await budget.acquire(signal));

    await permits[0].reserve(60, signal);
    const large = track(permits[1].reserve(70, signal));
    // Head-of-line: a small request behind the large one waits too.
    const small = track(permits[2].reserve(10, signal));
    await settle();
    expect([large.done(), small.done()]).toEqual([false, false]);
    expect(budget.snapshot).toMatchObject({ bufferedBytes: 60, waitingForBytes: 2 });

    permits[0].shrink(20);
    await settle();
    expect([large.done(), small.done()]).toEqual([true, true]);
    expect(budget.snapshot.bufferedBytes).toBe(100);

    await expect(permits[3].reserve(101, signal)).rejects.toThrow('buffer bound');
    await expect(permits[0].reserve(1, signal)).rejects.toThrow('once');
    for (const permit of permits) permit.release();
    expect(budget.snapshot).toMatchObject({ bufferedBytes: 0, activeOperations: 0, peakBufferedBytes: 100 });
  });

  it('ends a reservation wait on abort or release, and lets the next waiter through', async () => {
    const budget = new RegistryMetadataBudget({ maxBufferedBytes: 100, maxResponseBytes: 100 });
    const signal = new AbortController().signal;
    const holder = await budget.acquire(signal);
    const aborted = await budget.acquire(signal);
    const released = await budget.acquire(signal);
    const last = await budget.acquire(signal);
    await holder.reserve(90, signal);

    const controller = new AbortController();
    const abortedWait = aborted.reserve(50, controller.signal);
    const releasedWait = released.reserve(50, signal);
    const lastWait = track(last.reserve(10, signal));
    controller.abort();
    expect((await budgetError(abortedWait)).code).toBe('aborted');
    released.release();
    expect((await budgetError(releasedWait)).code).toBe('aborted');
    await settle();
    expect(lastWait.done()).toBe(true);
    expect(budget.snapshot).toMatchObject({ bufferedBytes: 100, waitingForBytes: 0 });

    for (const permit of [holder, aborted, last]) permit.release();
    expect(budget.snapshot).toMatchObject({ bufferedBytes: 0, activeOperations: 0 });
  });
});
