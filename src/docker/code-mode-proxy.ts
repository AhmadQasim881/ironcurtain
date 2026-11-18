/**
 * CodeModeProxy -- MCP server that exposes a single `execute_code` tool
 * backed by the UTCP Code Mode sandbox.
 *
 * Replaces the old ManagedProxy (which spawned mcp-proxy-server.ts as a
 * child process). Docker agents now send TypeScript via `execute_code`,
 * sharing the same execution engine as builtin Code Mode sessions.
 *
 * Architecture:
 *   Container (Claude Code) → socat → UDS/TCP socket
 *     → CodeModeProxy: one MCP Server (execute_code) per accepted connection
 *     → shared Sandbox.executeCode(code)
 *     → V8 isolate → UTCP → per-server mcp-proxy-server.ts (stdio)
 *     → PolicyEngine → real MCP servers
 *
 * Every agent process in the container opens its own connection to the proxy
 * socket (parallel workflow fan-out lanes in a shared container, a nested
 * CLI, a stray background process), so the transport runs in multi-client
 * mode: each connection gets a fresh MCP Server -- hence its own JSON-RPC id
 * space -- over the ONE shared sandbox and ToolCallCoordinator, whose call
 * mutex serializes the tool calls. A connection is never evicted by a
 * newcomer. A malformed or oversized frame from one client is rejected by
 * its connection transport, logged here, and affects only that connection:
 * the agent is untrusted and must not be able to take the host process down.
 * Likewise a client that sends requests without reading the replies: its
 * connection stops reading once 1,024 replies or 4 MiB are queued for it and
 * is dropped past 16,384 replies or 32 MiB (`socket-connection-transport.ts`),
 * so the replies it leaves unread cannot pile up in host memory.
 * For the same reason the warnings it can trigger go through a bounded,
 * rate-limited log (`agent-warning-log.ts`), never straight to the logger.
 *
 * Every connection can also send any number of concurrent `execute_code`
 * requests. The sandbox bounds them (a few scripts at once per proxy, more
 * queue, and a process-wide isolate budget; see `sandbox/chain-limits.ts`),
 * and each request's MCP signal -- aborted when the agent cancels it or its
 * connection closes -- cancels its script, so an abandoned request releases
 * its isolate and withdraws its pending escalations instead of holding them
 * until the chain timeout. The text sent back is bounded too: the `[logs]`
 * section and the return value share one size budget.
 *
 * Each connection is also its own circuit-breaker lane: the proxy mints a
 * lane key per accepted connection and every `execute_code` on it runs with
 * that lane, so the coordinator keeps a separate breaker window per agent
 * process (one per fan-out lane) instead of one window all lanes share. The
 * key is assigned here, on the host, and never comes from the agent; an
 * agent that opens extra connections gains nothing past the breaker's
 * all-lanes bound (`maxLanes`, see `call-circuit-breaker.ts`).
 */

import { AsyncResource } from 'node:async_hooks';
import type { TlsOptions } from 'node:tls';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UdsServerTransport } from '../trusted-process/uds-server-transport.js';
import { TcpServerTransport } from '../trusted-process/tcp-server-transport.js';
import type { SocketConnectionTransport } from '../trusted-process/socket-connection-transport.js';
import { Sandbox, type HelpData, type UnavailableMcpServer } from '../sandbox/index.js';
import { CODE_MODE_PROXY_MAX_CONCURRENT_CHAINS } from '../sandbox/chain-limits.js';
import {
  getResultSizeLimit,
  linesSize,
  splitOutputBudget,
  truncateLines,
  truncateString,
} from '../session/truncate-result.js';
import { EXECUTE_CODE_JUSTIFICATION_DESCRIPTION } from '../sandbox/chain-justifications.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { ControlServerAddress, ControlServerListenOptions } from '../trusted-process/control-server.js';
import type { ServerSchemaDrift } from '../trusted-process/schema-drift.js';
import type { EscalationPromptFn } from '../trusted-process/tool-call-coordinator.js';
import type { EgressAuthorizer } from '../trusted-process/egress-policy.js';
import type { WorkflowCommitHandler } from '../trusted-process/workflow-commit-tool.js';
import { VERSION } from '../version.js';
import * as logger from '../logger.js';
import { errorMessage } from '../utils/error-message.js';
import { createAgentWarningLog } from './agent-warning-log.js';

