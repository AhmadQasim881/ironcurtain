/**
 * Which identity record a Signal recipient is verified against.
 *
 * signal-cli-rest-api lists the identity keys signal-cli knows for the bot's
 * contacts (`GET /v1/identities/{bot}`). Setup stores the recipient's key
 * fingerprint and, when signal-cli lists one, the account UUID (ACI) of that
 * record; at runtime the daemon compares the stored key with the record the
 * list holds now. {@link selectRecipientIdentity} is the one place that
 * decides which record that is, for setup and runtime alike:
 *
 * - With a stored UUID: the record listed under that UUID. It names the
 *   recipient's account whatever number signal-cli shows for it, so another
 *   record for the same number (for example a second identity of the
 *   account) is never mistaken for it. Verifying that record says nothing
 *   about who sent a message, so the sender is tied to the same account:
 *   {@link matchSenderAccount} flags a message from the recipient's number
 *   whose envelope names another account (the number moved to someone
 *   else's Signal account: SIM swap, number reassignment), and one that
 *   names no account, which cannot be tied to it.
 * - Without one (a configuration from before the UUID was recorded, or a
 *   signal-cli that lists none, and always at setup): the newest record for
 *   the recipient's number by its `added` time, the last one listed when the
 *   times do not tell them apart.
 *
 * No such record, or one without a fingerprint, means the key cannot be
 * verified now. Callers then reject the message and check again on the next
 * one: no lock (signal-cli may list a record without its number for a
 * while) and no cached success.
 */

/** The parts of a recipient's configuration the selection reads. */
export interface RecipientIdentity {
  /** The recipient's phone number (E.164). */
  readonly number: string;
  /** The account UUID stored at setup, when signal-cli listed one. */
  readonly uuid?: string;
}

/** The record chosen by {@link selectRecipientIdentity}. */
export interface SelectedIdentity {
  /** The key fingerprint without whitespace (signal-cli may list space-separated hex). */
  readonly fingerprint: string;
  /** The account UUID the record is listed under, when any. */
  readonly uuid?: string;
}

/** Removes whitespace from a fingerprint, as stored in config.json. */
export function normalizeFingerprint(value: string): string {
  return value.replace(/\s+/gu, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function sameNumber(listed: unknown, wanted: string): boolean {
  return typeof listed === 'string' && listed.replace(/\s+/gu, '') === wanted.replace(/\s+/gu, '');
}

/**
 * A record's `added` time in ms since the epoch. signal-cli-rest-api lists a
 * millisecond timestamp (as a string in JSON-RPC mode) or a date string;
 * anything else is unknown.
 */
function addedTime(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = nonEmptyText(value);
  if (text === undefined) return undefined;
  if (/^\d+$/u.test(text)) {
    const millis = Number(text);
    return Number.isSafeInteger(millis) ? millis : undefined;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * How a message's sender account (the envelope's `sourceUuid`) relates to
 * the account UUID stored at setup:
 *
 * - `unchecked`: no UUID is stored (a configuration from before it was
 *   recorded); the record check, by number, decides alone.
 * - `same`: the envelope names the stored account.
 * - `other`: it names another account: the number moved (SIM swap, number
 *   reassignment).
 * - `unnamed`: it names no account, so the sender cannot be tied to the
 *   stored one. The record check verifies the stored account's record, not
 *   the sender, so such a message must be rejected, not passed on to it.
 */
export type SenderAccountMatch = 'unchecked' | 'same' | 'other' | 'unnamed';

/** See {@link SenderAccountMatch}; UUIDs compare case-insensitively. */
export function matchSenderAccount(senderUuid: unknown, recipient: RecipientIdentity): SenderAccountMatch {
  const stored = nonEmptyText(recipient.uuid)?.toLowerCase();
  if (stored === undefined) return 'unchecked';
  const sender = nonEmptyText(senderUuid)?.toLowerCase();
  if (sender === undefined) return 'unnamed';
  return sender === stored ? 'same' : 'other';
}

/**
 * True when a stored account UUID exists and the envelope's sender account
 * (`sourceUuid`) is a different one (`matchSenderAccount` gives `other`).
 */
export function isOtherAccount(senderUuid: unknown, recipient: RecipientIdentity): boolean {
  return matchSenderAccount(senderUuid, recipient) === 'other';
}

/**
 * Chooses the identity record to verify the recipient against (see the
 * module comment), or returns undefined when the list (any JSON value) holds
 * none for the recipient or the chosen record has no fingerprint.
 */
export function selectRecipientIdentity(records: unknown, recipient: RecipientIdentity): SelectedIdentity | undefined {
  if (!Array.isArray(records)) return undefined;
  const wantedUuid = nonEmptyText(recipient.uuid)?.toLowerCase();
  let chosen: Record<string, unknown> | undefined;
  let chosenTime = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (!isRecord(record)) continue;
    const matches =
      wantedUuid !== undefined
        ? nonEmptyText(record.uuid)?.toLowerCase() === wantedUuid
        : sameNumber(record.number, recipient.number);
    if (!matches) continue;
    // Unknown times sort before known ones; among equals the later record wins.
    const time = addedTime(record.added) ?? Number.NEGATIVE_INFINITY;
    if (chosen === undefined || time >= chosenTime) {
      chosen = record;
      chosenTime = time;
    }
  }
  if (chosen === undefined || typeof chosen.fingerprint !== 'string') return undefined;
  const fingerprint = normalizeFingerprint(chosen.fingerprint);
  if (fingerprint === '') return undefined;
  const uuid = nonEmptyText(chosen.uuid);
  return { fingerprint, ...(uuid !== undefined ? { uuid } : {}) };
}
