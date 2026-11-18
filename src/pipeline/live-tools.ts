/**
 * Live tool discovery for the offline pipeline commands.
 *
 * `annotate-tools` (annotating and `--check`), compile-policy's live-schema
 * drift check and `ironcurtain mcp add` (which annotates the server it adds)
 * start the configured MCP servers, list their tools and read the identity
 * each server reports at `initialize`. Every server is launched the way its
 * session relay launches it (`trusted-process/tool-listing-launch.ts`, shared
 * with `ironcurtain doctor`), so the tools seen here are the tools sessions
 * will see, and a server's code never runs with more than a session gives it:
 *
 *   - the same OS-sandbox decision: the user's `sandboxPolicy` and the
 *     availability sessions plan with (the dependency check confirmed by the
 *     srt smoke run). A server that asks for an OS sandbox runs inside srt
 *     (the filesystem server confined to its roots). One the plan refuses
 *     ("enforce", sandbox unavailable) is not started and is reported with
 *     the session's refusal message; under "warn" it runs without srt and the
 *     run carries the one-line warning (`sandboxWarning`);
 *   - the same environment: the child-env allowlist with the server's `-e
 *     NAME` passthroughs, its `env` block and its stored credentials
 *     (config.json `serverCredentials`), and the git hardening;
 *   - the same docker -> Apple `container` translation;
 *   - the filesystem server is pointed at a fresh, empty temporary directory:
 *     listing tools needs none of the user's files;
 *   - a server backed by an IronCurtain OAuth provider (google-workspace) is
 *     not started (a session hands it a freshly prepared access token, which
 *     tool listing does not create) and is reported as not started.
 *
 * A run's scratch directories (srt settings, sandboxed servers' working
 * directories, the stand-in allowed directory) are removed when it is closed.
 *
 * Pipeline-only: live sessions never import this module.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPServerConfig, SandboxAvailabilityPolicy } from '../config/types.js';
import { loadUserConfig } from '../config/user-config.js';
import { computeSandboxCredentialPaths, type CredentialProtectionSettings } from '../config/credential-stores.js';
import { permissiveJsonSchemaValidator } from '../trusted-process/permissive-output-validator.js';
import { resolveOsSandboxAvailability, type OsSandboxAvailability } from '../trusted-process/sandbox-integration.js';
import {
  createToolListingEnvironment,
  formatToolListingSandboxWarning,
  prepareToolListingLaunch,
  type ToolListingSpawn,
} from '../trusted-process/tool-listing-launch.js';
import { VERSION } from '../version.js';
import type { ServerInfo } from './annotation-overlay.js';
import type { LiveSchemaIndex } from './scenario-schema-validator.js';
import { liveSchemaKey } from './scenario-schema-validator.js';
import type { MCPToolSchema } from './tool-annotator.js';

/** What one connected server exposes: its tools and its reported identity. */
export interface LiveServerTools {
  readonly tools: MCPToolSchema[];
  readonly serverInfo?: ServerInfo;
}

/** A connected server: {@link LiveServerTools} plus the client, and how to let go of it. */
export interface LiveServerConnection extends LiveServerTools {
  readonly client: Client;
  /** Closes the client, which stops the server. Never throws. */
  close(): Promise<void>;
}

/** How a discovery run launches servers. Every field has a default; tests inject them. */
export interface ToolDiscoveryOptions {
  readonly credentialProtection?: CredentialProtectionSettings;
  /**
   * Stored credentials per server (config.json `serverCredentials`), handed
   * to each server as its relay hands them. Default: the user config's.
   */
  readonly serverCredentials?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The effective sandboxPolicy. Default: the user config's (env > config.json > platform default). */
  readonly sandboxPolicy?: SandboxAvailabilityPolicy;
  /**
   * OS-sandbox availability. Default: as sessions resolve it, the dependency
   * check confirmed by the srt smoke run (once per process) when a server
   * asks for the sandbox.
   */
  readonly availability?: OsSandboxAvailability;
  /** The transport for a prepared spawn (a test seam). Default: stdio. */
  readonly transport?: (spawn: ToolListingSpawn) => Transport;
}

