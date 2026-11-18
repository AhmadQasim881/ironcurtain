/**
 * The memory-mcp-server entry point (src/index.ts), run as a process (WP-94):
 *   - a server configured for another embedding model than the database's vectors
 *     refuses to start (exit code 1) and leaves the database untouched;
 *   - `backups` runs the maintenance command instead of the MCP server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initDatabase, snapshotDatabaseBeforeForget, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import { insertMemory } from '../src/storage/queries.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(PACKAGE_ROOT, 'src', 'index.ts');

function runEntry(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
      cwd: PACKAGE_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => {
      done({ code, stdout, stderr });
    });
  });
}

describe('memory-mcp-server entry point', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-entry-'));
    dbPath = join(dir, 'memory.db');
    const db = initDatabase(dbPath, 'Xenova/bge-base-en-v1.5');
    const vector = new Float32Array(EMBEDDING_DIMENSIONS);
    vector[0] = 1;
    insertMemory(
      db,
      { id: 'kept', namespace: 'test', content: 'a stored memory', tags: undefined, importance: 0.5 },
      vector,
    );
    snapshotDatabaseBeforeForget(db, dbPath);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to start when the embedding model does not match the stored vectors', async () => {
    const run = await runEntry([], {
      MEMORY_DB_PATH: dbPath,
      MEMORY_EMBEDDING_MODEL: 'Xenova/bge-small-en-v1.5',
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Refusing to open memory database');
    expect(run.stderr).toContain('(384 dimensions)');

    // Untouched: the database still opens for its own model, with its memory.
    const db = initDatabase(dbPath, 'Xenova/bge-base-en-v1.5');
    try {
      expect(db.prepare(`SELECT id FROM memories`).all()).toEqual([{ id: 'kept' }]);
    } finally {
      db.close();
    }
  }, 30_000);

  it('runs the backups command instead of the server', async () => {
    const run = await runEntry(['backups', '--db', dbPath], {});
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Copies of ${dbPath}:`);
    expect(run.stdout).toContain('before a memory_forget');
  }, 30_000);
});
