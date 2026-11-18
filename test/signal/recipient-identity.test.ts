/**
 * Tests for src/signal/recipient-identity.ts: which identity record a Signal
 * recipient is verified against, at setup and at runtime.
 */

import { describe, it, expect } from 'vitest';
import {
  isOtherAccount,
  matchSenderAccount,
  normalizeFingerprint,
  selectRecipientIdentity,
} from '../../src/signal/recipient-identity.js';

const NUMBER = '+15559876543';

describe('selectRecipientIdentity', () => {
  it('finds nothing in an empty, malformed or foreign list', () => {
    for (const records of [[], null, {}, 'oops', [null, 1, 'x'], [{ number: '+15550000000', fingerprint: 'other' }]]) {
      expect(selectRecipientIdentity(records, { number: NUMBER }), JSON.stringify(records)).toBeUndefined();
    }
  });

  it('finds nothing when the record has no fingerprint', () => {
    expect(selectRecipientIdentity([{ number: NUMBER }], { number: NUMBER })).toBeUndefined();
    expect(selectRecipientIdentity([{ number: NUMBER, fingerprint: ' ' }], { number: NUMBER })).toBeUndefined();
    expect(selectRecipientIdentity([{ number: NUMBER, fingerprint: 5 }], { number: NUMBER })).toBeUndefined();
  });

  it('normalizes the fingerprint and returns the account UUID', () => {
    expect(
      selectRecipientIdentity([{ number: '+1 555 987 6543', fingerprint: '05 a1 b2', uuid: ' aci-1 ' }], {
        number: NUMBER,
      }),
    ).toEqual({ fingerprint: '05a1b2', uuid: 'aci-1' });
    expect(normalizeFingerprint('05 a1\tb2\n')).toBe('05a1b2');
  });

  it('takes the newest record for the number by its added time, wherever it is listed', () => {
    const records = [
      { number: NUMBER, fingerprint: 'middle', added: '1700000005000' },
      { number: NUMBER, fingerprint: 'newest', added: '1700000009000' },
      { number: NUMBER, fingerprint: 'oldest', added: '1700000001000' },
    ];
    expect(selectRecipientIdentity(records, { number: NUMBER })?.fingerprint).toBe('newest');
  });

  it('reads added as a number, a millisecond string or a date', () => {
    const records = [
      { number: NUMBER, fingerprint: 'number', added: 1_700_000_000_000 },
      { number: NUMBER, fingerprint: 'date', added: '2030-01-01T00:00:00Z' },
      { number: NUMBER, fingerprint: 'millis', added: '1800000000000' },
    ];
    expect(selectRecipientIdentity(records, { number: NUMBER })?.fingerprint).toBe('date');
  });

  it('takes the last listed record when the times do not tell, and prefers a known time', () => {
    expect(
      selectRecipientIdentity(
        [
          { number: NUMBER, fingerprint: 'first' },
          { number: NUMBER, fingerprint: 'second', added: 'not a date' },
        ],
        { number: NUMBER },
      )?.fingerprint,
    ).toBe('second');
    expect(
      selectRecipientIdentity(
        [
          { number: NUMBER, fingerprint: 'dated', added: '1700000000000' },
          { number: NUMBER, fingerprint: 'undated' },
        ],
        { number: NUMBER },
      )?.fingerprint,
    ).toBe('dated');
  });

  it('with a stored UUID, verifies that record only, whatever its number and the other records', () => {
    const records = [
      { number: NUMBER, uuid: 'other-identity', fingerprint: 'other', added: '1700000009000' },
      { number: null, uuid: 'ACI-RECIPIENT', fingerprint: 'recipient', added: '1700000001000' },
    ];
    expect(selectRecipientIdentity(records, { number: NUMBER, uuid: 'aci-recipient' })).toEqual({
      fingerprint: 'recipient',
      uuid: 'ACI-RECIPIENT',
    });
  });

  it('with a stored UUID that is not listed, finds nothing (even when the number is)', () => {
    expect(
      selectRecipientIdentity([{ number: NUMBER, uuid: 'someone-new', fingerprint: 'new-key' }], {
        number: NUMBER,
        uuid: 'aci-recipient',
      }),
    ).toBeUndefined();
  });

  it('treats a blank stored UUID as none', () => {
    expect(
      selectRecipientIdentity([{ number: NUMBER, fingerprint: 'key' }], { number: NUMBER, uuid: '  ' })?.fingerprint,
    ).toBe('key');
  });
});

describe('isOtherAccount', () => {
  it('flags a sender account that is not the stored one', () => {
    expect(isOtherAccount('attacker-aci', { number: NUMBER, uuid: 'aci-recipient' })).toBe(true);
  });

  it('accepts the stored account, in any case and with surrounding space', () => {
    expect(isOtherAccount(' ACI-Recipient ', { number: NUMBER, uuid: 'aci-recipient' })).toBe(false);
  });

  it('cannot tell without a stored UUID or without a sender UUID', () => {
    expect(isOtherAccount('attacker-aci', { number: NUMBER })).toBe(false);
    expect(isOtherAccount('attacker-aci', { number: NUMBER, uuid: ' ' })).toBe(false);
    expect(isOtherAccount(undefined, { number: NUMBER, uuid: 'aci-recipient' })).toBe(false);
    expect(isOtherAccount('', { number: NUMBER, uuid: 'aci-recipient' })).toBe(false);
    expect(isOtherAccount(42, { number: NUMBER, uuid: 'aci-recipient' })).toBe(false);
  });
});

describe('matchSenderAccount', () => {
  const recorded = { number: NUMBER, uuid: 'aci-recipient' };

  it('ties the sender to the stored account, or flags another one', () => {
    expect(matchSenderAccount(' ACI-Recipient ', recorded)).toBe('same');
    expect(matchSenderAccount('attacker-aci', recorded)).toBe('other');
  });

  it('reports a sender that names no account when one is stored, so it can be refused', () => {
    for (const sender of [undefined, null, '', '  ', 42, {}]) {
      expect(matchSenderAccount(sender, recorded), JSON.stringify(sender)).toBe('unnamed');
    }
  });

  it('checks nothing without a stored UUID', () => {
    expect(matchSenderAccount('attacker-aci', { number: NUMBER })).toBe('unchecked');
    expect(matchSenderAccount(undefined, { number: NUMBER, uuid: ' ' })).toBe('unchecked');
  });
});
