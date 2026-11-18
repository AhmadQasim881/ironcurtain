/**
 * The task summary a session attaches to the escalations it surfaces.
 *
 * The trusted pipeline attaches the rest of the reviewer context to every
 * escalation request: the human's most recent message (trusted) and the
 * agent's justification (untrusted); see trusted-process/escalation-context.ts.
 * The task the session was started with is known only to the session: its
 * first human message, which is the `ironcurtain start` task, a cron job's
 * task description, or the opening message of a Signal or web UI session.
 * A turn IronCurtain generated itself (`origin: 'system'`: the memory
 * auto-save prompt, workflow state prompts, which may embed agent output)
 * never becomes the task, so the summary is always the human's own text.
 */

import type { EscalationRequest, MessageOrigin } from '../session/types.js';
import {
  boundReviewerText,
  MAX_REVIEWER_CONTEXT_CHARS,
  type TrustedUserMessage,
} from '../trusted-process/escalation-context.js';
import { escalationGroupKey } from './escalation-groups.js';

/**
 * The reviewer-context and grouping fields an approval front-end's DTO
 * carries for an escalation, each present only when the request has it.
 */
export interface EscalationDisplayFields {
  /** TRUSTED: the human's last message (see `EscalationRequest.lastTrustedUserMessage`). */
  readonly lastTrustedUserMessage?: TrustedUserMessage;
  /** TRUSTED: the session's task (see `EscalationRequest.taskSummary`). */
  readonly taskSummary?: string;
  /** UNTRUSTED: the agent's justification (see `EscalationRequest.agentJustification`). */
  readonly agentJustification?: string;
  /** The whitelist-pattern group the escalation belongs to (escalation-groups.ts). */
  readonly groupKey?: string;
}

/** The {@link EscalationDisplayFields} of `request`. */
export function escalationDisplayFields(request: EscalationRequest): EscalationDisplayFields {
  const groupKey = escalationGroupKey(request);
  return {
    ...(request.lastTrustedUserMessage !== undefined ? { lastTrustedUserMessage: request.lastTrustedUserMessage } : {}),
    ...(request.taskSummary !== undefined ? { taskSummary: request.taskSummary } : {}),
    ...(request.agentJustification !== undefined ? { agentJustification: request.agentJustification } : {}),
    ...(groupKey !== undefined ? { groupKey } : {}),
  };
}

/**
 * `request` as read from a request file, without any reviewer-context field
 * of the wrong shape. Request files are parsed without a schema; the
 * coordinator writes these fields well-formed, but a front-end must not
 * crash, or show a non-string, on a malformed one.
 *
 * A `taskSummary` in the file is dropped whatever its shape: the pipeline
 * never writes one, and the task is TRUSTED text that only the session
 * ({@link SessionTaskSummary}) or the workflow orchestrator attaches after
 * the request is read. A front-end that reads request files itself (mux,
 * listener, web UI terminal sessions) therefore never labels text from the
 * file as the human's task.
 */
export function withValidReviewFields(request: EscalationRequest): EscalationRequest {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- taskSummary is dropped on purpose (see above)
  const { lastTrustedUserMessage, taskSummary, agentJustification, ...rest } = request as EscalationRequest & {
    lastTrustedUserMessage?: unknown;
    taskSummary?: unknown;
    agentJustification?: unknown;
  };
  const message = validTrustedUserMessage(lastTrustedUserMessage);
  return {
    ...rest,
    ...(message !== undefined ? { lastTrustedUserMessage: message } : {}),
    ...(typeof agentJustification === 'string' ? { agentJustification } : {}),
  };
}

function validTrustedUserMessage(value: unknown): TrustedUserMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { text, sentAt } = value as { text?: unknown; sentAt?: unknown };
  if (typeof text !== 'string') return undefined;
  return { text, ...(typeof sentAt === 'string' ? { sentAt } : {}) };
}

/**
 * The human's last message as a front-end shows it beside the task: left
 * out when it is the task itself (the only message of a one-shot or cron
 * session), so one text is never shown twice under two labels. The task
 * label is the accurate one there: nobody typed that message just now.
 */
export function displayedUserMessage(
  request: Pick<EscalationRequest, 'lastTrustedUserMessage' | 'taskSummary'>,
): TrustedUserMessage | undefined {
  const message = request.lastTrustedUserMessage;
  if (message === undefined) return undefined;
  if (request.taskSummary !== undefined && message.text.trim() === request.taskSummary.trim()) return undefined;
  return message;
}

/** `request` with `taskSummary` set, or `request` itself when there is no summary. */
export function withTaskSummary(request: EscalationRequest, taskSummary: string | undefined): EscalationRequest {
  if (taskSummary === undefined) return request;
  return { ...request, taskSummary };
}

/** The task a session was started with, as the first human message gave it. */
export class SessionTaskSummary {
  private summary: string | undefined;

  /**
   * Records a message the session is about to send to the agent. The first
   * non-blank human message becomes the task; later messages and every
   * system-generated one leave it unchanged.
   */
  recordMessage(message: string, origin: MessageOrigin | undefined): void {
    if (this.summary !== undefined || origin === 'system') return;
    const trimmed = message.trim();
    if (trimmed === '') return;
    this.summary = boundReviewerText(trimmed, MAX_REVIEWER_CONTEXT_CHARS);
  }

  /** The recorded task, if any. */
  get value(): string | undefined {
    return this.summary;
  }

  /** `request` with this session's task summary attached (see {@link withTaskSummary}). */
  attach(request: EscalationRequest): EscalationRequest {
    return withTaskSummary(request, this.summary);
  }
}
