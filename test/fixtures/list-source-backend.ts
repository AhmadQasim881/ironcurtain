/**
 * The fake data-backed list source (list-source-mcp-server.mjs) for tests of
 * dynamic-list resolution through the security kernel: its server config, the
 * shape of its call log, and a JSONL reader for that log and audit logs.
 *
 * The backend exposes tools whose names match the bundled tool annotations
 * (github: list_issues, push_files, and the unannotated send_report;
 * filesystem: read_text_file, write_file) and records every call it receives,
 * so a test can prove which calls the kernel let through.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MCPServerConfig } from '../../src/config/types.js';

/** Path of the fake backend script. */
export const LIST_SOURCE_BACKEND_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'list-source-mcp-server.mjs');

/** One line of the backend's call log. */
export interface ListSourceBackendRecord {
  readonly event: 'startup' | 'call';
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  /** Relay-internal variables the backend found in its environment (must be none). */
  readonly relayInternalVars?: string[];
  /** A host-only canary the backend found in its environment (must be null). */
  readonly hostCanary?: string | null;
}

/**
 * The fake backend recording to `callLogPath`. The log path travels in the
 * server's own `env` block: a relay forwards no other host variable to its
 * backend, so a value set in this process's environment would never arrive.
 */
export function listSourceBackend(callLogPath: string, flavor: 'github' | 'filesystem' = 'github'): MCPServerConfig {
  return {
    command: process.execPath,
    args: flavor === 'github' ? [LIST_SOURCE_BACKEND_PATH] : [LIST_SOURCE_BACKEND_PATH, flavor],
    env: { LIST_SOURCE_CALL_LOG: callLogPath },
    sandbox: false,
  };
}

/** Parses a JSONL file; a missing file has no records. */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}
