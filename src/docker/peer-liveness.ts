/**
 * Observer-local liveness for the nested-Docker watchdog processes.
 *
 * Wall-clock timestamps cannot judge whether a process is alive. Host sleep, a
 * paused VM, and an NTP or WSL clock step all move the wall clock while no
 * process had a chance to run, and a backward step makes an old timestamp look
 * fresh. Staleness is therefore measured on the observer's own monotonic clock.
 * Wall-clock values remain the persisted evidence format; they are compared
 * here only to notice that the observer itself stopped running.
 *
 * Leaf module: no project imports, so both `src/docker/` and
 * `src/docker-workload/` can use it without an import cycle.
 */

/**
 * Production monotonic clock in milliseconds. Read through the global on every
 * call so fake timers that replace `performance` also replace this clock.
 */
export function monotonicNow(): number {
  return performance.now();
}

/**
 * Pick the monotonic clock for a component with injectable time. Production
 * injects neither clock and gets {@link monotonicNow}. A caller that injects
 * only a wall clock (a test that drives time through it) has that clock reused
 * as the monotonic source, so injected time stays the single source of truth.
 */
export function resolveMonotonicClock(
  injectedWallClock: (() => number) | undefined,
  injectedMonotonicClock: (() => number) | undefined,
): () => number {
  if (injectedMonotonicClock !== undefined) return injectedMonotonicClock;
  if (injectedWallClock !== undefined) return injectedWallClock;
  return monotonicNow;
}

/**
 * Observation gap after which an observer treats itself as not having watched
 * its peer (it was suspended, stopped, or starved).
 *
 * It must exceed the longest gap ordinary operation produces (one sleep plus
 * one bounded sample, plus one more interval of margin); otherwise every
 * observation would restart the peer's window and a dead peer would never be
 * declared stale. Half the stale window keeps at least half of that window for
 * a resumed peer to show progress when the configured cadence allows it.
 */
export function lateObservationGapMs(staleAfterMs: number, sampleIntervalMs: number, sampleTimeoutMs: number): number {
  return Math.max(Math.ceil(staleAfterMs / 2), 2 * sampleIntervalMs + sampleTimeoutMs);
}

export interface PeerProgressTrackerOptions {
  /** Observer-monotonic time without an observed change after which the peer is stale. */
  readonly staleAfterMs: number;
  /** Gap between two observations, on either clock, after which the observer was late. */
  readonly lateAfterMs: number;
  readonly monotonicNow: () => number;
  /** Wall clock, used only to notice that the observer stopped running. */
  readonly wallNow: () => number;
}

export interface PeerProgressObservation {
  /** The marker differs from the previous observation (or this is the first one). */
  readonly changed: boolean;
  /** The observer itself was late, so the peer was granted a fresh window. */
  readonly late: boolean;
  /**
   * Observer-monotonic time since the marker was last seen to change. Late
   * observations never shorten it, so a gate that must prove progress uses it.
   */
  readonly sinceChangeMs: number;
  /** Time since the last change or late-observation reset; what staleness is judged on. */
  readonly silentForMs: number;
  /** The peer showed no progress for a full window this observer actually watched. */
  readonly stale: boolean;
}

/**
 * Tracks a peer process's published progress marker (a heartbeat or status
 * timestamp) by when THIS observer saw it change, never by its value.
 *
 * An observer cannot blame a peer for an interval it was not watching: when
 * the gap since the previous observation is late on either clock, the peer's
 * window restarts so it gets one full fresh window to show progress. Destructive
 * decisions use `stale`; gates that must positively prove recent progress use
 * `sinceChangeMs`, which a late observation never resets.
 */
export class PeerProgressTracker {
  private readonly options: PeerProgressTrackerOptions;
  private marker: string | undefined;
  private changedAtMs = 0;
  private windowStartedAtMs = 0;
  private lastObservedMonotonicMs = 0;
  private lastObservedWallMs = 0;

  constructor(options: PeerProgressTrackerOptions) {
    if (!(options.staleAfterMs > 0) || !(options.lateAfterMs > 0)) {
      throw new Error('peer progress windows must be positive');
    }
    this.options = options;
  }

  observe(marker: string): PeerProgressObservation {
    const monotonicMs = this.options.monotonicNow();
    const wallMs = this.options.wallNow();
    if (this.marker === undefined) {
      this.marker = marker;
      this.changedAtMs = monotonicMs;
      this.windowStartedAtMs = monotonicMs;
      this.recordObservation(monotonicMs, wallMs);
      return { changed: true, late: false, sinceChangeMs: 0, silentForMs: 0, stale: false };
    }
    // A backward wall step is not lateness: the monotonic gap still shows a
    // pause wherever that clock counts one, and where it does not, the pause
    // never counted toward staleness in the first place.
    const late =
      monotonicMs - this.lastObservedMonotonicMs >= this.options.lateAfterMs ||
      wallMs - this.lastObservedWallMs >= this.options.lateAfterMs;
    const changed = marker !== this.marker;
    if (changed) {
      this.marker = marker;
      this.changedAtMs = monotonicMs;
      this.windowStartedAtMs = monotonicMs;
    } else if (late) {
      this.windowStartedAtMs = monotonicMs;
    }
    this.recordObservation(monotonicMs, wallMs);
    const sinceChangeMs = Math.max(0, monotonicMs - this.changedAtMs);
    const silentForMs = Math.max(0, monotonicMs - this.windowStartedAtMs);
    return { changed, late, sinceChangeMs, silentForMs, stale: silentForMs >= this.options.staleAfterMs };
  }

  private recordObservation(monotonicMs: number, wallMs: number): void {
    this.lastObservedMonotonicMs = monotonicMs;
    this.lastObservedWallMs = wallMs;
  }
}
