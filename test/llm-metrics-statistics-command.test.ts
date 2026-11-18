import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPersistenceIdentityProtector } from '../src/llm-metrics/identity-protector.js';
import { runStatisticsCommand } from '../src/llm-metrics/statistics-command.js';
import { compactLlmMetricsDatabase } from '../src/llm-metrics/persistence/maintenance.js';
import { LLM_METRICS_SCHEMA_VERSION } from '../src/llm-metrics/persistence/migrations.js';
import type { LlmDeleteBeforeResult } from '../src/llm-metrics/persistence/repository.js';
import { SqliteLlmMetricsRepository } from '../src/llm-metrics/persistence/sqlite-repository.js';
import {
  createStatisticsTestDatabase,
  statisticsRow,
  type StatisticsTestDatabase,
} from './helpers/llm-statistics-db.js';

function result(
  status: LlmDeleteBeforeResult['status'],
  deletedCount: number,
  snapshotMaxSequence: number | null,
): LlmDeleteBeforeResult {
  return { status, cutoffMs: 1_001, snapshotMaxSequence, deletedCount, chunksProcessed: 1 };
}

describe('statistics management command', () => {
  it('prints help without opening the database', async () => {
    const write = vi.fn();
    const openRepository = vi.fn();
    await runStatisticsCommand(['--help'], { write, openRepository });
    expect(write).toHaveBeenCalledWith(expect.stringContaining('statistics delete --before'));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('not secure erasure'));
    expect(openRepository).not.toHaveBeenCalled();
  });

  it('does not create a database when none exists', async () => {
    const write = vi.fn();
    const openRepository = vi.fn();
    await runStatisticsCommand(['delete', '--all'], {
      databasePath: '/missing/statistics.sqlite3',
      databaseExists: () => false,
      openRepository,
      write,
    });
    expect(openRepository).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('nothing was deleted'));
  });

  it('continues a stable bounded snapshot while preserving the initial cutoff', async () => {
    const deleteBefore = vi
      .fn()
      .mockResolvedValueOnce(result('partial', 10_000, 42))
      .mockResolvedValueOnce(result('complete', 7, 42));
    const close = vi.fn(async () => {});
    const write = vi.fn();

    await runStatisticsCommand(['delete', '--all'], {
      databasePath: '/tmp/statistics.sqlite3',
      databaseExists: () => true,
      now: () => 1_000,
      openRepository: async () => ({ deleteBefore, close }),
      write,
    });

    expect(deleteBefore).toHaveBeenNthCalledWith(1, 1_001, expect.not.objectContaining({ snapshotMaxSequence: 42 }));
    expect(deleteBefore).toHaveBeenNthCalledWith(2, 1_001, expect.objectContaining({ snapshotMaxSequence: 42 }));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Deleted 10007 statistics exchange(s)'));
    expect(close).toHaveBeenCalledOnce();
  });

  it('retries a busy maintenance lease with backoff and keeps the snapshot across retries', async () => {
    const deleteBefore = vi
      .fn()
      .mockResolvedValueOnce(result('partial', 10_000, 42))
      .mockResolvedValueOnce(result('busy', 0, null))
      .mockResolvedValueOnce(result('busy', 0, null))
      .mockResolvedValueOnce(result('complete', 5, 42));
    const close = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});
    const write = vi.fn();
    const writeError = vi.fn();

    await runStatisticsCommand(['delete', '--all'], {
      databasePath: '/tmp/statistics.sqlite3',
      databaseExists: () => true,
      now: () => 1_000,
      openRepository: async () => ({ deleteBefore, close }),
      write,
      writeError,
      sleep,
    });

    expect(deleteBefore).toHaveBeenCalledTimes(4);
    for (const call of [2, 3, 4]) {
      expect(deleteBefore).toHaveBeenNthCalledWith(call, 1_001, expect.objectContaining({ snapshotMaxSequence: 42 }));
    }
    expect(sleep.mock.calls).toEqual([[200], [400]]);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Deleted 10005 statistics exchange(s)'));
    expect(writeError).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails with a warning on standard error when the lease stays busy', async () => {
    const deleteBefore = vi
      .fn()
      .mockResolvedValueOnce(result('partial', 10_000, 42))
      .mockResolvedValue(result('busy', 0, null));
    const close = vi.fn(async () => {});
    const sleep = vi.fn<(delayMs: number) => Promise<void>>(async () => {});
    const write = vi.fn();
    const writeError = vi.fn();

    await expect(
      runStatisticsCommand(['delete', '--all'], {
        databasePath: '/tmp/statistics.sqlite3',
        databaseExists: () => true,
        now: () => 1_000,
        openRepository: async () => ({ deleteBefore, close }),
        write,
        writeError,
        sleep,
      }),
    ).rejects.toThrow(/did not complete: the maintenance lease stayed busy/);

    // One partial pass, then the initial busy pass and eight bounded retries.
    expect(deleteBefore).toHaveBeenCalledTimes(10);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([200, 400, 800, 1_600, 3_200, 5_000, 5_000, 5_000]);
    expect(deleteBefore).toHaveBeenLastCalledWith(1_001, expect.objectContaining({ snapshotMaxSequence: 42 }));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Deleted 10000 statistics exchange(s)'));
    expect(write).not.toHaveBeenCalledWith(expect.stringContaining('maintenance lease'));
    expect(writeError).toHaveBeenCalledWith(expect.stringMatching(/maintenance lease.*rows may remain/));
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails delete --all against a real database while another process holds the lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-statistics-busy-'));
    try {
      const databasePath = join(directory, 'statistics', 'llm-usage.sqlite3');
      const seeded = await SqliteLlmMetricsRepository.open({ databasePath });
      await seeded.close();
      const database = new DatabaseSync(databasePath);
      database
        .prepare(
          `INSERT INTO llm_maintenance_leases (lease_name, owner_id, expires_at_ms)
           VALUES ('llm-exchanges-delete', 'another-process-run', ?)`,
        )
        .run(Date.now() + 10 * 60 * 1_000);
      database.close();
      const sleep = vi.fn(async () => {});
      const writeError = vi.fn();

      await expect(
        runStatisticsCommand(['delete', '--all'], { databasePath, write: vi.fn(), writeError, sleep }),
      ).rejects.toThrow(/maintenance lease stayed busy/);
      expect(sleep).toHaveBeenCalledTimes(8);
      expect(writeError).toHaveBeenCalledWith(expect.stringMatching(/rows may remain/));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('restarts the busy budget after a pass that made progress', async () => {
    const busy = result('busy', 0, null);
    const deleteBefore = vi.fn();
    for (let round = 0; round < 3; round++) {
      for (let attempt = 0; attempt < 8; attempt++) deleteBefore.mockResolvedValueOnce(busy);
      deleteBefore.mockResolvedValueOnce(result('partial', 10_000, 42));
    }
    deleteBefore.mockResolvedValueOnce(result('complete', 1, 42));
    const sleep = vi.fn(async () => {});

    await runStatisticsCommand(['delete', '--all'], {
      databasePath: '/tmp/statistics.sqlite3',
      databaseExists: () => true,
      now: () => 1_000,
      openRepository: async () => ({ deleteBefore, close: vi.fn(async () => {}) }),
      write: vi.fn(),
      writeError: vi.fn(),
      sleep,
    });

    expect(deleteBefore).toHaveBeenCalledTimes(28);
    expect(sleep).toHaveBeenCalledTimes(24);
  });

  it('keeps the --all reporting cutoff inside the JavaScript Date range', async () => {
    const deleteBefore = vi.fn().mockResolvedValue(result('complete', 0, null));
    const write = vi.fn();

    await runStatisticsCommand(['delete', '--all'], {
      databasePath: '/tmp/statistics.sqlite3',
      databaseExists: () => true,
      now: () => 8_640_000_000_000_000,
      openRepository: async () => ({ deleteBefore, close: vi.fn(async () => {}) }),
      write,
    });

    expect(deleteBefore).toHaveBeenCalledWith(8_640_000_000_000_000, expect.any(Object));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Deleted 0 statistics exchange(s)'));
  });

  it('rejects ambiguous or malformed deletion requests before opening storage', async () => {
    const openRepository = vi.fn();
    await expect(
      runStatisticsCommand(['delete', '--all', '--before', '2026-08-15'], { openRepository }),
    ).rejects.toThrow(/either --before or --all/);
    await expect(runStatisticsCommand(['delete', '--before', 'not-a-date'], { openRepository })).rejects.toThrow(
      /Invalid statistics cutoff/,
    );
    await expect(
      runStatisticsCommand(['delete', '--before', '2026-08-15T12:00:00'], { openRepository }),
    ).rejects.toThrow(/Invalid statistics cutoff/);
    await expect(runStatisticsCommand(['delete', '--before', '2026-02-30'], { openRepository })).rejects.toThrow(
      /Invalid statistics cutoff/,
    );
    await expect(
      runStatisticsCommand(['delete', '--before', String(Number.MAX_SAFE_INTEGER)], { openRepository }),
    ).rejects.toThrow(/Invalid statistics cutoff/);
    await expect(runStatisticsCommand(['delete'], { openRepository })).rejects.toThrow(/requires --before.*--all/);
    expect(openRepository).not.toHaveBeenCalled();
  });

  it('keeps subcommand options apart', async () => {
    const openRepository = vi.fn();
    await expect(runStatisticsCommand(['summary', '--all'], { openRepository })).rejects.toThrow(/apply only to/);
    await expect(runStatisticsCommand(['delete', '--all', '--json'], { openRepository })).rejects.toThrow(
      /apply only to statistics summary/,
    );
    await expect(runStatisticsCommand(['reset', '--all'], { openRepository })).rejects.toThrow(/takes no options/);
    await expect(runStatisticsCommand(['summary', '--days', '367'], { openRepository })).rejects.toThrow(
      /--days must be a whole number from 1 to 366/,
    );
    await expect(runStatisticsCommand(['summary', 'extra'], { openRepository })).rejects.toThrow(/Usage/);
    expect(openRepository).not.toHaveBeenCalled();
  });
});

