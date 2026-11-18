/**
 * Bounded warning log for events an agent connection can trigger.
 *
 * The Code Mode proxy logs what its socket transports and per-connection MCP
 * servers report -- malformed frames, responses to request ids the proxy
 * never issued, socket errors -- so a misbehaving agent stays visible. The
 * agent controls how often that happens and much of the text: every
 * two-byte garbage line yields one warning, a response with an unknown id is
 * quoted back verbatim (up to the 10 MiB frame cap), and V8's JSON syntax
 * errors quote raw input bytes, terminal escape sequences included. Each
 * warning is a synchronous append to the host's session log, on the event
 * loop that every other session in the daemon shares, so unbounded logging
 * would let one hostile connection fill the host disk at socket speed.
 *
 * Every warning therefore carries at most {@link AGENT_WARNING_DETAIL_CHARS}
 * characters of the agent-influenced text, rendered on one line with every
 * control character escaped ({@link toDisplayText}), and at most
 * {@link AGENT_WARNING_BUDGET} warnings are written per
 * {@link AGENT_WARNING_WINDOW_MS}; the rest are only counted and reported in
 * one summary line.
 */

import { toDisplayText } from '../terminal/display-sanitize.js';

/** Warnings written per window; the rest are counted and summarized. */
export const AGENT_WARNING_BUDGET = 20;
/** Length of the rate-limit window, in milliseconds. */
export const AGENT_WARNING_WINDOW_MS = 60_000;
/** Characters of untrusted detail kept per warning (before escaping). */
export const AGENT_WARNING_DETAIL_CHARS = 300;

export interface AgentWarningLog {
  /**
   * Writes `${summary}: ${detail}` while the window's budget lasts, otherwise
   * counts it. `summary` is trusted text; `detail` is untrusted and is
   * bounded and escaped here.
   */
  warn(summary: string, detail: string): void;
  /** Writes how many warnings were suppressed since the last report, if any. */
  flush(): void;
}

export interface AgentWarningLogOptions {
  /** Receives every line that is written (e.g. a prefixed `logger.warn`). */
  readonly write: (line: string) => void;
  /** Monotonic clock in milliseconds. Defaults to `performance.now()`. */
  readonly now?: () => number;
  readonly budget?: number;
  readonly windowMs?: number;
}

/**
 * Renders untrusted text as one line of bounded length with every control
 * and invisible format character escaped.
 */
export function boundedDisplayDetail(text: string, maxChars = AGENT_WARNING_DETAIL_CHARS): string {
  if (text.length <= maxChars) return toDisplayText(text);
  // Cut before escaping: the text can be megabytes long and toDisplayText
  // walks every code point.
  return `${toDisplayText(text.slice(0, maxChars))}...[+${text.length - maxChars} chars]`;
}

export function createAgentWarningLog(options: AgentWarningLogOptions): AgentWarningLog {
  const now = options.now ?? (() => performance.now());
  const budget = options.budget ?? AGENT_WARNING_BUDGET;
  const windowMs = options.windowMs ?? AGENT_WARNING_WINDOW_MS;
  let windowStart = now();
  let written = 0;
  let suppressed = 0;

  function flush(): void {
    if (suppressed === 0) return;
    options.write(
      `${suppressed} further agent connection warning(s) suppressed (limit ${budget} per ${windowMs / 1000}s)`,
    );
    suppressed = 0;
  }

  return {
    warn(summary: string, detail: string): void {
      const time = now();
      if (time - windowStart >= windowMs) {
        flush();
        windowStart = time;
        written = 0;
      }
      if (written >= budget) {
        suppressed += 1;
        return;
      }
      written += 1;
      options.write(`${summary}: ${boundedDisplayDetail(detail)}`);
    },
    flush,
  };
}
