/**
 * Policy-mediated MCP access for dynamic list resolution.
 *
 * Data-backed lists (`requiresMcp: true`) are resolved by an LLM that calls
 * MCP tools and reads what they return: mail, issues, documents -- data an
 * attacker can influence. Every one of those calls therefore goes through
 * the security kernel, exactly like an agent session's calls:
 *
 *   resolver LLM -> ToolCallCoordinator.handleToolCall (read-only policy,
 *   argument validation and normalization, protected paths, circuit
 *   breaker, audit) -> mcp-proxy-server relay -> backend MCP server
 *
 * The relay subprocess is a pure pass-through (OAuth credential injection,
 * sandbox wrapping, stdio transport) and enforces nothing itself. The
 * coordinator is configured for unattended use:
 *   - policy: the bundled read-only policy (`getReadOnlyPolicyDir()`), never
 *     the user's main policy;
 *   - escalations are denied: no escalation directory or callback is wired,
 *     and auto-approval is off;
 *   - no `allowedDirectory`, so the structural sandbox fast-path never
 *     auto-allows a write (not even into a scratch directory: write access
 *     plus allowed git reads would let planted instructions stage a hostile
 *     repository config and then have the git server read it);
 *   - the caller's real protected paths;
 *   - a real audit log (`list-resolution-audit.jsonl`) next to the artifacts;
 *   - no trusted servers.
 *
 * One relay is spawned per needed server with `SERVER_FILTER`, so the server
 * name the policy sees is the server that will actually handle the call.
 * Only the server each list names in `mcpServerHint` is connected; there is
 * no "connect every server" fallback, and network-egress servers are refused
 * (see `getMcpListScopeError`). Of the tools a server exposes, the resolver
 * LLM is only told about those `isListResolutionTool` accepts
 * (`MediatedTool.offered`); a call to any other tool is still mediated.
 *
 * The user's OS-sandbox policy (`sandboxPolicy`) applies exactly as in a
 * session: availability is the dependency check confirmed by an srt smoke
 * run (`resolveOsSandboxAvailability`); a server that asks for an OS sandbox
 * that is unavailable is not started under "enforce" and runs unconfined
 * under "warn", with the one-line notice either way (`applyOsSandboxPolicy`),
 * and every relay receives the resolved policy rather than a hard-coded one,
 * and the availability it was planned with (OS_SANDBOX_AVAILABILITY).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { computeSandboxCredentialPaths } from '../config/credential-stores.js';
import { relayDiagnosticText } from '../trusted-process/relay-diagnostics.js';
import { sandboxCredentialPathsEnv } from '../trusted-process/sandbox-credential-paths.js';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { permissiveJsonSchemaValidator } from '../trusted-process/permissive-output-validator.js';
import {
  resolveNodeModulesBin,
  getOsSandboxAvailability,
  osSandboxAvailabilityEnv,
  planServerSandboxing,
  resolveOsSandboxAvailability,
  formatOsSandboxNotice,
  writeOsSandboxNotice,
  type OsSandboxAvailability,
} from '../trusted-process/sandbox-integration.js';
import { ToolCallCoordinator, type CoordinatorTool } from '../trusted-process/tool-call-coordinator.js';
import { collectAuditRedactionSecrets } from '../trusted-process/audit-secrets.js';
import { inheritedEnv, passthroughEnvNames, relayHostSettings } from '../trusted-process/child-env.js';
import { getTrustedSpawnCwd } from '../trusted-process/spawn-cwd.js';
import { getIronCurtainHome, getReadOnlyPolicyDir } from '../config/paths.js';
import {
  extractServerDomainAllowlists,
  getPackageGeneratedDir,
  loadPersonaPolicyArtifacts,
  safeForDisplay,
} from '../config/index.js';
import { loadUserConfig } from '../config/user-config.js';
import { sandboxPolicyEnv, type SandboxAvailabilityPolicy } from '../config/sandbox-policy.js';
import { VERSION } from '../version.js';
import type { MCPServerConfig } from '../config/types.js';
import { getMcpListScopeError } from './dynamic-list-types.js';
import { isListResolutionTool } from './list-resolution-tools.js';
import { loadStoredToolAnnotationsFile } from './pipeline-shared.js';
import type { ListDefinition, StoredToolAnnotation, StoredToolAnnotationsFile } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiled = __filename.endsWith('.js');

const proxyServerPath = resolve(__dirname, `../trusted-process/mcp-proxy-server.${isCompiled ? 'js' : 'ts'}`);
const tsxBin = resolveNodeModulesBin('tsx', resolve(__dirname, '..', '..'));
const PROXY_COMMAND = isCompiled ? 'node' : tsxBin;

/** File name of the audit log written next to the list artifacts. */
export const LIST_RESOLUTION_AUDIT_FILENAME = 'list-resolution-audit.jsonl';

