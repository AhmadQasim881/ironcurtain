/**
 * Binding Signal escalation replies to the escalation the user saw.
 *
 * Every escalation banner sent over Signal carries a short code derived from
 * the host-generated escalation ID, and an approval must quote it
 * (`approve K7Q2`). A reply therefore names one specific escalation: a late
 * or replayed reply cannot land on a different escalation that happens to be
 * pending when it is processed, and a look-alike banner written by an agent
 * cannot name a real escalation, because the agent never sees the code.
 *
 * - {@link EscalationCodes} derives the codes with HMAC-SHA256 under a
 *   random per-process key, so a code cannot be computed from the escalation
 *   ID alone (which some host files and logs contain).
 * - {@link parseEscalationReply} recognizes `approve`, `approve+`, `deny`,
 *   `details` / `/show` and `/pending`. It is the one place that decides
 *   whether a message is an escalation reply (consumed by the daemon, never
 *   forwarded to an agent).
 * - {@link replySentAt} and {@link predatesEscalation} reject a reply sent
 *   before the escalation it would act on was raised; {@link sentBefore}
 *   also rejects an approval sent before the escalation's banner had been
 *   delivered in full (a reply processed late, for example from the
 *   reconnect drain, may have been written before the arguments arrived).
 */

import { createHmac, randomBytes } from 'node:crypto';

/**
 * Characters a code is drawn from: digits and capital letters without the
 * look-alikes 0/O and 1/I. Exactly 32 characters, so one HMAC byte modulo 32
 * picks a character without bias.
 */
export const ESCALATION_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Characters in a code: 32^4, about one million, values. */
export const ESCALATION_CODE_LENGTH = 4;

/**
 * Allowance for clock skew when comparing a reply's timestamp (taken by the
 * Signal server, or the sender's phone) with the host time the escalation
 * was recorded. A reply sent more than this long before the escalation was
 * raised cannot be meant for it.
 */
export const REPLY_CLOCK_SKEW_MS = 10_000;

/**
 * Derives the short code shown in an escalation banner. One instance (one
 * key) per daemon process: the same escalation always gets the same code
 * there, and nothing outside the process can derive it.
 */
export class EscalationCodes {
  private readonly key: Buffer;

