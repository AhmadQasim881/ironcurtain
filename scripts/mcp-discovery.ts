/**
 * Shared MCP server discovery helper for developer scripts.
 *
 * Connects to configured MCP servers, lists their tools, and returns
 * structured tool entries. Used by show-system-prompt.ts to avoid
 * duplicating the connection/discovery logic.
 */

import { mkdirSync } from 'node:fs';
import { discoverLiveTools } from '../src/pipeline/live-tools.js';
import { effectiveSandboxPolicy } from '../src/config/sandbox-policy.js';
import { toDisplayText } from '../src/terminal/display-sanitize.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ServerListing } from '../src/session/prompts.js';

export interface ToolEntry {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: unknown;
}

/**
 * Connects to all configured MCP servers, lists their tools, and
 * returns the collected tool entries. Ensures the sandbox directory
 * exists so filesystem servers can start. Cleans up client connections
 * before returning.
 */
export async function discoverTools(config: IronCurtainConfig, clientName: string): Promise<ToolEntry[]> {
  mkdirSync(config.allowedDirectory, { recursive: true });

  const discovery = await discoverLiveTools(config.mcpServers, {
    serverCredentials: config.userConfig.serverCredentials,
    sandboxPolicy: effectiveSandboxPolicy(config),
    credentialProtection: config.userConfig.credentialProtection,
  });
  try {
    // Shared discovery owns client identities, containment and credentials;
    // the script's caller name labels its diagnostics only.
    const warn = (text: string): void => {
      process.stderr.write(`Warning: ${toDisplayText(`${clientName}: ${text}`, { maxLength: 2048 })}\n`);
    };
    if (discovery.sandboxWarning) warn(discovery.sandboxWarning);
    for (const skipped of discovery.skipped) warn(`failed to connect to "${skipped.name}": ${skipped.reason}`);
    return [...discovery.connections].flatMap(([serverName, connection]) =>
      connection.tools.map((tool) => ({
        serverName,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    );
  } finally {
    await discovery.close();
  }
}

/**
 * Builds ServerListing entries from discovered tools and the config.
 * Uses the `description` field from mcp-servers.json when available,
 * falling back to the server name.
 */
export function buildServerListings(tools: ToolEntry[], config: IronCurtainConfig): ServerListing[] {
  const serverNames = [...new Set(tools.map((t) => t.serverName))];
  return serverNames.map((name) => ({
    name,
    description: config.mcpServers[name]?.description ?? name,
  }));
}