/** An MCP tool available to the list resolver, attributed to its server. */
export interface MediatedTool {
  readonly serverName: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * True when the tool may be described to the resolver LLM: it is
   * annotated, cannot reach the network, and the read-only policy can allow
   * it for some arguments. Calls to tools that are not offered are still
   * possible (a model can name any tool) and are mediated the same way.
   */
  readonly offered: boolean;
}

/** Outcome of one mediated call, as returned to the resolver LLM. */
export interface MediatedToolResult {
  readonly content: unknown;
  readonly isError: boolean;
}

/** Routes one tool call through the security kernel. */
export interface MediatedToolCaller {
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<MediatedToolResult>;
}

/** MCP access for the list resolver in which every call is policy-mediated. */
export interface MediatedMcpConnection extends MediatedToolCaller {
  /** Every tool the connected servers expose. See `MediatedTool.offered`. */
  readonly tools: ReadonlyArray<MediatedTool>;
  /** Closes the coordinator (draining calls, closing the audit log) and the relays. */
  readonly shutdown: () => Promise<void>;
}

export interface ListResolutionMcpOptions {
  /**
   * MCP servers the caller may use (already narrowed by the caller, e.g. to
   * a persona's server allowlist). A list can only name one of these.
   */
  readonly mcpServers: Record<string, MCPServerConfig>;
  /** Directory holding tool-annotations.json. */
  readonly toolAnnotationsDir: string;
  /** Fallback for tool-annotations.json (defaults to the package-bundled copy). */
  readonly toolAnnotationsFallbackDir?: string;
  /** Protected paths enforced by the structural invariant, as for sessions. */
  readonly protectedPaths: readonly string[];
  /** JSONL audit log that receives one entry per mediated call. */
  readonly auditLogPath: string;
}

/**
 * Determines which MCP servers the list definitions need: exactly the servers
 * named by the data-backed lists' `mcpServerHint`s. Throws when a data-backed
 * list names no server, a network-egress server, or a server the caller does
 * not have.
 */
function selectNeededServers(
  definitions: readonly ListDefinition[],
  mcpServers: Record<string, MCPServerConfig>,
): Record<string, MCPServerConfig> {
  const needed: Record<string, MCPServerConfig> = {};
  for (const definition of definitions) {
    const scopeError = getMcpListScopeError(definition);
    if (scopeError) throw new Error(scopeError);
    if (!definition.requiresMcp || !definition.mcpServerHint) continue;

    const serverName = definition.mcpServerHint;
    if (!Object.hasOwn(mcpServers, serverName)) {
      throw new Error(
        `List ${safeForDisplay(`@${definition.name}`)} names MCP server ${safeForDisplay(serverName)}, ` +
          `which is not configured for this compilation.`,
      );
    }
    needed[serverName] = mcpServers[serverName];
  }
  return needed;
}

/**
 * Applies the OS-sandbox availability policy to the servers the list
 * resolver needs, exactly as a session does: servers that need an
 * unavailable OS sandbox are dropped under "enforce" and run unconfined
 * under "warn", and either case prints the one-line notice. Exported for
 * tests; `availability` is injectable.
 */
export function applyOsSandboxPolicy(
  neededServers: Record<string, MCPServerConfig>,
  policy: SandboxAvailabilityPolicy,
  availability: OsSandboxAvailability = getOsSandboxAvailability(),
  credentialPaths: readonly string[] = [],
): Record<string, MCPServerConfig> {
  const plan = planServerSandboxing(neededServers, undefined, availability, policy, credentialPaths);
  const notice = formatOsSandboxNotice(plan);
  if (notice !== undefined) writeOsSandboxNotice(notice);
  const refused = new Set(plan.refused);
  return Object.fromEntries(Object.entries(neededServers).filter(([name]) => !refused.has(name)));
}

