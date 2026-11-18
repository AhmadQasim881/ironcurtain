/**
 * A maintenance pass keeps its lease for as long as it runs (WP-94). One phase can take
 * longer than the 15-minute lease when the LLM is slow (dozens of calls, each allowed a
 * minute); a lease renewed only between phases expired mid-phase, and another server on
 * the same database then started an overlapping pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Consolidation waits until the test releases it, like a phase waiting on a slow LLM. */
const phase = vi.hoisted(() => ({ release: null as null | (() => void) }));

vi.mock('../src/storage/consolidation.js', () => ({
  runConsolidation: vi.fn(
    () =>
      new Promise((resolve) => {
        phase.release = () => {
          resolve({ consolidated: 0, merged: 0, superseded: 0 });
        };
      }),
  ),
}));

import type Database from 'better-sqlite3';
import { initDatabase } from '../src/storage/database.js';
import {
  acquireMaintenanceLease,
  MAINTENANCE_LEASE_MS,
  MAINTENANCE_LEASE_RENEW_MS,
  runMaintenance,
} from '../src/storage/maintenance.js';
import { loadConfig } from '../src/config.js';

const NAMESPACE = 'test';

describe('maintenance lease during a long pass', () => {
  let dir: string;
  let first: Database.Database;
  let second: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    phase.release = null;
    dir = mkdtempSync(join(tmpdir(), 'memory-lease-renew-'));
    first = initDatabase(join(dir, 'test.db'), 'test-model');
    second = initDatabase(join(dir, 'test.db'), 'test-model');
  });

  afterEach(() => {
    vi.useRealTimers();
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('renews the lease while a phase waits, so no other server starts a pass until it ends', async () => {
    expect(MAINTENANCE_LEASE_RENEW_MS).toBeLessThan(MAINTENANCE_LEASE_MS);
    const config = { ...loadConfig({}), namespace: NAMESPACE, llmApiKey: null, llmBaseUrl: null };

    const pass = runMaintenance(first, config);
    expect(phase.release).not.toBeNull();

    // The first phase is still running after more than a whole lease.
    vi.advanceTimersByTime(MAINTENANCE_LEASE_MS + 60_000);
    expect(acquireMaintenanceLease(second, NAMESPACE)).toBe(false);

    phase.release?.();
    expect((await pass).skipped).toBeUndefined();

    // The pass released its lease when it ended, and stopped renewing it.
    expect(vi.getTimerCount()).toBe(0);
    expect(acquireMaintenanceLease(second, NAMESPACE)).toBe(true);
  });
});
