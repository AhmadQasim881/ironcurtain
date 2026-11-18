/**
 * Sandbox -- Sets up UTCP Code Mode with the MCP proxy server.
 *
 * Code Mode creates a sandboxed TypeScript execution environment where
 * LLM-generated code runs with no direct access to the network, filesystem,
 * or credentials. Instead of connecting to real MCP servers, it connects
 * to our MCP proxy server which evaluates policy on every tool call.
 *
 * Each `execute_code` script runs in a fresh V8 isolate (`code-mode-chain.ts`)
 * under host-enforced limits (`chain-limits.ts`): an explicit isolate memory
 * limit, bounded console output, a timeout capped by the caller, a few
 * scripts at once per sandbox with a bounded queue, and one isolate memory
 * budget for the whole process. A caller's signal cancels a script, and every
 * tool call the script makes is withdrawn when the script ends.
 */

import { dirname, resolve } from 'node:path';
import { computeSandboxCredentialPaths } from '../config/credential-stores.js';
import { sandboxCredentialPathsEnv } from '../trusted-process/sandbox-credential-paths.js';
import { fileURLToPath } from 'node:url';
import '@utcp/mcp'; // Register MCP call template type with UTCP SDK
import { CodeModeUtcpClient } from '@utcp/code-mode';
import type { IronCurtainConfig, MCPServerConfig } from '../config/types.js';
import { CONTAINER_WORKSPACE_DIR } from '../docker/agent-adapter.js';
import { createLanguageModel } from '../config/model-provider.js';
import {
  resolveNodeModulesBin,
  getOsSandboxAvailability,
  osSandboxAvailabilityEnv,
  planServerSandboxing,
  resolveOsSandboxAvailability,
  formatOsSandboxNotice,
  writeOsSandboxNotice,
  type OsSandboxAvailability,
  type OsSandboxAvailabilityProbe,
  type OsSandboxPlan,
} from '../trusted-process/sandbox-integration.js';
import { effectiveSandboxPolicy, sandboxPolicyEnv, type SandboxAvailabilityPolicy } from '../config/sandbox-policy.js';
import {
  ToolCallCoordinator,
  type CoordinatorTool,
  type EscalationPromptFn,
} from '../trusted-process/tool-call-coordinator.js';
import { collectAuditRedactionSecrets } from '../trusted-process/audit-secrets.js';
import type { EgressPolicyOptions } from '../trusted-process/egress-policy.js';
import { contentAssessorOptionsFromConfig } from '../trusted-process/assessment-config.js';
import {
  BACKEND_CALL_TIMEOUT_ENV,
  backendCallTimeoutMsFromConfig,
  codeModeChainTimeoutMs,
  escalationTimeoutMsFromConfig,
} from '../trusted-process/call-timeouts.js';
import { loadGeneratedPolicy, extractServerDomainAllowlists, getPackageGeneratedDir } from '../config/index.js';
import { getIronCurtainHome } from '../config/paths.js';
import { buildTrustedServerSet } from '../memory/memory-annotations.js';
import { proxyAnnotations, proxyPolicyRules, createControlApiClient } from '../docker/proxy-tools.js';
import {
  WORKFLOW_COMMIT_SERVER,
  WORKFLOW_COMMIT_SERVER_DESCRIPTION,
  type WorkflowCommitHandler,
} from '../trusted-process/workflow-commit-tool.js';
import { extractPolicyRoots, toMcpRoots } from '../trusted-process/policy-roots.js';
import { loadTaskScopePolicy } from '../trusted-process/task-scope.js';
import { pickPassthroughEnv, relayHostSettings, type HostEnv } from '../trusted-process/child-env.js';
import type { ClientState, McpRoot, MCPClientManager } from '../trusted-process/mcp-client-manager.js';
import pLimit from 'p-limit';
import {
  registerIronCurtainProtocol,
  bindCoordinatorToManual,
  unbindCoordinatorFromManual,
  withToolCallOptions,
  IRONCURTAIN_CALL_TEMPLATE_TYPE,
} from './ironcurtain-protocol.js';
import { structuredResultNotes } from './structured-results.js';
import { runToolChain } from './code-mode-chain.js';
import {
  ChainAdmissionError,
  DEFAULT_CHAIN_MEMORY_LIMIT_MB,
  DEFAULT_MAX_CONCURRENT_CHAINS,
  DEFAULT_MAX_CONSOLE_BYTES,
  DEFAULT_MAX_CONSOLE_ENTRIES,
  DEFAULT_MAX_QUEUED_CHAINS,
  WeightedSemaphore,
  chainMemoryWeightMb,
  processChainBudget,
  type ReleaseSlot,
} from './chain-limits.js';
import { ChainJustifications } from './chain-justifications.js';
import * as logger from '../logger.js';
import { wrapLanguageModel } from 'ai';
import { createSessionLlmLogMiddleware } from '../observability/session-llm-log.js';
import type { LanguageModelV3 } from '@ai-sdk/provider';

// Tool-call timeouts are explicit per request: the security pipeline passes
// `relayCallTimeoutMs()` to every relay `callTool`, and the relay bounds
// the backend call with `BACKEND_CALL_TIMEOUT_MS` (see
// `trusted-process/call-timeouts.ts`). Human escalation does not happen
// inside an MCP request (the coordinator waits for it in this process,
// bounded by the configured escalation timeout, before dispatch), so no
// global MCP SDK timeout override is needed. The `initialize` handshake
// with each relay carries its own bound (`MCP_CONNECT_TIMEOUT_MS`, set in
// `MCPClientManager.connect`) because a relay answers only once its
// backend is up, and the start-up tool listing has its own as well
// (`RELAY_LIST_TOOLS_TIMEOUT_MS`); the remaining parent-to-relay requests
// keep the SDK default.

/**
 * Relays a sandbox starts at once. Each is a node/tsx process that in turn
 * starts its backend (possibly an `npx -y` resolution or a container), so
 * starting them together makes session start cost the slowest server rather
 * than the sum of all of them, while the bound keeps a long server list from
 * spawning everything in one burst.
 */
export const RELAY_CONNECT_CONCURRENCY = 4;

/**
 * Bound for a relay's start-up tool listing. The relay answers from the list
 * it fetched from its backend before it started serving, so this only cuts
 * off a relay that died or hung right after its handshake.
 */
export const RELAY_LIST_TOOLS_TIMEOUT_MS = 60_000;

/** An MCP server whose relay the sandbox could not start; the session runs without it. */
export interface UnavailableMcpServer {
  readonly serverName: string;
  /** Why: the connection or tool-listing error (one line of error text). */
  readonly reason: string;
}

// Detect compiled (.js in dist/) vs source (.ts in src/) mode.
// In compiled mode, spawn with `node`; in source mode, spawn with `tsx` directly.
// We resolve the tsx binary from node_modules/.bin instead of going through `npx`
// because npx spawns an intermediate `sh -c` process that doesn't forward SIGTERM,
// leaving orphaned child processes when the MCP SDK tries to shut down the transport.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiled = __filename.endsWith('.js');
const proxyServerPath = resolve(__dirname, `../trusted-process/mcp-proxy-server.${isCompiled ? 'js' : 'ts'}`);
const tsxBin = resolveNodeModulesBin('tsx', resolve(__dirname, '..', '..'));
const PROXY_COMMAND = isCompiled ? 'node' : tsxBin;
const PROXY_ARGS = [proxyServerPath];

/** Sanitize a string to a valid JS identifier segment. */
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');

/** `value` when it is a positive finite number, else `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Shared: first segment + remaining joined with underscores. */
function flattenDotted(segments: string[]): string {
  const [manual, ...parts] = segments;
  return `${sanitize(manual)}.${parts.map(sanitize).join('_')}`;
}

/**
 * Mirrors UTCP Code Mode's sanitizeIdentifier() behavior — the property name
 * that UTCP actually creates on `global.tools` in the V8 isolate.
 *
 * Example: "tools.filesystem.read_file" → "tools.filesystem_read_file"
 */
