/**
 * Resolves the SQLite database path for the memory MCP server
 * based on the session context (persona or cron job), and the
 * directory of its model store (shared by every session).
 *
 * Memory is only available for persona and cron job sessions,
 * not for ad-hoc default sessions.
 */

import { resolve } from 'node:path';
import { getIronCurtainHome, getJobDir } from '../config/paths.js';
import { getPersonaDir } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';

/**
 * Where every memory server keeps its embedding and re-ranking models:
 * `~/.ironcurtain/models` (under IRONCURTAIN_HOME), shared by all personas
 * and jobs. The memory server downloads only pinned, hash-verified files into
 * it and checks them again before each load (packages/memory-mcp-server/src/
 * models/). It lives outside node_modules, so a root-owned global install
 * needs no write access to its own tree and an upgrade keeps the models.
 */
export function resolveMemoryModelsDir(): string {
  return resolve(getIronCurtainHome(), 'models');
}

/**
 * Returns the absolute path to the memory SQLite database.
 *
 * - Persona sessions: ~/.ironcurtain/personas/{name}/memory.db
 * - Cron jobs (no persona): ~/.ironcurtain/jobs/{jobId}/memory.db
 *
 * Uses the established path helpers and validators (createPersonaName,
 * getJobDir) to ensure consistent validation and path construction.
 */
export function resolveMemoryDbPath(opts: { persona?: string; jobId?: string }): string {
  if (opts.persona) {
    return resolve(getPersonaDir(createPersonaName(opts.persona)), 'memory.db');
  }

  if (opts.jobId) {
    return resolve(getJobDir(opts.jobId), 'memory.db');
  }

  throw new Error('resolveMemoryDbPath requires either persona or jobId');
}
