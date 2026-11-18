import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CompatibilityCallToolResultSchema, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../config/types.js';
import * as logger from '../logger.js';
import { VERSION } from '../version.js';
import { permissiveJsonSchemaValidator } from './permissive-output-validator.js';
import { getTrustedSpawnCwd } from './spawn-cwd.js';
import { inheritedEnv, passthroughEnvNames } from './child-env.js';
import { MCP_CONNECT_TIMEOUT_MS } from './call-timeouts.js';

export const ROOTS_REFRESH_TIMEOUT_MS = 5_000;

/** Spawn options for {@link MCPClientManager.connect}. */
export interface McpConnectOptions {
  /**
   * Forward the ssh-agent socket (SSH_AUTH_SOCK) to the child. Only for a
   * server that authenticates with ssh: the git backend when it is spawned
   * directly (in-process mode). Relays carry it in their explicit `env`
   * block instead and forward it to their git backend themselves.
   */
  readonly sshAgent?: boolean;
}

export interface McpRoot {
  uri: string;
  name: string;
}

/**
 * Per-server connection state exposed to callers that need to interact
 * with the live MCP client (e.g. the coordinator's roots-expansion
 * path). Owned and mutated by `MCPClientManager`; callers receive the
 * live reference so their mutations (e.g. pushing new roots) and the
 * manager's `roots/list` responses share a single array.
 *
 * `rootsRefreshed` is a one-shot callback set by `addRootsToClient` in
 * `roots-expansion.ts`. The manager fires and clears it when the
 * connected MCP server issues a `roots/list` request after receiving
 * our `notifications/roots/list_changed` notification.
 */
export interface ClientState {
  client: Client;
  roots: McpRoot[];
  rootsRefreshed?: () => void;
}

interface ManagedServer extends ClientState {
  transport: StdioClientTransport;
}

export class MCPClientManager {
  private servers = new Map<string, ManagedServer>();

  async connect(
    name: string,
    config: MCPServerConfig,
    roots?: McpRoot[],
    options: McpConnectOptions = {},
  ): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      // Never the host environment. The child gets the allowlist of
      // child-env.ts (PATH, HOME, locale, temp and proxy settings, ...), the
      // host values its own `-e NAME` arguments forward, and its `env`
      // block -- for a relay, the complete configuration the parent built
      // for it. Provider API keys and every other host secret stay here.
      env: {
        ...inheritedEnv(process.env, {
          passthroughNames: passthroughEnvNames(config.args),
          sshAgent: options.sshAgent,
        }),
        ...config.env,
      },
      // Never inherit IronCurtain's own working directory: it may be the
      // agent-writable workspace or an untrusted checkout, and the child
      // would read code and configuration from it (tsx: tsconfig.json for
      // a relay in source mode; npx/dotenv for a backend). Relays and
      // in-process backends run from the package root (spawn-cwd.ts).
      cwd: getTrustedSpawnCwd(),
    });

    // Permissive validator bypasses client-side outputSchema validation that
    // breaks on MCP servers returning non-conforming structuredContent on errors.
    // See permissive-output-validator.ts for full context and SDK issue link.
    // Always advertise `roots.listChanged` so backend servers know to
    // subscribe to updates. Escalation-time root expansion relies on
    // this capability being present even when we connected with an
    // empty initial roots list.
    const client = new Client(
      { name: 'ironcurtain', version: VERSION },
      {
        capabilities: { roots: { listChanged: true } },
        jsonSchemaValidator: permissiveJsonSchemaValidator,
      },
    );

    // Always initialize a mutable roots array so `addRootsToClient` can
    // extend it at escalation time even when we started with none.
    const mutableRoots: McpRoot[] = roots ? [...roots] : [];
    const managed: ManagedServer = { client, transport, roots: mutableRoots };

    // When the server asks for roots, return the current set. The
    // handler is always registered so escalation-time root additions
    // are observable even if we connected with an empty initial list.
    client.setRequestHandler(ListRootsRequestSchema, () => {
      if (managed.rootsRefreshed) {
        managed.rootsRefreshed();
        managed.rootsRefreshed = undefined;
      }
      return { roots: managed.roots };
    });

    try {
      // Explicit bound: without it the SDK cuts the handshake at 60 s, less
      // than a relay may need to start its backend (see MCP_CONNECT_TIMEOUT_MS).
      await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS });
    } catch (err) {
      // Clean up the spawned subprocess so it doesn't leak.
      try {
        await client.close();
      } catch {
        // best-effort
      }
      throw err;
    }
    this.servers.set(name, managed);
  }

  /**
   * Returns the live MCP `Client` for a connected server, or undefined
   * when the server is not connected. Exposed so the coordinator can
   * wire an existing client through `ClientState` for
   * `handleCallTool`'s escalation/roots-expansion paths.
   *
   * Callers must not mutate client internals; use the manager's public
   * methods (`callTool`) for state-changing operations.
   */
  getClient(serverName: string): Client | undefined {
    return this.servers.get(serverName)?.client;
  }

  /** Returns the root list tracked for a connected server, if any. */
  getRoots(serverName: string): McpRoot[] | undefined {
    return this.servers.get(serverName)?.roots;
  }

  /**
   * Returns the live `ClientState` for a connected server. Callers use
   * this to share the manager's mutable `roots` array and one-shot
   * `rootsRefreshed` slot with the tool-call pipeline's roots expansion
   * (`addRootsToClient`), so a single mutation is both visible to the
   * `roots/list` handler and observable as a refresh event.
   */
  getClientState(serverName: string): ClientState | undefined {
    return this.servers.get(serverName);
  }

  /**
   * Lists a connected server's tools. `options.timeoutMs` bounds the request
   * (the MCP SDK's 60 s default otherwise).
   */
  async listTools(
    serverName: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<{ name: string; description?: string; inputSchema: unknown }[]> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" not connected`);
    }

    const result = await server.client.listTools(
      undefined,
      options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
    );
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" not connected`);
    }

    // CompatibilityCallToolResultSchema accepts the legacy `toolResult` response format.
    // Output schema validation is intentionally bypassed by the permissiveJsonSchemaValidator
    // on the Client (always returns { valid: true }) so schema issues don't hide real MCP tool errors.
    return server.client.callTool({ name: toolName, arguments: args }, CompatibilityCallToolResultSchema);
  }

  /**
   * Closes one server's connection, which stops its process, and forgets the
   * server. A server that is not connected is a no-op. Never throws.
   */
  async close(serverName: string): Promise<void> {
    const server = this.servers.get(serverName);
    if (!server) return;
    this.servers.delete(serverName);
    try {
      await server.client.close();
    } catch (err) {
      logger.error(`Error closing MCP server "${serverName}": ${String(err)}`);
    }
  }

  async closeAll(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        await server.client.close();
      } catch (err) {
        logger.error(`Error closing MCP server "${name}": ${String(err)}`);
      }
    }
    this.servers.clear();
  }
}
