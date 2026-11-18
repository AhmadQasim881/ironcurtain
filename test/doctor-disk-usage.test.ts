/**
 * `ironcurtain doctor` disk usage: sizes per category, what `prune` would
 * free, a warning when the home's filesystem runs low, and no writes.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IronCurtainConfig } from '../src/config/types.js';
import { RETENTION_CONFIG_DEFAULTS } from '../src/config/user-config.js';
import { checkDiskUsage } from '../src/doctor/disk-usage-checks.js';
import { testUserConfig } from './helpers/user-config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PLENTY = async (): Promise<{ free: number; total: number }> => ({ free: 500e9, total: 1000e9 });

function configWith(autoPrune: boolean): IronCurtainConfig {
  return {
    userConfig: testUserConfig({ retention: { ...RETENTION_CONFIG_DEFAULTS, autoPrune } }),
  } as unknown as IronCurtainConfig;
}

describe('checkDiskUsage', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-doctor-disk-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  function oldSession(id: string): string {
    const dir = join(home, 'sessions', id);
    mkdirSync(join(dir, 'sandbox'), { recursive: true });
    writeFileSync(join(dir, 'sandbox', 'big.bin'), Buffer.alloc(64 * 1024, 1));
    writeFileSync(join(dir, 'session.log'), 'x\n');
    const when = new Date(Date.now() - 60 * DAY_MS);
    for (const path of [join(dir, 'sandbox', 'big.bin'), join(dir, 'sandbox'), join(dir, 'session.log'), dir]) {
      utimesSync(path, when, when);
    }
    return dir;
  }

  it('reports usage per category and what prune would free, without changing anything', async () => {
    const dir = oldSession('old-session');
    mkdirSync(join(home, 'logs'));
    writeFileSync(join(home, 'logs', 'daemon.log'), 'line\n');
    const before = readdirSync(home).sort();

    const result = await checkDiskUsage(configWith(false), { freeSpace: PLENTY });

    expect(result.name).toBe('Disk usage');
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/sessions [\d.]+ KB \(1\)/);
    expect(result.message).toMatch(/logs [\d.]+ KB/);
    expect(result.message).toContain('free on its filesystem');
    expect(result.hint).toMatch(/`ironcurtain prune` would free [\d.]+ KB/);
    expect(result.hint).toContain('set retention.autoPrune');
    // Read-only: the dry run removed and locked nothing.
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(home).sort()).toEqual(before);
  });

  it('gives no hint when nothing is due, and does not suggest autoPrune when it is on', async () => {
    oldSession('old-session');
    const nothingDue = await checkDiskUsage(configWith(false), {
      freeSpace: PLENTY,
      dryRunPrune: async () => ({ dryRun: true, removed: [], kept: [], failed: [], notes: [], aborted: false }),
    });
    expect(nothingDue.hint).toBeUndefined();

    const autoPrune = await checkDiskUsage(configWith(true), { freeSpace: PLENTY });
    expect(autoPrune.hint).toMatch(/would free/);
    expect(autoPrune.hint).not.toContain('autoPrune');
  });

  it('warns when the filesystem of the home runs low on space', async () => {
    const low = await checkDiskUsage(configWith(false), {
      freeSpace: async () => ({ free: 1024 * 1024 * 1024, total: 500e9 }),
    });
    expect(low.status).toBe('warn');
    const lowShare = await checkDiskUsage(configWith(false), {
      freeSpace: async () => ({ free: 10e9, total: 1000e9 }),
    });
    expect(lowShare.status).toBe('warn');
    expect((await checkDiskUsage(configWith(false), { freeSpace: PLENTY })).status).toBe('ok');
  });

  it('reports a failed dry run as a hint instead of failing doctor', async () => {
    const result = await checkDiskUsage(configWith(false), {
      freeSpace: PLENTY,
      dryRunPrune: () => Promise.reject(new Error('boom')),
    });
    expect(result.status).toBe('ok');
    expect(result.hint).toContain('the retention dry run failed: boom');
  });
});