/** One discovery run: a sandbox plan and scratch directories shared by the servers it starts. */
export interface ToolDiscoveryRun {
  /**
   * The one-line warning naming the servers that run without the OS sandbox
   * they ask for (sandboxPolicy "warn"), or undefined. Servers refused under
   * "enforce" are reported by {@link ToolDiscoveryRun.connect} instead.
   */
  readonly sandboxWarning: string | undefined;
  /**
   * Starts one server of the run as its session relay would and lists its
   * tools. Rejects with the reason when the server is not started (refused
   * by the OS-sandbox policy, OAuth-backed, not part of the run) or does not
   * answer `tools/list`.
   */
  connect(name: string): Promise<LiveServerConnection>;
  /** Closes every connection of the run, then removes its scratch directories. Never throws. */
  close(): Promise<void>;
}

/**
 * Opens a discovery run over `mcpServers` (see the module comment): resolves
 * the credentials, policy and availability once and plans every server. The
 * caller must `close()` the run.
 */
export async function openToolDiscovery(
  mcpServers: Readonly<Record<string, MCPServerConfig>>,
  options: ToolDiscoveryOptions = {},
): Promise<ToolDiscoveryRun> {
  const { credentials, policy, credentialPaths } = discoverySettings(options);
  const availability = options.availability ?? (await resolveOsSandboxAvailability(mcpServers));
  const environment = createToolListingEnvironment({
    servers: mcpServers,
    availability,
    policy,
    credentialPaths,
    label: 'discovery',
  });
  const plan = environment.plan.ok ? environment.plan.plan : undefined;
  const open = new Set<LiveServerConnection>();
  const state = { closed: false };
  // A call, so the check after a connect sees a close() made meanwhile.
  const isClosed = (): boolean => state.closed;

  return {
    sandboxWarning: plan === undefined ? undefined : formatToolListingSandboxWarning(plan),
    connect: async (name) => {
      if (isClosed()) throw new Error('the tool discovery run is closed');
      if (!Object.hasOwn(environment.servers, name)) throw new Error(`"${name}" is not a server of this run`);
      const launch = prepareToolListingLaunch(
        name,
        environment.servers[name],
        environment,
        Object.hasOwn(credentials, name) ? credentials[name] : {},
      );
      if (launch.status !== 'ready') throw new Error(launch.message);
      const connection = await connectLaunched(launch.spawn, options.transport);
      if (isClosed()) {
        // Closed while this server was starting: its directories are gone.
        await connection.close();
        throw new Error('the tool discovery run is closed');
      }
      open.add(connection);
      return connection;
    },
    close: async () => {
      state.closed = true;
      for (const connection of [...open]) await connection.close();
      open.clear();
      environment.dispose();
    },
  };
}

/** The credentials and policy of a run: the options', else the user config's. */
function discoverySettings(options: ToolDiscoveryOptions): {
  credentialPaths: readonly string[];
  credentials: Readonly<Record<string, Readonly<Record<string, string>>>>;
  policy: SandboxAvailabilityPolicy;
} {
  if (options.serverCredentials !== undefined && options.sandboxPolicy !== undefined) {
    return {
      credentials: options.serverCredentials,
      policy: options.sandboxPolicy,
      credentialPaths: computeSandboxCredentialPaths(options.credentialProtection),
    };
  }
  const userConfig = loadUserConfig({ readOnly: true });
  return {
    credentials: options.serverCredentials ?? userConfig.serverCredentials,
    credentialPaths: computeSandboxCredentialPaths(options.credentialProtection ?? userConfig.credentialProtection),
    policy: options.sandboxPolicy ?? userConfig.sandboxPolicy,
  };
}

/**
 * Connects to a prepared spawn and lists its tools. Throws when the server
 * cannot be started or does not answer `tools/list`; the client is closed
 * before the error propagates.
 */
