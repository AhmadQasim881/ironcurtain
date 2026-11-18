/**
 * Admission control for Code Mode chains (WP-55, SES-4): the weighted FIFO
 * semaphore behind the per-sandbox and process-wide limits.
 */

import { describe, expect, it } from 'vitest';
import {
  ChainAdmissionError,
  DEFAULT_CHAIN_MEMORY_LIMIT_MB,
  ISOLATE_MEMORY_OVERSHOOT_FACTOR,
  PROCESS_CHAIN_MEMORY_BUDGET_MB,
  WeightedSemaphore,
  chainMemoryWeightMb,
  isChainAdmissionError,
  processChainBudget,
} from '../src/sandbox/chain-limits.js';

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('WeightedSemaphore', () => {
  it('grants free units at once and queues the rest in FIFO order', async () => {
    const semaphore = new WeightedSemaphore(2);
    const first = await semaphore.acquire(1);
    const second = await semaphore.acquire(1);
    const order: string[] = [];
    const third = semaphore.acquire(1).then((release) => {
      order.push('third');
      return release;
    });
    const fourth = semaphore.acquire(1).then((release) => {
      order.push('fourth');
      return release;
    });
    expect(semaphore.used).toBe(2);
    expect(semaphore.queued).toBe(2);

    first();
    (await third)();
    second();
    (await fourth)();
    expect(order).toEqual(['third', 'fourth']);
    expect(semaphore.used).toBe(0);
    expect(semaphore.queued).toBe(0);
  });

  it('serves a heavy waiter at the head before lighter ones behind it', async () => {
    const semaphore = new WeightedSemaphore(4);
    const holder = await semaphore.acquire(3);
    const order: string[] = [];
    const heavy = semaphore.acquire(4).then((release) => {
      order.push('heavy');
      return release;
    });
    const light = semaphore.acquire(1).then((release) => {
      order.push('light');
      return release;
    });
    // One unit is free, but the heavy head waiter blocks the light one.
    await Promise.resolve();
    expect(order).toEqual([]);
    holder();
    (await heavy)();
    (await light)();
    expect(order).toEqual(['heavy', 'light']);
  });

  it('clamps a request heavier than the capacity so it runs alone', async () => {
    const semaphore = new WeightedSemaphore(10);
    const release = await semaphore.acquire(1_000);
    expect(semaphore.used).toBe(10);
    release();
    expect(semaphore.used).toBe(0);
  });

  it('releases idempotently', async () => {
    const semaphore = new WeightedSemaphore(1);
    const release = await semaphore.acquire(1);
    release();
    release();
    expect(semaphore.used).toBe(0);
  });

  it('refuses at once when the queue is full', async () => {
    const semaphore = new WeightedSemaphore(1, 1);
    const holder = await semaphore.acquire(1);
    const waiting = semaphore.acquire(1);
    const refused = await rejectionOf(semaphore.acquire(1));
    expect(refused).toBeInstanceOf(ChainAdmissionError);
    expect((refused as ChainAdmissionError).code).toBe('CHAIN_QUEUE_FULL');
    holder();
    (await waiting)();
  });

  it('withdraws a waiter whose signal aborts and lets the next one through', async () => {
    const semaphore = new WeightedSemaphore(1);
    const holder = await semaphore.acquire(1);
    const controller = new AbortController();
    const cancelled = semaphore.acquire(1, { signal: controller.signal });
    const next = semaphore.acquire(1);
    controller.abort(new Error('turn ended'));
    const err = await rejectionOf(cancelled);
    expect(isChainAdmissionError(err)).toBe(true);
    expect((err as ChainAdmissionError).code).toBe('CHAIN_CANCELLED');
    expect((err as Error).message).toContain('turn ended');
    expect(semaphore.queued).toBe(1);
    holder();
    (await next)();
    expect(semaphore.used).toBe(0);
  });

  it('refuses an already-aborted request without queueing it', async () => {
    const semaphore = new WeightedSemaphore(1);
    const err = await rejectionOf(semaphore.acquire(1, { signal: AbortSignal.abort() }));
    expect((err as ChainAdmissionError).code).toBe('CHAIN_CANCELLED');
    expect(semaphore.used).toBe(0);
  });

  it('gives up at the deadline', async () => {
    const semaphore = new WeightedSemaphore(1);
    const holder = await semaphore.acquire(1);
    const started = Date.now();
    const err = await rejectionOf(semaphore.acquire(1, { deadlineMs: Date.now() + 50 }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect((err as ChainAdmissionError).code).toBe('CHAIN_QUEUE_TIMEOUT');
    expect(semaphore.queued).toBe(0);
    holder();
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new WeightedSemaphore(0)).toThrow(/capacity/);
  });
});

describe('process-wide chain budget', () => {
  it('weighs a chain by its memory limit times the overshoot factor', () => {
    expect(chainMemoryWeightMb(128)).toBe(128 * ISOLATE_MEMORY_OVERSHOOT_FACTOR);
  });

  it('admits six default-size chains at once', async () => {
    const weight = chainMemoryWeightMb(DEFAULT_CHAIN_MEMORY_LIMIT_MB);
    expect(PROCESS_CHAIN_MEMORY_BUDGET_MB / weight).toBe(6);
    const releases = [];
    for (let i = 0; i < 6; i++) releases.push(await processChainBudget.acquire(weight));
    const seventh = processChainBudget.acquire(weight);
    expect(processChainBudget.queued).toBe(1);
    releases[0]();
    const release7 = await seventh;
    for (const release of releases.slice(1)) release();
    release7();
    expect(processChainBudget.used).toBe(0);
  });
});
