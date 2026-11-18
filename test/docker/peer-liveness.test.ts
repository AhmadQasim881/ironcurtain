import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lateObservationGapMs,
  monotonicNow,
  PeerProgressTracker,
  resolveMonotonicClock,
} from '../../src/docker/peer-liveness.js';

afterEach(() => {
  vi.useRealTimers();
});

interface Timeline {
  wallMs: number;
  monotonicMs: number;
}

function tracker(time: Timeline, lateAfterMs = 15_000): PeerProgressTracker {
  return new PeerProgressTracker({
    staleAfterMs: 30_000,
    lateAfterMs,
    monotonicNow: () => time.monotonicMs,
    wallNow: () => time.wallMs,
  });
}

function advance(time: Timeline, milliseconds: number): void {
  time.wallMs += milliseconds;
  time.monotonicMs += milliseconds;
}

describe('peer progress tracker', () => {
  it('declares a peer stale only after a full window of observer-monotonic time without a change', () => {
    const time = { wallMs: 1_000_000, monotonicMs: 0 };
    const peer = tracker(time);
    expect(peer.observe('heartbeat-1')).toMatchObject({ changed: true, stale: false });
    for (let elapsedMs = 5_000; elapsedMs < 30_000; elapsedMs += 5_000) {
      advance(time, 5_000);
      expect(peer.observe('heartbeat-1')).toMatchObject({ changed: false, late: false, stale: false });
    }
    advance(time, 5_000);
    expect(peer.observe('heartbeat-1')).toMatchObject({ silentForMs: 30_000, stale: true });
    advance(time, 5_000);
    expect(peer.observe('heartbeat-2')).toMatchObject({ changed: true, silentForMs: 0, stale: false });
  });

  it('never judges by the wall clock: a 10-minute jump with a frozen monotonic clock is no silence', () => {
    const time = { wallMs: 1_000_000, monotonicMs: 0 };
    const peer = tracker(time);
    peer.observe('heartbeat-1');
    advance(time, 5_000);
    peer.observe('heartbeat-1');
    time.wallMs += 10 * 60_000;
    expect(peer.observe('heartbeat-1')).toMatchObject({ late: true, stale: false, sinceChangeMs: 5_000 });
  });

  it('restarts the window after its own late observation but keeps the gate evidence honest', () => {
    const time = { wallMs: 1_000_000, monotonicMs: 0 };
    const peer = tracker(time);
    peer.observe('heartbeat-1');
    advance(time, 25_000);
    expect(peer.observe('heartbeat-1')).toMatchObject({ late: true, stale: false, silentForMs: 0 });
    // A gate asks for a change it actually saw; the late reset proves nothing.
    expect(peer.observe('heartbeat-1').sinceChangeMs).toBe(25_000);
    advance(time, 10_000);
    expect(peer.observe('heartbeat-1')).toMatchObject({ late: false, stale: false, silentForMs: 10_000 });
  });

  it('does not treat a backward wall-clock step as lateness or as progress', () => {
    const time = { wallMs: 1_000_000, monotonicMs: 0 };
    const peer = tracker(time);
    peer.observe('heartbeat-1');
    for (let elapsedMs = 0; elapsedMs < 30_000; elapsedMs += 5_000) {
      time.wallMs -= 60 * 60_000;
      time.monotonicMs += 5_000;
      peer.observe('heartbeat-1');
    }
    expect(peer.observe('heartbeat-1')).toMatchObject({ late: false, stale: true });
  });

  it('keeps detecting a dead peer when the configured cadence is slower than half the window', () => {
    // A 60s sample interval observes the coordinator less often than its 30s
    // window; the late threshold must still exceed that ordinary gap.
    const lateAfterMs = lateObservationGapMs(30_000, 60_000, 5_000);
    expect(lateAfterMs).toBeGreaterThan(60_000 + 5_000);
    const time = { wallMs: 1_000_000, monotonicMs: 0 };
    const peer = tracker(time, lateAfterMs);
    peer.observe('heartbeat-1');
    advance(time, 60_000 + 5_000);
    expect(peer.observe('heartbeat-1')).toMatchObject({ late: false, stale: true });
  });

  it('uses half the stale window when the shipped cadence allows it', () => {
    expect(lateObservationGapMs(30_000, 5_000, 5_000)).toBe(15_000);
    expect(lateObservationGapMs(300, 100, 100)).toBe(300);
  });

  it('rejects non-positive windows', () => {
    const time = { wallMs: 0, monotonicMs: 0 };
    expect(() => tracker(time, 0)).toThrow(/positive/u);
  });
});

describe('monotonic clock selection', () => {
  it('prefers an injected monotonic clock, then an injected wall clock, then performance.now()', () => {
    const wall = () => 7;
    const monotonic = () => 9;
    expect(resolveMonotonicClock(wall, monotonic)).toBe(monotonic);
    expect(resolveMonotonicClock(wall, undefined)).toBe(wall);
    expect(resolveMonotonicClock(undefined, undefined)).toBe(monotonicNow);
  });

  it('reads the global performance clock on every call so fake timers can drive it', () => {
    vi.useFakeTimers();
    const before = monotonicNow();
    vi.advanceTimersByTime(1_234);
    expect(monotonicNow() - before).toBe(1_234);
  });
});
