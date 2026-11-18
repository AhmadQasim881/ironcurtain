/**
 * Tests for src/signal/escalation-reply.ts: the per-escalation reply code,
 * the parser that decides which messages are escalation replies, and the
 * timestamp checks that refuse replies written for an earlier escalation.
 */

import { describe, it, expect } from 'vitest';
import {
  EscalationCodes,
  ESCALATION_CODE_ALPHABET,
  ESCALATION_CODE_LENGTH,
  REPLY_CLOCK_SKEW_MS,
  parseEscalationReply,
  predatesEscalation,
  replySentAt,
  sentBefore,
} from '../../src/signal/escalation-reply.js';

describe('EscalationCodes', () => {
  it('derives a short code from the unambiguous alphabet', () => {
    const codes = new EscalationCodes();
    for (let index = 0; index < 200; index += 1) {
      const code = codes.codeFor(`esc-${index}`);
      expect(code).toHaveLength(ESCALATION_CODE_LENGTH);
      expect(code).toMatch(new RegExp(`^[${ESCALATION_CODE_ALPHABET}]+$`, 'u'));
    }
    expect(ESCALATION_CODE_ALPHABET).toHaveLength(32);
    expect(ESCALATION_CODE_ALPHABET).not.toMatch(/[01IO]/u);
  });

  it('gives the same escalation the same code under one key', () => {
    const codes = new EscalationCodes(Buffer.alloc(32, 7));
    expect(codes.codeFor('esc-1')).toBe(codes.codeFor('esc-1'));
    expect(new EscalationCodes(Buffer.alloc(32, 7)).codeFor('esc-1')).toBe(codes.codeFor('esc-1'));
  });

  it('depends on the key, so the escalation ID alone does not reveal the code', () => {
    const ids = Array.from({ length: 20 }, (_, index) => `esc-${index}`);
    const first = ids.map((id) => new EscalationCodes(Buffer.alloc(32, 1)).codeFor(id));
    const second = ids.map((id) => new EscalationCodes(Buffer.alloc(32, 2)).codeFor(id));
    expect(first).not.toEqual(second);
  });

  it('spreads different escalations over different codes', () => {
    const codes = new EscalationCodes();
    const seen = new Set(Array.from({ length: 1000 }, (_, index) => codes.codeFor(`esc-${index}`)));
    expect(seen.size).toBeGreaterThan(990);
  });
});

describe('parseEscalationReply', () => {
  it('parses approve and deny with a code, upper-casing it', () => {
    expect(parseEscalationReply('approve K7Q2')).toEqual({ kind: 'decision', decision: 'approved', code: 'K7Q2' });
    expect(parseEscalationReply('  /Deny  k7q2 ')).toEqual({ kind: 'decision', decision: 'denied', code: 'K7Q2' });
    expect(parseEscalationReply('APPROVE k7q2.')).toEqual({ kind: 'decision', decision: 'approved', code: 'K7Q2' });
  });

  it('parses bare replies and session labels, which carry no code', () => {
    expect(parseEscalationReply('approve')).toEqual({ kind: 'decision', decision: 'approved' });
    expect(parseEscalationReply('deny!')).toEqual({ kind: 'decision', decision: 'denied' });
    expect(parseEscalationReply('approve #2')).toEqual({ kind: 'decision', decision: 'approved', label: 2 });
    expect(parseEscalationReply('/deny #12')).toEqual({ kind: 'decision', decision: 'denied', label: 12 });
  });

  it('parses a label together with a code', () => {
    expect(parseEscalationReply('approve #3 m4tz')).toEqual({
      kind: 'decision',
      decision: 'approved',
      code: 'M4TZ',
      label: 3,
    });
  });

  it('treats any short token as a code attempt, so a mistyped code is not chat', () => {
    expect(parseEscalationReply('approve K7Q')).toEqual({ kind: 'decision', decision: 'approved', code: 'K7Q' });
    expect(parseEscalationReply('approve 2')).toEqual({ kind: 'decision', decision: 'approved', code: '2' });
  });

  it('parses details with a code', () => {
    expect(parseEscalationReply('details k7q2')).toEqual({ kind: 'details', code: 'K7Q2' });
    expect(parseEscalationReply('/details #4 K7Q2')).toEqual({ kind: 'details', code: 'K7Q2', label: 4 });
  });

  it('parses /show with a code as details', () => {
    expect(parseEscalationReply('/show k7q2')).toEqual({ kind: 'details', code: 'K7Q2' });
    expect(parseEscalationReply('/SHOW #2 K7Q2.')).toEqual({ kind: 'details', code: 'K7Q2', label: 2 });
  });

  it('parses /pending', () => {
    expect(parseEscalationReply('/pending')).toEqual({ kind: 'pending' });
    expect(parseEscalationReply(' /Pending! ')).toEqual({ kind: 'pending' });
  });

  it('parses approve+ as a whitelisting approval, with or without a slash', () => {
    expect(parseEscalationReply('approve+ k7q2')).toEqual({
      kind: 'decision',
      decision: 'approved',
      code: 'K7Q2',
      whitelist: true,
    });
    expect(parseEscalationReply('/APPROVE+ #3 m4tz.')).toEqual({
      kind: 'decision',
      decision: 'approved',
      code: 'M4TZ',
      label: 3,
      whitelist: true,
    });
    expect(parseEscalationReply('approve+')).toEqual({ kind: 'decision', decision: 'approved', whitelist: true });
    expect(parseEscalationReply('approve+ #2')).toEqual({
      kind: 'decision',
      decision: 'approved',
      label: 2,
      whitelist: true,
    });
  });

  it('consumes a malformed approve+ as usage instead of passing it to the agent', () => {
    expect(parseEscalationReply('approve+ the plan please')).toEqual({ kind: 'usage', verb: 'approve+' });
    expect(parseEscalationReply('/approve+ K7Q2 K7Q2')).toEqual({ kind: 'usage', verb: 'approve+' });
    // Typos without the space, doubled or followed by punctuation: still never chat.
    for (const text of ['approve+K7Q2', 'APPROVE+k7q2.', 'approve++ K7Q2', 'approve+: K7Q2', '/approve+K7Q2']) {
      expect(parseEscalationReply(text), text).toEqual({ kind: 'usage', verb: 'approve+' });
    }
  });

  it('leaves ordinary chat to the agent', () => {
    for (const text of [
      'approve the plan and continue',
      'please approve K7Q2',
      'I deny that',
      'details',
      'details please tell me more',
      'approvement',
      'approve-K7Q2',
      'approve K7Q2 K7Q2',
      'show K7Q2',
      'show tests',
      'pending',
      'pending K7Q2',
      'deny+ K7Q2',
      'hello',
    ]) {
      expect(parseEscalationReply(text), text).toBeNull();
    }
  });

  it('reports a slash command with an argument it does not take as usage', () => {
    expect(parseEscalationReply('/approve the plan')).toEqual({ kind: 'usage', verb: 'approve' });
    expect(parseEscalationReply('/deny everything now')).toEqual({ kind: 'usage', verb: 'deny' });
    expect(parseEscalationReply('/details')).toEqual({ kind: 'usage', verb: 'details' });
    expect(parseEscalationReply('/show')).toEqual({ kind: 'usage', verb: 'show' });
    expect(parseEscalationReply('/show me everything')).toEqual({ kind: 'usage', verb: 'show' });
    expect(parseEscalationReply('/show #2')).toEqual({ kind: 'usage', verb: 'show' });
    expect(parseEscalationReply('/pending now')).toEqual({ kind: 'usage', verb: 'pending' });
  });
});