export function toUtcpCallable(toolName: string): string {
  if (!toolName.includes('.')) return sanitize(toolName);
  return flattenDotted(toolName.split('.'));
}

/**
 * Transforms a UTCP tool name (dotted) into the user-facing callable name
 * with server-namespace prefix stripping.
 *
 * For 3+ segment names (tools.<server>.<tool>):
 * - Extract server and tool segments
 * - If tool starts with `serverName_`, strip that prefix
 * - Return `server.strippedTool`
 *
 * Examples:
 *   "tools.filesystem.read_file"    → "filesystem.read_file"
 *   "tools.git.git_add"             → "git.add"
 *   "tools.memory.memory_context"   → "memory.context"
 *   "tools.a.b.c"                   → "a.b_c"
 */
export function toCallableName(toolName: string): string {
  if (!toolName.includes('.')) return sanitize(toolName);
  const segments = toolName.split('.');

  // 2-segment names: unchanged (e.g., "tools.read_file")
  if (segments.length <= 2) return flattenDotted(segments);

  // 3+ segments: server-namespace with prefix stripping
  const server = sanitize(segments[1]);
  const toolParts = segments.slice(2).map(sanitize);
  const tool = toolParts.join('_');

  // Strip redundant server prefix from tool name (e.g., git_add → add)
  const prefix = server + '_';
  const strippedTool = tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;

  return `${server}.${strippedTool}`;
}

/**
 * Extracts required parameter names from a tool's JSON Schema inputs
 * to show inline in the catalog, e.g. "{ path }" or "{ path, content }".
 */
export function extractRequiredParams(inputs?: { properties?: Record<string, unknown>; required?: string[] }): string {
  if (!inputs?.required?.length) return '';
  return `{ ${inputs.required.join(', ')} }`;
}

/**
 * What one `execute_code` script returned and logged. A script that failed --
 * an exception, a timeout, a cancellation, a limit, or no free execution slot
 * -- has `result: null` and an `[ERROR] Code execution failed: ...` entry in
 * `logs`. `logs` is bounded by the console limits; callers bound what they
 * show the agent with `truncateExecutionOutput` (session layer).
 */
export interface CodeExecutionResult {
  result: unknown;
  logs: string[];
}

/** Per-call options for {@link Sandbox.executeCode}. */
export interface ExecuteCodeOptions {
  /**
   * Cancels the call: a queued call leaves the queue, a running script's
   * isolate is disposed, and its tool calls in flight are cancelled (a
   * pending escalation is withdrawn, nothing more is dispatched). The AI
   * SDK's per-turn signal (session close, wall-clock budget) and an MCP
   * request's signal (client cancellation, disconnect) are passed here.
   */
  readonly signal?: AbortSignal;
  /**
   * Upper bound for the whole call -- waiting for a free execution slot
   * included -- in milliseconds, e.g. the remaining wall-clock budget of the
   * turn. The sandbox's own chain timeout ({@link Sandbox.getChainTimeoutMs})
   * always applies as well.
   */
  readonly timeoutMs?: number;
  /**
   * Host-assigned lane of the agent stream that sent the code. Every tool
   * call the script makes reaches the coordinator with it, keying the
   * circuit breaker's per-lane window (`ToolCallOptions.lane`).
   */
  readonly lane?: string;
  /**
   * The agent's `execute_code` justification. UNTRUSTED: shown to a human
   * reviewer when one of the chain's calls escalates, labelled as the
   * agent's, and read by nothing else (see chain-justifications.ts).
   */
  readonly justification?: unknown;
}

/**
 * Isolate limits of one sandbox. Defaults come from `chain-limits.ts`; the
 * process-wide budget is shared by every sandbox in the process.
 */
export interface SandboxOptions {
  /** isolated-vm `memoryLimit` of each `execute_code` isolate, in MB. */
  readonly memoryLimitMb?: number;
  /** Scripts this sandbox runs at once; further calls queue. */
  readonly maxConcurrentChains?: number;
  /** Calls that may wait for a slot; further calls are refused at once. */
  readonly maxQueuedChains?: number;
  /** Console output (UTF-8 bytes) after which a script is stopped. */
  readonly maxConsoleBytes?: number;
  /** Console calls after which a script is stopped. */
  readonly maxConsoleEntries?: number;
  /**
   * Process-wide memory budget the sandbox's scripts draw on. Defaults to the
   * one every sandbox in the process shares; tests inject their own.
   */
  readonly processBudget?: WeightedSemaphore;
}

/** A sandbox's `execute_code` load (diagnostics, tests). */
export interface ChainLoad {
  /** Scripts holding one of the sandbox's slots (running, or waiting only for the process-wide budget). */
  readonly running: number;
  /** Calls waiting for a slot. */
  readonly queued: number;
}

/** A single tool entry for help discovery. */
export interface HelpToolEntry {
  callableName: string;
  params: string;
}

/** Structured help data for progressive tool disclosure. */
export interface HelpData {
  serverDescriptions: Record<string, string>;
  toolsByServer: Record<string, HelpToolEntry[]>;
  /**
   * What a server's results carry beyond `content` (its `structuredContent`),
   * printed after its tools by `help.help(server)`. See structured-results.ts.
   */
  resultNotes?: Record<string, string>;
}

/** Fixed reserved namespaces that aliases must never shadow. */
const FIXED_RESERVED_NAMESPACES = ['help', 'console', 'global', 'undefined', 'NaN', 'Infinity'];

/**
 * Builds a JavaScript snippet that creates server-namespace aliases in the
 * V8 sandbox isolate: `global.<server> = { <tool>: global.<utcpGlobal>.<utcpProp> }`.
 *
 * This enables `filesystem.read_file(...)` alongside the UTCP-created
 * `<utcpGlobal>.filesystem_read_file(...)`.
 *
 * `utcpGlobalName` is the sanitized UTCP manual name, which is the property
 * UTCP actually creates on `global` in the V8 isolate (e.g., `tools_abc123`
 * for manual name `tools-abc123`). Each Sandbox instance uses a unique
 * manual name so multiple sandboxes can coexist without global collisions.
 */
function buildNamespaceAliasSnippet(
  aliases: Array<{ newCallable: string; utcpProp: string }>,
  utcpGlobalName: string,
): string {
  // Group by namespace. Reserve both the fixed reserved names and the
  // UTCP global itself so no alias can overwrite the tool root.
  const reserved = new Set<string>([...FIXED_RESERVED_NAMESPACES, utcpGlobalName]);
  const byNs: Record<string, Array<{ tool: string; utcpProp: string }>> = {};
  for (const { newCallable, utcpProp } of aliases) {
    const dotIdx = newCallable.indexOf('.');
    if (dotIdx === -1) continue;
    const ns = newCallable.slice(0, dotIdx);
    if (reserved.has(ns)) continue;
    const tool = newCallable.slice(dotIdx + 1);
    if (!(ns in byNs)) byNs[ns] = [];
    byNs[ns].push({ tool, utcpProp });
  }

  if (Object.keys(byNs).length === 0) return '';

  const lines: string[] = ['(function() {'];
  for (const [ns, tools] of Object.entries(byNs)) {
    lines.push(`  global["${ns}"] = {};`);
    for (const { tool, utcpProp } of tools) {
      lines.push(`  global["${ns}"]["${tool}"] = global["${utcpGlobalName}"]["${utcpProp}"];`);
    }
  }
  lines.push('})();');
  return lines.join('\n');
}

/**
 * Builds a JavaScript snippet that patches __getToolInterface inside the
 * sandbox isolate so that both new callable names (e.g., "filesystem.read_file")
 * and old UTCP callable names (e.g., "<utcpGlobalName>.filesystem_read_file")
 * resolve to the same interface as the raw UTCP tool names (with dots).
 *
 * UTCP Code Mode keys its interface map by raw tool name (e.g.,
 * "<manualName>.git.git_add") but the callable function name the agent sees
 * uses the new namespace format (e.g., "git.add"). Without this patch,
 * __getToolInterface(callableName) returns null.
 *
 * `manualName` is the UTCP manual name (unsanitized, may contain hyphens).
 * `utcpGlobalName` is the sanitized form UTCP uses as a V8 global.
 */
