// Minimal stdio MCP server for the relay's session-log redaction test
// (test/relay-log-redaction.integration.test.ts). At startup it writes the
// value of the environment variable that STDERR_TOKEN_VARIABLE names to
// stderr, the way a server echoes its configuration or an authentication
// error, then either exits (STDERR_TOKEN_EXIT=1, a server that fails to
// start) or serves a single `ping` tool. With STDERR_TOKEN_SPLIT=1 the line
// goes out in two writes, split inside the value, which the relay then reads
// as two chunks (as it does a write larger than the pipe's atomic size).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const variable = process.env.STDERR_TOKEN_VARIABLE ?? '';
const value = process.env[variable] ?? '<unset>';
if (process.env.STDERR_TOKEN_SPLIT === '1') {
  const half = Math.floor(value.length / 2);
  process.stderr.write(`backend saw token=${value.slice(0, half)}`);
  await new Promise((settle) => setTimeout(settle, 200));
  process.stderr.write(`${value.slice(half)}\n`);
} else {
  process.stderr.write(`backend saw token=${value}\n`);
}
if (process.env.STDERR_TOKEN_EXIT === '1') process.exit(3);

const server = new Server({ name: 'stderr-token', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: 'ping', description: 'Returns pong.', inputSchema: { type: 'object', properties: {} } }],
}));

server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: 'pong' }] }));

await server.connect(new StdioServerTransport());
