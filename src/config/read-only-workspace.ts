/**
 * The one place a session or workflow-bundle config becomes read-only
 * (see `src/types/read-only-workspace.ts` for what that means and who
 * enforces it). Both callers, the session factory for a read-only workflow
 * state and the workflow infrastructure factory for a read-only container
 * scope, go through {@link applyReadOnlyWorkspace} so the settings that must
 * travel together cannot drift apart.
 */

import type { IronCurtainConfig } from './types.js';
import type { ReadOnlyWorkspace } from '../types/read-only-workspace.js';

/**
 * The MCP server a read-only agent writes its declared outputs through: its
 * own tools cannot write the read-only workspace mount. Sessions and bundles
 * with a read-only workspace start it even when no compiled rule names it
 * (structural sandbox containment and the read-only workspace rule then decide
 * every call). A persona's server allowlist cannot leave it out: the allowlist
 * always keeps the filesystem server (`applyServerAllowlist`).
 */
export const READ_ONLY_OUTPUT_SERVER = 'filesystem';

/**
 * Returns a copy of `config` whose agent works on a read-only workspace:
 *
 * - `readOnlyWorkspace` is set, so Docker Agent Mode mounts `/workspace`
 *   read-only and the coordinator's policy engine denies every change outside
 *   `readOnlyWorkspace.writablePaths`, through every policy hot-swap.
 * - Nested Docker is switched off for the session (`dockerWorkload` disabled):
 *   its daemon mounts the workspace read-write for the agent's own containers,
 *   which would give the agent its write access back.
 *
 * `config` itself is not modified.
 */
export function applyReadOnlyWorkspace(
  config: IronCurtainConfig,
  readOnlyWorkspace: ReadOnlyWorkspace,
): IronCurtainConfig {
  return {
    ...config,
    readOnlyWorkspace,
    userConfig: { ...config.userConfig, dockerWorkload: { enabled: false } },
  };
}

/**
 * Refuses a config that asks for a read-only workspace together with nested
 * Docker. `applyReadOnlyWorkspace` never produces one; this guards the Docker
 * infrastructure against a caller that set the field some other way.
 */
export function assertReadOnlyWorkspaceSupported(
  config: Pick<IronCurtainConfig, 'readOnlyWorkspace' | 'userConfig'>,
): void {
  if (config.readOnlyWorkspace === undefined) return;
  if (config.userConfig.dockerWorkload?.enabled === true) {
    throw new Error(
      'A read-only workspace session cannot run with nested Docker: its daemon would mount the workspace ' +
        'read-write. Build the session config with applyReadOnlyWorkspace().',
    );
  }
}