export function buildInterfacePatchSnippet(
  callableToRawMap: Record<string, string>,
  manualName: string,
  utcpGlobalName: string,
): string {
  const mapJson = JSON.stringify(callableToRawMap);
  // The manual prefix the raw UTCP tool names carry (e.g., "tools-abc.").
  const manualPrefixJson = JSON.stringify(`${manualName}.`);
  // The sanitized name used in the old UTCP callable form
  // (e.g., "tools_abc.filesystem_read_file").
  const utcpGlobalPrefixJson = JSON.stringify(`${utcpGlobalName}.`);
  // The snippet runs inside the V8 isolate before user code.
  // It wraps the existing __getToolInterface to also accept callable names.
  // When the name is wrong, it tries auto-correction and falls back to
  // a helpful error message with suggestions.
  return `
    (function() {
      var _callableToRaw = ${mapJson};
      var _manualPrefix = ${manualPrefixJson};
      var _utcpGlobalPrefix = ${utcpGlobalPrefixJson};
      var _origGetToolInterface = global.__getToolInterface;
      if (_origGetToolInterface) {
        global.__getToolInterface = function(toolName) {
          var result = _origGetToolInterface(toolName);
          if (result) return result;
          var rawName = _callableToRaw[toolName];
          if (rawName) return _origGetToolInterface(rawName);

          // Auto-correct: try prepending the manual prefix for raw name lookup
          if (toolName && !toolName.startsWith(_manualPrefix)) {
            var prefixed = _manualPrefix + toolName;
            result = _origGetToolInterface(prefixed);
            if (result) return result;
            rawName = _callableToRaw[prefixed];
            if (rawName) return _origGetToolInterface(rawName);
            // Try converting dots to underscores (e.g. "git.add" -> "<utcpGlobal>.git_add")
            var asOldCallable = _utcpGlobalPrefix + toolName.replace(/\\./g, '_');
            rawName = _callableToRaw[asOldCallable];
            if (rawName) return _origGetToolInterface(rawName);
          }

          // Build helpful error with suggestions. Only ever surface
          // friendly callable names (e.g. "filesystem.read_file"); never
          // the internal UTCP names carrying the per-sandbox manual prefix
          // (e.g. "tools_<id>.filesystem_read_file"), which are useless and
          // confusing for the agent to copy into its next call.
          var allNames = Object.keys(_callableToRaw);
          var suggestions = [];
          var needle = toolName.toLowerCase();
          if (needle.indexOf(_manualPrefix.toLowerCase()) === 0) {
            needle = needle.slice(_manualPrefix.length);
          }
          for (var i = 0; i < allNames.length && suggestions.length < 3; i++) {
            var name = allNames[i];
            // Skip internal UTCP names (manual- or global-prefixed).
            if (name.indexOf(_manualPrefix) === 0 || name.indexOf(_utcpGlobalPrefix) === 0) {
              continue;
            }
            var candidate = name.toLowerCase();
            if (candidate.indexOf(needle) !== -1 || needle.indexOf(candidate) !== -1) {
              suggestions.push(name);
            }
          }
          var msg = "Unknown tool '" + toolName + "'.";
          if (suggestions.length > 0) {
            msg += " Did you mean: " + suggestions.join(', ') + "?";
          } else {
            msg += " Use the callable name format shown in the tool catalog, e.g. git.push";
          }
          return msg;
        };
      }
    })();
  `;
}

/**
 * Builds a JavaScript snippet that injects `global.help = { help: fn }` into the
 * V8 sandbox isolate. This is a pure in-isolate function — no MCP request is
 * created, so the policy engine and audit log never see help calls.
 *
 * - `help.help()` with no args lists all servers with descriptions.
 * - `help.help('filesystem')` lists that server's tools as `callableName(params)`,
 *   then the server's result note, if it has one (`HelpData.resultNotes`).
 * - Unknown server returns an error message suggesting `help.help()`.
 */
export function buildHelpSnippet(helpData: HelpData): string {
  const descriptionsJson = JSON.stringify(helpData.serverDescriptions);
  const toolsJson = JSON.stringify(helpData.toolsByServer);
  const resultNotesJson = JSON.stringify(helpData.resultNotes ?? {});

  return `
    (function() {
      var _serverDescs = ${descriptionsJson};
      var _toolsByServer = ${toolsJson};
      var _resultNotes = ${resultNotesJson};
      global.help = {
        help: function(serverName) {
          if (!serverName) {
            var lines = ['Available tool servers:'];
            var names = Object.keys(_serverDescs);
            for (var i = 0; i < names.length; i++) {
              lines.push('  ' + names[i] + ' - ' + _serverDescs[names[i]]);
            }
            lines.push('');
            lines.push("Call help.help('serverName') to list tools in a server.");
            return lines.join('\\n');
          }
          var tools = _toolsByServer[serverName];
          if (!tools) {
            var known = Object.keys(_serverDescs).join(', ');
            return 'Unknown server: ' + serverName + '. Available servers: ' + known + ". Call help.help() to list all.";
          }
          var lines = ['Tools in ' + serverName + ':'];
          for (var i = 0; i < tools.length; i++) {
            var t = tools[i];
            lines.push('  ' + t.callableName + '(' + t.params + ')');
          }
          if (Object.prototype.hasOwnProperty.call(_resultNotes, serverName)) {
            lines.push('');
            lines.push(_resultNotes[serverName]);
          }
          return lines.join('\\n');
        }
      };
    })();
  `;
}

/**
 * Prefix for per-sandbox virtual UTCP manual names. A short counter
 * suffix is appended per Sandbox instance so two sandboxes running in the
 * same Node process (e.g., the daemon hosting multiple sessions) can
 * coexist without their `coordinatorByManual` bindings colliding.
 *
 * Uniqueness only needs to hold within a single process (the binding map
 * is in-memory, per process) -- it does NOT need to be globally unique or
 * unguessable, so a monotonic counter is sufficient and keeps the name
 * tiny. A short name matters because UTCP creates `global.<name>` in the
 * V8 isolate; if it ever surfaces (e.g. an agent enumerating globals) we
 * want `tools_3`, not a 32-char UUID.
 *
 * The prefix + suffix are already valid identifier characters
 * (underscores, letters, digits) so UTCP's own name sanitization
 * (`[^\w]` → `_`) is a no-op on the chosen name -- the name we bind
 * in the coordinator map is byte-identical to what UTCP passes to
 * `registerManual` on the protocol.
 */
const VIRTUAL_MANUAL_PREFIX = 'tools_';

/** Monotonic per-process counter making each sandbox's manual name unique. */
let manualNameCounter = 0;

/** Caller-supplied hooks for `Sandbox.initialize()`. */
export interface SandboxInitOptions {
  /**
   * In-process escalation handler for the coordinator. When set it
   * supersedes the file-IPC escalation path (`config.escalationDir`); the
   * workflow orchestrator uses it so a shared-container bundle's
   * escalations reach the workflow's human route instead of a per-session
   * watcher. Standalone sessions leave it unset.
   */
  readonly onEscalation?: EscalationPromptFn;
  /**
   * Most agent lanes expected to call through this sandbox's coordinator
   * at once (`ToolCallCoordinatorOptions.maxLanes`). The workflow
   * orchestrator sets it for a shared-container bundle whose scope runs a
   * fan-out; everything else leaves it unset (1).
   */
  readonly maxLanes?: number;
  /**
   * Target of the coordinator-owned `workflow_commit` tool. The workflow
   * orchestrator sets it for agent states (a bundle's channel in
   * shared-container mode, a per-state channel otherwise) so the agent can
   * commit its state's result through the tool; every other session leaves
   * it unset and its agent has no such tool.
   */
  readonly workflowCommit?: WorkflowCommitHandler;
}

