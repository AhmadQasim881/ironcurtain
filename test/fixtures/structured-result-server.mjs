// Minimal stdio MCP server for the relay structuredContent test. Two tools:
//   - `structured`: answers with text content and structuredContent;
//   - `structured_error`: the same, as an error result.
// Spawned by the relay (mcp-proxy-server) as a backend; its imports resolve
// from this file's location.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'structured-result', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: ['structured', 'structured_error'].map((name) => ({
    name,
    description: 'Answers with structuredContent.',
    inputSchema: { type: 'object', properties: {} },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: `${request.params.name} answered` }],
  structuredContent: { source_segment_ids: ['0123456789abcdef0123456789abcdef'], memories_used: 1 },
  ...(request.params.name === 'structured_error' ? { isError: true } : {}),
}));

await server.connect(new StdioServerTransport());