/**
 * Builds the environment of one relay subprocess. The relay inherits the
 * allowlist of trusted-process/child-env.ts (as session relays do) -- the
 * system variables, the host values this server's `-e NAME` arguments
 * forward, and the ssh-agent socket for its git backend -- never the whole
 * parent environment, so the host's provider keys do not reach the backend,
 * and the variables that would change how the relay talks to us (a TCP or
 * Unix-socket listener instead of stdio, the virtual proxy-tool mode) or
 * move its backend call bound (`BACKEND_CALL_TIMEOUT_MS`, which a session
 * parent sets explicitly; a malformed stray value would stop the relay)
 * cannot be inherited, so the relay runs with the default bound. The
 * variables it acts on are set explicitly:
 *   - SERVER_FILTER / MCP_SERVERS_CONFIG: this one backend only;
 *   - SERVER_CREDENTIALS: this server's credentials only;
 *   - GENERATED_DIR: the read-only policy (used only for MCP roots);
 *   - IRONCURTAIN_SANDBOX_POLICY / SANDBOX_POLICY: the user's resolved
 *     `sandboxPolicy` (env override > config > platform default), under
 *     both names so the relay cannot resolve a different, inherited value;
 *   - OS_SANDBOX_AVAILABILITY, when `availability` is given: the
 *     availability the servers were planned with (srt smoke run included),
 *     so the relay plans its server alike instead of running srt again;
 *   - ALLOWED_DIRECTORY: an empty throwaway directory, overriding anything
 *     inherited, so sandboxed backends get no writable real directory and
 *     the roots advertised to backends name nothing of the user's;
 *   - IRONCURTAIN_HOME: the already-resolved home (OAuth tokens and client
 *     credentials are read from it);
 *   - ANTHROPIC_CONFIG_DIR / CODEX_HOME, when set (`relayHostSettings`):
 *     where the credential stores the relay hides from sandboxed servers
 *     live, so its srt denyRead baseline covers the stores themselves.
 *
 * The relay runs from IronCurtain's package root, not this process's cwd
 * (see trusted-process/spawn-cwd.ts), so every path handed to it is
 * absolute; the relay refuses a relative ALLOWED_DIRECTORY.
 *
 * Exported for testing.
 */
export function buildRelayEnv(
  serverName: string,
  serverConfig: MCPServerConfig,
  toolAnnotationsDir: string,
  credentials: Record<string, string> | undefined,
  scratchDir: string,
  sandboxPolicy: SandboxAvailabilityPolicy,
  availability?: OsSandboxAvailability,
  credentialPaths: readonly string[] = [],
): Record<string, string> {
  return {
    ...sandboxCredentialPathsEnv(credentialPaths),
    ...inheritedEnv(process.env, { passthroughNames: passthroughEnvNames(serverConfig.args), sshAgent: true }),
    ...relayHostSettings(process.env),
    MCP_SERVERS_CONFIG: JSON.stringify({ [serverName]: serverConfig }),
    SERVER_FILTER: serverName,
    GENERATED_DIR: getReadOnlyPolicyDir(),
    // Paths are resolved against this process's cwd, the base the rest of
    // the pipeline uses; the relay refuses a relative ALLOWED_DIRECTORY
    // (os.tmpdir() honours a relative TMPDIR).
    TOOL_ANNOTATIONS_DIR: resolve(toolAnnotationsDir),
    ALLOWED_DIRECTORY: resolve(scratchDir),
    IRONCURTAIN_HOME: getIronCurtainHome(),
    ...sandboxPolicyEnv(sandboxPolicy),
    ...(availability === undefined ? {} : osSandboxAvailabilityEnv(availability)),
    SERVER_CREDENTIALS: JSON.stringify(credentials ?? {}),
  };
}

/**
 * Spawns one relay subprocess and connects to it over stdio.
 *
 * Only the relay's own diagnostic lines (WARNING:/ERROR: from
 * `emitProxyDiagnostic`) are forwarded to our stderr. Backend MCP-server
 * stderr can include unredacted credentials in failure paths, so arbitrary
 * subprocess output is never echoed verbatim. Incomplete lines are buffered
 * until the trailing newline.
 */
async function connectRelay(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: PROXY_COMMAND,
    args: [proxyServerPath],
    env,
    stderr: 'pipe',
    // The relay must not inherit the user's cwd (tsx would read its
    // tsconfig.json in source mode); see spawn-cwd.ts.
    cwd: getTrustedSpawnCwd(),
  });

  if (transport.stderr) {
    let buffer = '';
    transport.stderr.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (/^(WARNING|ERROR): /.test(line)) {
          process.stderr.write(`${relayDiagnosticText(line)}\n`);
        }
      }
    });
  }

  const client = new Client(
    { name: 'ironcurtain-list-resolver', version: VERSION },
    { jsonSchemaValidator: permissiveJsonSchemaValidator },
  );
  try {
    await client.connect(transport);
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
  return client;
}

