// Minimal stdio MCP server for the spawn working-directory and environment
// tests. Tools:
//   - `report_cwd`: returns the server process's working directory;
//   - `report_env`: returns the value of the environment variable `name`
//     (empty string when unset);
//   - `report_env_all`: returns the server process's whole environment as a
//     JSON object.
// Spawned as `node test/fixtures/cwd-probe-server.mjs` (or under tsx); its
// imports resolve from this file's location, so the cwd it reports is the
// only thing the spawner controls.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'cwd-probe', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'report_cwd',
      description: 'Returns the working directory of the server process.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'report_env',
      description: 'Returns the value of one environment variable of the server process.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    {
      name: 'report_env_all',
      description: 'Returns the whole environment of the server process as JSON.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

function respond(name, args) {
  if (name === 'report_env') return process.env[String(args?.name)] ?? '';
  if (name === 'report_env_all') return JSON.stringify(process.env);
  return process.cwd();
}

server.setRequestHandler(CallToolRequestSchema, (request) => ({
  content: [{ type: 'text', text: respond(request.params.name, request.params.arguments) }],
}));

await server.connect(new StdioServerTransport());
