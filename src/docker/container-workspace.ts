import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import { isEqualOrInsideFolded } from '../security/path-fold.js';
import { getPrivateScratchRoot } from '../trusted-process/spawn-cwd.js';
import type { DockerMount } from './types.js';

/** The workspace directory shared by host, agent, and nested Docker daemon. */
export const CONTAINER_WORKSPACE_DIR = '/workspace';

/** Options for {@link buildContainerWorkspaceMount}. */
export interface ContainerWorkspaceMountOptions {
  /**
   * Mount the workspace read-only: the agent's own tools can read it but
   * cannot create, change or delete anything in it. Set for a read-only
   * workspace session (`IronCurtainConfig.readOnlyWorkspace`), which writes
   * its declared outputs through the policy-checked filesystem MCP server
   * instead. Default false.
   */
  readonly readonly?: boolean;
}

/** Build the one host-workspace mount shared by agent and nested-daemon containers. */
export function buildContainerWorkspaceMount(
  workspaceDir: string,
  options: ContainerWorkspaceMountOptions = {},
): DockerMount {
  // User-selected paths are physically canonicalized by workspace validation.
  // Keep the mount helper filesystem-independent, but reject a source Docker
  // could reinterpret as a named volume or normalize to a different path.
  if (!isAbsolute(workspaceDir) || resolve(workspaceDir) !== workspaceDir || workspaceDir === '/') {
    throw new Error('container workspace source must be a canonical absolute directory below root');
  }
  // Defense in depth for any caller that skipped validateWorkspacePath():
  // files under a read-write bind mount never pass through the PolicyEngine,
  // so mounting the IronCurtain home (escalation IPC, config, credentials,
  // policies) or the user's home, or any ancestor of either, would hand the
  // agent that whole tree. This is a spelling-level check (folded, since it
  // only denies) and cannot see through symlinked path components; the
  // authoritative identity-based check is validateWorkspacePath().
  for (const trustedRoot of [getIronCurtainHome(), resolve(homedir())]) {
    if (isEqualOrInsideFolded(trustedRoot, workspaceDir)) {
      throw new Error(
        'container workspace source must not be the home directory, the IronCurtain home, or an ancestor of either',
      );
    }
  }
  // The MCP relays' private scratch root (srt settings, the sandboxed
  // servers' working directories, an OAuth server's access-token files) is
  // never mounted, whole, in part, or inside a larger mount such as /tmp.
  const scratchRoot = resolve(getPrivateScratchRoot());
  if (isEqualOrInsideFolded(scratchRoot, workspaceDir) || isEqualOrInsideFolded(workspaceDir, scratchRoot)) {
    throw new Error(
      'container workspace source must not be, contain or lie inside the private scratch directory of the MCP servers',
    );
  }
  return { source: workspaceDir, target: CONTAINER_WORKSPACE_DIR, readonly: options.readonly === true };
}