/** Indexes stored annotations by `server__tool`. */
function indexAnnotations(annotations: StoredToolAnnotationsFile): Map<string, StoredToolAnnotation> {
  const index = new Map<string, StoredToolAnnotation>();
  for (const [serverName, server] of Object.entries(annotations.servers)) {
    for (const tool of server.tools) index.set(`${serverName}__${tool.toolName}`, tool);
  }
  return index;
}

/**
 * Connects the MCP servers that the data-backed list definitions name, behind
 * a `ToolCallCoordinator` that evaluates every call against the read-only
 * policy and denies escalations. See the module comment for the full
 * configuration.
 *
 * A server whose relay fails to start (missing credentials, Docker down), or
 * that the OS-sandbox policy refuses, is skipped with a warning; lists that
 * name it then fail to resolve with "no MCP tools are available". The caller
 * must call `shutdown()`.
 */
export async function connectViaProxy(
  definitions: readonly ListDefinition[],
  options: ListResolutionMcpOptions,
): Promise<MediatedMcpConnection> {
  const listedServers = selectNeededServers(definitions, options.mcpServers);
  const userConfig = loadUserConfig({ readOnly: true });
  // As a session decides it: the dependency check, confirmed by the srt
  // smoke run when a listed server asks for an OS sandbox.
  const availability = await resolveOsSandboxAvailability(listedServers, {
    dependencies: getOsSandboxAvailability(),
  });
  const credentialPaths = computeSandboxCredentialPaths(userConfig.credentialProtection);
  const neededServers = applyOsSandboxPolicy(listedServers, userConfig.sandboxPolicy, availability, credentialPaths);

  const toolAnnotations = loadStoredToolAnnotationsFile(
    options.toolAnnotationsDir,
    options.toolAnnotationsFallbackDir ?? getPackageGeneratedDir(),
  );
  if (!toolAnnotations) {
    throw new Error("tool-annotations.json not found. Run 'ironcurtain annotate-tools' first.");
  }
  // The read-only policy and any lists it ships come only from the bundled
  // read-only directory; nothing falls back to the user's main policy.
  const { compiledPolicy, dynamicLists } = loadPersonaPolicyArtifacts(getReadOnlyPolicyDir());

  const coordinator = new ToolCallCoordinator({
    compiledPolicy,
    toolAnnotations,
    protectedPaths: [...options.protectedPaths],
    serverDomainAllowlists: extractServerDomainAllowlists(neededServers),
    dynamicLists,
    auditLogPath: options.auditLogPath,
    auditRedact: userConfig.auditRedaction.enabled,
    // Offline list resolution never handles host OAuth tokens; the
    // configured server credentials and provider keys are enough here.
    auditRedactSecrets: collectAuditRedactionSecrets(userConfig, { includeHostCredentialStores: false }),
    autoApproveModel: null,
  });

  const scratchDir = mkdtempSync(join(tmpdir(), 'ironcurtain-list-resolution-'));
  const relays: Client[] = [];
  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await coordinator.close();
    } finally {
      for (const relay of relays) {
        await relay.close().catch(() => {});
      }
      rmSync(scratchDir, { recursive: true, force: true });
    }
  };

  const annotationIndex = indexAnnotations(toolAnnotations);
  const tools: MediatedTool[] = [];
  try {
    for (const [serverName, serverConfig] of Object.entries(neededServers)) {
      const credentials = userConfig.serverCredentials[serverName] as Record<string, string> | undefined;
      let relay: Client;
      try {
        relay = await connectRelay(
          buildRelayEnv(
            serverName,
            serverConfig,
            options.toolAnnotationsDir,
            credentials,
            scratchDir,
            userConfig.sandboxPolicy,
            availability,
            credentialPaths,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `Warning: MCP server ${safeForDisplay(serverName)} is unavailable for list resolution: ${message}\n`,
        );
        continue;
      }
      relays.push(relay);

      const listed = await relay.listTools();
      const coordinatorTools: CoordinatorTool[] = listed.tools.map((t) => ({
        serverName,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      coordinator.registerTools(serverName, coordinatorTools, { client: relay, roots: [] });

      for (const t of coordinatorTools) {
        const stored = annotationIndex.get(`${serverName}__${t.name}`);
        tools.push({
          serverName,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          offered: isListResolutionTool(compiledPolicy.rules, serverName, t.name, stored),
        });
      }
    }
  } catch (err) {
    await shutdown();
    throw err;
  }

  return {
    tools,
    callTool: async (serverName, toolName, args) => {
      const response = await coordinator.handleToolCall(serverName, toolName, args);
      return { content: response.content, isError: response.isError === true };
    },
    shutdown,
  };
}
