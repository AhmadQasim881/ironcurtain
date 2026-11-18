/**
 * Output formatting for `ironcurtain observe`.
 *
 * Pure functions that transform TokenStreamEvent batches into
 * terminal-friendly text. No I/O or side effects -- all output
 * is returned as strings.
 *
 * Every event field is untrusted (model output, the agent's own tool
 * results) and lands on the user's terminal, so it is sanitized here, at
 * the sink (see observe-text.ts): text deltas keep their line breaks but
 * lose escape sequences and control characters; every other field is
 * shown on one line with controls as visible escapes. `--json` output
 * escapes every character a terminal could act on (C1 controls included,
 * which `JSON.stringify` leaves raw) and still parses to the same events.
 */

import chalk from 'chalk';
import type { TokenStreamEvent } from '../docker/token-stream-types.js';
import { truncate } from '../mux/mux-renderer.js';
import { toTerminalSafeJson } from '../terminal/display-sanitize.js';
import { observedField, observedProse } from './observe-text.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Show all event kinds, not just text. */
  readonly raw: boolean;
  /** Output events as newline-delimited JSON. */
  readonly json: boolean;
  /** When set, prefix output lines with a session label. */
  readonly showLabel: boolean;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render a batch of events for a single session label. */
export function renderEventBatch(label: number, events: readonly TokenStreamEvent[], options: RenderOptions): string {
  const parts: string[] = [];
  for (const event of events) {
    const rendered = renderEvent(label, event, options);
    if (rendered !== null) {
      parts.push(rendered);
    }
  }
  return parts.join('');
}

/** Render a single event. Returns null if the event should be suppressed. */
export function renderEvent(label: number, event: TokenStreamEvent, options: RenderOptions): string | null {
  if (options.json) {
    return renderJson(label, event);
  }
  return renderText(label, event, options);
}

// ---------------------------------------------------------------------------
// JSON mode
// ---------------------------------------------------------------------------

function renderJson(label: number, event: TokenStreamEvent): string {
  return toTerminalSafeJson({ label, ...event }) + '\n';
}

// ---------------------------------------------------------------------------
// Text mode
// ---------------------------------------------------------------------------

function renderText(label: number, event: TokenStreamEvent, options: RenderOptions): string | null {
  const prefix = options.showLabel ? chalk.dim(`[${observedField(label)}] `) : '';

  switch (event.kind) {
    case 'text_delta':
      return `${prefix}${observedProse(event.text)}`;

    case 'tool_use':
      if (!options.raw) return null;
      // Mid-stream input_json_delta fragments arrive with an empty toolName;
      // skip them in plain mode so we do not emit noisy "[tool: ]" lines.
      if (event.toolName === '') return null;
      return `${prefix}${chalk.cyan(`[tool: ${observedField(event.toolName)}]`)} ${chalk.dim(truncate(observedField(event.inputDelta), 120))}\n`;

    case 'message_start':
      if (!options.raw) return null;
      return `${prefix}${chalk.green(`--- message start (${observedField(event.model)}) ---`)}\n`;

    case 'message_end':
      if (!options.raw) return null;
      return `${prefix}${chalk.green(`--- message end (${observedField(event.stopReason)}, ${observedField(event.inputTokens)}+${observedField(event.outputTokens)} tokens) ---`)}\n`;

    case 'error':
      return `${prefix}${chalk.red(`[error] ${observedField(event.message)}`)}\n`;

    case 'tool_result':
      if (!options.raw) return null;
      return `${prefix}${chalk.dim(`[tool_result] ${truncate(observedField(event.content), 120)}`)}\n`;

    case 'raw':
      if (!options.raw) return null;
      return `${prefix}${chalk.dim(`[${observedField(event.eventType)}] ${truncate(observedField(event.data), 120)}`)}\n`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render a connection header message. */
export function renderConnected(label?: number): string {
  if (label !== undefined) {
    return chalk.dim(`Observing session ${label}. Press Ctrl+C to stop.\n`);
  }
  return chalk.dim('Observing all sessions. Press Ctrl+C to stop.\n');
}

/** Render a session-ended notification (the reason is shown escaped, on one line). */
export function renderSessionEnded(label: number, reason: string): string {
  return chalk.dim(`\nSession ${observedField(label)} ended: ${observedField(reason)}\n`);
}

/** Render a connection-lost notice (the reason is shown escaped, on one line). */
export function renderConnectionLost(reason: string): string {
  return `\nConnection lost: ${observedField(reason)}\n`;
}