export class Sandbox {
  private client: CodeModeUtcpClient | null = null;
  private toolCatalog: string = '';
  private preamble: string = '';
  private helpData: HelpData = { serverDescriptions: {}, toolsByServer: {} };
  private coordinator: ToolCallCoordinator | null = null;
  /**
   * Per-sandbox UTCP manual name (e.g., `tools_3`). Unique per instance
   * (within the process) so concurrent sandboxes don't overwrite each
   * other's coordinator binding. The same name is used as the V8 global
   * UTCP creates in the isolate; snippets reference it directly.
   */
  private readonly manualName = `${VIRTUAL_MANUAL_PREFIX}${++manualNameCounter}`;
  /**
   * Default `execute_code` chain timeout. Set by `initialize()` from the
   * session's escalation and backend-call bounds so a chain outlives the
   * longest single wait inside it (see `codeModeChainTimeoutMs`); the
   * pre-initialize value is the historical 300 s.
   */
  private chainTimeoutMs = 300_000;

  private readonly memoryLimitMb: number;
  private readonly maxConsoleBytes: number;
  private readonly maxConsoleEntries: number;
  /** Scripts of this sandbox that run at once (count semaphore). */
  private readonly chainSlots: WeightedSemaphore;
  /** Isolate memory budget shared with every other sandbox in the process. */
  private readonly processBudget: WeightedSemaphore;
  /**
   * Aborted by `shutdown()`: every running script is cancelled and every
   * queued one leaves the queue, so nothing outlives the sandbox.
   */
  private lifetime = new AbortController();
  /** Servers whose relay could not be started by the last `initialize()`. */
  private unavailableServers: readonly UnavailableMcpServer[] = [];

  /** The agent's justification for each running chain (see chain-justifications.ts). */
  private readonly chainJustifications = new ChainJustifications();

  constructor(options: SandboxOptions = {}) {
    this.memoryLimitMb = positiveOr(options.memoryLimitMb, DEFAULT_CHAIN_MEMORY_LIMIT_MB);
    this.maxConsoleBytes = positiveOr(options.maxConsoleBytes, DEFAULT_MAX_CONSOLE_BYTES);
    this.maxConsoleEntries = positiveOr(options.maxConsoleEntries, DEFAULT_MAX_CONSOLE_ENTRIES);
    this.chainSlots = new WeightedSemaphore(
      positiveOr(options.maxConcurrentChains, DEFAULT_MAX_CONCURRENT_CHAINS),
      positiveOr(options.maxQueuedChains, DEFAULT_MAX_QUEUED_CHAINS),
      'execute_code slot in this session',
    );
    this.processBudget = options.processBudget ?? processChainBudget;
  }

  /**
   * Exposes the policy coordinator once the sandbox is initialized.
   * Returns `null` before `initialize()` completes.
   */
  getCoordinator(): ToolCallCoordinator | null {
    return this.coordinator;
  }

  /**
   * MCP servers the last `initialize()` skipped because their relay failed
   * to connect or to list its tools (each also logged). The session runs
   * without them; sessions report them as `mcp_server_unavailable`
   * diagnostics. Servers refused by the OS-sandbox plan are not included:
   * `reportOsSandboxPlan` reports those.
   */
  getUnavailableServers(): readonly UnavailableMcpServer[] {
    return this.unavailableServers;
  }

  /**
   * Starts the sandbox: the coordinator, one relay per configured server
   * (a server whose relay fails is skipped, see `getUnavailableServers`)
   * and the UTCP manual. When it throws, everything it had started (relays
   * and their backends, the coordinator and its audit log, the manual
   * binding) has been shut down again, so a failed session start leaks
   * nothing, whichever factory created the sandbox.
   */
  async initialize(config: IronCurtainConfig, options: SandboxInitOptions = {}): Promise<void> {
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    // A chain that timed out before one of its calls finished waiting for
    // an approval would abandon that call while the approval could still
    // run it, so the default chain timeout tracks the configured waits.
    this.chainTimeoutMs = codeModeChainTimeoutMs({
      escalationTimeoutMs: escalationTimeoutMsFromConfig(config),
      backendCallTimeoutMs: backendCallTimeoutMsFromConfig(config),
    });
    this.unavailableServers = [];

    try {
      await this.start(config, options);
    } catch (error) {
      await this.shutdown().catch((shutdownError: unknown) => {
        logger.warn(
          `[sandbox] Cleanup after a failed start did not complete: ${
            shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
          }`,
        );
      });
      throw error;
    }
  }

  private async start(config: IronCurtainConfig, options: SandboxInitOptions): Promise<void> {
    this.client = await CodeModeUtcpClient.create();

    // Install the custom in-process UTCP protocol that routes tool calls
    // to the coordinator. Idempotent: safe to call multiple times.
    registerIronCurtainProtocol();

    // Decide, once, which servers get an OS sandbox, which run without one
    // ("warn") and which must not start ("enforce"). The same plan drives
    // audit stamping, relay spawning and the user notice so they agree, and
    // its availability (srt smoke run included) is handed to every relay.
    const osSandboxPlan = await resolveSessionOsSandboxPlan(config);
    reportOsSandboxPlan(osSandboxPlan);

    // Build the coordinator. It owns policy evaluation, audit logging,
    // the circuit breaker, the approval whitelist, and the server-context
    // map. All of these used to be duplicated per subprocess.
    const { coordinator, initialRoots } = await buildCoordinator(config, osSandboxPlan, options);
    this.coordinator = coordinator;
    // An escalated call shows the reviewer the justification the agent gave
    // the chain that issued it, while exactly one chain runs.
    coordinator.setAgentJustificationProvider(() => this.currentAgentJustification());
    bindCoordinatorToManual(this.manualName, coordinator);

    // Spawn one router-mode mcp-proxy-server subprocess per backend
    // server. Each subprocess handles OAuth credential injection,
    // sandbox-runtime wrapping, and the stdio MCP connection to the
    // real backend, but forwards CallTool requests verbatim -- the
    // coordinator owns the policy gate.
    this.unavailableServers = await connectBackendSubprocesses(coordinator, config, initialRoots, osSandboxPlan);

    // Register a single virtual UTCP manual. The UTCP variable
    // substitutor deep-clones `config` into a plain object, so class
    // instances cannot survive the round trip -- the IronCurtain
    // protocol resolves the live coordinator via `coordinatorByManual`
    // (bound above) instead of reading it from the template.
    const registration = await this.client.registerManual({
      name: this.manualName,
      call_template_type: IRONCURTAIN_CALL_TEMPLATE_TYPE,
    });

    if (!registration.success) {
      const errors = registration.errors.join(', ') || 'unknown error';
      throw new Error(`Failed to register IronCurtain manual: ${errors}`);
    }

    const { catalog, patchSnippet, aliasSnippet, helpData } = await this.buildToolCatalogAndPatch(config);
    this.toolCatalog = catalog;
    this.helpData = helpData;

    // Pre-build the preamble once — each executeCode() call creates a fresh
    // V8 isolate, so the preamble must be prepended every time, but the
    // string itself never changes after initialization.
    let preamble = '';
    if (patchSnippet) preamble += patchSnippet + '\n';
    if (aliasSnippet) preamble += aliasSnippet + '\n';
    const helpSnippet = buildHelpSnippet(helpData);
    if (helpSnippet) preamble += helpSnippet + '\n';
    this.preamble = preamble;
  }

