/**
 * The shipped tool annotations must describe exactly the tools of the MCP
 * servers IronCurtain runs from its own install: the locked
 * @cyanheads/git-mcp-server and @modelcontextprotocol/server-filesystem
 * (package-lock.json) and IronCurtain's fetch server.
 *
 * The policy engine evaluates only the arguments an annotation classifies,
 * and the pipeline denies every other argument. A dependency bump that
 * renames, adds or removes an argument, or changes an enum, silently changes
 * what policy evaluates (git-mcp-server 2.15 renamed git_clone's destination
 * and git_branch's discriminator; v0.13.0 and v0.14.0 shipped the 2.8.4
 * annotations). This test spawns each server exactly as `annotate-tools`
 * does (`pipeline/live-tools.ts`), lists its tools and diffs them with the
 * runtime drift check (`trusted-process/schema-drift.ts`). It needs no
 * network, repository or credentials, and takes about two seconds.
 *
 * github (a container, pinned by digest in mcp-servers.json) and
 * google-workspace (npx with an exact version) are not installed locally and
 * are not covered here; `ironcurtain annotate-tools --check` checks github
 * against the real server. It never starts google-workspace: tool listings
 * outside a session do not start a server backed by an IronCurtain OAuth
 * login (trusted-process/tool-listing-launch.ts).
 *
 * When it fails after a dependency bump: re-annotate the server
 * (`ironcurtain annotate-tools --server <name>`), review the result, promote
 * it into the package file (`scripts/stamp-package-annotations.ts --from
 * ...`) and recompile the policy.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAllowedDirectoryToMcpArgs, resolveMcpServerPaths } from '../src/config/index.js';
import type { MCPServerConfig } from '../src/config/types.js';
import { buildAnnotationCheckReport, formatAnnotationCheckReport } from '../src/pipeline/annotation-check.js';
import { discoverLiveTools, type LiveServerConnection, type LiveToolDiscovery } from '../src/pipeline/live-tools.js';
import { computeHash } from '../src/pipeline/pipeline-shared.js';
import { buildAnnotationPrompt } from '../src/pipeline/tool-annotator.js';
import type { StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import { describeServerDrift, diffServerSchemas } from '../src/trusted-process/schema-drift.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const configDir = resolve(packageRoot, 'src/config');

/** The servers whose code ships in node_modules or in IronCurtain itself. */
const LOCAL_SERVERS = ['git', 'filesystem', 'fetch'] as const;

const shipped = JSON.parse(
  readFileSync(resolve(configDir, 'generated/tool-annotations.json'), 'utf-8'),
) as StoredToolAnnotationsFile;

const allowedDir = mkdtempSync(join(tmpdir(), 'ic-annotation-drift-'));
let discovery: LiveToolDiscovery | undefined;
let connections = new Map<string, LiveServerConnection>();
let skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }> = [];

/** The shipped server entries, spawnable from this checkout without a PATH lookup. */
function localServerConfigs(): Record<string, MCPServerConfig> {
  const all = JSON.parse(readFileSync(resolve(configDir, 'mcp-servers.json'), 'utf-8')) as Record<
    string,
    MCPServerConfig
  >;
  resolveMcpServerPaths(all);
  applyAllowedDirectoryToMcpArgs(all, allowedDir);
  const selected: Record<string, MCPServerConfig> = {};
  for (const name of LOCAL_SERVERS) {
    const config = all[name];
    const command =
      config.command === 'node'
        ? process.execPath
        : config.command === 'tsx'
          ? resolve(packageRoot, 'node_modules/.bin/tsx')
          : config.command;
    selected[name] = { ...config, command, env: { ...config.env, MCP_LOG_LEVEL: 'error' } };
  }
  return selected;
}

beforeAll(async () => {
  // git and filesystem ask for an OS sandbox. Discovery launches them as
  // their relays do: inside srt where it can start a sandbox, and (with
  // "warn") without it on a build host where it cannot, rather than not at
  // all, since this file checks their tool schemas, not the sandbox.
  discovery = await discoverLiveTools(localServerConfigs(), { sandboxPolicy: 'warn' });
  connections = discovery.connections;
  skipped = discovery.skipped;
}, 60_000);

afterAll(async () => {
  await discovery?.close();
  rmSync(allowedDir, { recursive: true, force: true });
});

function live(name: string): LiveServerConnection {
  const connection = connections.get(name);
  if (!connection) throw new Error(`${name} did not start: ${JSON.stringify(skipped)}`);
  return connection;
}

describe('shipped annotations match the locally installed MCP servers', () => {
  it('starts every local server', () => {
    expect(skipped).toEqual([]);
    expect([...connections.keys()].sort()).toEqual([...LOCAL_SERVERS].sort());
  });

  it.each(LOCAL_SERVERS)('%s: no tool, argument, discriminator, enum or schema drift', (name) => {
    const { tools } = live(name);
    expect(tools.length).toBeGreaterThan(0);
    const drift = diffServerSchemas(name, shipped.servers[name].tools, tools);
    // The report names every drifted tool and argument when this fails.
    expect({ server: name, drift: describeServerDrift(drift) }).toEqual({ server: name, drift: [] });
  });

  it.each(LOCAL_SERVERS)(
    '%s: carries the annotate-tools inputHash of the live tools, so annotate-tools adopts the shipped entry',
    (name) => {
      const { tools } = live(name);
      const liveHash = computeHash(name, JSON.stringify(tools), buildAnnotationPrompt(name, tools));
      expect({ server: name, inputHash: shipped.servers[name].inputHash }).toEqual({
        server: name,
        inputHash: liveHash,
      });
    },
  );

  it('records the identity the third-party servers report', () => {
    for (const name of ['git', 'filesystem'] as const) {
      expect({ server: name, serverInfo: shipped.servers[name].serverInfo }).toEqual({
        server: name,
        serverInfo: live(name).serverInfo,
      });
    }
  });

  it('passes the annotate-tools --check report', () => {
    const report = buildAnnotationCheckReport(shipped, connections);
    expect(formatAnnotationCheckReport(report).filter((line) => line.level === 'warn')).toEqual([]);
    expect(report.hasDrift).toBe(false);
  });
});
