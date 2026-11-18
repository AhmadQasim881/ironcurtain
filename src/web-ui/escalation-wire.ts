/** Complete browser review records, or explicit bounded deny-only summaries. */
import type { SessionSource } from '../session/session-manager.js';
import type { EscalationDto, WorkflowEscalationDto } from './web-ui-types.js';
import { InvalidParamsError } from './web-ui-types.js';

export const MAX_ESCALATION_REVIEW_BYTES = 16 * 1024;
export const ESCALATION_REVIEW_UNAVAILABLE =
  'This request is too large for complete browser review. It can only be denied; ask for smaller calls.';

/** Accounts only bounded JSON fragments; never stringifies an oversized tree. */
export function fitsEscalationReview(value: unknown, maxBytes = MAX_ESCALATION_REVIEW_BYTES): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  let remaining = maxBytes;
  let entries = 0;
  const ancestors = new Set<object>();
  const spend = (text: string): boolean => {
    if (text.length > remaining) return false;
    remaining -= Buffer.byteLength(text);
    return remaining >= 0;
  };
  const string = (text: string): boolean => text.length <= remaining && spend(JSON.stringify(text));
  const visit = (item: unknown, depth: number): boolean => {
    if (++entries > 2048 || depth > 16) return false;
    if (typeof item === 'string') return string(item);
    if (item === undefined || item === null) return spend('null');
    if (typeof item === 'boolean' || typeof item === 'number') return spend(JSON.stringify(item));
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    if (!Array.isArray(item)) {
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    ancestors.add(item);
    if (!spend('[]')) return false;
    if (Array.isArray(item)) {
      for (const child of item) if (!spend(',') || !visit(child, depth + 1)) return false;
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (!string(key) || !spend(':,') || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
      }
    }
    ancestors.delete(item);
    return true;
  };
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
}

/** The original pending record, never a client-supplied summary, is checked. */
export function assertEscalationReviewable(value: unknown): void {
  const unavailable =
    typeof value === 'object' && value !== null && 'reviewUnavailable' in value && value.reviewUnavailable === true;
  if (unavailable || !fitsEscalationReview(value)) throw new InvalidParamsError(ESCALATION_REVIEW_UNAVAILABLE);
}

const label = (text: unknown): string => (typeof text === 'string' ? text.slice(0, 96) : '');

function boundedSource(source: SessionSource | undefined): SessionSource {
  if (!source) return { kind: 'web' };
  if (source.kind === 'cron') return { ...source, jobName: label(source.jobName) };
  if (source.kind === 'signal') return source;
  return { kind: source.kind, ...(source.persona ? { persona: label(source.persona) } : {}) };
}

export function escalationForWire(value: EscalationDto, maxBytes?: number): EscalationDto;
export function escalationForWire(value: WorkflowEscalationDto, maxBytes?: number): WorkflowEscalationDto;
export function escalationForWire(
  value: EscalationDto | WorkflowEscalationDto,
  maxBytes = MAX_ESCALATION_REVIEW_BYTES,
): EscalationDto | WorkflowEscalationDto {
  if (fitsEscalationReview(value, maxBytes)) return value;
  const common = {
    escalationId: value.escalationId,
    serverName: label(value.serverName),
    toolName: label(value.toolName),
    arguments: {},
    reason: ESCALATION_REVIEW_UNAVAILABLE,
    receivedAt: value.receivedAt,
    humanOnly: true as const,
    reviewUnavailable: true as const,
  };
  // Routing identifiers are host-issued and retained exactly. Untrusted
  // arguments, reviewer prose, whitelist candidates and groups are omitted.
  if ('sessionLabel' in value) {
    return { ...common, sessionLabel: value.sessionLabel, sessionSource: boundedSource(value.sessionSource) };
  }
  return {
    ...common,
    workflowId: value.workflowId,
    stateId: label(value.stateId),
    ...(value.persona ? { persona: label(value.persona) } : {}),
  };
}
