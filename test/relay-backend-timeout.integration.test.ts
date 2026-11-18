/**
 * The relay subprocess (`mcp-proxy-server.ts`) bounds each backend tool call
 * with the `BACKEND_CALL_TIMEOUT_MS` the parent hands it, resets that bound
 * on backend progress, and forwards the progress to its caller (WP-35,
 * SES-12).
 *
 * Before the fix the relay passed no options to `callTool`, so every backend
 * call was cut at the MCP SDK's 60 s default whatever the parent expected,
 * and backend progress could not extend it. Spawns the real relay (under
 * tsx) over stdio with a fake backend that sleeps and optionally reports
 * progress; a tiny bound keeps the test fast.
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
const backendPath = resolve(__dirname, 'fixtures/slow-progress-server.mjs');

/** The relay's backend bound in these tests. */
const BOUND_MS = 1_000;

let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
});

async function connectRelay(): Promise<Client> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCP_SERVERS_CONFIG: JSON.stringify({
      slow: { command: process.execPath, args: [backendPath], sandbox: false },
    }),
    SERVER_FILTER: 'slow',
    GENERATED_DIR: resolve(projectRoot, 'src/config/generated'),
    PROTECTED_PATHS: '[]',
    SANDBOX_POLICY: 'warn',
    BACKEND_CALL_TIMEOUT_MS: String(BOUND_MS),
  };
  delete env.PROXY_SOCKET_PATH;
  delete env.PROXY_TCP_PORT;
  const transport = new StdioClientTransport({ command: tsxBin, args: [relayPath], env, stderr: 'ignore' });
  const relay = new Client({ name: 'relay-timeout-test', version: '0.0.0' }, {});
  await relay.connect(transport);
  client = relay;
  return relay;
}

describe('relay backend call bound', { timeout: 60_000 }, () => {
  it('cuts a silent backend call at BACKEND_CALL_TIMEOUT_MS, not the SDK 60 s default', async () => {
    const relay = await connectRelay();
    const started = Date.now();
    const result = await relay.callTool(
      { name: 'slow', arguments: { ms: BOUND_MS * 3 } },
      CompatibilityCallToolResultSchema,
      { timeout: 30_000 },
    );
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/timed out/i);
    expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - 100);
    expect(elapsed).toBeLessThan(BOUND_MS * 3);
  });

  it('keeps a backend call alive while it reports progress and forwards that progress', async () => {
    const relay = await connectRelay();
    const progress: unknown[] = [];
    const result = await relay.callTool(
      { name: 'slow', arguments: { ms: BOUND_MS * 2.5, progressEveryMs: BOUND_MS / 5 } },
      CompatibilityCallToolResultSchema,
      {
        timeout: 30_000,
        onprogress: (p) => progress.push(p),
      },
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain(`done after ${BOUND_MS * 2.5}ms`);
    // Every backend report reached the caller through the relay.
    expect(progress.length).toBeGreaterThanOrEqual(5);
  });
});
