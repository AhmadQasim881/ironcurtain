/**
 * Hardened environment for the host-side git MCP backend.
 *
 * The built-in `git` MCP server (`@cyanheads/git-mcp-server`) runs host `git`
 * with the agent's repository as its working directory, and copies its own
 * `process.env` into every git invocation. That repository is agent-writable
 * in both session modes, so the relay must spawn the server with an
 * environment that neutralizes repository configuration (see
 * `buildBackendEnv` in `mcp-proxy-server.ts` for the threat model and the
 * residual risk). The mechanics live in `src/security/git-hardening.ts`
 * ({@link hardenedGitEnv}); this module only fixes the choices IronCurtain
 * makes for its git backend.
 */

import { dirname } from 'node:path';

import { hardenedGitEnv, type GitTransportProtocol } from '../security/git-hardening.js';
import { resolveRealPath } from '../types/argument-roles.js';

/**
 * Name of the MCP server that runs host git, as configured in
 * `mcp-servers.json`. The policy engine and the tool-call pipeline
 * special-case the same name; renaming the server drops this hardening.
 */
export const GIT_SERVER_NAME = 'git';

/**
 * Transports the git backend may use (`GIT_ALLOW_PROTOCOL`). Authenticated,
 * encrypted remotes only: never `ext::`/`fd::` (which run commands), and no
 * `file://` URLs or local paths, which would let a clone or fetch read any
 * repository on the host and run a planted `remote.<name>.uploadpack`.
 * Plain `git://` and `http://` are refused as well.
 */
export const GIT_BACKEND_PROTOCOLS: readonly GitTransportProtocol[] = ['https', 'ssh'];

/** True for the backend that runs host git and must be spawned with {@link hardenGitBackendEnv}. */
export function isGitBackend(serverName: string): boolean {
  return serverName === GIT_SERVER_NAME;
}

/**
 * The directory git repository discovery must never enter: the parent of the
 * allowed directory's real path. Git compares ceilings with `getcwd()`, which
 * is always a real path, so the parent of the lexical path would not bound a
 * symlinked workspace. A repository rooted at the allowed directory itself
 * (a `--workspace` checkout) is still found from any directory below it.
 */
export function gitDiscoveryCeiling(allowedDirectory: string): string {
  return dirname(resolveRealPath(allowedDirectory));
}

/**
 * Harden `env` for the git backend: {@link hardenedGitEnv} with
 * {@link GIT_BACKEND_PROTOCOLS}, the user's trusted global/system credential
 * helpers and `core.sshCommand` (read with `env`'s `HOME`, so `env` must be
 * the trusted relay environment), and `GIT_CEILING_DIRECTORIES` from
 * {@link gitDiscoveryCeiling} when an allowed directory is configured (relays
 * started by offline tooling may have none; an empty value counts as none).
 * Returns a new object; `env` is not modified.
 *
 * Throws when the hardening cannot be expressed (for example an allowed
 * directory whose parent contains the path-list delimiter); callers must then
 * not start the backend.
 */
export function hardenGitBackendEnv(
  env: Readonly<Record<string, string>>,
  allowedDirectory: string | undefined,
): Record<string, string> {
  const hardened = hardenedGitEnv({
    baseEnv: env,
    allowedProtocols: GIT_BACKEND_PROTOCOLS,
    ceilingDirectories: allowedDirectory ? [gitDiscoveryCeiling(allowedDirectory)] : [],
  });
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(hardened)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}
