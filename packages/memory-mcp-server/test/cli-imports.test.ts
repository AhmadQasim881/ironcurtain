/**
 * The entry point (src/index.ts) imports cli.ts for every command line, the model-store
 * commands (`--verify-models`, `--prefetch-models`, models/cli.ts) included. Those must
 * not load the database module (SQLite and sqlite-vec, native addons), so cli.ts loads
 * it only when one of its own commands (`backups`, `restore`) runs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const loads = vi.hoisted(() => ({ database: 0 }));

describe('cli.ts module loading', () => {
  afterEach(() => {
    vi.doUnmock('../src/storage/database.js');
    vi.resetModules();
  });

  it('loads the database module only when a database command runs', async () => {
    vi.resetModules();
    loads.database = 0;
    vi.doMock('../src/storage/database.js', () => {
      loads.database += 1;
      return { listDatabaseCopies: () => [], restoreDatabase: () => Promise.reject(new Error('not used')) };
    });

    const cli = await import('../src/cli.js');
    expect(cli.isAdminCommand('backups')).toBe(true);
    expect(cli.isAdminCommand('--verify-models')).toBe(false);
    expect(loads.database).toBe(0);

    const out: string[] = [];
    const code = await cli.runAdminCommand(
      ['backups', '--db', '/nonexistent/memory.db'],
      {},
      {
        out: (line) => out.push(line),
        err: (line) => out.push(line),
      },
    );
    expect(code).toBe(0);
    expect(out).toEqual(['No copies of /nonexistent/memory.db found.']);
    expect(loads.database).toBe(1);
  });
});
