/**
 * What an approval front-end shows a human reviewer about an escalation
 * besides the call itself, and where each piece comes from.
 *
 * TRUSTED context, written by the human and recorded by the trusted host:
 *
 * - `lastTrustedUserMessage`: the human's most recent message to the
 *   session, read here from the same source the auto-approver reads (the
 *   coordinator's in-process message, or `user-context.json`). A PTY session
 *   trusts only what its trusted host front-end wrote (the mux or web UI
 *   trusted-input bar), exactly like the auto-approver; text the agent's
 *   terminal session could have produced never appears as the human's.
 * - `taskSummary`: the task the session was started with. The session layer
 *   attaches it (see `withTaskSummary`), not this module.
 *
 * UNTRUSTED context:
 *
 * - `agentJustification`: the agent's own explanation, the optional
 *   `justification` it passed to the `execute_code` chain that issued the
 *   call. It is attacker-controlled under the threat model, so it is bounded
 *   here, shown escaped and labelled as written by the agent, never passed
 *   to the auto-approver, and it authorizes nothing.
 *
 * Everything is bounded before it is written to an escalation request so a
 * pasted document or a megabyte of justification cannot inflate the IPC file
 * or the approval views.
 */

import { readUserContext, type UserContext } from './auto-approver.js';

/** Longest trusted text (user message, task) an escalation request carries, in code points. */
export const MAX_REVIEWER_CONTEXT_CHARS = 2000;

/** Longest agent justification an escalation request carries, in code points. */
export const MAX_AGENT_JUSTIFICATION_CHARS = 500;

/** Source the trusted PTY front-ends (mux, web UI trusted-input bar) stamp on user-context.json. */
export const TRUSTED_INPUT_SOURCE = 'mux-trusted-input';

/** The human's most recent message, as the trusted host recorded it. */
export interface TrustedUserMessage {
  /** The message, cut to {@link MAX_REVIEWER_CONTEXT_CHARS} (the cut is marked). */
  readonly text: string;
  /** When it was sent (ISO 8601), when the writer recorded a valid time. */
  readonly sentAt?: string;
}

/**
 * The reviewer context the pipeline attaches to an escalation request and
 * hands to an in-process escalation handler.
 */
export interface EscalationReviewContext {
  /** TRUSTED: the human's most recent message (see the module comment). */
  readonly lastTrustedUserMessage?: TrustedUserMessage;
  /** UNTRUSTED: written by the agent; display only, never authorizes anything. */
  readonly agentJustification?: string;
}

/**
 * Cuts `text` to at most `maxChars` code points and marks the cut with the
 * number of code points left out. Never splits a surrogate pair.
 */
export function boundReviewerText(text: string, maxChars: number): string {
  let kept = 0;
  let end = 0;
  for (const character of text) {
    if (kept === maxChars) break;
    kept += 1;
    end += character.length;
  }
  if (end >= text.length) return text;
  return `${text.slice(0, end)}… [+${countCodePointsFrom(text, end)} more characters]`;
}

/** Code points in `text` from UTF-16 index `start`, a lone surrogate counting as one. */
function countCodePointsFrom(text: string, start: number): number {
  let count = 0;
  for (let index = start; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

/**
 * The agent's justification as a reviewer may see it: a non-empty string,
 * trimmed and bounded. Any other value (absent, not a string, blank) is
 * dropped, so a malformed `execute_code` input never reaches a reviewer.
 */
export function normalizeAgentJustification(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return boundReviewerText(trimmed, MAX_AGENT_JUSTIFICATION_CHARS);
}

/**
 * Whether the writer of a user context may speak for the human. A PTY
 * session's own process never sees what the user types into the agent's
 * terminal, so only the trusted front-end's trusted-input bar
 * ({@link TRUSTED_INPUT_SOURCE}) counts there; a non-PTY session records the
 * human's messages itself. This is the source half of the auto-approver's
 * trust check (`isUserContextTrusted`); freshness is checked there only.
 */
export function isTrustedUserContextSource(context: UserContext, isPtySession: boolean): boolean {
  return !isPtySession || context.source === TRUSTED_INPUT_SOURCE;
}

/** Inputs for {@link reviewerUserMessage}: where the session's user context lives. */
export interface ReviewerUserMessageSource {
  /** The coordinator's in-process message (`setLastUserMessage`), which supersedes the file. */
  readonly inProcessMessage?: string;
  /** The session's escalation directory, holding `user-context.json`. */
  readonly escalationDir?: string;
  readonly isPtySession: boolean;
}

/**
 * The human's most recent message for the reviewer, from the source the
 * auto-approver reads. Unlike the auto-approver, a stale message is still
 * shown: the reviewer sees when it was sent and judges its relevance, while
 * nothing is approved on its strength. Returns undefined when there is no
 * message, it is empty (a turn IronCurtain generated clears it), or a PTY
 * session's context was not written by the trusted front-end.
 */
export function reviewerUserMessage(source: ReviewerUserMessageSource): TrustedUserMessage | undefined {
  if (source.inProcessMessage !== undefined) {
    if (source.inProcessMessage.trim() === '') return undefined;
    return { text: boundReviewerText(source.inProcessMessage, MAX_REVIEWER_CONTEXT_CHARS) };
  }
  if (source.escalationDir === undefined) return undefined;
  const context = readUserContext(source.escalationDir);
  if (context === null || !isTrustedUserContextSource(context, source.isPtySession)) return undefined;
  const sentAt = validTimestamp(context.timestamp);
  return {
    text: boundReviewerText(context.userMessage, MAX_REVIEWER_CONTEXT_CHARS),
    ...(sentAt !== undefined ? { sentAt } : {}),
  };
}

/** The timestamp, normalized to ISO 8601, when it parses; undefined otherwise. */
function validTimestamp(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  const ms = new Date(timestamp).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * The review context for one escalation: the trusted user message and the
 * agent's justification, each present only when there is one.
 */
export function buildEscalationReviewContext(
  source: ReviewerUserMessageSource,
  agentJustification: unknown,
): EscalationReviewContext {
  const lastTrustedUserMessage = reviewerUserMessage(source);
  const justification = normalizeAgentJustification(agentJustification);
  return {
    ...(lastTrustedUserMessage !== undefined ? { lastTrustedUserMessage } : {}),
    ...(justification !== undefined ? { agentJustification: justification } : {}),
  };
}