  /**
   * Builds the tool catalog, the __getToolInterface patch, namespace alias
   * snippet, and help data in one pass.
   *
   * The catalog is a compact one-line-per-tool listing using new callable names.
   * The patch snippet maps both new and old callable names back to raw UTCP
   * names so that __getToolInterface works with any naming convention.
   * The alias snippet creates server-namespace globals so the new names work.
   * The help data groups tools by server for progressive disclosure.
   */
  private async buildToolCatalogAndPatch(
    config: IronCurtainConfig,
  ): Promise<{ catalog: string; patchSnippet: string; aliasSnippet: string; helpData: HelpData }> {
    if (!this.client) throw new Error('Sandbox not initialized');
    const emptyHelp: HelpData = { serverDescriptions: {}, toolsByServer: {} };

    const tools = await this.client.getTools();
    if (tools.length === 0) {
      return { catalog: 'No tools available', patchSnippet: '', aliasSnippet: '', helpData: emptyHelp };
    }

    const callableToRaw: Record<string, string> = {};
    const catalogLines: string[] = [];
    const toolsByServer: Record<string, HelpToolEntry[]> = {};
    const serverDescriptions: Record<string, string> = {};
    const namespaceAliases: Array<{ newCallable: string; utcpProp: string }> = [];

    for (const t of tools) {
      // Split once; derive all name variants from the same segments.
      const segments = t.name.split('.');
      const callableName = toCallableName(t.name);
      const utcpCallable = segments.length > 1 ? flattenDotted(segments) : sanitize(t.name);
      const params = extractRequiredParams(t.inputs);
      catalogLines.push(`- \`${callableName}(${params})\` — ${t.description}`);

      // Map new callable name → raw UTCP name
      if (callableName !== t.name) {
        callableToRaw[callableName] = t.name;
      }
      // Map old UTCP callable name → raw UTCP name (backward compat)
      if (utcpCallable !== t.name && utcpCallable !== callableName) {
        callableToRaw[utcpCallable] = t.name;
      }

      // Build namespace alias: new callable → UTCP property on global.tools
      // The utcpCallable is "tools.<prop>", extract the property part after the dot
      if (segments.length > 1) {
        const utcpProp = utcpCallable.slice(utcpCallable.indexOf('.') + 1);
        namespaceAliases.push({ newCallable: callableName, utcpProp });
      }

      // Extract server name from the UTCP name: tools.<server>.<tool>
      const serverName = segments.length >= 2 ? segments[1] : segments[0];
      if (!(serverName in toolsByServer)) {
        toolsByServer[serverName] = [];
        serverDescriptions[serverName] =
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: Record index may be undefined at runtime
          config.mcpServers[serverName]?.description ??
          (serverName === WORKFLOW_COMMIT_SERVER ? WORKFLOW_COMMIT_SERVER_DESCRIPTION : serverName);
      }
      toolsByServer[serverName].push({ callableName, params });
    }

    // UTCP creates `global.<sanitizedManualName>` in the V8 isolate.
    // The snippets must target the same property UTCP sets.
    const utcpGlobalName = sanitize(this.manualName);
    const patchSnippet =
      Object.keys(callableToRaw).length > 0
        ? buildInterfacePatchSnippet(callableToRaw, this.manualName, utcpGlobalName)
        : '';
    const aliasSnippet =
      namespaceAliases.length > 0 ? buildNamespaceAliasSnippet(namespaceAliases, utcpGlobalName) : '';
    const resultNotes = structuredResultNotes(Object.keys(toolsByServer));
    const helpData: HelpData = {
      serverDescriptions,
      toolsByServer,
      ...(Object.keys(resultNotes).length > 0 ? { resultNotes } : {}),
    };

    return { catalog: catalogLines.join('\n'), patchSnippet, aliasSnippet, helpData };
  }

  getToolInterfaces(): string {
    return this.toolCatalog;
  }

  getHelpData(): HelpData {
    return this.helpData;
  }

  /** Default chain timeout `executeCode` applies (see {@link codeModeChainTimeoutMs}). */
  getChainTimeoutMs(): number {
    return this.chainTimeoutMs;
  }

  /** Scripts this sandbox is running, and calls waiting for a slot. */
  getChainLoad(): ChainLoad {
    return { running: this.chainSlots.used, queued: this.chainSlots.queued };
  }

  /**
   * Runs one `execute_code` script in a fresh V8 isolate.
   *
   * The call first takes one of the sandbox's execution slots and its share
   * of the process-wide isolate budget, waiting in FIFO order when none is
   * free (a full queue refuses the call at once). Waiting counts against the
   * call's time: the script runs for whatever remains of
   * `min(options.timeoutMs, chain timeout)`. Console output is bounded on the
   * host side; a script past the limit is stopped. `options.signal` cancels
   * the call at any point, `options.lane` goes with every tool call the
   * script makes, and `options.justification` is shown to the reviewer of
   * an escalated call while this is the only script running (see
   * {@link ExecuteCodeOptions}). Failures are reported in the result, never
   * thrown (see {@link CodeExecutionResult}).
   */
  async executeCode(code: string, options: ExecuteCodeOptions = {}): Promise<CodeExecutionResult> {
    const client = this.client;
    if (!client) throw new Error('Sandbox not initialized');

    const requested = options.timeoutMs;
    const timeoutMs =
      requested !== undefined && Number.isFinite(requested)
        ? Math.max(1, Math.min(requested, this.chainTimeoutMs))
        : this.chainTimeoutMs;
    const deadlineMs = Date.now() + timeoutMs;
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;

    let release: ReleaseSlot;
    try {
      release = await this.admitChain(signal, deadlineMs);
    } catch (err) {
      const message = err instanceof ChainAdmissionError ? err.message : String(err);
      return { result: null, logs: [`[ERROR] Code execution failed: ${message}`] };
    }

    // Counted as running only once admitted: a queued call cannot issue
    // tool calls yet, so it does not hide the justification of the one
    // chain that can (see chain-justifications.ts).
    const endChain = this.chainJustifications.begin(options.justification);
    try {
      // Prepend the pre-built preamble (interface patch + namespace aliases +
      // help snippet). Each chain creates a fresh V8 isolate.
      const patchedCode = this.preamble ? `${this.preamble}${code}` : code;
      return await runToolChain(client, patchedCode, {
        timeoutMs: Math.max(1, deadlineMs - Date.now()),
        memoryLimitMb: this.memoryLimitMb,
        maxConsoleBytes: this.maxConsoleBytes,
        maxConsoleEntries: this.maxConsoleEntries,
        signal,
        // The call's signal aborts when the script ends; the lane is the
        // host-assigned lane of the agent stream that sent the script. The
        // IronCurtain protocol hands both to the coordinator (see
        // `withToolCallOptions`).
        callTool: (toolName, args, callSignal) =>
          withToolCallOptions({ signal: callSignal, lane: options.lane }, () => client.callTool(toolName, args)),
      });
    } finally {
      endChain();
      release();
    }
  }

  /**
   * The agent's justification for the chain issuing tool calls now: the
   * justification of the only running chain, or undefined when none or
   * several run (a call cannot be attributed to one of several chains).
   * UNTRUSTED display text for the human reviewer.
   */
  currentAgentJustification(): string | undefined {
    return this.chainJustifications.current();
  }

  /**
   * Takes a sandbox slot, then the chain's weight in the process-wide
   * budget (always in that order, so no two waiters can deadlock).
   */
  private async admitChain(signal: AbortSignal, deadlineMs: number): Promise<ReleaseSlot> {
    const releaseSlot = await this.chainSlots.acquire(1, { signal, deadlineMs });
    try {
      const releaseBudget = await this.processBudget.acquire(chainMemoryWeightMb(this.memoryLimitMb), {
        signal,
        deadlineMs,
      });
      return () => {
        releaseBudget();
        releaseSlot();
      };
    } catch (err) {
      releaseSlot();
      throw err;
    }
  }

