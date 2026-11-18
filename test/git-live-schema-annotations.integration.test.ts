/**
 * The shipped git tool annotations must describe exactly the tools of the
 * locked @cyanheads/git-mcp-server (package-lock.json), as `annotate-tools`
 * sees them.
 *
 * The policy engine only evaluates arguments the annotation classifies, and
 * the pipeline denies every other argument ('unannotated-arguments'). When a
 * server release renames or adds an argument (2.15 renamed git_clone's
 * `localPath` to `path` and git_branch's `operation` to `mode`), the shipped
 * annotations must follow in the same change, or calls either bypass policy
 * (before the guard) or fail closed for every user (after it). This test
 * spawns the locked server over stdio and lists its tools; it needs no
 * network, git repository or credentials.
 *
 * When it fails after a dependency bump: re-annotate the server
 * (`ironcurtain annotate-tools --server git`), review the result, promote it
 * into the package file (`scripts/stamp-package-annotations.ts --from ...`)
 * and recompile the policy.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveMcpServerPaths } from '../src/config/index.js';
import type { MCPServerConfig } from '../src/config/types.js';
import { computeHash } from '../src/pipeline/pipeline-shared.js';
import { buildAnnotationPrompt } from '../src/pipeline/tool-annotator.js';
import type { StoredToolAnnotation, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import { isConditionalRoles } from '../src/types/argument-roles.js';
import { permissiveJsonSchemaValidator } from '../src/trusted-process/permissive-output-validator.js';
import { VERSION } from '../src/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = resolve(__dirname, '../src/config');

interface LiveTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const shipped = JSON.parse(
  readFileSync(resolve(configDir, 'generated/tool-annotations.json'), 'utf-8'),
) as StoredToolAnnotationsFile;
const gitEntry = shipped.servers.git;
const annotated = new Map<string, StoredToolAnnotation>(gitEntry.tools.map((t) => [t.toolName, t]));

function liveProperties(tool: LiveTool): Record<string, { enum?: unknown[] }> {
  return (tool.inputSchema.properties ?? {}) as Record<string, { enum?: unknown[] }>;
}

describe('shipped git annotations match the locked git-mcp-server', () => {
  let client: Client | undefined;
  let tools: LiveTool[] = [];

  beforeAll(async () => {
    // Spawn the server exactly as annotate-tools does: the shipped
    // mcp-servers.json entry with node_modules paths made absolute.
    const servers = JSON.parse(readFileSync(resolve(configDir, 'mcp-servers.json'), 'utf-8')) as Record<
      string,
      MCPServerConfig
    >;
    resolveMcpServerPaths(servers);
    const git = servers.git;
    const transport = new StdioClientTransport({
      command: git.command === 'node' ? process.execPath : git.command,
      args: git.args,
      env: { ...(process.env as Record<string, string>), ...git.env, MCP_LOG_LEVEL: 'error' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    client = new Client(
      { name: 'ironcurtain-annotator', version: VERSION },
      { jsonSchemaValidator: permissiveJsonSchemaValidator },
    );
    await client.connect(transport);
    tools = (await client.listTools()).tools;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('annotates every live tool and no other', () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name).sort()).toEqual([...annotated.keys()].sort());
  });

  it('classifies exactly the arguments each live tool accepts', () => {
    const drift = tools.flatMap((tool) => {
      const live = Object.keys(liveProperties(tool)).sort();
      const roles = Object.keys(annotated.get(tool.name)?.args ?? {}).sort();
      return JSON.stringify(live) === JSON.stringify(roles) ? [] : [{ tool: tool.name, live, annotated: roles }];
    });
    expect(drift).toEqual([]);
  });

  it('stores the live input schema of every tool', () => {
    for (const tool of tools) {
      expect({ tool: tool.name, schema: annotated.get(tool.name)?.inputSchema }).toEqual({
        tool: tool.name,
        schema: tool.inputSchema,
      });
    }
  });

  it('keys conditional roles on live arguments and on values their enums accept', () => {
    const problems: string[] = [];
    for (const tool of tools) {
      const props = liveProperties(tool);
      for (const [arg, spec] of Object.entries(annotated.get(tool.name)?.args ?? {})) {
        if (!isConditionalRoles(spec)) continue;
        for (const { condition } of spec.when) {
          const discriminator = props[condition.arg] as { enum?: unknown[] } | undefined;
          if (!discriminator) {
            problems.push(`${tool.name}.${arg}: condition on unknown argument "${condition.arg}"`);
            continue;
          }
          const values = condition.in ?? (condition.equals !== undefined ? [condition.equals] : []);
          for (const value of values) {
            if (discriminator.enum && !discriminator.enum.includes(value)) {
              problems.push(`${tool.name}.${arg}: ${condition.arg}=${JSON.stringify(value)} is not a live value`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('carries the annotate-tools inputHash of the live tools, so annotate-tools adopts the shipped entry', () => {
    // annotate-tools adopts a reviewed package entry instead of calling the
    // LLM only when the entry's inputHash equals this hash (see
    // src/pipeline/annotate.ts). It covers the server name, the tools/list
    // output and the annotation prompt (role registry included): when it
    // changes, set servers.git.inputHash in the shipped file to the value
    // reported here.
    const live = computeHash('git', JSON.stringify(tools), buildAnnotationPrompt('git', tools));
    expect({ server: 'git', inputHash: gitEntry.inputHash }).toEqual({ server: 'git', inputHash: live });
  });
});