/**
 * Narrow handle the workflow orchestrator uses to attach a control
 * server to the sandbox's live coordinator. Intentionally exposes only
 * the bind operation so callers cannot reach the rest of the security
 * kernel (PolicyEngine, AuditLog, etc.) through this seam.
 *
 * This narrowing is a **type-level seam for API hygiene, not a runtime
 * capability boundary**. Our threat model treats the host process as
 * trusted: LLM-generated code runs in the V8 isolate (sandboxed) and
 * untrusted MCP servers run under `srt` containment. A caller casting
 * `DockerProxy` back to the full `ToolCallCoordinator` would be a
 * malicious module already executing inside our own process, at which
 * point capability wrappers offer no defense. The seam exists to keep
 * orchestrator code from accidentally reaching into unrelated
 * coordinator surface area, not to constrain an adversary.
 */
/** Code Mode requests are source text, with a tighter cap than general MCP traffic. */
export const CODE_MODE_MAX_FRAME_BYTES = 1024 * 1024;

export interface PolicySwapTarget {
  startControlServer(opts: ControlServerListenOptions): Promise<ControlServerAddress>;
}

/** Public interface for the Docker session's proxy. */
export interface DockerProxy {
  start(): Promise<void>;
  getHelpData(): HelpData;
  stop(): Promise<void>;
  /**
   * Returns the proxy's policy-swap target once `start()` has completed,
   * or `null` before the sandbox is initialized. Used by the workflow
   * orchestrator to attach a control server on a workflow-scoped UDS;
   * single-session callers (CLI, daemon, cron) never use this.
   */
  getPolicySwapTarget(): PolicySwapTarget | null;
  /**
   * Live-schema drift the sandbox's coordinator found while registering the
   * backend servers' tools (empty before `start()` and when nothing
   * drifted). Sessions report it as an `annotation_drift` diagnostic.
   * Optional so narrow test doubles of this interface need not provide it.
   */
  getSchemaDrift?(): readonly ServerSchemaDrift[];
  /**
   * The seam the MITM proxy uses to have the sandbox's coordinator decide
   * destinations under policy-evaluated egress (`egressPolicy.enabled`):
   * only `authorizeEgress`, nothing else of the coordinator. Null before
   * `start()`. Like `PolicySwapTarget`, a type-level seam for API hygiene,
   * not a capability boundary. Optional so narrow test doubles of this
   * interface need not provide it.
   */
  getEgressAuthorizer?(): EgressAuthorizer | null;
  /**
   * MCP servers the sandbox skipped because their relay failed to start
   * (empty before `start()`). Sessions report them as
   * `mcp_server_unavailable` diagnostics. Optional like `getSchemaDrift`.
   */
  getUnavailableServers?(): readonly UnavailableMcpServer[];
  readonly socketPath: string;
  readonly port: number | undefined;
}

export interface CodeModeProxyOptions {
  /** Absolute path for the UDS socket (used in UDS mode, also stored for reference in TCP mode). */
  readonly socketPath: string;
  /** Session configuration passed to the Sandbox. */
  readonly config: IronCurtainConfig;
  /** Listen mode: 'uds' (default) or 'tcp'. TCP mode uses OS-assigned port. */
  readonly listenMode?: 'uds' | 'tcp';
  /** Per-bundle TCP admission credential; ignored for the filesystem-confined UDS listener. */
  readonly requiredTcpToken?: string;
  /** Encrypt the shared sidecar-to-host TCP hop; unused for UDS listeners. */
  readonly tls?: TlsOptions;
  /**
   * TCP bind address. Defaults to 127.0.0.1 (the tcp-sidecar topology,
   * where Docker Desktop forwards `host.docker.internal` to loopback).
   * The tcp-hostonly topology binds 0.0.0.0 — the vmnet gateway interface
   * does not exist until the first container attaches — and MUST pair
   * that with `allowRemoteAddress` to keep the unauthenticated MCP
   * endpoint off the LAN. Ignored in UDS mode.
   */
  readonly bindHost?: string;
  /** Connection-source filter forwarded to the TCP transport. Ignored in UDS mode. */
  readonly allowRemoteAddress?: (remoteAddress: string | undefined) => boolean;
  /**
   * In-process escalation handler for the sandbox's coordinator. Set by
   * the workflow orchestrator for shared-container bundles so escalated
   * tool calls reach the workflow's human route; standalone sessions rely
   * on the file-IPC escalation directory instead and leave this unset.
   */
  readonly onEscalation?: EscalationPromptFn;
  /**
   * Most agent lanes expected to share the sandbox's coordinator at once
   * (`SandboxInitOptions.maxLanes`). Set by the workflow orchestrator for a
   * bundle whose scope runs a fan-out; standalone sessions leave it unset.
   */
  readonly maxLanes?: number;
  /**
   * Target of the sandbox coordinator's `workflow_commit` tool. Set by the
   * workflow orchestrator only (see `SandboxInitOptions.workflowCommit`).
   */
  readonly workflowCommit?: WorkflowCommitHandler;
}