  /**
   * Stops everything the sandbox started. The coordinator (which closes the
   * relays and the audit log) is closed and unbound even when closing the
   * UTCP client fails; that failure is rethrown afterwards. Idempotent.
   */
  async shutdown(): Promise<void> {
    // Cancel running and queued scripts first: their tool calls are then
    // withdrawn, so the coordinator's drain below does not wait for them.
    this.lifetime.abort(new Error('the Code Mode sandbox is shutting down'));
    const client = this.client;
    const coordinator = this.coordinator;
    this.client = null;
    this.coordinator = null;
    try {
      if (client) await client.close();
    } finally {
      if (coordinator) {
        unbindCoordinatorFromManual(this.manualName);
        await coordinator.close();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Coordinator construction + subprocess wiring helpers
// ---------------------------------------------------------------------------

/**
 * Wraps the auto-approve model with the session's LLM interaction logging
 * when `config.autoApproveLlmLogPath` is set. What is logged follows
 * `observability.llmInteractionLog` ('off' returns the model unwrapped), and
 * the log is appended to, so a resumed session extends it. Exported for tests.
 */
export function wrapAutoApproveModel(model: LanguageModelV3, config: IronCurtainConfig): LanguageModelV3 {
  if (!config.autoApproveLlmLogPath) return model;
  const middleware = createSessionLlmLogMiddleware(
    config.autoApproveLlmLogPath,
    { stepName: 'auto-approve' },
    config.userConfig,
  );
  return middleware ? wrapLanguageModel({ model, middleware }) : model;
}

/**
 * Bundle returned by `buildCoordinator`: the coordinator plus the
 * initial MCP roots derived from the compiled policy. The roots are
 * passed to `MCPClientManager.connect()` when the coordinator talks
 * to relay subprocesses so that escalation-time root expansion has
 * the correct base set on which to extend.
 */
interface CoordinatorBundle {
  coordinator: ToolCallCoordinator;
  initialRoots: McpRoot[];
}

/**
 * Applies the session's OS-sandbox availability policy to its MCP servers,
 * given the availability (see {@link resolveSessionOsSandboxPlan}, which
 * session start uses). Exported for tests, which inject the availability to
 * simulate a host with or without a working sandbox.
 */
export function planSessionOsSandbox(config: IronCurtainConfig, availability: OsSandboxAvailability): OsSandboxPlan {
  return planServerSandboxing(
    config.mcpServers,
    config.allowedDirectory,
    availability,
    effectiveSandboxPolicy(config),
    computeSandboxCredentialPaths(config.userConfig.credentialProtection),
  );
}

/**
 * The session's OS-sandbox plan. Availability means "platform supported, no
 * missing dependency (bubblewrap, socat, ripgrep on Linux), and srt can
 * start a sandbox": when a server asks for an OS sandbox, the dependency
 * check is confirmed by one srt smoke run per process
 * (`resolveOsSandboxAvailability`), so on a host where srt cannot start
 * (AppArmor-restricted user namespaces, a seccomp helper the host will not
 * run) "enforce" refuses those servers with the notice and "warn" runs them
 * unconfined, instead of wrapping them in an srt that fails. Exported for
 * tests; `probe` injects the host checks.
 */
export async function resolveSessionOsSandboxPlan(
  config: IronCurtainConfig,
  probe: OsSandboxAvailabilityProbe = {},
): Promise<OsSandboxPlan> {
  const availability = await resolveOsSandboxAvailability(config.mcpServers, {
    dependencies: probe.dependencies ?? getOsSandboxAvailability(),
    smokeTest: probe.smokeTest,
  });
  return planSessionOsSandbox(config, availability);
}

/**
 * Surfaces servers that will not get the OS sandbox they ask for: one line
 * on stderr (the session logger swallows console output, so it is written
 * to the stream directly) plus the session log. Silent when every server
 * that asks for a sandbox gets one. Called at session start by
 * `Sandbox.initialize()`; exported for tests.
 */
export function reportOsSandboxPlan(plan: OsSandboxPlan): void {
  const notice = formatOsSandboxNotice(plan);
  if (notice === undefined) return;
  logger.warn(`[sandbox] ${notice}`);
  writeOsSandboxNotice(notice);
}

/**
 * The coordinator's policy-evaluated egress options (see
 * docs/designs/mitm-egress-policy.md): present only when the user opted in
 * (`egressPolicy.enabled`) and the session has a MITM proxy whose control
 * API is up, which is what asks the coordinator (Docker Agent Mode).
 * Exported for tests.
 */
export function egressPolicyOptionsFor(config: IronCurtainConfig): EgressPolicyOptions | undefined {
  const egressPolicy = config.userConfig.egressPolicy;
  if (egressPolicy?.enabled !== true || !config.mitmControlAddr) return undefined;
  return { allowedHosts: egressPolicy.allowedHosts };
}

/**
 * The servers the session spawns relays for: every configured server except
 * those the OS-sandbox plan refuses. Exported for tests.
 */
export function relayServerNames(config: IronCurtainConfig, plan: OsSandboxPlan): string[] {
  const refused = new Set(plan.refused);
  return Object.keys(config.mcpServers).filter((name) => !refused.has(name));
}

/**
 * Builds the `ToolCallCoordinator` from the loaded policy artifacts.
 * Merges proxy-tool annotations/rules so the coordinator can evaluate
 * virtual proxy tools the same way the subprocess used to.
 */
async function buildCoordinator(
  config: IronCurtainConfig,
  osSandboxPlan: OsSandboxPlan,
  initOptions: SandboxInitOptions = {},
): Promise<CoordinatorBundle> {
  // Schema-validated by the loader (src/types/policy-schema.ts): a
  // malformed compiled policy, lists file or annotations file throws here
  // and the session does not start.
  const { compiledPolicy, toolAnnotations, dynamicLists } = loadGeneratedPolicy({
    policyDir: config.generatedDir,
    toolAnnotationsDir: config.toolAnnotationsDir ?? config.generatedDir,
    fallbackDir: getPackageGeneratedDir(),
  });

  // Inject the virtual proxy tools/rules so the coordinator treats
  // add_proxy_domain / remove_proxy_domain / list_proxy_domains as
  // policy-evaluated tools like any other. They are merged after
  // validation: the hardcoded rules carry `humanOnly`, which the file
  // format does not allow.
  toolAnnotations.servers.proxy = {
    inputHash: 'hardcoded',
    tools: proxyAnnotations,
  };
  compiledPolicy.rules = [...proxyPolicyRules, ...compiledPolicy.rules];

  // `--task-scoped`: the task scope narrows the session policy for the
  // coordinator's whole life (the coordinator adds the proxy rules to it,
  // and the egress rules when policy-evaluated egress is on). A scope that
  // cannot be loaded throws here, so the session fails to start instead of
  // running unscoped.
  const taskScope = config.taskPolicyDir === undefined ? undefined : loadTaskScopePolicy(config.taskPolicyDir);
  if (taskScope) {
    logger.info(`[policy] Task scope: ${taskScope.policyDir} (calls outside it escalate)`);
  }

  const serverDomainAllowlists = extractServerDomainAllowlists(config.mcpServers);
  const trustedServers = buildTrustedServerSet(config.mcpServers);

  // Auto-approve model: build in-process now that the subprocess no
  // longer owns it.
  let autoApproveModel: LanguageModelV3 | null = null;
  const autoApprove = config.userConfig.autoApprove;
  if (autoApprove.enabled) {
    try {
      const base = await createLanguageModel(autoApprove.modelId, config.userConfig, 'autoApprove');
      autoApproveModel = wrapAutoApproveModel(base, config);
    } catch (err) {
      // Model construction failure is non-fatal: auto-approve becomes
      // unavailable but the session still runs with manual escalation.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[auto-approve] Model construction failed (${autoApprove.modelId}): ${message}`);
    }
  }

  // Outbound content assessment (opt-in, off unless the user enabled it):
  // the coordinator checks what assess-allowed and escalated calls send out.
  const contentAssessment = await contentAssessorOptionsFromConfig(config.userConfig);

  // Virtual proxy control client (Docker Agent Mode only). Matches the
  // subprocess's previous behavior where SERVER_FILTER=proxy entered
  // virtual-only mode with MITM_CONTROL_ADDR set.
  const controlApiClient = config.mitmControlAddr
    ? createControlApiClient(config.mitmControlAddr, { token: config.mitmControlToken })
    : null;

  // Per-server sandbox disposition for audit-log annotation. The
  // subprocesses own the actual sandbox wrapping (srt settings files,
  // command wrapping); the parent only needs the disposition to stamp audit
  // entries and annotate EPERM/EACCES errors as sandbox violations. The
  // plan marks a server sandboxed only when sandboxing is really available
  // (platform supported, no missing dependency, and srt's smoke run passed),
  // and leaves refused servers out entirely.
  const resolvedSandboxConfigs = new Map(osSandboxPlan.resolved);

  const coordinator = new ToolCallCoordinator({
    compiledPolicy,
    toolAnnotations,
    ...(taskScope ? { taskScope: taskScope.policy } : {}),
    protectedPaths: config.protectedPaths,
    allowedDirectory: config.allowedDirectory,
    // A read-only workspace (a read-only workflow state or scope) denies
    // every change outside its writable directories, whatever the policy.
    readOnlyWorkspace: config.readOnlyWorkspace,
    serverDomainAllowlists,
    dynamicLists,
    trustedServers,
    auditLogPath: config.auditLogPath,
    auditRedact: config.userConfig.auditRedaction.enabled,
    auditRedactSecrets: collectAuditRedactionSecrets(config.userConfig),
    autoApproveModel,
    contentAssessment,
    escalationDir: config.escalationDir,
    // The coordinator runs in this process, so the PTY mode that gates the
    // auto-approver's trust in user-context.json is passed explicitly from
    // the session config rather than read from any environment variable.
    isPtySession: config.isPtySession === true,
    // The user's escalationTimeoutSeconds bounds the in-process human
    // wait; the backend bound is what every relay also gets through
    // BACKEND_CALL_TIMEOUT_MS (see buildProxySubprocessEnv).
    escalationTimeoutMs: escalationTimeoutMsFromConfig(config),
    backendCallTimeoutMs: backendCallTimeoutMsFromConfig(config),
    onEscalation: initOptions.onEscalation,
    controlApiClient,
    ...(initOptions.workflowCommit ? { workflowCommit: initOptions.workflowCommit } : {}),
    resolvedSandboxConfigs,
    // Workflow policy hot-swaps check each persona's policy provenance.
    policyOnStale: config.userConfig.policy?.onStale,
    maxLanes: initOptions.maxLanes,
    // Opt-in sequence-aware policy (absent = disabled). The coordinator
    // replays this session's audit log first, so a resumed session that was
    // tainted stays tainted, then the earlier legs' bundle logs of a resumed
    // workflow run (set by the workflow orchestrator).
    taintEscalation: config.userConfig.taintEscalation,
    taintReplayAuditLogPaths: config.taintReplayAuditLogPaths,
    // Opt-in policy-evaluated MITM egress (absent = disabled; Docker Agent
    // Mode only, where the MITM proxy asks this coordinator).
    egressPolicy: egressPolicyOptionsFor(config),
    approvalHistoryScope: config.approvalHistoryScope,
  });

  // Derive initial MCP roots from the compiled policy using the same
  // rule the relay subprocess applied in the legacy single-process
  // path. Passing these to `manager.connect()` makes the coordinator's
  // client advertise `roots.listChanged` and seeds the mutable roots
  // array that `addRootsToClient` extends on escalation approval.
  const policyRoots = extractPolicyRoots(compiledPolicy, config.allowedDirectory);
  const initialRoots: McpRoot[] = toMcpRoots(policyRoots);

  return { coordinator, initialRoots };
}

/** One relay subprocess the sandbox starts. */
interface RelaySpec {
  /** The server the relay serves (`proxy` for the virtual proxy-tools relay). */
  readonly serverName: string;
  readonly config: MCPServerConfig;
}

/** A relay that connected and listed its tools, ready to register with the coordinator. */
interface StartedRelay {
  readonly tools: CoordinatorTool[];
  readonly clientState: ClientState;
}

/**
 * Spawns one `mcp-proxy-server.ts` subprocess per backend server in
 * router mode (coordinator-owned policy gate). Also spawns a
 * virtual-only proxy subprocess when `mitmControlAddr` is configured.
 *
 * The subprocesses are driven through the coordinator's
 * `MCPClientManager`. They start concurrently, at most
 * `RELAY_CONNECT_CONCURRENCY` at a time, each within its own deadlines
 * (the `MCP_CONNECT_TIMEOUT_MS` handshake, then
 * `RELAY_LIST_TOOLS_TIMEOUT_MS` for its tool list), so a slow server delays
 * no other. Once all have settled, each started relay's tools are
 * registered with the coordinator in configuration order, so the tool
 * catalog (and the system prompt built from it) never depends on which
 * relay answered first.
 *
 * A relay that fails to connect or to list its tools is closed (its process
 * stops with its connection), logged, and returned in the result; the
 * session runs without that server. Anything else that fails here throws,
 * and `Sandbox.initialize` shuts everything down.
 *
 * `initialRoots` seeds the mutable roots array each relay connection
 * advertises. Passing the same set to every subprocess ensures the
 * policy-derived roots are visible through the relay before any
 * escalation-time expansion.
 *
 * `config.mcpServers` is expected to be pre-filtered to the set of
 * servers the active compiled policy actually references. The standalone
 * session path applies that filter in `buildSessionConfig` via
 * `filterMcpServersByPolicy`; the workflow infrastructure factory does
 * the same with the per-scope union. Servers absent from the map are
 * never started — default-deny would reject every call to them anyway,
 * so spawning their subprocesses would just cost startup time and file
 * descriptors.
 */
async function connectBackendSubprocesses(
  coordinator: ToolCallCoordinator,
  config: IronCurtainConfig,
  initialRoots: McpRoot[],
  osSandboxPlan: OsSandboxPlan,
): Promise<UnavailableMcpServer[]> {
  const manager = coordinator.getMcpManager();
  const proxyEnv = buildProxySubprocessEnv(config, osSandboxPlan);

  for (const serverName of osSandboxPlan.refused) {
    logger.warn(`[sandbox] Not starting MCP server "${serverName}": required OS sandbox is unavailable`);
  }

  const relays: RelaySpec[] = relayServerNames(config, osSandboxPlan).map((serverName) => ({
    serverName,
    config: {
      command: PROXY_COMMAND,
      args: [...PROXY_ARGS],
      env: buildServerRelayEnv(
        proxyEnv,
        serverName,
        config.mcpServers[serverName],
        config.userConfig.serverCredentials[serverName] as Record<string, string> | undefined,
      ),
      sandbox: false,
    },
  }));

  // Virtual-only proxy subprocess (domain management tools). Only
  // exists when MITM is active (Docker Agent Mode). MITM_CONTROL_ADDR
  // and the control API's bearer token are set exclusively here; no
  // backend config or credentials, no SERVER_FILTER mapping to a real
  // server.
  if (config.mitmControlAddr) {
    relays.push({
      serverName: 'proxy',
      config: {
        command: PROXY_COMMAND,
        args: [...PROXY_ARGS],
        env: {
          ...proxyEnv,
          MCP_SERVERS_CONFIG: '{}',
          SERVER_FILTER: 'proxy',
          MITM_CONTROL_ADDR: config.mitmControlAddr,
          ...(config.mitmControlToken === undefined ? {} : { MITM_CONTROL_TOKEN: config.mitmControlToken }),
        },
        sandbox: false,
      },
    });
  }

  const limit = pLimit(RELAY_CONNECT_CONCURRENCY);
  const outcomes = await Promise.allSettled(
    relays.map((relay) => limit(() => startRelay(manager, relay, initialRoots))),
  );

  const unavailable: UnavailableMcpServer[] = [];
  for (const [index, relay] of relays.entries()) {
    const outcome = outcomes[index];
    if (outcome.status === 'fulfilled') {
      coordinator.registerTools(relay.serverName, outcome.value.tools, outcome.value.clientState);
      continue;
    }
    const reason = errorLine(outcome.reason);
    logger.warn(`Failed to start MCP server "${relay.serverName}": ${reason} -- skipping`);
    // A relay that connected and then failed its tool listing would
    // otherwise live on, unused, until the session ends.
    await manager.close(relay.serverName);
    unavailable.push({ serverName: relay.serverName, reason });
  }
  return unavailable;
}

/**
 * Connects one relay and lists its tools, within the relay's deadlines.
 * The tools are not registered yet (see `connectBackendSubprocesses`).
 * The coordinator later shares the manager's live `ClientState`, so
 * `addRootsToClient` mutates the same array the manager returns from its
 * `roots/list` handler.
 */
async function startRelay(manager: MCPClientManager, relay: RelaySpec, initialRoots: McpRoot[]): Promise<StartedRelay> {
  await manager.connect(relay.serverName, relay.config, initialRoots);
  const clientState = manager.getClientState(relay.serverName);
  if (!clientState) throw new Error('no live client after connecting');
  const tools = await manager.listTools(relay.serverName, { timeoutMs: RELAY_LIST_TOOLS_TIMEOUT_MS });
  return {
    clientState,
    tools: tools.map((t) => ({
      serverName: relay.serverName,
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    })),
  };
}

/** First line of an error's message, for logs and diagnostics. */
function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const newline = message.indexOf('\n');
  return newline === -1 ? message : message.slice(0, newline);
}

/**
 * Builds the environment block passed to router-mode subprocesses.
 *
 * Router subprocesses are pure MCP relays: they load the compiled
 * policy only to derive MCP roots advertised at connection time, and
 * forward CallTool requests verbatim. They do NOT construct the
 * security kernel (PolicyEngine/AuditLog/CircuitBreaker/
 * ApprovalWhitelist/auto-approve model) -- the coordinator in the
 * parent process owns all of that.
 *
 * As a result, the following env vars are deliberately omitted:
 *   - AUDIT_LOG_PATH, AUDIT_REDACTION   -- coordinator owns audit
 *   - CONSTITUTION_PATH                 -- never read by the proxy
 *   - PROTECTED_PATHS                   -- only used by PolicyEngine
 *   - ESCALATION_DIR, ESCALATION_TIMEOUT_SECONDS -- escalation runs in the
 *     coordinator; the relay only gets the backend call bound
 *   - AUTO_APPROVE_*                    -- coordinator owns auto-approve
 *   - IRONCURTAIN_PTY_SESSION           -- the PTY mode gates auto-approve
 *                                          trust in the coordinator, which
 *                                          receives it as a constructor
 *                                          option (`isPtySession`)
 *
 * The sandbox policy is the session's resolved policy (which already gives
 * an explicit IRONCURTAIN_SANDBOX_POLICY / SANDBOX_POLICY precedence), set
 * under both names so the relay cannot resolve a different one from its
 * inherited environment. The availability the plan was made with, srt smoke
 * run included, goes along as OS_SANDBOX_AVAILABILITY: the relay narrows it
 * with its own dependency check instead of deciding from that check alone,
 * so on a host where srt cannot start it runs a "warn" server unconfined, as
 * the plan (and the audit stamp) says, rather than wrapping it in srt.
 *
 * Every path in the block is absolute, resolved here against this
 * process's cwd (the base the coordinator's policy engine uses for the
 * same values): relays run from IronCurtain's package root (see
 * trusted-process/spawn-cwd.ts), not this process's cwd, and refuse a
 * relative ALLOWED_DIRECTORY. `allowedDirectory` is resolved too, as
 * defense in depth for callers that set it without going through
 * loadConfig(): a relative value would otherwise make every relay exit.
 *
 * This is the part shared by every relay of the session. What is specific
 * to one relay -- its server's config (MCP_SERVERS_CONFIG), SERVER_FILTER,
 * SERVER_CREDENTIALS and the host values its server's `-e NAME` arguments
 * forward -- is added per relay by {@link buildServerRelayEnv}, so no relay
 * sees another server's configuration or credentials. The relay inherits
 * nothing else from this process: `MCPClientManager.connect` spawns it with
 * the allowlist of trusted-process/child-env.ts plus this block.
 * Exported for tests.
 */
export function buildProxySubprocessEnv(
  config: IronCurtainConfig,
  osSandboxPlan: OsSandboxPlan,
): Record<string, string> {
  const env: Record<string, string> = {
    ...sandboxCredentialPathsEnv(computeSandboxCredentialPaths(config.userConfig.credentialProtection)),
    // Needed for policy-root derivation (advertised to backend MCP
    // servers as MCP Roots at connection time).
    GENERATED_DIR: resolve(config.generatedDir),
    TOOL_ANNOTATIONS_DIR: resolve(config.toolAnnotationsDir ?? config.generatedDir),
    ALLOWED_DIRECTORY: resolve(config.allowedDirectory),
    // The relay runs from the package root, not this process's cwd, so it
    // gets the home this process resolved (always absolute: a relative
    // IRONCURTAIN_HOME is refused) and both agree on where OAuth tokens
    // and client credentials are read from.
    IRONCURTAIN_HOME: getIronCurtainHome(),
    CONTAINER_WORKSPACE_DIR,
    // The relay bounds each backend call with this; the coordinator waits
    // `relayCallTimeoutMs()` for the relay so both agree on who times out.
    [BACKEND_CALL_TIMEOUT_ENV]: String(backendCallTimeoutMsFromConfig(config)),
    ...sandboxPolicyEnv(relaySandboxPolicy(osSandboxPlan)),
    ...osSandboxAvailabilityEnv(osSandboxPlan.availability),
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    // Where the user moved the credential stores the relay must hide from
    // sandboxed servers (ANTHROPIC_CONFIG_DIR, CODEX_HOME): the relay builds
    // the srt denyRead baseline from them and does not pass them on.
    ...relayHostSettings(process.env),
  };

  if (config.sessionLogPath) env.SESSION_LOG_PATH = resolve(config.sessionLogPath);

  return env;
}

/**
 * The environment block of the relay for one server: the shared block from
 * {@link buildProxySubprocessEnv} plus what belongs to that server alone.
 *
 * - `MCP_SERVERS_CONFIG` holds only this server's config. A relay used to
 *   receive every server's config, `env` blocks included, and spread its
 *   environment into its backend, so each third-party server could read the
 *   others' configuration (and the memory server's LLM key).
 * - `SERVER_CREDENTIALS` carries this server's stored credentials
 *   (config.json `serverCredentials`); the relay scrubs the variable before
 *   spawning the backend and injects the values into the backend's
 *   environment.
 * - The host values the server's docker-style `-e NAME` arguments forward
 *   (GITHUB_PERSONAL_ACCESS_TOKEN for the shipped github server) are copied
 *   from `hostEnv` by name. The relay's environment is allowlisted and holds
 *   nothing else from the host, so this process, which still has the host
 *   environment, is the one that must hand them over; the relay forwards
 *   them to the backend because the backend's arguments name them. They are
 *   layered first, so a `-e` name can never replace a value the relay is
 *   configured with (the relay-internal names are refused outright).
 *
 * Exported for tests.
 */
export function buildServerRelayEnv(
  proxyEnv: Readonly<Record<string, string>>,
  serverName: string,
  serverConfig: MCPServerConfig,
  serverCredentials: Readonly<Record<string, string>> | undefined,
  hostEnv: HostEnv = process.env,
): Record<string, string> {
  return {
    ...pickPassthroughEnv(hostEnv, serverConfig.args),
    ...proxyEnv,
    MCP_SERVERS_CONFIG: JSON.stringify({ [serverName]: serverConfig }),
    SERVER_FILTER: serverName,
    ...(serverCredentials ? { SERVER_CREDENTIALS: JSON.stringify(serverCredentials) } : {}),
  };
}

/**
 * The policy handed to relays. When the parent found OS sandboxing
 * available it stamps sandbox-requesting servers `sandboxed: true` in the
 * audit log, so the relay gets "enforce": a relay that nonetheless finds
 * sandboxing unavailable then refuses the server instead of running it
 * unconfined under a sandboxed audit stamp. Otherwise the session policy
 * applies unchanged.
 */
function relaySandboxPolicy(plan: OsSandboxPlan): SandboxAvailabilityPolicy {
  return plan.availability.available ? 'enforce' : plan.policy;
}
