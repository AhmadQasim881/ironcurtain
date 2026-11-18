/**
 * The filesystem MCP server exactly as IronCurtain ships it: the
 * `filesystem` entry of src/config/mcp-servers.json, resolved the way
 * loadConfig() does it (`node` + the absolute path of the exact-pinned
 * @modelcontextprotocol/server-filesystem dependency, with the allowed
 * directory as the last argument).
 *
 * Integration tests spawn the server through this helper so they run the
 * pinned version that tool-annotations.json describes, never `npx -y`
 * (which resolves whatever the registry or the working directory offers).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAllowedDirectoryToMcpArgs, resolveMcpServerPaths } from '../../src/config/index.js';
import type { MCPServerConfig } from '../../src/config/types.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Spawn spec (`command` + `args`) of the packaged filesystem server serving `allowedDirectory`. */
export function packagedFilesystemServer(allowedDirectory: string): Pick<MCPServerConfig, 'command' | 'args'> {
  const { command, args } = packagedFilesystemServerConfig(allowedDirectory);
  return { command, args };
}

/**
 * The whole shipped `filesystem` entry serving `allowedDirectory`, including
 * its `sandbox` section (confined to its MCP roots), resolved the way
 * loadConfig() resolves it.
 */
export function packagedFilesystemServerConfig(allowedDirectory: string): MCPServerConfig {
  const shipped = JSON.parse(readFileSync(resolve(projectRoot, 'src/config/mcp-servers.json'), 'utf-8')) as Record<
    string,
    MCPServerConfig
  >;
  const servers = { filesystem: { ...shipped.filesystem, args: [...shipped.filesystem.args] } };
  applyAllowedDirectoryToMcpArgs(servers, allowedDirectory);
  resolveMcpServerPaths(servers);
  return servers.filesystem;
}

/** Absolute path of the packaged server's entry point (the spec's first argument). */
export function packagedFilesystemServerEntry(): string {
  const [entry] = packagedFilesystemServer(projectRoot).args;
  return entry;
}
