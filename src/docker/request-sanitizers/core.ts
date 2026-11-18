/**
 * Shared primitives for the MITM request sanitizers. See `./index.ts` for the
 * framework overview; this module is the leaf the protocol sanitizers import.
 */

import type { OutgoingHttpHeaders } from 'node:http';
import { toDisplayText } from '../../terminal/display-sanitize.js';
import { isObjectWithProp } from '../../utils/is-plain-object.js';

/** Request facts a sanitizer may consult. */
export interface SanitizeContext {
  readonly method: string;
  readonly path: string;
}

/** The body to forward, plus one log label per removed or neutralized item. */
export interface SanitizeResult {
  readonly body: Record<string, unknown>;
  readonly removed: readonly string[];
}

/**
 * Sanitizer for one wire protocol. It removes everything that would make the
 * provider act on the network for the agent (provider-hosted tools, remote
 * connectors, URL-sourced content, egress-enabling feature flags).
 *
 * Contract:
 * - `sanitizeBody` never mutates its input. It returns the input object
 *   itself when nothing was removed, so callers can detect "unchanged".
 * - A request that cannot be made safe throws {@link RequestRejectedError};
 *   it is never passed through as-is.
 * - `sanitizeHeaders` edits the forwarded header object in place (the proxy
 *   reuses it for the 401 retry) and returns one label per removed value.
 *   Callers use `sanitizeRequestHeaders` (./index.ts), which also pins the
 *   forwarded Content-Type to the canonical JSON body before calling it.
 */
export interface RequestSanitizer {
  /** Wire protocol name used in log lines, e.g. `anthropic-messages`. */
  readonly protocol: string;
  sanitizeHeaders(headers: OutgoingHttpHeaders): readonly string[];
  sanitizeBody(body: Readonly<Record<string, unknown>>, context: SanitizeContext): SanitizeResult;
}

/** A POST endpoint whose request body is sanitized before it is forwarded. */
export interface SanitizedEndpoint {
  readonly method: 'POST';
  /** Exact path, or a path whose `*` matches one segment (as in `allowedEndpoints`). */
  readonly path: string;
  readonly sanitizer: RequestSanitizer;
}

/** Error-code discriminant; catchers test it instead of `instanceof` (CLAUDE.md layering). */
export const REQUEST_REJECTED = 'REQUEST_REJECTED';

/**
 * HTTP status the proxy answers locally for a rejected request: 400 for a
 * body it cannot parse or sanitize, 413 for a body that exceeds the buffering
 * limit once decoded, 415 for a Content-Encoding it cannot decode.
 */
export type RequestRejectionStatus = 400 | 413 | 415;

const REJECTION_STATUSES: ReadonlySet<unknown> = new Set<RequestRejectionStatus>([400, 413, 415]);

/** A request the proxy refuses to forward. The message is safe to show the agent. */
export class RequestRejectedError extends Error {
  readonly code = REQUEST_REJECTED;

  constructor(
    readonly status: RequestRejectionStatus,
    message: string,
  ) {
    super(message);
    this.name = 'RequestRejectedError';
  }
}

export function isRequestRejectedError(error: unknown): error is RequestRejectedError {
  return (
    isObjectWithProp(error, 'code') &&
    error.code === REQUEST_REJECTED &&
    isObjectWithProp(error, 'status') &&
    REJECTION_STATUSES.has(error.status) &&
    isObjectWithProp(error, 'message') &&
    typeof error.message === 'string'
  );
}

/** Reject the request with a local 400. Never returns. */
export function rejectRequest(message: string): never {
  throw new RequestRejectedError(400, message);
}

/**
 * Text that replaces neutralized content (a URL-sourced block or part, replayed
 * provider-side tool activity), so the agent and the model can see why content
 * is missing. Shared by every protocol sanitizer.
 */
export const NEUTRALIZED_CONTENT_TEXT =
  '[IronCurtain removed content that would have made the provider fetch data or run tools outside this request.]';

const MAX_LABEL_VALUE_LENGTH = 80;

/**
 * Render an agent-controlled value (a tool type, a beta name, a block type)
 * for one session-log line: control characters become visible escapes and
 * long values are cut, so request content cannot forge or flood log lines.
 */
export function labelValue(value: unknown): string {
  if (typeof value === 'string') return toDisplayText(value, { maxLength: MAX_LABEL_VALUE_LENGTH });
  return `<${value === null ? 'null' : typeof value}>`;
}