/** Heading of the console section in an `execute_code` reply. */
const LOGS_HEADER = '[logs]\n';

/**
 * The text an agent receives for one `execute_code` call: a `[logs]` section
 * (when the script logged anything) and the return value, under one size
 * budget shared by both (`getResultSizeLimit()`, the limit a builtin session
 * applies; see `splitOutputBudget`). The console is cut by whole lines and
 * the return value as text, each keeping its head and tail around a marker,
 * so neither part can grow the reply without bound. Exported for tests.
 */
export function formatExecutionOutput(
  result: unknown,
  logs: readonly string[],
  budget: number = getResultSizeLimit(),
): string {
  const resultText =
    result === undefined ? '(no return value)' : typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const headerSize = Buffer.byteLength(LOGS_HEADER, 'utf-8');
  const consoleSize = logs.length > 0 ? headerSize + linesSize(logs) : 0;
  const resultSize = Buffer.byteLength(resultText, 'utf-8');
  const { consoleBudget, resultBudget } = splitOutputBudget(consoleSize, resultSize, budget);

  const parts: string[] = [];
  if (logs.length > 0) {
    const kept = truncateLines(logs, Math.max(0, consoleBudget - headerSize));
    parts.push(`${LOGS_HEADER}${kept.lines.join('\n')}`);
  }
  parts.push(truncateString(resultText, resultBudget));
  return parts.join('\n\n');
}

/** Runs `fn` in a fixed async context (see `createCodeModeProxy`). */
type ContextRunner = <T>(fn: () => T) => T;

