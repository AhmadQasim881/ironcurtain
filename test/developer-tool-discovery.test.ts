import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IronCurtainConfig } from '../src/config/types.js';
import { testUserConfig } from './helpers/user-config.js';

const mocks = vi.hoisted(() => ({ discover: vi.fn(), direct: vi.fn(), close: vi.fn() }));
vi.mock('../src/pipeline/live-tools.js', () => ({ discoverLiveTools: mocks.discover }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(function blockedDirectTransport() {
    mocks.direct();
    throw new Error('direct developer spawn refused by test');
  }),
}));
import { discoverTools } from '../scripts/mcp-discovery.js';

describe('developer tool discovery containment', () => {
  let directory: string;
  let config: IronCurtainConfig;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'developer-discovery-'));
    config = {
      allowedDirectory: directory,
      auditLogPath: join(directory, 'audit.jsonl'),
      generatedDir: directory,
      constitutionPath: join(directory, 'constitution.md'),
      protectedPaths: [],
      agentModelId: 'test:model',
      escalationTimeoutSeconds: 120,
      mcpServers: { example: { command: 'unused', args: [], env: { DECLARED: 'yes' } } },
      sandboxPolicy: 'enforce',
      userConfig: testUserConfig({
        serverCredentials: { example: { DECLARED_TOKEN: 'test-only' } },
        credentialProtection: { disabledStores: [], extraPaths: [join(directory, 'private-note')] },
      }),
    };
    vi.clearAllMocks();
    mocks.discover.mockResolvedValue({
      connections: new Map([
        ['example', { tools: [{ name: 'readme', description: 'A tool', inputSchema: { type: 'object' } }] }],
      ]),
      skipped: [],
      close: mocks.close,
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('uses the shared sandbox/credential launcher and closes its discovery run', async () => {
    const tools = await discoverTools(config, 'test');
    expect(tools).toEqual([
      { serverName: 'example', name: 'readme', description: 'A tool', inputSchema: { type: 'object' } },
    ]);
    expect(mocks.discover).toHaveBeenCalledWith(config.mcpServers, {
      serverCredentials: config.userConfig.serverCredentials,
      sandboxPolicy: 'enforce',
      credentialProtection: config.userConfig.credentialProtection,
    });
    expect(mocks.direct).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('quotes skipped-server and sandbox warnings before displaying them', async () => {
    mocks.discover.mockResolvedValue({
      connections: new Map(),
      skipped: [{ name: 'example\u0007', reason: 'unavailable\u202e' }],
      sandboxWarning: 'sandbox\u0007',
      close: mocks.close,
    });
    await discoverTools(config, 'test');
    const output = vi
      .mocked(process.stderr.write)
      .mock.calls.map(([text]) => String(text))
      .join('');
    expect(output).toContain('example\\u0007');
    expect(output).toContain('unavailable\\u202e');
    expect(output).toContain('sandbox\\u0007');
    expect(output).not.toContain('\u0007');
    expect(output).not.toContain('\u202e');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
