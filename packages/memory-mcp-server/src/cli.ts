/**
 * Maintenance commands of the memory-mcp-server binary, run by a person in a terminal
 * (never by the MCP server itself):
 *
 *   memory-mcp-server backups [--db <path>]            list the copies kept next to the database
 *   memory-mcp-server restore <copy> [--db <path>]     restore the database from one of them
 *
 * The database defaults to MEMORY_DB_PATH (or the server's default path). IronCurtain
 * keeps a persona's memory at ~/.ironcurtain/personas/<name>/memory.db; stop the
 * sessions that use it before restoring.
 *
 * The entry point (index.ts) imports this module for every command line, so the
 * database module (SQLite) is loaded only when one of these commands runs: the
 * model-store commands (models/cli.ts) do not load it.
 */

import { parseArgs } from 'node:util';
import { defaultDbPath } from './config.js';
import type { DatabaseCopyKind } from './storage/database.js';

/**
 * The commands this module handles. The entry point starts the MCP server when there are
 * no arguments and hands any other command line to the model-store commands (models/cli.ts).
 */
export const ADMIN_COMMANDS = ['backups', 'restore'] as const;
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

export function isAdminCommand(arg: string | undefined): arg is AdminCommand {
  return arg !== undefined && (ADMIN_COMMANDS as readonly string[]).includes(arg);
}

export interface CliOutput {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  'Usage:',
  '  memory-mcp-server                                  start the MCP server (stdio)',
  '  memory-mcp-server backups [--db <path>]            list the copies kept next to the database',
  '  memory-mcp-server restore <copy> [--db <path>]     restore the database from one of them',
  '  memory-mcp-server --prefetch-models                download the pinned models (if missing), verify them',
  '  memory-mcp-server --verify-models                  check the installed models against their pins',
  '',
  'The database defaults to MEMORY_DB_PATH. Stop the sessions that use it before restoring;',
  'the current database is saved next to it first, so a restore can be undone.',
].join('\n');

const KIND_LABELS: Readonly<Record<DatabaseCopyKind, string>> = {
  'schema-upgrade': 'before a schema upgrade',
  'forget-snapshot': 'before a memory_forget',
  'before-restore': 'before a restore',
};

/** Run an admin command; resolves to the process exit code (0 success, 1 failure, 2 usage). */
export async function runAdminCommand(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  output: CliOutput,
): Promise<number> {
  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(argv);
  } catch (err) {
    output.err(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  const dbPath = parsed.db ?? env.MEMORY_DB_PATH ?? defaultDbPath();
  const { listDatabaseCopies, restoreDatabase } = await import('./storage/database.js');

  if (parsed.command === 'backups') {
    const copies = listDatabaseCopies(dbPath);
    if (copies.length === 0) {
      output.out(`No copies of ${dbPath} found.`);
      return 0;
    }
    output.out(`Copies of ${dbPath}:`);
    for (const copy of copies) {
      output.out(`  ${copy.path}  (${KIND_LABELS[copy.kind]}, ${formatBytes(copy.bytes)})`);
    }
    return 0;
  }

  const source = parsed.copy;
  if (source === undefined) {
    output.err(`restore needs the copy to restore from.\n\n${USAGE}`);
    return 2;
  }
  try {
    const result = await restoreDatabase(source, dbPath);
    output.out(`Restored ${result.dbPath} from ${result.backupPath} (schema ${result.restoredSchema}).`);
    if (result.previousCopy !== null) {
      output.out(`The database as it was before the restore is saved at ${result.previousCopy}.`);
    }
    return 0;
  } catch (err) {
    output.err(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function parseCommand(argv: readonly string[]): { command: AdminCommand; copy?: string; db?: string } {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { db: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  if (!isAdminCommand(command)) throw new Error(`Unknown command: ${command}`);
  const maxArgs = command === 'restore' ? 1 : 0;
  if (rest.length > maxArgs) throw new Error(`Unexpected argument: ${rest[maxArgs]}`);
  return { command, copy: rest[0], db: values.db };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