async function connectLaunched(
  spawn: ToolListingSpawn,
  transportFor: ToolDiscoveryOptions['transport'],
): Promise<LiveServerConnection> {
  const transport = transportFor ? transportFor(spawn) : stdioTransport(spawn);
  const client = new Client(
    { name: 'ironcurtain-annotator', version: VERSION },
    { jsonSchemaValidator: permissiveJsonSchemaValidator },
  );
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const reported = client.getServerVersion();
    return {
      client,
      tools,
      ...(reported ? { serverInfo: { name: reported.name, version: reported.version } } : {}),
      close: () => client.close().catch(() => undefined),
    };
  } catch (err) {
    // Clean up the connected client to avoid leaking the subprocess.
    await client.close().catch(() => undefined);
    throw err;
  }
}

/** The stdio transport for a prepared spawn; its stderr is drained and discarded. */
function stdioTransport(spawn: ToolListingSpawn): Transport {
  const transport = new StdioClientTransport({
    command: spawn.command,
    args: [...spawn.args],
    env: spawn.env,
    stderr: 'pipe',
    // The relay's choice: a private directory for a sandboxed server, the
    // package root otherwise; never the user's cwd (spawn-cwd.ts).
    cwd: spawn.cwd,
  });
  // Drain piped stderr to prevent backpressure (logs are discarded).
  transport.stderr?.on('data', () => {});
  return transport;
}

/**
 * Starts one server as a session relay would and lists its tools (a run of
 * one server, see {@link openToolDiscovery}). The caller owns the returned
 * connection and closes it, which also removes the run's scratch
 * directories. Throws with the reason when the server is not started or
 * does not answer `tools/list`.
 */
export async function connectForToolDiscovery(
  name: string,
  config: MCPServerConfig,
  options: ToolDiscoveryOptions = {},
): Promise<LiveServerConnection> {
  const run = await openToolDiscovery({ [name]: config }, options);
  try {
    const connection = await run.connect(name);
    return { ...connection, close: () => run.close() };
  } catch (err) {
    await run.close();
    throw err;
  }
}

export interface LiveToolDiscovery {
  /** Servers that connected, in the order of `mcpServers`. */
  readonly connections: Map<string, LiveServerConnection>;
  /** Servers that were not started or could not be listed, with the reason. */
  readonly skipped: Array<{ readonly name: string; readonly reason: string }>;
  /** See {@link ToolDiscoveryRun.sandboxWarning}. */
  readonly sandboxWarning?: string;
  /** Closes every connection and removes the run's scratch directories. Never throws. */
  close(): Promise<void>;
}

/**
 * Connects to every server in `mcpServers` (in parallel, one run) and lists
 * its tools. A server that is not started or fails is skipped, never fatal:
 * the caller decides whether a missing server matters. The caller must
 * `close()` the result.
 */
export async function discoverLiveTools(
  mcpServers: Record<string, MCPServerConfig>,
  options: ToolDiscoveryOptions = {},
): Promise<LiveToolDiscovery> {
  const run = await openToolDiscovery(mcpServers, options);
  type Outcome =
    | { readonly name: string; readonly connection: LiveServerConnection }
    | { readonly name: string; readonly reason: string };
  const settled = await Promise.all(
    Object.keys(mcpServers).map(async (name): Promise<Outcome> => {
      try {
        return { name, connection: await run.connect(name) };
      } catch (err) {
        return { name, reason: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const connections = new Map<string, LiveServerConnection>();
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const result of settled) {
    if ('connection' in result) connections.set(result.name, result.connection);
    else skipped.push({ name: result.name, reason: result.reason });
  }
  return {
    connections,
    skipped,
    ...(run.sandboxWarning === undefined ? {} : { sandboxWarning: run.sandboxWarning }),
    close: () => run.close(),
  };
}

/** Closes every connection; never throws (best-effort cleanup). */
export async function disconnectAll(connections: Iterable<LiveServerConnection>): Promise<void> {
  for (const connection of connections) {
    await connection.close();
  }
}

/**
 * Indexes the live input schemas of the connected servers' tools for the
 * scenario validator (`liveSchemaKey(server, tool)` → schema).
 */
export function buildLiveSchemaIndex(connections: ReadonlyMap<string, LiveServerTools>): LiveSchemaIndex {
  const index = new Map<string, Record<string, unknown>>();
  for (const [serverName, { tools }] of connections) {
    for (const tool of tools) index.set(liveSchemaKey(serverName, tool.name), tool.inputSchema);
  }
  return index;
}
