/**
 * The relay subprocess (`mcp-proxy-server.ts`) forwards a backend's
 * `structuredContent` with its content, on success and on error. The memory
 * server's recall reports the source segments memory_expand takes there; a
 * relay that kept only `content` dropped them on every path.
 *
 * Spawns the real relay (under tsx) over stdio with a fake backend.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const relayPath = resolve(projectRoot, 'src/trusted-process/mcp-proxy-server.ts');
const tsxBin = resolve(projectRoot, 'node_modules/.bin/tsx');
const backendPath = resolve(__dirname, 'fixtures/structured-result-server.mjs');

const STRUCTURED = { source_segment_ids: ['0123456789abcdef0123456789abcdef'], memories_used: 1 };

let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
});

async function connectRelay(): Promise<Client> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCP_SERVERS_CONFIG: JSON.stringify({
      structured: { command: process.execPath, args: [backendPath], sandbox: false },
    }),
    SERVER_FILTER: 'structured',
    GENERATED_DIR: resolve(projectRoot, 'src/config/generated'),
    PROTECTED_PATHS: '[]',
    SANDBOX_POLICY: 'warn',
  };
  delete env.PROXY_SOCKET_PATH;
  delete env.PROXY_TCP_PORT;
  const transport = new StdioClientTransport({ command: tsxBin, args: [relayPath], env, stderr: 'ignore' });
  const relay = new Client({ name: 'relay-structured-test', version: '0.0.0' }, {});
  await relay.connect(transport);
  client = relay;
  return relay;
}

describe('relay structuredContent', { timeout: 60_000 }, () => {
  it('forwards the backend structuredContent with its content', async () => {
    const relay = await connectRelay();
    const result = await relay.callTool({ name: 'structured', arguments: {} }, CompatibilityCallToolResultSchema, {
      timeout: 30_000,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'structured answered' }]);
    expect(result.structuredContent).toEqual(STRUCTURED);
  });

  it('refuses over-nested arguments on the direct relay and serves the next call', async () => {
    const relay = await connectRelay();
    let value: unknown = 'note';
    for (let i = 0; i < 32; i++) value = { child: value };
    const refused = await relay.callTool(
      { name: 'structured', arguments: { value } },
      CompatibilityCallToolResultSchema,
    );
    expect(refused.isError).toBe(true);
    expect(refused.content).toEqual([{ type: 'text', text: 'Tool arguments exceed the resource evaluation limits' }]);

    const allowed = await relay.callTool(
      { name: 'structured', arguments: { value: ['note'] } },
      CompatibilityCallToolResultSchema,
    );
    expect(allowed.structuredContent).toEqual(STRUCTURED);
  });

  it('forwards it with an error result too', async () => {
    const relay = await connectRelay();
    const result = await relay.callTool(
      { name: 'structured_error', arguments: {} },
      CompatibilityCallToolResultSchema,
      { timeout: 30_000 },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(STRUCTURED);
  });
});
