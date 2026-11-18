import * as logger from '../../logger.js';

export type LlmMetricsLogLevel = 'info' | 'warn' | 'error';

export type LlmMetricsLogSink = (level: LlmMetricsLogLevel, message: string) => void;

/** Persistence health goes to the project log; it is a no-op until a session or daemon sets one up. */
export const projectLogSink: LlmMetricsLogSink = (level, message) => logger[level](message);

export interface RateLimitedLog {
  /**
   * Writes `message` unless a message with the same key was written less than
   * the interval ago. The next message written for that key reports how many
   * were suppressed in between.
   */
  emit(key: string, level: LlmMetricsLogLevel, message: string): void;
}

export interface RateLimitedLogOptions {
  readonly intervalMs: number;
  readonly sink: LlmMetricsLogSink;
  readonly now?: () => number;
}

/**
 * Rate limiting per key keeps a flapping writer from flooding the log while
 * each distinct kind of transition still appears. Keys come from a fixed set
 * chosen by the caller, so the bookkeeping stays bounded.
 */
export function createRateLimitedLog(options: RateLimitedLogOptions): RateLimitedLog {
  const now = options.now ?? Date.now;
  const lastWrittenAt = new Map<string, number>();
  const suppressed = new Map<string, number>();
  return {
    emit(key, level, message): void {
      const at = now();
      const previous = lastWrittenAt.get(key);
      if (previous !== undefined && at - previous < options.intervalMs) {
        suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
        return;
      }
      const skipped = suppressed.get(key) ?? 0;
      suppressed.delete(key);
      lastWrittenAt.set(key, at);
      try {
        options.sink(level, skipped > 0 ? `${message} (${skipped} similar message(s) suppressed)` : message);
      } catch {
        // Logging must never disturb persistence or the proxy path.
      }
    },
  };
}
