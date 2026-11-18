/**
 * CallCircuitBreaker -- Proxy-level rate limiter for MCP tool calls.
 *
 * Protects against runaway sandbox code that hammers the same tool
 * with identical arguments. Uses a sliding-window approach: if the
 * same (tool, argsHash) pair appears more than `threshold` times
 * within `windowMs`, the call is denied.
 *
 * Windows are kept per lane. A lane is the caller-supplied identity of
 * one agent stream sharing the coordinator: in a workflow's shared
 * container every agent process (one per fan-out lane) holds its own
 * connection to the Code Mode proxy, which tags that connection's calls
 * with a host-assigned lane key (`code-mode-proxy.ts`). Each lane keeps
 * the single-lane `threshold`, so a runaway lane is stopped exactly as a
 * lone agent would be, and N lanes making the same legitimate call do not
 * share (and false-trip) one window. Calls without a lane share one
 * default lane.
 *
 * A second, all-lanes window per (tool, argsHash) bounds the total at
 * `threshold * maxLanes`, where `maxLanes` is the number of lanes the
 * coordinator was built for (1 for a standalone session, the widest
 * fan-out for a workflow bundle). Lane keys are minted per connection,
 * so without it an agent that reconnected for every call would get a
 * fresh window each time. With `maxLanes: 1` the all-lanes window caps
 * every caller at `threshold`, exactly the pre-lane behaviour.
 *
 * Runs AFTER policy evaluation so every call is always audited.
 */

import { computeHash } from '../hash.js';
import { ERROR_PREFIX_CIRCUIT_BREAKER } from './error-prefixes.js';

export interface CircuitBreakerConfig {
  windowMs: number;
  /** Identical calls one lane may make within `windowMs`. */
  threshold: number;
  /**
   * Number of concurrent agent lanes expected to share this breaker.
   * Does NOT raise the per-lane threshold; it only sizes the all-lanes
   * window (`threshold * maxLanes`) that bounds the total across lanes.
   */
  maxLanes: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  windowMs: 60_000,
  threshold: 20,
  maxLanes: 1,
};

/** Lane used for calls that carry no lane identity. */
const DEFAULT_LANE = '';

export type CircuitBreakerVerdict = { allowed: true } | { allowed: false; reason: string };

export class CallCircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  /** Per-lane windows: lane -> `${tool}:${argsHash}` -> call timestamps. */
  private readonly laneWindows = new Map<string, Map<string, number[]>>();
  /** All-lanes windows: `${tool}:${argsHash}` -> call timestamps. */
  private readonly totalWindows = new Map<string, number[]>();
  /** When stale windows were last swept (see `sweepStaleWindows`). */
  private lastSweepAt = Date.now();

  constructor(config?: Partial<CircuitBreakerConfig>) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    this.config = {
      ...merged,
      // Fail closed: a NaN or infinite count would make every `>=` check
      // false and silently switch that window off.
      threshold: positiveCount(merged.threshold, DEFAULT_CONFIG.threshold),
      maxLanes: positiveCount(merged.maxLanes, 1),
    };
  }

  /**
   * Check whether a tool call should be allowed, and count it when it is.
   *
   * @param lane - opaque identity of the calling agent stream; omitted
   *   for callers without one, which then share the default lane.
   * @returns `{ allowed: true }` or `{ allowed: false, reason: string }`
   */
  check(toolName: string, args: Record<string, unknown>, lane?: string): CircuitBreakerVerdict {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    this.sweepStaleWindows(now, cutoff);

    const key = `${toolName}:${computeHash(args)}`;
    const laneKey = lane ?? DEFAULT_LANE;
    let windows = this.laneWindows.get(laneKey);
    if (!windows) {
      windows = new Map();
      this.laneWindows.set(laneKey, windows);
    }
    const laneTimestamps = windowFor(windows, key, cutoff);
    const totalTimestamps = windowFor(this.totalWindows, key, cutoff);

    const windowSeconds = this.config.windowMs / 1000;
    if (laneTimestamps.length >= this.config.threshold) {
      return {
        allowed: false,
        reason:
          `${ERROR_PREFIX_CIRCUIT_BREAKER} Tool '${toolName}' called ${this.config.threshold} times ` +
          `with identical arguments within ${windowSeconds}s window. ` +
          'Try a different approach.',
      };
    }
    const totalThreshold = this.config.threshold * this.config.maxLanes;
    if (totalTimestamps.length >= totalThreshold) {
      return {
        allowed: false,
        reason:
          `${ERROR_PREFIX_CIRCUIT_BREAKER} Tool '${toolName}' called ${totalThreshold} times ` +
          `with identical arguments within ${windowSeconds}s window across all agents sharing this session. ` +
          'Try a different approach.',
      };
    }

    laneTimestamps.push(now);
    totalTimestamps.push(now);
    return { allowed: true };
  }

  /** Reset all state. */
  reset(): void {
    this.laneWindows.clear();
    this.totalWindows.clear();
  }

  /** Number of (lane, call) windows currently retained (tests, diagnostics). */
  getTrackedWindowCount(): number {
    let count = this.totalWindows.size;
    for (const windows of this.laneWindows.values()) count += windows.size;
    return count;
  }

  /**
   * Drops windows whose newest call has left the window, at most once per
   * window period. A window is otherwise pruned only when the same call is
   * checked again, and lane keys are minted per agent connection, so
   * without this sweep every finished connection's windows would stay in
   * memory for the life of the coordinator.
   */
  private sweepStaleWindows(now: number, cutoff: number): void {
    if (now - this.lastSweepAt < this.config.windowMs) return;
    this.lastSweepAt = now;
    dropStaleWindows(this.totalWindows, cutoff);
    for (const [lane, windows] of this.laneWindows) {
      dropStaleWindows(windows, cutoff);
      if (windows.size === 0) this.laneWindows.delete(lane);
    }
  }
}

/** `value` floored to a positive integer, or `fallback` when it is not a finite number. */
function positiveCount(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** Returns the window for `key` with entries older than `cutoff` pruned, creating it if absent. */
function windowFor(windows: Map<string, number[]>, key: string, cutoff: number): number[] {
  let timestamps = windows.get(key);
  if (!timestamps) {
    timestamps = [];
    windows.set(key, timestamps);
    return timestamps;
  }
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) {
    timestamps.splice(0, firstValid);
  } else if (firstValid === -1) {
    timestamps.length = 0;
  }
  return timestamps;
}

function dropStaleWindows(windows: Map<string, number[]>, cutoff: number): void {
  for (const [key, timestamps] of windows) {
    const newest = timestamps.at(-1);
    if (newest === undefined || newest <= cutoff) windows.delete(key);
  }
}
