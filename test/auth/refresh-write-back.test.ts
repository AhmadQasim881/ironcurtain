import { describe, expect, it } from 'vitest';

import { keepsStoredToken } from '../../src/auth/refresh-write-back.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

describe('keepsStoredToken', () => {
  it('keeps a stored token that expires later than the refreshed one (issued after ours)', () => {
    const stored = { refreshToken: 'rt-0', expiresAt: NOW + 2 * HOUR };
    const refreshed = { refreshToken: 'rt-0', expiresAt: NOW + HOUR };
    expect(keepsStoredToken(stored, refreshed, 'rt-0', NOW)).toBe(true);
    expect(keepsStoredToken(stored, refreshed, undefined, NOW)).toBe(true);
  });

  it('replaces the token the refresh was made from', () => {
    const stored = { refreshToken: 'rt-0', expiresAt: NOW - 1_000 };
    expect(keepsStoredToken(stored, { refreshToken: 'rt-1', expiresAt: NOW + HOUR }, 'rt-0', NOW)).toBe(false);
    // Providers that do not rotate hand back the same refresh token.
    expect(keepsStoredToken(stored, { refreshToken: 'rt-0', expiresAt: NOW + HOUR }, 'rt-0', NOW)).toBe(false);
  });

  it('keeps a usable token whose refresh token replaced the one we refreshed from (rotation or re-login)', () => {
    const stored = { refreshToken: 'rt-host', expiresAt: NOW + 30 * 60_000 };
    expect(keepsStoredToken(stored, { refreshToken: 'rt-ours', expiresAt: NOW + HOUR }, 'rt-0', NOW)).toBe(true);
  });

  it('replaces a replaced token that is about to expire, and one that already holds our new refresh token', () => {
    const nearlyExpired = { refreshToken: 'rt-host', expiresAt: NOW + 4 * 60_000 };
    expect(keepsStoredToken(nearlyExpired, { refreshToken: 'rt-ours', expiresAt: NOW + HOUR }, 'rt-0', NOW)).toBe(
      false,
    );
    const alreadyOurs = { refreshToken: 'rt-ours', expiresAt: NOW + 30 * 60_000 };
    expect(keepsStoredToken(alreadyOurs, { refreshToken: 'rt-ours', expiresAt: NOW + HOUR }, 'rt-0', NOW)).toBe(false);
  });

  it('replaces a stored token that still holds the refresh token our grant rotated away, however long it lasts', () => {
    const stored = { refreshToken: 'rt-0', expiresAt: NOW + 8 * HOUR };
    expect(keepsStoredToken(stored, { refreshToken: 'rt-1', expiresAt: NOW + HOUR }, 'rt-0', NOW)).toBe(false);
    // Without knowing which token the grant spent, the later expiry wins.
    expect(keepsStoredToken(stored, { refreshToken: 'rt-1', expiresAt: NOW + HOUR }, undefined, NOW)).toBe(true);
  });

  it('applies only the expiry rule without the refresh token the grant used', () => {
    const stored = { refreshToken: 'rt-host', expiresAt: NOW + 30 * 60_000 };
    expect(keepsStoredToken(stored, { refreshToken: 'rt-ours', expiresAt: NOW + HOUR }, undefined, NOW)).toBe(false);
  });
});