describe('replySentAt', () => {
  it("prefers the Signal server's receive time over the sender's clock", () => {
    expect(replySentAt({ serverReceivedTimestamp: 2_000, dataMessage: { timestamp: 1_000 } })).toBe(2_000);
  });

  it("falls back to the sender's timestamp", () => {
    expect(replySentAt({ dataMessage: { timestamp: 1_000 } })).toBe(1_000);
    expect(replySentAt({ serverReceivedTimestamp: 0, dataMessage: { timestamp: 1_000 } })).toBe(1_000);
  });

  it('is undefined when neither timestamp is usable', () => {
    expect(replySentAt({})).toBeUndefined();
    expect(replySentAt({ serverReceivedTimestamp: '5', dataMessage: { timestamp: Number.NaN } })).toBeUndefined();
  });
});

describe('predatesEscalation', () => {
  const raisedAt = new Date('2026-11-11T10:00:00.000Z');

  it('refuses a reply sent before the escalation was raised, beyond the skew allowance', () => {
    expect(predatesEscalation(raisedAt.getTime() - REPLY_CLOCK_SKEW_MS - 1, raisedAt.toISOString())).toBe(true);
    expect(predatesEscalation(raisedAt.getTime() - 60_000, raisedAt.toISOString())).toBe(true);
  });

  it('accepts a reply sent after the escalation, or within the skew allowance', () => {
    expect(predatesEscalation(raisedAt.getTime() + 5_000, raisedAt.toISOString())).toBe(false);
    expect(predatesEscalation(raisedAt.getTime() - REPLY_CLOCK_SKEW_MS, raisedAt.toISOString())).toBe(false);
  });

  it('fails closed on an unreadable escalation time', () => {
    expect(predatesEscalation(Date.now(), 'not a date')).toBe(true);
  });
});

describe('sentBefore', () => {
  const deliveredAt = Date.parse('2026-11-11T10:00:30.000Z');

  it('is true for a reply sent before the instant, beyond the skew allowance', () => {
    expect(sentBefore(deliveredAt - REPLY_CLOCK_SKEW_MS - 1, deliveredAt)).toBe(true);
    expect(sentBefore(deliveredAt - 1, deliveredAt, 0)).toBe(true);
  });

  it('is false for a reply sent after the instant, or within the skew allowance', () => {
    expect(sentBefore(deliveredAt, deliveredAt, 0)).toBe(false);
    expect(sentBefore(deliveredAt - REPLY_CLOCK_SKEW_MS, deliveredAt)).toBe(false);
    expect(sentBefore(deliveredAt + 1, deliveredAt)).toBe(false);
  });

  it('fails closed on an unusable instant', () => {
    expect(sentBefore(Date.now(), Number.NaN)).toBe(true);
  });
});
