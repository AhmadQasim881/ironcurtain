/** Common MCP transport command; UDS keeps its existing local socat path. */
export const MCP_TCP_BRIDGE_PATH = '/usr/local/bin/ironcurtain-mcp-bridge.mjs';
export const MCP_TCP_TOKEN_ENV = 'IRONCURTAIN_MCP_TCP_TOKEN';
export function mcpClientCommand(address: string): { command: string; args: string[]; tcp: boolean } {
  const tcp = address.includes(':');
  return tcp
    ? { command: 'node', args: [MCP_TCP_BRIDGE_PATH, address], tcp }
    : { command: 'socat', args: ['STDIO', `UNIX-CONNECT:${address}`], tcp };
}