describe('statistics summary and reset', () => {
  const databases: StatisticsTestDatabase[] = [];
  const NOW = Date.parse('2026-08-20T12:00:00.000Z');

  afterEach(() => {
    for (const database of databases.splice(0)) database.remove();
  });

  function seededDatabase(): { database: StatisticsTestDatabase; statisticsDirectory: string } {
    const database = createStatisticsTestDatabase('ironcurtain-statistics-command-');
    databases.push(database);
    const statisticsDirectory = join(database.directory, 'statistics');
    const protector = createPersistenceIdentityProtector(statisticsDirectory);
    const persona = protector.protectLabel('persona', 'security-reviewer');
    const profile = protector.protectLabel('profile', 'work-openrouter');
    database.insert([
      statisticsRow({ completedAtMs: NOW - 1_000, personaId: persona, providerProfile: profile, costUsd: 0.25 }),
      statisticsRow({ completedAtMs: NOW - 2_000, personaId: persona, providerProfile: profile, costUsd: 0.25 }),
      // Priced by the host at list prices (no gateway-reported cost).
      statisticsRow({
        completedAtMs: NOW - 3_000,
        personaId: null,
        workflowRunId: 'workflow-run-7',
        outcome: 'error',
        costUsd: null,
        estimatedCostUsd: 0.5,
      }),
      // Outside a 7-day window.
      statisticsRow({ completedAtMs: NOW - 10 * 24 * 60 * 60 * 1_000, personaId: persona }),
    ]);
    return { database, statisticsDirectory };
  }

  it('prints usage, speed and breakdowns with configured names instead of pseudonyms', async () => {
    const { database, statisticsDirectory } = seededDatabase();
    let output = '';
    await runStatisticsCommand(['summary', '--days', '7'], {
      databasePath: database.databasePath,
      statisticsDirectory,
      now: () => NOW,
      labelCandidates: () => ({ personas: ['security-reviewer'], providerProfiles: ['work-openrouter'], agents: [] }),
      write: (message) => {
        output += message;
      },
    });
    expect(output).toContain('last 7 day(s)');
    expect(output).toMatch(/Exchanges\s+3\b/);
    expect(output).toMatch(/Errors\s+1\s+33\.3%/);
    // Gateway-reported costs plus the list-price estimate.
    expect(output).toMatch(/Cost\s+\$1\.00\s+3 of 3 exchanges priced \(gateway-reported or list price\)/);
    expect(output).toMatch(/workflow-run-7\s+1 exchanges\s+15 tokens\s+\$0\.50/);
    expect(output).toMatch(/Effective speed\s+83\.3 tok\/s/);
    expect(output).toMatch(/security-reviewer\s+2 exchanges/);
    expect(output).toMatch(/work-openrouter\s+2 exchanges/);
    expect(output).toMatch(/\(none\)\s+1 exchanges/);
    expect(output).toMatch(/workflow-run-7\s+1 exchanges/);
    expect(output).toMatch(/claude-code\s+3 exchanges/);
    expect(output).not.toContain('hmac:');

    let json = '';
    await runStatisticsCommand(['summary', '--days', '30', '--json'], {
      databasePath: database.databasePath,
      statisticsDirectory,
      now: () => NOW,
      labelCandidates: () => ({ personas: ['security-reviewer'], providerProfiles: [], agents: [] }),
      write: (message) => {
        json += message;
      },
    });
    const parsed = JSON.parse(json) as {
      overall: { measure: string; value: number }[];
      breakdowns: Record<string, { labels?: Record<string, string> }[]>;
    };
    expect(parsed.overall.find((summary) => summary.measure === 'requestCount')?.value).toBe(4);
    expect(parsed.breakdowns.persona.some((summary) => summary.labels?.personaId === 'security-reviewer')).toBe(true);
  });

  it('escapes JSON model labels while preserving their decoded value', async () => {
    const database = createStatisticsTestDatabase('ironcurtain-statistics-json-');
    databases.push(database);
    const model = 'neutral\u0085\u202e\u034f';
    database.insert([statisticsRow({ completedAtMs: NOW - 1_000, forwardedModel: model })]);
    let out = '';
    await runStatisticsCommand(['summary', '--days', '1', '--json'], {
      databasePath: database.databasePath,
      statisticsDirectory: join(database.directory, 'statistics'),
      now: () => NOW,
      write: (text) => {
        out += text;
      },
    });
    expect(out).not.toMatch(/\u0085|\u202e|\u034f/u);
    expect(JSON.stringify(JSON.parse(out))).toContain(model);
  });

  it('shows an unpriced window as unknown and a partly priced one as a lower bound', async () => {
    const database = createStatisticsTestDatabase('ironcurtain-statistics-cost-');
    databases.push(database);
    database.insert([statisticsRow({ completedAtMs: NOW - 1_000, costUsd: null })]);
    const summary = async (): Promise<string> => {
      let output = '';
      await runStatisticsCommand(['summary', '--days', '1'], {
        databasePath: database.databasePath,
        statisticsDirectory: join(database.directory, 'statistics'),
        now: () => NOW,
        write: (message) => {
          output += message;
        },
      });
      return output;
    };

    expect(await summary()).toMatch(/Cost\s+unknown\s+0 of 1 exchanges priced/);
    database.insert([statisticsRow({ completedAtMs: NOW - 2_000, costUsd: null, estimatedCostUsd: 0.25 })]);
    const partlyPriced = await summary();
    expect(partlyPriced).toMatch(/Cost\s+≥ \$0\.25\s+1 of 2 exchanges priced/);
    expect(partlyPriced).toMatch(/claude-code\s+2 exchanges\s+30 tokens\s+≥ \$0\.25/);
  });

  it('reports a missing database without creating one', async () => {
    const write = vi.fn();
    const openReader = vi.fn();
    await runStatisticsCommand(['summary'], {
      databasePath: '/missing/statistics.sqlite3',
      databaseExists: () => false,
      openReader,
      write,
    });
    expect(openReader).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('No statistics database exists'));
  });

  it('resets in order: deletes every row, then rotates the key, then compacts', async () => {
    const { database, statisticsDirectory } = seededDatabase();
    // Recorded while the clock ran ahead: still a row from before the reset.
    database.insert([statisticsRow({ completedAtMs: NOW + 2 * 24 * 60 * 60 * 1_000 })]);
    const keyPath = join(statisticsDirectory, 'identity.key');
    const oldKey = readFileSync(keyPath);
    let output = '';
    await runStatisticsCommand(['reset'], {
      databasePath: database.databasePath,
      statisticsDirectory,
      now: () => NOW,
      write: (message) => {
        output += message;
      },
    });

    expect(output).toMatch(/Deleted 5 statistics exchange\(s\)\.\nRotated the statistics identity key\.\nCompacted/);
    expect(readFileSync(keyPath)).not.toEqual(oldKey);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const verification = new DatabaseSync(database.databasePath, { readOnly: true });
    try {
      expect(verification.prepare('SELECT COUNT(*) AS count FROM llm_exchanges').get()).toMatchObject({ count: 0 });
      expect(verification.prepare('PRAGMA freelist_count').get()).toMatchObject({ freelist_count: 0 });
    } finally {
      verification.close();
    }
    expect(statSync(database.databasePath).mode & 0o777).toBe(0o600);
  });

  it('stops before rotating the key when rows remain', async () => {
    for (const status of ['busy', 'partial'] as const) {
      const rotateIdentityKey = vi.fn();
      const compactDatabase = vi.fn();
      const close = vi.fn(async () => {});
      const sleep = vi.fn(async () => {});
      const deleteBefore = vi.fn().mockResolvedValue({
        status,
        cutoffMs: 1,
        snapshotMaxSequence: status === 'busy' ? null : 5,
        deletedCount: 0,
        chunksProcessed: 0,
      });
      await expect(
        runStatisticsCommand(['reset'], {
          databasePath: '/tmp/statistics.sqlite3',
          databaseExists: () => true,
          now: () => 1_000,
          openRepository: async () => ({ deleteBefore, close }),
          rotateIdentityKey,
          compactDatabase,
          write: vi.fn(),
          sleep,
        }),
      ).rejects.toThrow(
        status === 'busy'
          ? /maintenance lease.*identity key was not rotated/
          : /pass limit.*identity key was not rotated/,
      );
      // A busy lease is retried with the same bounded backoff as `delete` before the reset gives up.
      expect(sleep).toHaveBeenCalledTimes(status === 'busy' ? 8 : 0);
      expect(rotateIdentityKey).not.toHaveBeenCalled();
      expect(compactDatabase).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it('waits out a briefly busy maintenance lease, then resets', async () => {
    const rotateIdentityKey = vi.fn();
    const compactDatabase = vi.fn(() => ({ walTruncated: true }));
    const sleep = vi.fn(async () => {});
    const deleteBefore = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'busy',
        cutoffMs: 1,
        snapshotMaxSequence: null,
        deletedCount: 0,
        chunksProcessed: 0,
      })
      .mockResolvedValueOnce({
        status: 'complete',
        cutoffMs: 1,
        snapshotMaxSequence: 9,
        deletedCount: 9,
        chunksProcessed: 1,
      });
    const write = vi.fn();

    await runStatisticsCommand(['reset'], {
      databasePath: '/state/statistics/llm-usage.sqlite3',
      databaseExists: () => true,
      openRepository: async () => ({ deleteBefore, close: vi.fn(async () => {}) }),
      rotateIdentityKey,
      compactDatabase,
      write,
      sleep,
    });

    expect(sleep.mock.calls).toEqual([[200]]);
    expect(write).toHaveBeenCalledWith('Deleted 9 statistics exchange(s).\n');
    expect(rotateIdentityKey).toHaveBeenCalledWith('/state/statistics');
    expect(compactDatabase).toHaveBeenCalledWith('/state/statistics/llm-usage.sqlite3');
  });

  it('compacts a newer schema whose range admits this writer and refuses one that does not', () => {
    const database = createStatisticsTestDatabase('ironcurtain-statistics-compact-');
    databases.push(database);
    const setSchema = (minWriterSchema: number): void => {
      const raw = new DatabaseSync(database.databasePath);
      try {
        raw.prepare("UPDATE llm_metrics_meta SET value = ? WHERE key = 'min_writer_schema'").run(minWriterSchema);
        raw.exec(`PRAGMA user_version = ${LLM_METRICS_SCHEMA_VERSION + 1}`);
      } finally {
        raw.close();
      }
    };

    setSchema(LLM_METRICS_SCHEMA_VERSION);
    expect(compactLlmMetricsDatabase(database.databasePath)).toEqual({ walTruncated: true });
    const compacted = new DatabaseSync(database.databasePath, { readOnly: true });
    try {
      expect(compacted.prepare('PRAGMA user_version').get()).toMatchObject({
        user_version: LLM_METRICS_SCHEMA_VERSION + 1,
      });
    } finally {
      compacted.close();
    }

    setSchema(LLM_METRICS_SCHEMA_VERSION + 1);
    expect(() => compactLlmMetricsDatabase(database.databasePath)).toThrow(
      `requires writer schema ${LLM_METRICS_SCHEMA_VERSION + 1} or newer`,
    );
  });

  it('rotates an existing key even when no database exists', async () => {
    const rotateIdentityKey = vi.fn();
    const compactDatabase = vi.fn();
    const openRepository = vi.fn();
    const write = vi.fn();
    await runStatisticsCommand(['reset'], {
      databasePath: '/state/statistics/llm-usage.sqlite3',
      databaseExists: (path) => path.endsWith('identity.key'),
      openRepository,
      rotateIdentityKey,
      compactDatabase,
      write,
    });
    expect(openRepository).not.toHaveBeenCalled();
    expect(rotateIdentityKey).toHaveBeenCalledWith('/state/statistics');
    expect(compactDatabase).not.toHaveBeenCalled();
  });
});
