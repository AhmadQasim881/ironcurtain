/**
 * Unit tests for the shared tool-call timeout contract
 * (`src/trusted-process/call-timeouts.ts`): the escalation wait and the
 * backend call bound derive from config, the parent always outlives the
 * relay's deadline, and the relay refuses a malformed environment value.
 */

import { describe, it, expect } from 'vitest';
import {
  BACKEND_CALL_TIMEOUT_ENV,
  CODE_MODE_CHAIN_GRACE_MS,
  DEFAULT_BACKEND_CALL_TIMEOUT_MS,
  DEFAULT_ESCALATION_TIMEOUT_SECONDS,
  MAX_PROGRESS_EXTENDED_CALL_MS,
  RELAY_CALL_GRACE_MS,
  backendCallTimeoutMsFromConfig,
  codeModeChainTimeoutMs,
  escalationTimeoutMsFromConfig,
  maxTotalBackendCallMs,
  parseBackendCallTimeoutMs,
  relayCallTimeoutMs,
} from '../src/trusted-process/call-timeouts.js';

describe('call-timeouts', () => {
  it('derives the escalation wait from escalationTimeoutSeconds', () => {
    expect(escalationTimeoutMsFromConfig({ escalationTimeoutSeconds: 30 })).toBe(30_000);
    expect(escalationTimeoutMsFromConfig({ escalationTimeoutSeconds: 600 })).toBe(600_000);
    expect(escalationTimeoutMsFromConfig({})).toBe(DEFAULT_ESCALATION_TIMEOUT_SECONDS * 1000);
    // Nonsense falls back to the default instead of a zero or negative wait.
    expect(escalationTimeoutMsFromConfig({ escalationTimeoutSeconds: 0 })).toBe(300_000);
    expect(escalationTimeoutMsFromConfig({ escalationTimeoutSeconds: Number.NaN })).toBe(300_000);
  });

  it('derives the backend call bound from backendCallTimeoutSeconds with a 300 s default', () => {
    expect(backendCallTimeoutMsFromConfig({})).toBe(DEFAULT_BACKEND_CALL_TIMEOUT_MS);
    expect(DEFAULT_BACKEND_CALL_TIMEOUT_MS).toBe(300_000);
    expect(backendCallTimeoutMsFromConfig({ backendCallTimeoutSeconds: 90 })).toBe(90_000);
    expect(backendCallTimeoutMsFromConfig({ backendCallTimeoutSeconds: -1 })).toBe(DEFAULT_BACKEND_CALL_TIMEOUT_MS);
  });

  it('makes the parent wait longer than the relay so the relay times out first', () => {
    expect(relayCallTimeoutMs(DEFAULT_BACKEND_CALL_TIMEOUT_MS)).toBe(
      DEFAULT_BACKEND_CALL_TIMEOUT_MS + RELAY_CALL_GRACE_MS,
    );
    expect(relayCallTimeoutMs(1_000)).toBeGreaterThan(1_000);
  });

  it('caps a progress-extended backend call at one hour, or at the bound when that is larger', () => {
    expect(MAX_PROGRESS_EXTENDED_CALL_MS).toBe(3_600_000);
    expect(maxTotalBackendCallMs(DEFAULT_BACKEND_CALL_TIMEOUT_MS)).toBe(3_600_000);
    expect(maxTotalBackendCallMs(7_200_000)).toBe(7_200_000);
  });

  it('keeps the Code Mode chain alive past one full escalation wait and one full relay call', () => {
    // Defaults: the relay call (300 s + 15 s grace) is the longer wait.
    expect(
      codeModeChainTimeoutMs({ escalationTimeoutMs: 300_000, backendCallTimeoutMs: DEFAULT_BACKEND_CALL_TIMEOUT_MS }),
    ).toBe(315_000 + CODE_MODE_CHAIN_GRACE_MS);
    // The maximum configurable escalation timeout (600 s) outlasts the old fixed 300 s chain.
    const chain = codeModeChainTimeoutMs({ escalationTimeoutMs: 600_000, backendCallTimeoutMs: 300_000 });
    expect(chain).toBe(600_000 + CODE_MODE_CHAIN_GRACE_MS);
    expect(chain).toBeGreaterThan(600_000);
  });

  it('parses the relay environment value and refuses malformed ones', () => {
    expect(BACKEND_CALL_TIMEOUT_ENV).toBe('BACKEND_CALL_TIMEOUT_MS');
    expect(parseBackendCallTimeoutMs(undefined)).toBe(DEFAULT_BACKEND_CALL_TIMEOUT_MS);
    expect(parseBackendCallTimeoutMs('')).toBe(DEFAULT_BACKEND_CALL_TIMEOUT_MS);
    expect(parseBackendCallTimeoutMs('42000')).toBe(42_000);
    for (const bad of ['0', '-5', '1.5', 'abc', '60s', '99999999999']) {
      expect(() => parseBackendCallTimeoutMs(bad)).toThrow(/BACKEND_CALL_TIMEOUT_MS/);
    }
  });
});