  constructor(key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  codeFor(escalationId: string): string {
    const digest = createHmac('sha256', this.key).update(escalationId, 'utf8').digest();
    let code = '';
    for (let index = 0; index < ESCALATION_CODE_LENGTH; index += 1) {
      code += ESCALATION_CODE_ALPHABET[digest[index] % ESCALATION_CODE_ALPHABET.length];
    }
    return code;
  }
}

/** The reply words {@link parseEscalationReply} knows (`show` and `pending` only as slash commands). */
export type EscalationReplyVerb = 'approve' | 'approve+' | 'deny' | 'details' | 'show' | 'pending';

/** An escalation reply recognized by {@link parseEscalationReply}. */
export type EscalationReply =
  | {
      readonly kind: 'decision';
      readonly decision: 'approved' | 'denied';
      /** The code typed by the user, upper-cased; absent for a bare reply. */
      readonly code?: string;
      /** A session label given as `#N`. */
      readonly label?: number;
      /**
       * `approve+`: approve and whitelist the pattern the escalation's banner
       * showed (its first whitelist candidate).
       */
      readonly whitelist?: true;
    }
  /** `details <code>` or `/show <code>`: the escalation's details. */
  | { readonly kind: 'details'; readonly code: string; readonly label?: number }
  /** `/pending`: list the pending escalations with their codes. */
  | { readonly kind: 'pending' }
  /**
   * A slash command (or `approve+`) with an argument it does not take, or
   * `/show` without a code.
   */
  | { readonly kind: 'usage'; readonly verb: EscalationReplyVerb };

const REPLY = /^(\/?)(approve\+|approve|deny|details|show|pending)(?:\s+(.+))?$/isu;

/**
 * A message that starts with `approve+` (optionally after a slash). No chat
 * word does, so one that {@link REPLY} does not parse (`approve+K7Q2`,
 * `approve++ K7Q2`) is an approval attempt with a typo, consumed as usage.
 */
const APPROVE_PLUS_ATTEMPT = /^\/?approve\+/iu;

/**
 * What may follow the verb: `#N`, `#N CODE` or `CODE`. A code attempt is any
 * short run of letters and digits, so a mistyped code (`approve K7Q`) is
 * consumed and refused instead of being forwarded to the agent as chat; only
 * an exact code of a pending escalation is ever acted on.
 */
const TARGET = /^(?:#(\d{1,9})(?:\s+([a-z0-9]{1,8}))?|([a-z0-9]{1,8}))$/iu;

/**
 * Parses an escalation reply, or returns null for any other message (which
 * then goes to the agent). Recognized, case-insensitively:
 *
 * - `approve`, `approve+` and `deny`, with or without a leading slash, bare
 *   or followed by `#N`, `#N CODE` or `CODE` (`approve+` approves and
 *   whitelists the pattern shown in the banner);
 * - `details CODE` / `details #N CODE`, with or without a slash, and the
 *   same as `/show CODE` / `/show #N CODE`;
 * - `/pending`.
 *
 * Trailing `.` or `!` is ignored. `show` and `pending` count only with the
 * slash, so `show tests` stays a chat message. A bare `details`, and
 * `approve`/`deny` followed by anything longer (`approve the plan`), stay
 * chat messages; with a leading slash they are reported as `usage` instead,
 * because slash commands are never forwarded. `approve+` is no chat word, so
 * any other message that starts with it (`approve+ the plan`, `approve+K7Q2`)
 * is reported as `usage` too.
 */
export function parseEscalationReply(text: string): EscalationReply | null {
  const trimmed = text.trim().replace(/[.!]+$/u, '');
  const match = REPLY.exec(trimmed);
  if (!match) return APPROVE_PLUS_ATTEMPT.test(trimmed) ? { kind: 'usage', verb: 'approve+' } : null;
  // Optional groups are undefined when they did not participate.
  const groups = match as ArrayLike<string | undefined>;
  const slash = groups[1] === '/';
  const verb = match[2].toLowerCase() as EscalationReplyVerb;
  const argument = groups[3]?.trim() ?? '';
  if ((verb === 'show' || verb === 'pending') && !slash) return null;
  const usage: EscalationReply | null = slash || verb === 'approve+' ? { kind: 'usage', verb } : null;

  if (verb === 'pending') return argument === '' ? { kind: 'pending' } : usage;
  const decision = verb === 'deny' ? 'denied' : 'approved';
  const whitelist = verb === 'approve+' ? { whitelist: true as const } : {};

  if (argument === '') {
    if (verb === 'details' || verb === 'show') return usage;
    return { kind: 'decision', decision, ...whitelist };
  }

  const targetMatch = TARGET.exec(argument);
  if (!targetMatch) return usage;
  const target = targetMatch as ArrayLike<string | undefined>;
  const label = target[1] !== undefined ? Number(target[1]) : undefined;
  const code = (target[2] ?? target[3])?.toUpperCase();

  if (verb === 'details' || verb === 'show') {
    if (code === undefined) return usage;
    return { kind: 'details', code, ...(label !== undefined ? { label } : {}) };
  }
  return {
    kind: 'decision',
    decision,
    ...(code !== undefined ? { code } : {}),
    ...(label !== undefined ? { label } : {}),
    ...whitelist,
  };
}

/** The envelope fields {@link replySentAt} reads. */
export interface ReplyTimestamps {
  readonly serverReceivedTimestamp?: unknown;
  readonly dataMessage?: { readonly timestamp?: unknown };
}

function positiveTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * When a reply was sent, in ms since the epoch: the Signal server's receive
 * time when the envelope carries it (the server clock, not the sender's), or
 * else the sender's message timestamp. Undefined when neither is present.
 */
export function replySentAt(envelope: ReplyTimestamps): number | undefined {
  return positiveTimestamp(envelope.serverReceivedTimestamp) ?? positiveTimestamp(envelope.dataMessage?.timestamp);
}

/**
 * True when a reply sent at `sentAtMs` predates the escalation recorded at
 * `escalationReceivedAt` (an ISO timestamp) by more than the clock-skew
 * allowance, so it was written for something else. An unreadable
 * `escalationReceivedAt` counts as predating (fail closed).
 */
export function predatesEscalation(
  sentAtMs: number,
  escalationReceivedAt: string,
  skewMs: number = REPLY_CLOCK_SKEW_MS,
): boolean {
  const receivedAtMs = Date.parse(escalationReceivedAt);
  if (!Number.isFinite(receivedAtMs)) return true;
  return sentBefore(sentAtMs, receivedAtMs, skewMs);
}

/**
 * True when a reply sent at `sentAtMs` was sent more than the clock-skew
 * allowance before `instantMs` (host time, ms since the epoch), for example
 * before an escalation's banner had been delivered in full. A non-finite
 * `instantMs` counts as later than any reply (fail closed).
 */
export function sentBefore(sentAtMs: number, instantMs: number, skewMs: number = REPLY_CLOCK_SKEW_MS): boolean {
  if (!Number.isFinite(instantMs)) return true;
  return sentAtMs < instantMs - skewMs;
}