/**
 * Builds the MCP server for ONE agent connection. Every connection gets its
 * own instance (own JSON-RPC id space, own lifecycle); they all execute code
 * in the one shared sandbox, each under its own circuit-breaker `lane`.
 * `inProxyContext` runs each `execute_code` call in the async context the
 * proxy was created in.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- Low-level API exposes custom request handlers.
function createExecuteCodeServer(sandbox: Sandbox, lane: string, inProxyContext: ContextRunner): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Low-level API exposes custom request handlers.
  const mcpServer = new Server({ name: 'ironcurtain-code-mode', version: VERSION }, { capabilities: { tools: {} } });

  // eslint-disable-next-line @typescript-eslint/require-await -- MCP SDK handler must return Promise
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'execute_code',
        description:
          'Execute TypeScript code in a secure sandbox. ' +
          'Tool calls are synchronous (no await). ' +
          'Use `return` to send a value back. ' +
          'Call help.help() to discover available tools.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            code: {
              type: 'string',
              description: 'TypeScript code to execute',
            },
            justification: {
              type: 'string',
              description: EXECUTE_CODE_JUSTIFICATION_DESCRIPTION,
            },
          },
          required: ['code'],
        },
      },
    ],
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    inProxyContext(() => callTool(request, extra)),
  );

  async function callTool(
    request: { params: { name: string; arguments?: Record<string, unknown> } },
    extra: { signal: AbortSignal },
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    if (request.params.name !== 'execute_code') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    const args = request.params.arguments as { code?: unknown; justification?: unknown } | undefined;
    const code = args?.code;
    const justification = args?.justification;
    if (!code || typeof code !== 'string') {
      return {
        content: [{ type: 'text', text: 'Missing required parameter: code' }],
        isError: true,
      };
    }

    try {
      // The request's signal aborts when the agent cancels it or its
      // connection closes; the script is then cancelled with it. Every tool
      // call the script makes runs under this connection's breaker lane. The
      // justification is the agent's own text: shown, labelled as the
      // agent's, to a human reviewing an escalated call and read by nothing
      // else. The sandbox drops anything that is not a non-empty string.
      const { result, logs } = await sandbox.executeCode(code, {
        signal: extra.signal,
        lane,
        ...(justification === undefined ? {} : { justification }),
      });
      return {
        content: [{ type: 'text', text: formatExecutionOutput(result, logs) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  return mcpServer;
}

export function createCodeModeProxy(options: CodeModeProxyOptions): DockerProxy {
  // Several agent processes may share this proxy (workflow lanes), so it
  // runs more scripts at once than a builtin session does.
  const sandbox = new Sandbox({ maxConcurrentChains: CODE_MODE_PROXY_MAX_CONCURRENT_CHAINS });
  // Agent connections are accepted sockets, whose events carry no async
  // context. Their execute_code calls run in the context the proxy was
  // created in instead -- for a standalone session, bound to the session's
  // logger claim -- so the coordinator's lines for them (policy decisions,
  // auto-approve) reach that session's log.
  const inProxyContext: ContextRunner = AsyncResource.bind(<T>(fn: () => T): T => fn());
  const useTcp = options.listenMode === 'tcp';

  let transport: UdsServerTransport | TcpServerTransport | null = null;
  /** One MCP server per live agent connection. */
  const servers = new Set<Server>(); // eslint-disable-line @typescript-eslint/no-deprecated
  /**
   * Agents decide how often these fire and much of their text (an unknown-id
   * response is quoted back whole), so they are bounded and rate-limited.
   */
  const warnings = createAgentWarningLog({ write: (line) => logger.warn(`Code Mode proxy: ${line}`) });
  /** Source of per-connection circuit-breaker lane keys (see the module comment). */
  let connectionCount = 0;

  /** Serves one accepted connection with its own MCP server and breaker lane. */
  function attachServer(connection: SocketConnectionTransport): void {
    connectionCount += 1;
    const mcpServer = createExecuteCodeServer(sandbox, `connection-${connectionCount}`, inProxyContext);
    servers.add(mcpServer);
    // Protocol drops transport errors silently when no handler is set; a
    // frame the transport rejected (malformed, oversized) must stay visible.
    mcpServer.onerror = (err) => {
      warnings.warn('agent connection error', err.message);
    };
    mcpServer.onclose = () => {
      servers.delete(mcpServer);
    };
    mcpServer.connect(connection).catch((err: unknown) => {
      servers.delete(mcpServer);
      warnings.warn('could not attach an agent connection', errorMessage(err));
      void connection.close();
    });
  }

  return {
    socketPath: options.socketPath,

    get port(): number | undefined {
      if (transport instanceof TcpServerTransport) {
        try {
          return transport.port;
        } catch {
          return undefined;
        }
      }
      return undefined;
    },

    async start(): Promise<void> {
      // 1. Initialize the sandbox (registers MCP proxy servers per backend)
      await sandbox.initialize(options.config, {
        onEscalation: options.onEscalation,
        maxLanes: options.maxLanes,
        ...(options.workflowCommit ? { workflowCommit: options.workflowCommit } : {}),
      });

      // 2. Listen. Each accepted connection gets its own MCP server exposing
      //    execute_code (attachServer); the listener itself carries no MCP
      //    session, so nothing is evicted when another agent process connects.
      const listener = useTcp
        ? new TcpServerTransport(options.bindHost ?? '127.0.0.1', 0, {
            tls: options.tls,
            requiredToken: options.requiredTcpToken,
            allowRemoteAddress: options.allowRemoteAddress,
            maxBufferSize: CODE_MODE_MAX_FRAME_BYTES,
          })
        : new UdsServerTransport(options.socketPath, { maxBufferSize: CODE_MODE_MAX_FRAME_BYTES });
      listener.onerror = (err) => {
        warnings.warn('listener error', err.message);
      };
      listener.onconnection = attachServer;
      transport = listener;
      await listener.start();
    },

    getHelpData(): HelpData {
      return sandbox.getHelpData();
    },

    getPolicySwapTarget(): PolicySwapTarget | null {
      return sandbox.getCoordinator();
    },

    getSchemaDrift(): readonly ServerSchemaDrift[] {
      const coordinator = sandbox.getCoordinator();
      return coordinator ? [...coordinator.getSchemaDrift().values()] : [];
    },

    getEgressAuthorizer(): EgressAuthorizer | null {
      const coordinator = sandbox.getCoordinator();
      if (!coordinator) return null;
      return { authorizeEgress: (request) => coordinator.authorizeEgress(request) };
    },

    getUnavailableServers(): readonly UnavailableMcpServer[] {
      return sandbox.getUnavailableServers();
    },

    async stop(): Promise<void> {
      const listener = transport;
      transport = null;
      // Closing a per-connection server closes its socket; then stop
      // listening and shut the shared sandbox down.
      await Promise.all([...servers].map((mcpServer) => mcpServer.close().catch(() => undefined)));
      servers.clear();
      if (listener) await listener.close();
      warnings.flush();
      await sandbox.shutdown();
    },
  };
}
