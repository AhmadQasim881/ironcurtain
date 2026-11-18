/**
 * `ironcurtain doctor`'s V8 sandbox check always runs the real viability
 * probe: it never answers from the start-up cache marker, which a different
 * Node.js, architecture, isolated-vm build or installation sharing the home
 * may have written (see test/preflight-cache.test.ts for the cache itself).
 */

import { describe, expect, it, vi } from 'vitest';

const preflight = vi.hoisted(() => ({
  checkSandboxViability: vi.fn(async (options?: { useCache?: boolean }) =>
    options?.useCache === false
      ? { ok: true, message: 'V8 sandbox loaded successfully.' }
      : { ok: true, message: 'cached' },
  ),
}));

vi.mock('../src/utils/preflight-checks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/preflight-checks.js')>()),
  checkSandboxViability: preflight.checkSandboxViability,
}));

import { checkSandbox } from '../src/doctor/checks.js';

describe('doctor V8 sandbox check', () => {
  it('bypasses the cache marker', async () => {
    const result = await checkSandbox();

    expect(preflight.checkSandboxViability).toHaveBeenCalledTimes(1);
    expect(preflight.checkSandboxViability).toHaveBeenCalledWith({ useCache: false });
    expect(result).toEqual({ name: 'V8 sandbox', status: 'ok', message: 'OK' });
  });
});
