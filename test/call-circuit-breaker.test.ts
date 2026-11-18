import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallCircuitBreaker } from '../src/trusted-process/call-circuit-breaker.js';

describe('CallCircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows calls below threshold', () => {
    const breaker = new CallCircuitBreaker({ threshold: 5, windowMs: 60_000 });
    for (let i = 0; i < 4; i++) {
      const result = breaker.check('read_file', { path: '/tmp/test.txt' });
      expect(result.allowed).toBe(true);
    }
  });

  it('denies at threshold', () => {
    const breaker = new CallCircuitBreaker({ threshold: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      breaker.check('read_file', { path: '/tmp/test.txt' });
    }
    const result = breaker.check('read_file', { path: '/tmp/test.txt' });
    if (result.allowed) expect.unreachable('the breaker should deny at the threshold');
    expect(result.reason).toContain('CIRCUIT BREAKER');
    expect(result.reason).toContain('read_file');
  });

  describe('lanes', () => {
    it('identical calls from 4 lanes do not trip a shared 20-per-60 s window', () => {
      // Default window: 20 identical calls per 60 s, per lane.
      const breaker = new CallCircuitBreaker({ maxLanes: 4 });
      const lanes = ['lane-0', 'lane-1', 'lane-2', 'lane-3'];
      for (let i = 0; i < 20; i++) {
        for (const lane of lanes) {
          expect(breaker.check('filesystem__read_file', { path: '/w/a.txt' }, lane).allowed).toBe(true);
        }
      }
      // 80 identical calls went through; each lane is now at its own threshold.
      for (const lane of lanes) {
        const verdict = breaker.check('filesystem__read_file', { path: '/w/a.txt' }, lane);
        expect(verdict.allowed).toBe(false);
        expect(verdict.allowed ? '' : verdict.reason).toContain('20 times');
      }
    });

    it('keeps the single-lane threshold for one lane however many lanes the breaker expects', () => {
      // The old design multiplied the threshold by the worker count, handing a
      // single runaway lane threshold x N calls.
      const breaker = new CallCircuitBreaker({ threshold: 5, maxLanes: 3, windowMs: 60_000 });
      for (let i = 0; i < 5; i++) {
        expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'runaway').allowed).toBe(true);
      }
      const result = breaker.check('read_file', { path: '/tmp/test.txt' }, 'runaway');
      expect(result.allowed).toBe(false);
      expect(result.allowed ? '' : result.reason).toContain('5 times');
      // Another lane is unaffected.
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'other').allowed).toBe(true);
    });

    it('bounds the total across lanes at threshold x maxLanes', () => {
      // A caller that gets a fresh lane per call (an agent reconnecting for
      // every call) still runs into the all-lanes window.
      const breaker = new CallCircuitBreaker({ threshold: 3, maxLanes: 2, windowMs: 60_000 });
      for (let i = 0; i < 6; i++) {
        expect(breaker.check('read_file', { path: '/tmp/test.txt' }, `lane-${i}`).allowed).toBe(true);
      }
      const verdict = breaker.check('read_file', { path: '/tmp/test.txt' }, 'lane-fresh');
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed ? '' : verdict.reason).toContain('6 times');
      expect(verdict.allowed ? '' : verdict.reason).toContain('across all agents');
      // Other calls have their own all-lanes window.
      expect(breaker.check('read_file', { path: '/tmp/other.txt' }, 'lane-fresh').allowed).toBe(true);
    });

    it('caps every lane together at the single-lane threshold with the default maxLanes', () => {
      const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 60_000 });
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'a').allowed).toBe(true);
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'b').allowed).toBe(true);
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'c').allowed).toBe(false);
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(false);
    });

    it('fails closed on a maxLanes or threshold that is not a finite number', () => {
      // NaN or Infinity would make every `>=` comparison false and switch the
      // window off; an invalid maxLanes falls back to 1, a threshold to 20.
      for (const maxLanes of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const breaker = new CallCircuitBreaker({ threshold: 2, maxLanes, windowMs: 60_000 });
        expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'a').allowed).toBe(true);
        expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'b').allowed).toBe(true);
        expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'c').allowed).toBe(false);
      }
      for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const breaker = new CallCircuitBreaker({ threshold, windowMs: 60_000 });
        for (let i = 0; i < 20; i++) {
          expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
        }
        expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(false);
      }
    });

    it('treats calls without a lane as one default lane', () => {
      const breaker = new CallCircuitBreaker({ threshold: 2, maxLanes: 4, windowMs: 60_000 });
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(false);
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'lane-1').allowed).toBe(true);
    });

    it('lets a lane call again once its window has passed', () => {
      const breaker = new CallCircuitBreaker({ threshold: 2, maxLanes: 2, windowMs: 10_000 });
      breaker.check('read_file', { path: '/tmp/test.txt' }, 'a');
      breaker.check('read_file', { path: '/tmp/test.txt' }, 'a');
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'a').allowed).toBe(false);
      vi.advanceTimersByTime(11_000);
      expect(breaker.check('read_file', { path: '/tmp/test.txt' }, 'a').allowed).toBe(true);
    });

    it('forgets the windows of lanes that have gone quiet', () => {
      const breaker = new CallCircuitBreaker({ threshold: 5, maxLanes: 4, windowMs: 10_000 });
      for (let i = 0; i < 50; i++) {
        breaker.check('read_file', { path: `/tmp/${i}.txt` }, `connection-${i}`);
      }
      expect(breaker.getTrackedWindowCount()).toBe(100);
      // A window period later, the next check sweeps every window whose
      // newest call has left it; only the new call's windows remain.
      vi.advanceTimersByTime(11_000);
      breaker.check('read_file', { path: '/tmp/new.txt' }, 'connection-new');
      expect(breaker.getTrackedWindowCount()).toBe(2);
    });
  });

  it('tracks independent windows per tool+args combination', () => {
    const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 60_000 });

    // Fill up read_file with path A
    for (let i = 0; i < 3; i++) {
      breaker.check('read_file', { path: '/tmp/a.txt' });
    }
    // read_file + path A is now at threshold
    expect(breaker.check('read_file', { path: '/tmp/a.txt' }).allowed).toBe(false);

    // read_file + path B should still be allowed
    expect(breaker.check('read_file', { path: '/tmp/b.txt' }).allowed).toBe(true);

    // write_file + path A should still be allowed
    expect(breaker.check('write_file', { path: '/tmp/a.txt' }).allowed).toBe(true);
  });

  it('isolates buckets across servers when callers use server-qualified keys', () => {
    // Companion check to the pipeline-level fix that switched the
    // circuit-breaker key from `toolName` to `${server}__${toolName}`.
    // Two servers exposing the same bare tool name must not share a
    // rate-limit bucket.
    const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 60_000 });

    // Fill filesystem__read_file up to the threshold.
    for (let i = 0; i < 3; i++) {
      breaker.check('filesystem__read_file', { path: '/tmp/a.txt' });
    }
    expect(breaker.check('filesystem__read_file', { path: '/tmp/a.txt' }).allowed).toBe(false);

    // Same bare tool name on a different server -- own bucket, still allowed.
    expect(breaker.check('other-server__read_file', { path: '/tmp/a.txt' }).allowed).toBe(true);
  });

  it('sliding window expiry allows calls after window passes', () => {
    const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 10_000 });

    // Make 3 calls
    for (let i = 0; i < 3; i++) {
      breaker.check('read_file', { path: '/tmp/test.txt' });
    }
    // At threshold — denied
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(false);

    // Advance past window
    vi.advanceTimersByTime(11_000);

    // Should be allowed again (old entries expired)
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
  });

  it('sliding window partially expires old entries', () => {
    const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 10_000 });

    // Make 2 calls at t=0
    breaker.check('read_file', { path: '/tmp/test.txt' });
    breaker.check('read_file', { path: '/tmp/test.txt' });

    // Advance 6s, make 1 more call at t=6s
    vi.advanceTimersByTime(6_000);
    breaker.check('read_file', { path: '/tmp/test.txt' });

    // At t=6s, we have 3 calls — denied
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(false);

    // Advance to t=11s — the first 2 calls expire, leaving 1 from t=6s
    vi.advanceTimersByTime(5_000);
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
  });

  it('uses default config values', () => {
    const breaker = new CallCircuitBreaker();
    // Default threshold is 20 — should allow 19 calls
    for (let i = 0; i < 19; i++) {
      expect(breaker.check('tool', { x: 1 }).allowed).toBe(true);
    }
  });

  it('reset clears all state', () => {
    const breaker = new CallCircuitBreaker({ threshold: 2, windowMs: 60_000 });
    breaker.check('read_file', { path: '/tmp/test.txt' });
    breaker.check('read_file', { path: '/tmp/test.txt' });
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(false);

    breaker.reset();
    expect(breaker.check('read_file', { path: '/tmp/test.txt' }).allowed).toBe(true);
  });

  it('hash stability: key ordering does not matter', () => {
    const breaker = new CallCircuitBreaker({ threshold: 3, windowMs: 60_000 });
    breaker.check('tool', { b: 2, a: 1 });
    breaker.check('tool', { a: 1, b: 2 });
    breaker.check('tool', { b: 2, a: 1 });
    // All three should count as the same key
    expect(breaker.check('tool', { a: 1, b: 2 }).allowed).toBe(false);
  });
});
