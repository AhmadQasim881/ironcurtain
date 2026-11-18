// Minimal stdio MCP server for the relay backend-timeout tests. One tool:
//   - `slow`: waits `ms` milliseconds, then returns "done after <ms>ms".
//     When `progressEveryMs` is set and the request carries a progress
//     token, it reports progress at that interval while it waits.
// Spawned by the relay (mcp-proxy-server) as a backend; its imports resolve
// from this file's location.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'slow-progress', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'slow',
      description: 'Waits, optionally reporting progress, then answers.',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'number' }, progressEveryMs: { type: 'number' } },
        required: ['ms'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const ms = Number(request.params.arguments?.ms ?? 0);
  const every = Number(request.params.arguments?.progressEveryMs ?? 0);
  const token = request.params._meta?.progressToken;
  let reported = 0;
  const timer =
    every > 0 && token !== undefined
      ? setInterval(() => {
          reported += 1;
          extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, progress: reported },
            })
            .catch(() => {});
        }, every)
      : undefined;
  await new Promise((resolve) => setTimeout(resolve, ms));
  if (timer) clearInterval(timer);
  return { content: [{ type: 'text', text: `done after ${ms}ms (${reported} progress reports)` }] };
});

await server.connect(new StdioServerTransport());
