/**
 * What the installed memory server package provides, found by resolving its
 * package exports: the package is never loaded, and nothing here throws when it
 * is missing. (memory-annotations.ts resolves the server's entry point when it
 * loads, and throws then.) So `ironcurtain doctor` can import this module and
 * still report a missing or outdated memory server.
 */

import { createRequire } from 'node:module';

const MEMORY_SERVER_PACKAGE = '@provos/memory-mcp-server';

/**
 * Whether `@provos/memory-mcp-server/<subpath>` resolves from `from` (default:
 * this module, i.e. the installed package IronCurtain runs). False when the
 * package does not export it (an older release) or the file is not there (a
 * checkout whose workspace package was not rebuilt).
 */
function resolvesExport(subpath: string, from: string | URL): boolean {
  try {
    createRequire(from).resolve(`${MEMORY_SERVER_PACKAGE}/${subpath}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the installed memory server has the review quarantine (WP-96): it
 * marks what a cron job or a workflow state writes as waiting for review under
 * the writer's scope (MEMORY_WRITER_SCOPE) and hides it from interactive
 * sessions until the user approves it. The quarantine shipped with the
 * package's `./admin` export (the API `ironcurtain memory ... review` approves
 * through), so a server without it predates the quarantine: the published
 * 0.2.1, or a checkout whose `packages/memory-mcp-server/dist` was built before
 * it. Such a server ignores MEMORY_WRITER_SCOPE and stores what an unattended
 * run writes among the memories interactive sessions read, so the host must
 * not start one for an unattended writer (buildMemoryServerConfig).
 */
export function memoryServerHasReviewQuarantine(from: string | URL = import.meta.url): boolean {
  return resolvesExport('admin', from);
}

/** How to replace a memory server that predates the review quarantine. */
export const UPDATE_MEMORY_SERVER_HINT =
  'Update @provos/memory-mcp-server to the version this IronCurtain release depends on (reinstall IronCurtain); ' +
  'in a source checkout, rebuild it with `npm run build -w packages/memory-mcp-server`.';
